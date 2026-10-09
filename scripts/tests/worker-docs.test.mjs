import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import catalog from "../../apps/docs/catalog.json" with { type: "json" };
import { fetchWorker } from "../../apps/worker/src/index.ts";
import { docsAssetHeaders } from "../lib/docs-asset-routing.mjs";

const origin = "https://docs.example.test";
const appHtml = '<!doctype html><html><body><div id="app">Main application</div></body></html>';
const docsHtml = (title) => `<!doctype html><html><head><meta name="cfkanban-docs" content="true"></head><body>${title}</body></html>`;

test("documentation headers accept VitePress local search chunks without permitting header patterns", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cfkanban-docs-headers-"));
  try {
    await mkdir(path.join(directory, "chunks"));
    await writeFile(path.join(directory, "chunks/@localSearchIndexen.CXd3GAVa.js"), "export default {};");
    const headers = await docsAssetHeaders(directory, "/app/*\n  Cache-Control: no-store");
    assert.match(headers, /\/docs\/assets\/\*\.js\n  Cache-Control: public, max-age=31536000, immutable/u);
    await writeFile(path.join(directory, "unsafe#fragment.js"), "");
    await assert.rejects(docsAssetHeaders(directory, ""), /safe header patterns/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function fixture({ missing = [], appFallback = [], missingResponse = "spa", assetHeaders = {} } = {}) {
  const files = new Map([
    ["/llms.txt", { body: "# cfKanban\nAgent getting started / Agent 入门", type: "text/plain" }],
    ["/docs/", { body: docsHtml("Choose your language"), type: "text/html; charset=utf-8" }],
    ["/docs/404", { body: docsHtml("Documentation not found"), type: "text/html; charset=utf-8" }],
    ["/docs/llms.txt", { body: "# cfKanban docs", type: "text/plain" }],
    ["/docs/hashmap.json", { body: '{"en_overview_index.md":"fingerprint"}', type: "application/json" }],
    ["/docs/vp-icons.css", { body: ".vpi-search { mask-image: url(data:image/svg+xml;base64,PHN2Zy8+); }", type: "text/css" }],
    ["/docs/assets/app.A1b2C3d4.js", { body: "export const docs = true;", type: "application/javascript" }],
    ["/docs/assets/style.A1b2C3d4.css", { body: ".docs { color: orange; }", type: "text/css" }],
    ["/docs/assets/logo.svg", { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', type: "image/svg+xml" }],
  ]);
  for (const locale of ["en", "zh-CN"]) {
    for (const group of catalog) {
      for (const page of group.pages) {
        const path = `/docs/${locale}/${page.path.replace(/\/index$/u, "/")}`;
        files.set(path, { body: docsHtml(page[locale]), type: "text/html; charset=utf-8" });
        files.set(`/docs/${locale}/${page.path}.md`, { body: `# ${page[locale]}\n`, type: "text/markdown" });
      }
    }
  }
  for (const path of missing) files.delete(path);
  for (const path of appFallback) files.set(path, { body: appHtml, type: "text/html" });
  const requests = [];
  const env = {
    get DB() { assert.fail("Public documentation must not access D1"); },
    get INSTANCE_RATE_LIMITER() { assert.fail("Public documentation must not use dynamic API rate limits"); },
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push({ path, url: request.url, method: request.method, headers: request.headers });
        const file = files.get(path);
        if (file) return new Response(request.method === "HEAD" ? null : file.body, {
          headers: { "content-type": file.type, "cache-control": "public, max-age=0, must-revalidate", "content-length": String(Buffer.byteLength(file.body)), ...assetHeaders },
        });
        if (path.endsWith(".html")) {
          return new Response(null, { status: 308, headers: { location: path.slice(0, -5) } });
        }
        if (missingResponse === "404") return new Response(null, { status: 404 });
        return new Response(request.method === "HEAD" ? null : appHtml, { headers: { "content-type": "text/html" } });
      },
    },
  };
  const request = (path, init = {}) => fetchWorker(new Request(`${origin}${path}`, init), env);
  return { request, requests, env };
}

function assertDocumentHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.get("x-request-id"));
}

test("documentation roots and HTML aliases redirect to their canonical public paths", async () => {
  const { request, requests } = fixture();
  const redirects = [
    ["/docs", "/docs/"],
    ["/docs/index.html", "/docs/"],
    ["/docs/en", "/docs/en/overview/"],
    ["/docs/zh-CN/", "/docs/zh-CN/overview/"],
    ["/docs/en/usage", "/docs/en/usage/"],
    ["/docs/en/usage/index.html", "/docs/en/usage/"],
    ["/docs/en/usage/issues.html", "/docs/en/usage/issues"],
    ["/docs/en/usage/issues/", "/docs/en/usage/issues"],
    ["/docs/en/integrations", "/docs/en/integrations/"],
    ["/docs/zh-CN/administration/index.html", "/docs/zh-CN/administration/"],
    ["/docs/en/overview/quick-start.html", "/docs/en/overview/quick-start"],
    ["/docs/zh-CN/usage/agents/", "/docs/zh-CN/usage/agents"],
  ];
  for (const [path, location] of redirects) {
    const response = await request(path);
    assert.equal(response.status, 308, path);
    assert.equal(response.headers.get("location"), location, path);
    assertDocumentHeaders(response);
  }
  assert.equal(requests.length, 0);
});

test("all catalog deep links render public documentation without API, auth or D1 dependencies", async () => {
  const { request, requests } = fixture();
  const root = await request("/docs/");
  assert.equal(root.status, 200);
  assert.match(await root.text(), /Choose your language/);
  for (const locale of ["en", "zh-CN"]) {
    for (const group of catalog) {
      for (const page of group.pages) {
        const path = `/docs/${locale}/${page.path.replace(/\/index$/u, "/")}`;
        const response = await request(`${path}?search=example`, {
          headers: { cookie: "synthetic-session-cookie", authorization: "Bearer synthetic-test-value" },
        });
        assert.equal(response.status, 200, path);
        assert.match(await response.text(), /name="cfkanban-docs"/, path);
        assertDocumentHeaders(response);
      }
    }
  }
  assert.ok(requests.every(({ path }) => !path.endsWith(".html")), "ASSETS must receive clean URLs to avoid redirect loops");
  assert.ok(requests.every(({ headers }) => !headers.has("cookie") && !headers.has("authorization")));
});

test("navigation grouping preserves content URLs and hidden compatibility entries", async () => {
  assert.deepEqual(catalog.map(group => group.slug), ["overview", "integrations", "usage", "deployment", "cli"]);
  assert.deepEqual(catalog.find(group => group.slug === "integrations").pages.map(page => page.path), ["integrations/index", "integrations/general", "integrations/deepseek-harness", "integrations/codex-app"]);
  const { request } = fixture();
  for (const locale of ["en", "zh-CN"]) {
    for (const path of ["integrations/general", "integrations/deepseek-harness", "integrations/codex-app", "integrations/webui", "administration/projects", "administration/settings", "overview/quick-start", "usage/agents"]) {
      const response = await request(`/docs/${locale}/${path}`);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /name="cfkanban-docs"/, path);
      assertDocumentHeaders(response);
      const markdown = await request(`/docs/${locale}/${path}.md`);
      assert.equal(markdown.status, 200, path);
      assert.equal(markdown.headers.get("content-type"), "text/plain; charset=utf-8", path);
      assertDocumentHeaders(markdown);
    }
    for (const path of ["overview/general", "overview/deepseek-harness", "usage/projects", "deployment/settings", "integrations/mcp", "integrations/mcp.html"]) {
      const response = await request(`/docs/${locale}/${path}`);
      assert.equal(response.status, 404, path);
      assert.match(await response.text(), /Documentation not found/, path);
    }
    const retiredMarkdown = await request(`/docs/${locale}/integrations/mcp.md`);
    assert.equal(retiredMarkdown.status, 404);
    assert.equal(await retiredMarkdown.text(), "Not Found");
    assertDocumentHeaders(retiredMarkdown);
  }
});

test("unknown documentation paths return the documentation 404 and never the app shell", async () => {
  const { request, requests } = fixture();
  for (const path of ["/docs/missing", "/docs/en/usage/missing", "/docs/en/unknown.html", "/docs/fr/overview/", "/docs/404.html"]) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
    assert.match(await response.text(), /Documentation not found/, path);
    assertDocumentHeaders(response);
  }
  assert.ok(requests.every(({ path }) => path === "/docs/404"));
});

test("missing built documents fail closed even when the SPA binding returns HTML with 200", async () => {
  const first = fixture({ missing: ["/docs/en/usage/issues"] });
  const response = await first.request("/docs/en/usage/issues");
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Documentation not found/);
  const second = fixture({ appFallback: ["/docs/en/usage/issues", "/docs/404"] });
  const fallback = await second.request("/docs/en/usage/issues");
  assert.equal(fallback.status, 404);
  assert.equal(await fallback.text(), "Not Found");
  assert.equal(fallback.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("Markdown and discovery text are readable UTF-8 and never cached", async () => {
  const { request } = fixture();
  for (const path of ["/llms.txt", "/docs/en/usage/index.md", "/docs/zh-CN/usage/issues.md", "/docs/llms.txt"]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(await response.text(), /^# /);
    assertDocumentHeaders(response);
  }
  const hashmap = await request("/docs/hashmap.json");
  assert.equal(hashmap.status, 200);
  assert.equal(hashmap.headers.get("content-type"), "application/json; charset=utf-8");
  assertDocumentHeaders(hashmap);
  assert.deepEqual(await hashmap.json(), { "en_overview_index.md": "fingerprint" });
});

test("all canonical catalog pages negotiate their existing Markdown source without forwarding credentials", async () => {
  const { request, requests } = fixture({ assetHeaders: { vary: "Accept-Encoding" } });
  for (const locale of ["en", "zh-CN"]) {
    for (const group of catalog) {
      for (const page of group.pages) {
        const canonical = `/docs/${locale}/${page.path.replace(/\/index$/u, "/")}`;
        const response = await request(`${canonical}?search=example`, {
          headers: { accept: "text/markdown", cookie: "synthetic-session-cookie", authorization: "Bearer synthetic-test-value" },
        });
        assert.equal(response.status, 200, canonical);
        assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8", canonical);
        assert.equal(response.headers.get("vary"), "Accept-Encoding, Accept", canonical);
        assert.equal(await response.text(), `# ${page[locale]}\n`, canonical);
        assertDocumentHeaders(response);
        assert.equal(requests.at(-1).path, `/docs/${locale}/${page.path}.md`);
      }
    }
  }
  assert.ok(requests.every(({ method, headers, url }) => method === "GET" && [...headers].length === 0 && !new URL(url).search));
});

test("HTML and Markdown negotiate on canonical URLs while aliases and explicit source URLs keep their contracts", async () => {
  const { request, requests } = fixture();
  const path = "/docs/en/usage/issues";
  for (const accept of [undefined, "*/*", "text/markdown;q=0,text/*;q=1", "text/markdown,text/html", "text/markdown;q=0.4,text/html;q=0.8"]) {
    const response = await request(path, { headers: accept ? { accept } : {} });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.equal(response.headers.get("vary"), "Accept");
    assert.match(await response.text(), /name="cfkanban-docs"/);
    assert.equal(requests.at(-1).path, path);
  }
  const redirect = await request("/docs/en/usage/issues.html", { headers: { accept: "text/markdown" } });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), path);
  const explicit = await request(`${path}.md`, { headers: { accept: "text/html" } });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(await explicit.text(), /^# /);
});

test("documentation language chooser has a Markdown representation from the built bilingual index", async () => {
  const { request, requests } = fixture();
  const response = await request("/docs/", { headers: { accept: "text/markdown" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("vary"), "Accept");
  assert.equal(await response.text(), "# cfKanban docs");
  assert.equal(requests.at(-1).path, "/docs/llms.txt");
});

test("negotiated Markdown HEAD uses the same verified source and headers as GET without a body", async () => {
  const { request, requests } = fixture({ assetHeaders: { vary: "Accept-Encoding", etag: '"source-representation"' } });
  for (const path of ["/docs/", "/docs/zh-CN/overview/", "/docs/en/usage/issues"]) {
    const headers = { accept: "text/markdown" };
    const get = await request(path, { headers });
    const head = await request(path, { method: "HEAD", headers });
    assert.equal(head.status, get.status, path);
    for (const name of ["content-type", "cache-control", "vary", "content-length", "etag", "referrer-policy", "x-content-type-options"]) {
      assert.equal(head.headers.get(name), get.headers.get(name), `${path}: ${name}`);
    }
    assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(await get.text()));
    assert.equal(await head.text(), "");
  }
  assert.ok(requests.every(({ method }) => method === "GET"));
});

test("missing negotiated Markdown fails closed rather than falling back to HTML or the SPA", async () => {
  for (const missingResponse of ["spa", "404"]) {
    const { request, requests } = fixture({ missingResponse, missing: ["/docs/en/usage/issues.md", "/docs/llms.txt"] });
    for (const path of ["/docs/en/usage/issues", "/docs/"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(path, { method, headers: { accept: "text/markdown" } });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(response.headers.get("vary"), "Accept");
        assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
        assert.equal(await response.text(), method === "HEAD" ? "" : "Not Found");
        assertDocumentHeaders(response);
      }
    }
    assert.ok(requests.every(({ path }) => path === "/docs/en/usage/issues.md" || path === "/docs/llms.txt"));
  }
  const { request } = fixture({ appFallback: ["/docs/en/usage/issues.md"] });
  assert.equal((await request("/docs/en/usage/issues", { headers: { accept: "text/markdown" } })).status, 404);
  const unknown = await request("/docs/en/usage/unlisted", { headers: { accept: "text/markdown" } });
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /Documentation not found/);
});

test("fingerprinted documentation assets cache immutably while ordinary assets remain fresh", async () => {
  const { request } = fixture();
  for (const path of ["/docs/assets/app.A1b2C3d4.js", "/docs/assets/style.A1b2C3d4.css"]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  const logo = await request("/docs/assets/logo.svg");
  assert.equal(logo.status, 200);
  assertDocumentHeaders(logo);
});

test("the generated icon stylesheet has a fixed public route and remains fresh", async () => {
  const { request, requests } = fixture();
  for (const method of ["GET", "HEAD"]) {
    const response = await request("/docs/vp-icons.css", { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
    assertDocumentHeaders(response);
    const body = await response.text();
    if (method === "GET") assert.match(body, /\.vpi-search/);
    else assert.equal(body, "");
  }
  const otherCss = await request("/docs/unlisted.css");
  assert.equal(otherCss.status, 404);
  assert.equal(await otherCss.text(), "Not Found");
  assert.ok(requests.every(({ path }) => path === "/docs/vp-icons.css"));
});

test("missing assets and text return plain 404 rather than an HTML SPA response", async () => {
  for (const missingResponse of ["spa", "404"]) {
    const { request } = fixture({ missingResponse, missing: ["/llms.txt", "/docs/en/usage/issues.md", "/docs/llms.txt", "/docs/hashmap.json", "/docs/vp-icons.css"] });
    for (const path of ["/llms.txt", "/docs/assets/missing.A1b2C3d4.js", "/docs/assets/", "/docs/en/usage/missing.md", "/docs/en/usage/issues.md", "/docs/llms.txt", "/docs/hashmap.json", "/docs/vp-icons.css"]) {
      const response = await request(path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await response.text(), "Not Found");
      assertDocumentHeaders(response);
    }
  }
});

test("HEAD preserves status and document headers without exposing a response body", async () => {
  const { request } = fixture();
  for (const [path, status] of [["/llms.txt", 200], ["/docs", 308], ["/docs/", 200], ["/docs/zh-CN/usage/issues", 200], ["/docs/en/usage/index.md", 200], ["/docs/assets/app.A1b2C3d4.js", 200], ["/docs/missing", 404], ["/docs/assets/missing.js", 404]]) {
    const response = await request(path, { method: "HEAD" });
    assert.equal(response.status, status, path);
    assert.equal(await response.text(), "", path);
  }
  const { request: missingRequest } = fixture({ appFallback: ["/docs/", "/docs/404"] });
  assert.equal((await missingRequest("/docs/", { method: "HEAD" })).status, 404);
  const { request: missingText } = fixture({ missing: ["/llms.txt"] });
  const missing = await missingText("/llms.txt", { method: "HEAD" });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "");
  assertDocumentHeaders(missing);
});

test("documentation rejects writes before reading assets or touching the application", async () => {
  const { request, requests } = fixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const path of ["/llms.txt", "/docs/en/usage/issues"]) {
      const response = await request(path, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
      assert.equal(await response.text(), "Method Not Allowed");
      assertDocumentHeaders(response);
    }
  }
  assert.equal(requests.length, 0);
});

test("application and public guide paths retain their existing asset behavior", async () => {
  const { request, requests, env } = fixture();
  for (const path of ["/app/issues/CFK-1", "/join.md", "/deploy-guide.zh-CN.md", "/docs-other"]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), appHtml, path);
    assert.equal(requests.at(-1).path, path);
  }
  const apiEnv = Object.create(env);
  Object.defineProperty(apiEnv, "INSTANCE_RATE_LIMITER", { value: { limit: async () => ({ success: true }) } });
  Object.assign(apiEnv, {
    RATE_LIMIT_INSTANCE_LIMIT: "300", RATE_LIMIT_INSTANCE_PERIOD_SECONDS: "60",
    RATE_LIMIT_PRINCIPAL_LIMIT: "120", RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS: "60",
    RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT: "30", RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS: "60",
  });
  const openapi = await fetchWorker(new Request(`${origin}/openapi.json`), apiEnv);
  assert.equal(openapi.status, 200);
  assert.ok((await openapi.json()).openapi);
  const missingApi = await fetchWorker(new Request(`${origin}/api/v1/docs`), apiEnv);
  assert.equal(missingApi.status, 404);
  assert.match(missingApi.headers.get("content-type"), /^application\/json/);
  assert.equal(requests.length, 4, "API documents do not enter the static documentation handler");
});

test("Worker-first routing excludes public documentation assets and preserves a real missing-asset 404", async () => {
  const config = JSON.parse(await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.assets.not_found_handling, "none");
  assert.deepEqual(config.assets.run_worker_first, [
    "/api/*", "/healthz", "/openapi.json", "/invite", "/", "/app", "/app/*", "/llms.txt",
    "/robots.txt", "/robots.txt/*", "/sitemap.xml", "/sitemap.xml/*", "/agent-skills", "/agent-skills/*",
    "/docs", "/docs/*", "/.well-known/*", "!/docs/assets/*",
  ]);
});

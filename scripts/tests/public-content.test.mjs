import assert from "node:assert/strict";
import test from "node:test";

import { fetchWorker } from "../../apps/worker/src/index.ts";
import { RELEASE_VERSION } from "../../apps/worker/src/release-version.ts";

const origin = "https://public.example.test";
const signal = "ai-train=no, search=yes, ai-input=yes";
const appHtml = '<!doctype html><html><body><div id="app">Application</div></body></html>';
const docsHtml = '<!doctype html><html><head><meta name="cfkanban-docs" content="true"></head><body>Public documentation</body></html>';

function fixture({ failAssets = false, homepageStatus = 200, homepageType = "text/html; charset=utf-8", vary = "Accept-Encoding", allowApi = false, missing = [] } = {}) {
  const assets = [];
  const limits = [];
  const files = new Map([
    ["/", { body: appHtml, type: homepageType, status: homepageStatus }],
    ["/docs/", { body: docsHtml, type: "text/html; charset=utf-8" }],
    ["/docs/404", { body: docsHtml, type: "text/html; charset=utf-8" }],
    ["/docs/en/overview/", { body: docsHtml, type: "text/html; charset=utf-8" }],
    ["/docs/zh-CN/overview/", { body: docsHtml, type: "text/html; charset=utf-8" }],
    ["/docs/en/overview/index.md", { body: "# cfKanban\nPublic documentation.\n", type: "text/markdown" }],
    ["/docs/zh-CN/overview/index.md", { body: "# cfKanban\n公开使用手册。\n", type: "text/markdown" }],
    ["/docs/llms.txt", { body: "# cfKanban documentation\nEnglish / 简体中文\n", type: "text/plain" }],
    ["/llms.txt", { body: "# cfKanban\nAgent getting started\n", type: "text/plain" }],
    ["/docs/assets/logo.svg", { body: '<svg xmlns="http://www.w3.org/2000/svg"/>', type: "image/svg+xml" }],
  ]);
  for (const path of missing) files.delete(path);
  const env = {
    get DB() { assert.fail("Public representations must not read D1"); },
    get INSTANCE_RATE_LIMITER() {
      assert(allowApi, "Public representations must not enter the API limiter");
      return { async limit({ key }) { limits.push(key); return { success: true }; } };
    },
    get PRINCIPAL_RATE_LIMITER() { assert.fail("Public representations must not enter principal rate limits"); },
    get UNAUTHENTICATED_RATE_LIMITER() { assert.fail("Public representations must not enter sensitive rate limits"); },
    get ASSETS() {
      assert(!failAssets, "The fixed homepage Markdown must not fetch ASSETS");
      return { async fetch(request) {
        const path = new URL(request.url).pathname;
        assets.push({ path, url: request.url, headers: request.headers, method: request.method });
        const file = files.get(path) ?? { body: appHtml, type: "text/html; charset=utf-8" };
        return new Response(request.method === "HEAD" ? null : file.body, {
          status: file.status ?? 200,
          headers: {
            "content-type": file.type,
            "content-length": String(Buffer.byteLength(file.body)),
            "content-security-policy": "default-src 'self'",
            "x-existing-header": "preserved",
            link: `<${origin}/>; rel="canonical"`,
            vary,
          },
        });
      } };
    },
    RATE_LIMIT_INSTANCE_LIMIT: "100",
    RATE_LIMIT_INSTANCE_PERIOD_SECONDS: "60",
    RATE_LIMIT_PRINCIPAL_LIMIT: "100",
    RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS: "60",
    RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT: "100",
    RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS: "60",
  };
  return {
    assets, limits, env,
    request: (path, init) => fetchWorker(new Request(`${origin}${path}`, init), env),
  };
}

function representationHeaders(response) {
  return [...response.headers].filter(([name]) => name !== "x-request-id");
}

function assertPublicTextHeaders(response, mediaType) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), `${mediaType}; charset=utf-8`);
  assert.equal(response.headers.get("content-signal"), signal);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(response.headers.get("x-request-id"));
}

test("the fixed bilingual homepage Markdown serves GET and HEAD before assets, D1 or any API limiter", async () => {
  const { request, assets, limits } = fixture({ failAssets: true });
  const get = await request("/?capability=synthetic", { headers: { accept: "text/markdown", authorization: "Bearer synthetic-test-value", cookie: "synthetic-session-cookie" } });
  const head = await request("/", { method: "HEAD", headers: { accept: "text/markdown" } });
  assertPublicTextHeaders(get, "text/markdown");
  assertPublicTextHeaders(head, "text/markdown");
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.equal(get.headers.get("vary"), "Accept");
  assert.deepEqual(representationHeaders(head), representationHeaders(get));
  assert.equal(await head.text(), "");
  const body = await get.text();
  assert.match(body, /^# cfKanban\n/u);
  assert(body.includes(`Release / 发行版本: ${RELEASE_VERSION}`));
  assert.match(body, /## English\n/u);
  assert.match(body, /## 简体中文\n/u);
  assert.match(body, /milestone, permission, and collaboration semantics/u);
  assert.match(body, /事项、里程碑、权限和协作规则/u);
  assert(!body.includes("synthetic"));
  assert(!body.includes("capability="));
  assert.deepEqual(assets, []);
  assert.deepEqual(limits, []);
});

test("homepage Markdown links derive from Request.url.origin and do not trust forwarding, authentication or query input", async () => {
  const selfOrigin = "https://self-hosted.example.test:9443";
  const { env } = fixture({ failAssets: true });
  const response = await fetchWorker(new Request(`${selfOrigin}/?source=synthetic-query`, {
    headers: {
      accept: "text/markdown", "accept-language": "zh-CN",
      "x-forwarded-host": "attacker.example.test", "x-forwarded-proto": "http",
      forwarded: 'host="attacker.example.test";proto=http',
      authorization: "Bearer synthetic-test-value", cookie: "synthetic-session-cookie",
    },
  }), env);
  const body = await response.text();
  const links = [...body.matchAll(/\]\(([^)]+)\)/gu)].map(match => match[1]);
  const localPaths = ["/docs/en/overview/", "/docs/en/usage/access", "/app", "/docs/zh-CN/overview/", "/docs/zh-CN/usage/access", "/auth.md", "/.well-known/api-catalog", "/openapi.json", "/.well-known/agent-skills/index.json", "/llms.txt"];
  for (const path of localPaths) assert(links.includes(`${selfOrigin}${path}`), path);
  const external = links.filter(link => new URL(link).origin !== selfOrigin);
  assert.deepEqual(external, [
    "https://github.com/breakstring/cfKanban/releases/latest/download/install.md",
    "https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md",
  ]);
  for (const value of ["attacker", "synthetic", "cfkanban.dev", "source="]) {
    assert(!body.includes(value), value);
    assert(!response.headers.get("link").includes(value), value);
  }
  const clean = await fetchWorker(new Request(`${selfOrigin}/`, { headers: { accept: "text/markdown" } }), env);
  assert.equal(await clean.text(), body);
  assert.deepEqual(representationHeaders(clean), representationHeaders(response));
});

test("homepage negotiation honors quality while default HTML preserves assets headers and strips public input", async () => {
  const { request, assets } = fixture();
  for (const accept of [undefined, "*/*", "text/*", "text/markdown,text/html", "text/markdown;q=0,text/*;q=1", "text/markdown;q=0.4,text/html;q=0.8"]) {
    const result = await request("/?source=synthetic", { headers: { ...(accept ? { accept } : {}), authorization: "Bearer synthetic-test-value", cookie: "synthetic-session-cookie" } });
    assertPublicTextHeaders(result, "text/html");
    assert.equal(result.headers.get("vary"), "Accept-Encoding, Accept");
    assert.equal(result.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(result.headers.get("x-existing-header"), "preserved");
    assert.match(result.headers.get("link"), /rel="canonical"/u);
    assert.match(result.headers.get("link"), /rel="api-catalog"/u);
    assert.equal(await result.text(), appHtml);
    const source = assets.at(-1);
    assert.equal(source.url, `${origin}/`);
    assert.equal(source.method, "GET");
    assert.deepEqual([...source.headers], []);
  }
  const priorAssets = assets.length;
  for (const accept of ["text/markdown", "text/html;q=0.2,text/markdown;q=0.8", "text/html;q=0,text/*;q=0.8"]) {
    const result = await request("/", { headers: { accept } });
    assertPublicTextHeaders(result, "text/markdown");
    assert.equal(result.headers.get("vary"), "Accept");
    assert.match(await result.text(), /^# cfKanban/u);
  }
  assert.equal(assets.length, priorAssets);
});

test("HTML homepage HEAD preserves GET metadata and existing Vary dimensions without duplication", async () => {
  for (const [vary, expected] of [["Accept-Encoding", "Accept-Encoding, Accept"], ["accept-encoding, ACCEPT", "accept-encoding, ACCEPT"], ["*", "*"]]) {
    const { request, assets } = fixture({ vary });
    const get = await request("/");
    const head = await request("/?source=synthetic", { method: "HEAD", headers: { authorization: "Bearer synthetic-test-value", cookie: "synthetic-session-cookie" } });
    assertPublicTextHeaders(head, "text/html");
    assert.equal(head.headers.get("vary"), expected);
    assert.deepEqual(representationHeaders(head), representationHeaders(get));
    assert.equal(await head.text(), "");
    assert.equal(assets.at(-1).url, `${origin}/`);
    assert.deepEqual([...assets.at(-1).headers], []);
  }
});

test("public homepage, negotiated docs, explicit Markdown and text indexes use the same fixed Content Signal", async () => {
  const { request } = fixture();
  const cases = [
    ["/", "text/markdown", "text/markdown"], ["/", undefined, "text/html"],
    ["/docs/", "text/markdown", "text/markdown"], ["/docs/", undefined, "text/html"],
    ["/docs/en/overview/", "text/markdown", "text/markdown"], ["/docs/zh-CN/overview/", undefined, "text/html"],
    ["/docs/en/overview/index.md", "text/html", "text/plain"], ["/docs/zh-CN/overview/index.md", "text/markdown", "text/plain"],
    ["/llms.txt", undefined, "text/plain"], ["/docs/llms.txt", undefined, "text/plain"], ["/robots.txt", undefined, "text/plain"],
  ];
  for (const [path, accept, mediaType] of cases) {
    const headers = accept ? { accept } : {};
    const get = await request(path, { headers });
    const head = await request(path, { method: "HEAD", headers });
    assertPublicTextHeaders(get, mediaType);
    assertPublicTextHeaders(head, mediaType);
    assert.deepEqual(representationHeaders(head), representationHeaders(get), path);
    assert.equal(await head.text(), "", path);
    if (path === "/robots.txt") assert((await get.text()).includes(`Content-Signal: ${signal}\n`));
  }
});

test("error responses, non-HTML homepage assets, application pages and APIs receive no new content declaration", async () => {
  const { request, assets, limits } = fixture({ allowApi: true, missing: ["/docs/en/overview/index.md"] });
  for (const path of ["/app", "/app/issues/CFK-1", "/docs/unknown", "/docs/en/overview/", "/docs/en/overview/index.md", "/api/v1/unknown", "/openapi.json", "/.well-known/api-catalog", "/sitemap.xml", "/robots.txt/unknown", "/docs/assets/logo.svg"]) {
    const result = await request(path, { headers: { accept: "text/markdown" } });
    assert.equal(result.headers.get("content-signal"), null, path);
    if (path.startsWith("/app")) {
      assert.match(result.headers.get("content-type"), /^text\/html/u);
      assert.equal(await result.text(), appHtml);
      assert.doesNotMatch(result.headers.get("link"), /api-catalog/u);
    }
  }
  assert.equal(limits.length, 2, "only actual API paths enter the existing API limiter");
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const path of ["/", "/docs/en/overview/", "/llms.txt", "/robots.txt"]) {
      const before = assets.length;
      const result = await request(path, { method, headers: { accept: "text/markdown" } });
      assert.equal(result.status, 405, `${method} ${path}`);
      assert.equal(result.headers.get("allow"), "GET, HEAD");
      assert.equal(result.headers.get("content-signal"), null);
      assert.equal(result.headers.get("link"), null);
      assert.equal(await result.text(), "Method Not Allowed");
      assert.equal(assets.length, before);
    }
  }
  for (const options of [{ homepageStatus: 503 }, { homepageStatus: 201 }, { homepageType: "application/json" }]) {
    const response = await fixture(options).request("/");
    assert.equal(response.headers.get("content-signal"), null);
    assert.doesNotMatch(response.headers.get("link"), /api-catalog/u);
  }
});

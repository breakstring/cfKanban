import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { docsAssetHeaders } from "../lib/docs-asset-routing.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const configuration = JSON.parse(await readFile(new URL("../../wrangler.jsonc", import.meta.url), "utf8"));
const temporary = await mkdtemp(path.join(tmpdir(), "cfkanban-static-assets-cost-"));
const assets = path.join(temporary, "assets");
const main = path.join(temporary, "worker.mjs");
const appBody = '<!doctype html><html><body>APP_SHELL_FIXTURE</body></html>';
const docsBody = '<!doctype html><html><head><meta name="cfkanban-docs" content="true"></head><body>DOCS_FIXTURE</body></html>';
const scriptBody = 'export const asset = "DIRECT_ASSET_FIXTURE";';
const llmsBody = await readFile(new URL("../../apps/web/public/llms.txt", import.meta.url), "utf8");
let address;
let server;

before(async () => {
  const files = {
    "index.html": appBody,
    "llms.txt": llmsBody,
    "docs/index.html": docsBody,
    "docs/en/overview/index.html": docsBody,
    "docs/404.html": docsBody.replace("DOCS_FIXTURE", "DOCS_NOT_FOUND"),
    "docs/assets/app.A1b2C3d4.js": scriptBody,
    "docs/assets/chunks/split.E5f6G7h8.js": scriptBody,
    "docs/assets/chunks/@localSearchIndexen.I9j0K1l2.js": scriptBody,
    "docs/assets/style.A1b2C3d4.css": ".fixture { color: orange; }",
    "docs/assets/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
  };
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(assets, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  await writeFile(path.join(assets, "_headers"), await docsAssetHeaders(path.join(assets, "docs/assets"), await readFile(new URL("../../apps/web/public/_headers", import.meta.url), "utf8")));
  // 仅包裹真实 Worker 记录 invocation，路由与 _headers 使用生产配置/生成器。
  await writeFile(main, `import { fetchWorker } from ${JSON.stringify(path.join(root, "apps/worker/src/index.ts"))};
let invocations = 0;
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === "/app/__fixture_invocations") return Response.json({ invocations });
  invocations++;
  const fixtureEnv = { ...env, get DB() { throw new Error("Static routing must not use D1"); } };
  const response = await fetchWorker(request, fixtureEnv);
  const headers = new Headers(response.headers);
  headers.set("x-fixture-worker-invocation", String(invocations));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
} };`);
  // TestHarness 固定 127.0.0.1:0、persist:false；不绑定 D1、凭据或远端资源。
  server = createTestHarness({ root, workers: [{ config: {
    name: "cfkanban-static-assets-cost-test", main,
    compatibility_date: configuration.compatibility_date,
    compatibility_flags: configuration.compatibility_flags,
    assets: { ...configuration.assets, directory: assets },
  } }] });
  const listening = await server.listen();
  address = new URL(listening.url);
  assert.equal(address.hostname, "127.0.0.1");
});

after(async () => {
  try { await server?.close(); } finally { await rm(temporary, { recursive: true, force: true }); }
});

const request = (pathname, method = "GET", headers = {}) => fetch(new URL(pathname, address), { method, headers, redirect: "manual" });
const invocationCount = async () => (await (await request("/app/__fixture_invocations")).json()).invocations;

function assertSafeHeaders(response) {
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("root Agent guide serves public UTF-8 text with GET/HEAD and rejects writes", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await request("/llms.txt", method);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("x-fixture-worker-invocation"));
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assertSafeHeaders(response);
    assert.equal(await response.text(), method === "HEAD" ? "" : llmsBody);
  }
  const response = await request("/llms.txt", "POST");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.equal(await response.text(), "Method Not Allowed");
});

test("real Static Assets GET/HEAD serve fingerprinted docs directly with immutable safe headers", async t => {
  const previous = await invocationCount();
  for (const pathname of ["/docs/assets/app.A1b2C3d4.js", "/docs/assets/chunks/split.E5f6G7h8.js", "/docs/assets/chunks/@localSearchIndexen.I9j0K1l2.js", "/docs/assets/style.A1b2C3d4.css"]) {
    for (const method of ["GET", "HEAD"]) {
      let response = await request(pathname, method);
      if (pathname.includes("@")) {
        assert.equal(response.status, 307);
        assert.equal(response.headers.get("x-fixture-worker-invocation"), null);
        const canonical = pathname.replace("@", "%40");
        assert.equal(response.headers.get("location"), canonical);
        response = await request(canonical, method);
      }
      assert.equal(response.status, 200, `${method} ${pathname}`);
      assert.equal(response.headers.get("x-fixture-worker-invocation"), null);
      assert.equal(response.headers.get("x-request-id"), null);
      assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assertSafeHeaders(response);
      const body = await response.text();
      if (method === "HEAD") assert.equal(body, "");
      else assert.match(body, pathname.endsWith(".css") ? /color: orange/ : /DIRECT_ASSET_FIXTURE/);
    }
  }
  const logo = await request("/docs/assets/logo.svg");
  assert.equal(logo.status, 200); assertSafeHeaders(logo);
  assert.equal(logo.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(logo.headers.get("x-fixture-worker-invocation"), null);
  assert.equal(await invocationCount(), previous);
  t.diagnostic("11 real HTTP asset requests including two canonical encoding redirects: 0 user Worker invocations; GET/HEAD, nested routes and VitePress local search chunks verified");
});

test("missing docs assets return a true 404 without invoking Worker or returning the app shell", async t => {
  const previous = await invocationCount();
  for (const method of ["GET", "HEAD"]) {
    const response = await request("/docs/assets/missing.Z9y8X7w6.js", method, { "sec-fetch-mode": "navigate" });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-fixture-worker-invocation"), null);
    assert.doesNotMatch(await response.text(), /APP_SHELL_FIXTURE|DOCS_FIXTURE/);
  }
  assert.equal(await invocationCount(), previous);
  t.diagnostic("2 real HTTP missing-asset requests: 404; 0 user Worker invocations; no SPA fallback");
});

test("documentation HTML remains Worker-first and application deep links retain the SPA shell", async t => {
  const previous = await invocationCount();
  for (const pathname of ["/docs/", "/docs/en/overview/"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(pathname, method);
      assert.equal(response.status, 200, `${method} ${pathname}`);
      assert.ok(response.headers.get("x-fixture-worker-invocation"));
      assert.ok(response.headers.get("x-request-id"));
      assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
      assertSafeHeaders(response);
      assert.equal(await response.text(), method === "HEAD" ? "" : docsBody);
    }
  }
  for (const method of ["GET", "HEAD"]) {
    const response = await request("/app/issues/CFK-1", method, { "sec-fetch-mode": "navigate" });
    assert.equal(response.status, 200, `${method} app navigation`);
    assert.ok(response.headers.get("x-fixture-worker-invocation"));
    assert.ok(response.headers.get("x-request-id"));
    assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(await response.text(), method === "HEAD" ? "" : appBody);
  }
  assert.equal(await invocationCount(), previous + 6);
  t.diagnostic("4 documentation HTML and 2 app deep-link HTTP requests: 6 user Worker invocations; secure HTML/SPA responses");
});

import assert from "node:assert/strict";
import test from "node:test";
import docsCatalog from "../../apps/docs/catalog.json" with { type: "json" };

import { fetchWorker } from "../../apps/worker/src/index.ts";
import { authenticationGuideBody } from "../../apps/worker/src/kernel/auth-documentation.ts";

const origin = "https://self-hosted.example.test:9443";
const env = Object.fromEntries([
  "DB", "ASSETS", "INSTANCE_RATE_LIMITER", "PRINCIPAL_RATE_LIMITER", "UNAUTHENTICATED_RATE_LIMITER",
].map(name => [name, undefined]));
for (const name of Object.keys(env)) Object.defineProperty(env, name, {
  get() { assert.fail(`Public auth discovery must not touch ${name}`); },
});
const request = (path, init) => fetchWorker(new Request(`${origin}${path}`, init), env);

function assertPublicHeaders(response) {
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.ok(response.headers.get("x-request-id"));
}

test("auth.md is an explicit anonymous Markdown representation for GET and HEAD regardless of Accept", async () => {
  for (const accept of [undefined, "text/html", "application/json", "text/markdown", "*/*"]) {
    const headers = accept ? { accept } : {};
    const get = await request("/auth.md", { headers });
    const head = await request("/auth.md", { method: "HEAD", headers });
    assert.equal(get.status, 200);
    assert.equal(head.status, 200);
    assertPublicHeaders(get);
    assertPublicHeaders(head);
    assert.equal(get.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(get.headers.get("content-signal"), "ai-train=no, search=yes, ai-input=yes");
    const representation = response => [...response.headers].filter(([name]) => name !== "x-request-id");
    assert.deepEqual(representation(get), representation(head));
    assert.equal(await get.text(), authenticationGuideBody(origin));
    assert.equal(await head.text(), "");
  }
});

test("auth.md does not consume or reflect credentials, query parameters or forwarded origins", async () => {
  const result = await request("/auth.md?credential=synthetic-query&return_to=https://attacker.example.test", {
    headers: {
      authorization: "Bearer synthetic-credential",
      cookie: "session=synthetic-cookie",
      "x-forwarded-host": "attacker.example.test",
      "x-forwarded-proto": "http",
      forwarded: 'host="attacker.example.test";proto=http',
    },
  });
  assert.equal(result.status, 200);
  assertPublicHeaders(result);
  const body = await result.text();
  assert.equal(body, authenticationGuideBody(origin));
  assert.match(body, /^# .*auth\.md\n/u);
  assert.match(body, /## English/u);
  assert.match(body, /## 简体中文/u);
  assert(body.includes(`${origin}/api/v1/me`));
  for (const forbidden of ["synthetic", "attacker.example.test", "return_to", "cfkanban.dev"]) {
    assert(!body.includes(forbidden));
    assert(![...result.headers].some(([, value]) => value.includes(forbidden)));
  }
});

test("auth.md rejects writes and descendants without registering, serving assets or invoking API limits", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const result = await request("/auth.md", { method });
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.get("allow"), "GET, HEAD");
    assert.equal(result.headers.get("content-signal"), null);
    assertPublicHeaders(result);
    assert.equal(await result.text(), "Method Not Allowed");
  }
  for (const path of ["/auth.md/", "/auth.md/unknown"]) for (const method of ["GET", "HEAD"]) {
    const result = await request(path, { method });
    assert.equal(result.status, 404);
    assertPublicHeaders(result);
    assert.equal(result.headers.get("content-signal"), null);
    assert.equal(await result.text(), method === "HEAD" ? "" : "Not Found");
  }
});

test("API catalog and robots expose the real auth guide while sitemap stays HTML only", async () => {
  const catalog = await (await request("/.well-known/api-catalog")).json();
  const auth = catalog.linkset[0]["service-doc"].find(link => link.href === `${origin}/auth.md`);
  assert.deepEqual(auth, { href: `${origin}/auth.md`, type: "text/markdown", hreflang: ["en", "zh-CN"] });
  assert.equal((await request(new URL(auth.href).pathname)).status, 200);
  const robots = await (await request("/robots.txt")).text();
  assert.match(robots, /^Allow: \/auth\.md\$$/mu);
  assert(!robots.includes("Allow: /auth.md/"));
  const sitemap = await (await request("/sitemap.xml")).text();
  assert(!sitemap.includes("auth.md"));
  const publicHtmlPaths = new Set(["/", ...docsCatalog.flatMap(group => group.pages.flatMap(page => (
    ["en", "zh-CN"].map(locale => `/docs/${locale}/${page.path.replace(/\/index$/u, "/")}`)
  )))]);
  assert.equal([...sitemap.matchAll(/<loc>/gu)].length, publicHtmlPaths.size);
});

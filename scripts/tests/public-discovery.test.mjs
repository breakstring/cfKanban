import assert from "node:assert/strict";
import test from "node:test";

import catalog from "../../apps/docs/catalog.json" with { type: "json" };
import { fetchWorker } from "../../apps/worker/src/index.ts";
import { homepageDiscoveryLink, publicDiscoveryResponse } from "../../apps/worker/src/kernel/public-discovery.ts";

const origin = "https://discovery.example.test";
const response = (path, init) => publicDiscoveryResponse(new Request(`${origin}${path}`, init));

function assertHeaders(result, type) {
  assert.equal(result.status, 200);
  assert.match(result.headers.get("content-type"), type);
  assert.equal(result.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("set-cookie"), null);
}

test("API catalog identifies its API context and publishes typed bilingual description targets", async () => {
  const result = response("/.well-known/api-catalog");
  assertHeaders(result, /^application\/linkset\+json; profile="https:\/\/www\.rfc-editor\.org\/info\/rfc9727"$/u);
  const body = await result.json();
  assert.equal(body.linkset.length, 1);
  const api = body.linkset.find(item => item.anchor === `${origin}/api/v1`);
  assert.deepEqual(api["service-desc"], [{ href: `${origin}/openapi.json`, type: "application/json" }]);
  assert.deepEqual(api["service-doc"], [
    { href: `${origin}/docs/en/overview/`, type: "text/html", hreflang: ["en"] },
    { href: `${origin}/docs/zh-CN/overview/`, type: "text/html", hreflang: ["zh-CN"] },
  ]);
  assert(!JSON.stringify(body).includes("principal"));
  assert(!JSON.stringify(body).includes("instance_id"));
});

const appHtml = '<!doctype html><html><body><div id="app">Application</div></body></html>';
const docsHtml = '<!doctype html><html><head><meta name="cfkanban-docs" content="true"></head><body>Public documentation</body></html>';

function workerFixture({ status = 200, contentType = "text/html; charset=utf-8", permitDynamicRateLimit = false, missingAppRoute = false } = {}) {
  const assets = [];
  const rateLimits = [];
  const documents = new Set(["/docs/404"]);
  for (const locale of ["en", "zh-CN"]) for (const group of catalog) for (const page of group.pages) {
    documents.add(`/docs/${locale}/${page.path.replace(/\/index$/u, "/")}`);
  }
  const env = {
    get DB() { assert.fail("Public discovery must not access D1"); },
    get INSTANCE_RATE_LIMITER() {
      assert(permitDynamicRateLimit, "Public discovery must not access the dynamic API limiter");
      return { async limit({ key }) { rateLimits.push(key); return { success: true }; } };
    },
    get PRINCIPAL_RATE_LIMITER() { assert.fail("Public discovery must not access principal rate limits"); },
    get UNAUTHENTICATED_RATE_LIMITER() { assert.fail("Public discovery must not access sensitive-operation rate limits"); },
    RATE_LIMIT_INSTANCE_LIMIT: "100",
    RATE_LIMIT_INSTANCE_PERIOD_SECONDS: "60",
    RATE_LIMIT_PRINCIPAL_LIMIT: "100",
    RATE_LIMIT_PRINCIPAL_PERIOD_SECONDS: "60",
    RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_LIMIT: "100",
    RATE_LIMIT_UNAUTHENTICATED_SENSITIVE_PERIOD_SECONDS: "60",
    ASSETS: { async fetch(request) {
      const path = new URL(request.url).pathname;
      assets.push(path);
      if (documents.has(path)) return new Response(request.method === "HEAD" ? null : docsHtml, { headers: { "content-type": "text/html" } });
      if (missingAppRoute && path.startsWith("/app/")) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : appHtml, {
        status,
        headers: {
          "content-type": contentType,
          "content-security-policy": "default-src 'self'",
          "x-content-type-options": "nosniff",
          "x-existing-header": "preserved",
          link: '<https://discovery.example.test/>; rel="canonical"',
        },
      });
    } },
  };
  return { assets, rateLimits, request: (path, init) => fetchWorker(new Request(`${origin}${path}`, init), env) };
}

test("Worker serves GET and HEAD discovery before D1, authentication, API rate limits or SPA assets", async () => {
  const fixture = workerFixture();
  for (const path of ["/.well-known/api-catalog", "/robots.txt", "/sitemap.xml"]) {
    const get = await fixture.request(path, { headers: { authorization: "Bearer synthetic-test-value", cookie: "synthetic-session-cookie" } });
    const head = await fixture.request(path, { method: "HEAD" });
    assert.equal(get.status, 200, path);
    assert.equal(head.status, 200, path);
    assert.ok(get.headers.get("x-request-id"));
    assert.ok(head.headers.get("x-request-id"));
    const representationHeaders = result => [...result.headers].filter(([name]) => name !== "x-request-id");
    assert.deepEqual(representationHeaders(head), representationHeaders(get), path);
    assert.equal(await head.text(), "", path);
    assert(!(await get.text()).includes("synthetic"));
  }
  assert.deepEqual(fixture.assets, []);
  assert.deepEqual(fixture.rateLimits, []);
});

test("all catalog href targets resolve to existing public resources without inventing an API base route", async () => {
  const fixture = workerFixture({ permitDynamicRateLimit: true });
  const catalogResponse = await fixture.request("/.well-known/api-catalog");
  const catalogBody = await catalogResponse.json();
  const targets = catalogBody.linkset.flatMap(context => Object.entries(context).flatMap(([name, links]) => name === "anchor" ? [] : links.map(link => link.href)));
  assert.equal(targets.length, 3);
  assert(!targets.includes(`${origin}/api/v1`));
  for (const target of targets) {
    const result = await fixture.request(new URL(target).pathname);
    assert.equal(result.status, 200, target);
  }
  assert.deepEqual(fixture.rateLimits, ["dynamic-api"], "only the existing OpenAPI operation uses its dynamic limiter");
});

test("homepage discovery Link preserves existing headers and body for real GET and HEAD HTML 200 responses", async () => {
  const fixture = workerFixture();
  for (const method of ["GET", "HEAD"]) {
    const result = await fixture.request("/", { method });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("x-existing-header"), "preserved");
    assert.equal(result.headers.get("content-security-policy"), "default-src 'self'");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.equal(result.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(result.headers.get("referrer-policy"), "no-referrer");
    assert.ok(result.headers.get("x-request-id"));
    assert.match(result.headers.get("link"), /rel="canonical"/u);
    assert.match(result.headers.get("link"), /rel="api-catalog"/u);
    assert.match(result.headers.get("link"), /rel="service-desc"/u);
    assert.equal(await result.text(), method === "HEAD" ? "" : appHtml);
  }
  assert.deepEqual(fixture.assets, ["/", "/"]);
});

test("homepage Link is absent for other methods, non-HTML and non-200 responses", async () => {
  for (const options of [{ status: 503 }, { status: 201 }, { contentType: "application/json" }]) {
    const fixture = workerFixture(options);
    const result = await fixture.request("/");
    assert.doesNotMatch(result.headers.get("link"), /api-catalog/u);
  }
  const result = await workerFixture().request("/", { method: "POST" });
  assert.doesNotMatch(result.headers.get("link"), /api-catalog/u);
});

test("Worker keeps unknown discovery resources out of the SPA and retains normal app deep-link fallback", async () => {
  const fixture = workerFixture();
  for (const path of ["/.well-known/api-catalog/unknown", "/robots.txt/unknown", "/sitemap.xml/unknown"]) {
    for (const method of ["GET", "HEAD"]) {
      const result = await fixture.request(path, { method });
      assert.equal(result.status, 404, path);
      assert.equal(await result.text(), method === "HEAD" ? "" : "Not Found");
      assert.ok(result.headers.get("x-request-id"));
    }
  }
  assert.deepEqual(fixture.assets, []);
  const dynamic = workerFixture({ permitDynamicRateLimit: true });
  assert.equal((await dynamic.request("/.well-known/unknown-discovery")).status, 404);
  assert.deepEqual(dynamic.assets, []);
  const app = workerFixture({ missingAppRoute: true });
  const result = await app.request("/app/issues/CFK-1");
  assert.equal(result.status, 200);
  assert.equal(await result.text(), appHtml);
  assert.doesNotMatch(result.headers.get("link"), /api-catalog/u);
  assert.deepEqual(app.assets, ["/app/issues/CFK-1", "/index.html"]);
});

test("catalog HEAD carries the RFC9727 Link relation and the same representation headers with no body", async () => {
  const get = response("/.well-known/api-catalog");
  const head = response("/.well-known/api-catalog", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.deepEqual([...head.headers], [...get.headers]);
  assert.match(head.headers.get("link"), /<https:\/\/discovery\.example\.test\/\.well-known\/api-catalog>; rel="api-catalog"/u);
  assert.match(head.headers.get("link"), /rel="service-desc"; type="application\/json"; anchor="https:\/\/discovery\.example\.test\/api\/v1"/u);
  assert.match(head.headers.get("link"), /hreflang="en"/u);
  assert.match(head.headers.get("link"), /hreflang="zh-CN"/u);
  assert.equal(await head.text(), "");
});

test("public discovery and homepage links use only Request.url.origin without auth or forwarded headers", async () => {
  const request = new Request("https://self-hosted.example.test:9443/.well-known/api-catalog?source=untrusted", {
    headers: {
      "x-forwarded-host": "attacker.example.test",
      "x-forwarded-proto": "http",
      forwarded: 'host="attacker.example.test";proto=http',
      authorization: "Bearer synthetic-test-value",
      cookie: "synthetic-session-cookie",
    },
  });
  const result = publicDiscoveryResponse(request);
  const body = await result.text();
  const link = homepageDiscoveryLink(request);
  assert.match(body, /https:\/\/self-hosted\.example\.test:9443\/api\/v1/u);
  assert.match(link, /https:\/\/self-hosted\.example\.test:9443\//u);
  for (const privateValue of ["attacker", "synthetic", "source=untrusted", "cfkanban.dev"]) {
    assert(!body.includes(privateValue));
    assert(!link.includes(privateValue));
  }
  const clean = publicDiscoveryResponse(new Request(request.url));
  assert.equal(body, await clean.text());
  assert.deepEqual([...result.headers], [...clean.headers]);
});

function robotsAllows(body, path) {
  const matches = body.split("\n").flatMap(line => {
    const rule = /^(Allow|Disallow): (.+)$/u.exec(line);
    if (!rule) return [];
    const expression = rule[2].replace(/[.+?^{}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
    return new RegExp(`^${expression}`).test(path) ? [{ allowed: rule[1] === "Allow", length: rule[2].length }] : [];
  }).sort((left, right) => right.length - left.length || Number(right.allowed) - Number(left.allowed));
  return matches[0]?.allowed ?? true;
}

test("robots allows canonical public pages and denies private, exchange, removed and unknown paths", async () => {
  const result = response("/robots.txt");
  assertHeaders(result, /^text\/plain; charset=utf-8$/u);
  const body = await result.text();
  assert.match(body, /^User-agent: \*\nDisallow: \/\n/u);
  assert.match(body, /Sitemap: https:\/\/discovery\.example\.test\/sitemap\.xml\n$/u);
  for (const path of ["/", "/docs/en/overview/", "/docs/zh-CN/usage/milestones", "/docs/en/overview/quick-start", "/docs/zh-CN/usage/agents"]) {
    assert.equal(robotsAllows(body, path), true, path);
  }
  for (const path of ["/app", "/app/issues/CFK-1", "/api/v1/me", "/api/v1/invitations/redeem", "/launch", "/?capability=synthetic", "/docs/en/integrations/mcp", "/docs/en/unknown", "/docs/en/overview/unknown", "/not-a-page"]) {
    assert.equal(robotsAllows(body, path), false, path);
  }
  assert(!body.includes("ai-train"));
  assert(!body.includes("GPTBot"));
});

test("sitemap contains only catalog-derived bilingual canonical HTML and the homepage", async () => {
  const result = response("/sitemap.xml");
  assertHeaders(result, /^application\/xml; charset=utf-8$/u);
  const body = await result.text();
  assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/u);
  assert.match(body, /<\/urlset>\n$/u);
  const locations = [...body.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match => match[1]);
  const expected = new Set([`${origin}/`]);
  for (const locale of ["en", "zh-CN"]) for (const group of catalog) for (const page of group.pages) {
    const path = page.path.endsWith("/index") ? `${page.path.slice(0, -6)}/` : page.path;
    expected.add(`${origin}/docs/${locale}/${path}`);
  }
  assert.deepEqual(new Set(locations), expected);
  assert.equal(locations.length, expected.size);
  for (const location of locations) {
    assert.equal(new URL(location).origin, origin);
    assert(!location.includes(".md"));
    assert(!location.includes("/app"));
    assert(!location.endsWith(".html"));
  }
  for (const path of ["/docs/", "/docs/en/", "/docs/zh-CN/", "/docs/en/integrations/mcp", "/docs/zh-CN/integrations/mcp"]) {
    assert(!locations.includes(`${origin}${path}`), path);
  }
  assert(!body.includes("<lastmod>"));
});

test("robots and sitemap HEAD retain GET metadata without a body and self-hosted origins remain local", async () => {
  for (const path of ["/robots.txt", "/sitemap.xml"]) {
    const get = response(path);
    const head = response(path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.deepEqual([...head.headers], [...get.headers]);
    assert.equal(await head.text(), "");
    const local = publicDiscoveryResponse(new Request(`http://127.0.0.1:8787${path}`, { headers: { "x-forwarded-host": "attacker.example.test" } }));
    const body = await local.text();
    assert(body.includes("http://127.0.0.1:8787/"));
    assert(!body.includes("attacker"));
    assert(!body.includes(origin));
  }
});

test("discovery only supports GET and HEAD, resource descendants return real 404 and unrelated routes remain available", async () => {
  for (const path of ["/.well-known/api-catalog", "/robots.txt", "/sitemap.xml"]) for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const result = response(path, { method });
    assert.equal(result.status, 405, `${method} ${path}`);
    assert.equal(result.headers.get("allow"), "GET, HEAD");
    assert.equal(result.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await result.text(), "Method Not Allowed");
  }
  for (const path of ["/.well-known/api-catalog/", "/robots.txt/unknown", "/sitemap.xml/missing"]) for (const method of ["GET", "HEAD"]) {
    const result = response(path, { method });
    assert.equal(result.status, 404, path);
    assert.equal(result.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await result.text(), method === "HEAD" ? "" : "Not Found");
  }
  for (const path of ["/", "/app/issues/CFK-1", "/docs/en/overview/", "/.well-known/cfkanban-instance.json", "/.well-known/skills/index.json"]) {
    assert.equal(response(path), null, path);
  }
});

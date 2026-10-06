import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const repo = "https://github.com/breakstring/cfKanban/releases";
const [nativeCard, nativeDetail, nativeEmpty] = await Promise.all(["card", "detail", "empty"].map(name => readFile(new URL(`./fixtures/github-release-${name}.html`, import.meta.url), "utf8")));
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const list = cards => `<div id="repo-content-pjax-container"><div class="container-xl"><div data-pjax data-hpc><div><div class="col-md-9">${cards.join("")}</div></div></div></div></div>`;
function card(version, date, prerelease = true) {
  let html = nativeCard.replaceAll("1.10.0-rc.2", version).replace("2026-10-06T06:21:15Z", date);
  if (!prerelease) html = html.replace(/<span[^>]*class="[^"]*Label--warning[^"]*"[^>]*>Pre-release<\/span>/g, "");
  return html;
}
const detail = (version = "2.0.0") => nativeDetail.replaceAll("1.9.4", version);
const duplicateTag = html => html.replace(/(<a[^>]*href="\/breakstring\/cfKanban\/releases\/tag\/[^\"]+"[^>]*>[^<]*<\/a>)/, "$1$1");
const sortedList = list([
  card("2.3.0", "2026-09-05T00:00:00Z"),
  card("2.1.0-rc.10", "2026-10-03T00:00:00Z"),
  card("9.0.0-rc.1", "2026-10-05T00:00:00Z", false),
  card("2.1.0-rc.2", "2026-10-04T00:00:00Z"),
  card("2.2.0-rc.1", "2026-09-01T00:00:00Z"),
  card("2.5.0-rc.1", "2026-08-01T00:00:00Z"),
  card("2.6.0-rc.1", "2026-07-01T00:00:00Z"),
]);

test("真实workerd使用原生HTMLRewriter发现网页发行并保持可信边界、缓存与总deadline", async t => {
  const calls = [], modes = new Map();
  let redirectedRequests = 0, runtime;
  const sink = createServer((_request, response) => { redirectedRequests++; response.end("unexpected redirect"); });
  const source = createServer((request, response) => {
    const match = /^\/([^/]+)(\/.*)$/.exec(request.url);
    const scenario = match?.[1], path = match?.[2], latest = path?.endsWith("/latest"), tag = path?.includes("/tag/");
    calls.push({ scenario, path, headers: request.headers });
    const mode = modes.get(scenario);
    const send = (body, status = 200, headers = {}) => { response.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }); response.end(body); };
    const redirect = location => send("", 302, { location });
    if (mode === "rate_limited") return send("", 429);
    if (scenario === "partial" && !latest && !tag) return send("", 403);
    if (scenario === "malicious") return redirect(`http://127.0.0.1:${sink.address().port}/sink`);
    if (scenario === "cross-repo") return redirect("https://github.com/breakstring/other/releases/tag/2.0.0");
    if (scenario === "empty" && latest) return send("", 404);
    if (scenario === "initial-200" && latest) return send(detail());
    if (scenario === "timeout" && latest) {
      const timer = setTimeout(() => redirect(`${repo}/tag/2.0.0`), 2500);
      response.on("close", () => clearTimeout(timer)); return;
    }
    if (latest) return redirect(`${repo}/tag/2.0.0`);
    if (scenario === "second-redirect" && tag) return redirect(`${repo}/tag/3.0.0`);
    if (scenario === "tag-404" && tag) return send("", 404);
    if (scenario === "timeout" && tag) {
      response.writeHead(200, { "content-type": "text/html" }); response.write(detail().slice(0, 100));
      const timer = setTimeout(() => response.end(detail().slice(100)), 4000);
      response.on("close", () => clearTimeout(timer)); return;
    }
    if (scenario === "large") {
      response.writeHead(200, { "content-type": "text/html" });
      response.write("x".repeat(1024 * 1024)); return response.end("x");
    }
    if (scenario === "declared-large") return send("small", 200, { "content-length": String(1024 * 1024 + 1) });
    if (scenario === "non-html") return send("{}", 200, { "content-type": "application/json" });
    if (scenario === "partial-status") return send(tag ? detail() : sortedList, 206);
    if (tag) {
      if (scenario === "wrong-tag") return send(detail("3.0.0"));
      if (scenario === "duplicate-breadcrumb") return send(duplicateTag(detail()));
      if (scenario === "stable-marked") return send(detail().replace('<span>', '<span><span class="Label Label--warning">Pre-release</span>'));
      if (scenario === "body-fields") return send(detail().replace("Fixture release body", '<div class="d-flex flex-md-row flex-column"><div class="wb-break-word"><div data-pjax="#repo-content-pjax-container"><span><span class="Label--warning">Pre-release</span><a href="/breakstring/cfKanban/releases/tag/99.0.0">99.0.0</a></span></div></div></div><relative-time datetime="2099-01-01T00:00:00Z"></relative-time><script>fetch("https://attacker.test")</script>'));
      return send(detail());
    }
    if (scenario === "empty" || scenario === "timeout") return send(nativeEmpty);
    if (scenario === "filtered-empty") return send(nativeEmpty.replace("There aren’t any releases here", "No releases found"));
    if (scenario === "drift") return send('<div id="repo-content-pjax-container"><div class="container-xl"><div data-pjax data-hpc><p>Changed structure</p></div></div></div>');
    if (scenario === "bad-date") return send(list([card("2.1.0-rc.1", "2026-02-30T00:00:00Z")]));
    if (scenario === "bad-tag") return send(list([card("v2.1.0", "2026-10-01T00:00:00Z")]));
    if (scenario === "bad-link") return send(list([card("2.1.0-rc.1", "2026-10-01T00:00:00Z").replaceAll("/breakstring/cfKanban/releases/tag/", "/breakstring/other/releases/tag/")]));
    if (scenario === "bad-badge") return send(list([card("2.1.0-rc.1", "2026-10-01T00:00:00Z").replaceAll("Pre-release", "Draft")]));
    if (scenario === "duplicate") return send(list([card("2.1.0-rc.1", "2026-10-01T00:00:00Z"), card("2.1.0-rc.1", "2026-10-02T00:00:00Z")]));
    if (scenario === "duplicate-tag-field") return send(list([duplicateTag(card("2.1.0-rc.1", "2026-10-01T00:00:00Z"))]));
    if (scenario === "missing-turbo-frame") return send(sortedList.replaceAll(' data-turbo-frame="repo-content-turbo-frame"', ""));
    if (scenario === "budget") return send(list([...Array.from({ length: 20 }, (_, i) => card(`2.1.0-rc.${i}`, `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`)), card("invalid-ignored-card", "invalid-ignored-date")]));
    if (scenario === "body-fields") return send(list([card("2.1.0-rc.2", "2026-10-04T00:00:00Z").replace("Fixture release body", '<span class="Label--warning">Pre-release</span><a href="/breakstring/cfKanban/releases/tag/99.0.0">99.0.0</a><relative-time datetime="2099-01-01T00:00:00Z"></relative-time>')]));
    return send(sortedList);
  });
  try {
    await listen(sink); await listen(source);
    const output = await build({
      stdin: { resolveDir: fileURLToPath(new URL("../../", import.meta.url)), contents: `
        import { createReleaseUpdatesReader } from './apps/worker/src/services/release-updates.ts';
        const readers = new Map(), clocks = new Map(), traces = new Map();
        export default { async fetch(request) {
          const scenario = new URL(request.url).pathname.slice(1);
          const options = request.method === 'POST' ? await request.json() : {};
          clocks.set(scenario, options.now ?? clocks.get(scenario) ?? 1000000);
          if (!readers.has(scenario)) {
            traces.set(scenario, []);
            readers.set(scenario, createReleaseUpdatesReader((url, init) => {
              traces.get(scenario).push({url, redirect: init.redirect, headers: [...new Headers(init.headers)]});
              return fetch('http://127.0.0.1:${source.address().port}/' + scenario + new URL(url).pathname, init);
            }, () => clocks.get(scenario)));
          }
          const data = await readers.get(scenario)();
          if (options.mutate) data.stable.releases.length = 0;
          return Response.json({data, trace: traces.get(scenario)});
        }};` },
      bundle: true, format: "esm", platform: "browser", write: false,
    });
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-08-29", script: output.outputFiles[0].text }));
    const query = async (scenario, options = {}) => (await runtime.dispatchFetch(`http://localhost/${scenario}`, { method: "POST", body: JSON.stringify(options), headers: { authorization: "fixture-only-owner", cookie: "fixture-only-session", referer: "https://fixture-only.test/private" } })).json();
    const unavailable = channel => { assert.equal(channel.status, "unavailable"); assert.equal(channel.error, "query_failed"); assert.equal(channel.checked_at, null); assert.deepEqual(channel.releases, []); };

    await t.test("可信单跳到准确tag；原生徽标决定通道、发布时间决定顺序且最多5份", async () => {
      const { data, trace } = await query("success");
      assert.equal(data.stable.status, "fresh"); assert.equal(data.stable.releases[0].version, "2.0.0");
      assert.deepEqual(data.prereleases.releases.map(row => row.version), ["2.1.0-rc.2", "2.1.0-rc.10", "2.3.0", "2.2.0-rc.1", "2.5.0-rc.1"]);
      assert.equal(data.prerelease_window, 20);
      assert.equal(trace.length, 3);
      assert.deepEqual(new Set(trace.map(row => row.url)), new Set([repo, `${repo}/latest`, `${repo}/tag/2.0.0`]));
      for (const row of data.prereleases.releases) assert.equal(row.newer_than_instance, true);
      for (const call of trace) { assert.equal(call.redirect, "manual"); assert.deepEqual(call.headers, [["accept", "text/html"], ["user-agent", "cfKanban-release-discovery"]]); }
    });
    await t.test("外host/仓库和额外重定向拒绝，初始latest200不能冒充正式版，tag必须与跳转一致", async () => {
      for (const scenario of ["malicious", "cross-repo", "second-redirect", "initial-200", "wrong-tag", "stable-marked", "tag-404", "duplicate-breadcrumb"]) {
        const { data, trace } = await query(scenario); unavailable(data.stable);
        assert.ok(trace.length <= 3);
        if (["malicious", "cross-repo"].includes(scenario)) unavailable(data.prereleases);
        assert.equal(trace.some(row => row.url.endsWith("/tag/3.0.0")), false);
      }
      assert.equal(redirectedRequests, 0);
    });
    await t.test("原生空态可fresh；过滤空态、结构漂移和坏元数据明确查询失败", async () => {
      const { data } = await query("empty");
      assert.equal(data.stable.status, "fresh"); assert.deepEqual(data.stable.releases, []);
      assert.equal(data.prereleases.status, "fresh"); assert.deepEqual(data.prereleases.releases, []);
      for (const scenario of ["filtered-empty", "drift", "bad-date", "bad-tag", "bad-link", "bad-badge", "duplicate", "duplicate-tag-field"]) unavailable((await query(scenario)).data.prereleases);
      assert.deepEqual((await query("missing-turbo-frame")).data.prereleases.releases.map(row => row.version), ["2.1.0-rc.2", "2.1.0-rc.10", "2.3.0", "2.2.0-rc.1", "2.5.0-rc.1"]);
    });
    await t.test("正文伪徽标/版本/时间与script不作为元数据，不执行远端内容；只检查前20张", async () => {
      const { data } = await query("body-fields");
      assert.equal(data.stable.status, "fresh"); assert.equal(data.stable.releases[0].published_at, "2026-10-05T14:35:47Z");
      assert.equal(data.prereleases.status, "fresh"); assert.deepEqual(data.prereleases.releases.map(row => row.version), ["2.1.0-rc.2"]);
      assert.equal(data.prereleases.releases[0].published_at, "2026-10-04T00:00:00Z");
      const budget = (await query("budget")).data;
      assert.equal(budget.prereleases.status, "fresh"); assert.deepEqual(budget.prereleases.releases.map(row => row.version), ["2.1.0-rc.19", "2.1.0-rc.18", "2.1.0-rc.17", "2.1.0-rc.16", "2.1.0-rc.15"]);
      assert.equal(redirectedRequests, 0);
    });
    await t.test("并发合并、15分钟TTL、旧信息失败保留和60秒重试，调用方不能污染缓存", async () => {
      const [first] = await Promise.all([query("cache"), query("cache"), query("cache")]);
      assert.equal(calls.filter(row => row.scenario === "cache").length, 3);
      await query("cache", { mutate: true }); const preserved = (await query("cache")).data;
      assert.equal(preserved.stable.releases.length, 1);
      modes.set("cache", "rate_limited");
      const stale = (await query("cache", { now: 1_900_001 })).data;
      assert.equal(stale.stable.status, "stale"); assert.equal(stale.stable.error, "rate_limited");
      assert.equal(stale.stable.checked_at, first.data.stable.checked_at); assert.deepEqual(stale.stable.releases, first.data.stable.releases);
      assert.equal(calls.filter(row => row.scenario === "cache").length, 5);
      await query("cache"); assert.equal(calls.filter(row => row.scenario === "cache").length, 5);
      await query("cache", { now: 1_960_001 }); assert.equal(calls.filter(row => row.scenario === "cache").length, 7);
      const partial = (await query("partial")).data;
      await query("partial", { now: 1_060_001 });
      assert.equal(calls.filter(row => row.scenario === "partial" && row.path.endsWith("/latest")).length, 1);
      assert.deepEqual((await query("partial")).data.stable, partial.stable);
    });
    await t.test("大响应、声明超限和非HTML拒绝；单通道5秒包含跳转和body读取", async () => {
      for (const scenario of ["large", "declared-large", "non-html", "partial-status"]) {
        const { data } = await query(scenario); unavailable(data.stable); unavailable(data.prereleases);
      }
      const started = Date.now(), { data } = await query("timeout"), elapsed = Date.now() - started;
      unavailable(data.stable); assert.equal(data.prereleases.status, "fresh");
      assert.ok(elapsed >= 4500 && elapsed < 6500, `shared deadline took ${elapsed}ms`);
    });
    for (const call of calls) {
      assert.equal(call.headers.authorization, undefined); assert.equal(call.headers.cookie, undefined); assert.equal(call.headers.referer, undefined);
      assert.equal(call.headers.accept, "text/html"); assert.equal(call.headers["x-github-api-version"], undefined);
    }
    t.diagnostic("仅本机 HTTP fixtures 与 workerd；原生结构来自公开 GitHub 快照，未请求 GitHub REST API、线上实例或 Cloudflare 控制面。");
  } finally {
    await runtime?.dispose();
    for (const server of [source, sink]) server.closeAllConnections();
    await Promise.all([source, sink].map(server => new Promise(resolve => server.close(resolve))));
  }
});

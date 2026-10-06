import assert from "node:assert/strict";
import test from "node:test";
import { createReleaseUpdatesReader } from "../../apps/worker/src/services/release-updates.ts";

const release = (version, prerelease = false) => ({ tag_name: version, prerelease, draft: false, published_at: "2026-10-01T00:00:00Z", html_url: `https://github.com/breakstring/cfKanban/releases/tag/${version}` });
const json = body => new Response(JSON.stringify(body), { status: 200 });
test("stable与最近预发行独立发现，限定可信链接并按SemVer排序，不向GitHub发送身份", async () => {
  const calls = [];
  const read = createReleaseUpdatesReader(async (url, init) => {
    calls.push({ url, init });
    return json(url.endsWith("/latest") ? release("2.0.0") : [release("2.1.0-rc.2", true), release("2.1.0-rc.10", true), release("2.0.0"), { ...release("3.0.0-rc.1", true), draft: true }]);
  }, () => 1_000_000);
  const result = await read();
  assert.equal(result.stable.releases[0].version, "2.0.0");
  assert.deepEqual(result.prereleases.releases.map(item => item.version), ["2.1.0-rc.10", "2.1.0-rc.2"]);
  assert.equal(result.prerelease_window, 20);
  for (const { url, init } of calls) {
    assert.ok(url.startsWith("https://api.github.com/repos/breakstring/cfKanban/releases"));
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), null);
    assert.ok(init.signal instanceof AbortSignal);
  }
  result.stable.releases.length = 0;
  assert.equal((await read()).stable.releases.length, 1, "调用方不能污染共享缓存");
  assert.equal(calls.length, 2);
});
test("并发冷读合并、TTL缓存、过期失败保留旧信息与时间并限流退避", async () => {
  let now = 1_000_000, count = 0, failing = false;
  const read = createReleaseUpdatesReader(async url => { count++; return failing ? new Response(null, { status: 429 }) : json(url.endsWith("/latest") ? release("2.0.0") : []); }, () => now);
  const results = await Promise.all([read(), read(), read()]);
  assert.equal(count, 2); assert.equal(results[0].stable.status, "fresh");
  const checked = results[0].stable.checked_at;
  now += 15 * 60_000 + 1; failing = true;
  const stale = await read();
  assert.equal(stale.stable.status, "stale"); assert.equal(stale.stable.error, "rate_limited");
  assert.equal(stale.stable.checked_at, checked); assert.equal(stale.stable.releases.length, 1);
  await read(); assert.equal(count, 4);
  now += 60_001; await read(); assert.equal(count, 6);
});
test("首次失败、稳定版不存在及独立通道失败不会冒充最新发行", async () => {
  const unavailable = await createReleaseUpdatesReader(async () => { throw new Error("network"); })();
  assert.equal(unavailable.stable.status, "unavailable"); assert.equal(unavailable.stable.checked_at, null);
  const partial = await createReleaseUpdatesReader(async url => url.endsWith("/latest") ? new Response(null, { status: 404 }) : new Response(null, { status: 503 }))();
  assert.equal(partial.stable.status, "fresh"); assert.deepEqual(partial.stable.releases, []);
  assert.equal(partial.prereleases.status, "unavailable");
});
test("一个通道失败仅重试该通道，成功通道的15分钟TTL与显示时间一致", async () => {
  let now = 1_000_000, stableCalls = 0, prereleaseCalls = 0;
  const read = createReleaseUpdatesReader(async url => {
    if (url.endsWith("/latest")) { stableCalls++; return json(release("2.0.0")); }
    prereleaseCalls++; return new Response(null, { status: 429 });
  }, () => now);
  const first = await read();
  now += 60_001;
  const second = await read();
  assert.equal(stableCalls, 1); assert.equal(prereleaseCalls, 2);
  assert.deepEqual(second.stable, first.stable);
  assert.equal(second.prereleases.last_attempt_at, new Date(now).toISOString());
});
test("异常版本、伪造链接、过大响应拒绝；最多5份预发行", async () => {
  for (const invalid of [{ ...release("2.0.0"), html_url: "https://attacker.test" }, release("v2.0.0"), release("2.0.0-rc.01", true)]) {
    const result = await createReleaseUpdatesReader(async url => json(url.endsWith("/latest") ? invalid : []))();
    assert.equal(result.stable.status, "unavailable");
  }
  const large = await createReleaseUpdatesReader(async () => new Response("x".repeat(512 * 1024 + 1)))();
  assert.equal(large.stable.status, "unavailable");
  const limited = await createReleaseUpdatesReader(async url => json(url.endsWith("/latest") ? release("2.0.0") : Array.from({ length: 12 }, (_, i) => release(`3.0.0-rc.${i}`, true))))();
  assert.equal(limited.prereleases.releases.length, 5);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createReleaseUpdatesReader } from "../../apps/worker/src/services/release-updates.ts";
import { beforeDeadline, MAX_RELEASE_PAGE_BYTES, readReleaseHtml, releaseTimestamp, RELEASES_URL, trustedReleaseLink } from "../../apps/worker/src/services/release-page.ts";

test("只接受官方仓库准确严格SemVer tag URL，拒绝外站、伪路径、凭据与浮动入口", () => {
  for (const version of ["2.0.0", "2.1.0-rc.10", "2.0.0-preview"]) {
    for (const link of [`${RELEASES_URL}/tag/${version}`, `/breakstring/cfKanban/releases/tag/${version}`]) {
      assert.deepEqual(trustedReleaseLink(link), { version, url: `${RELEASES_URL}/tag/${version}` });
    }
  }
  for (const link of [
    "https://attacker.test/breakstring/cfKanban/releases/tag/2.0.0", "http://github.com/breakstring/cfKanban/releases/tag/2.0.0",
    "https://github.com.evil.test/breakstring/cfKanban/releases/tag/2.0.0", "https://user:password@github.com/breakstring/cfKanban/releases/tag/2.0.0",
    "https://github.com/breakstring/other/releases/tag/2.0.0", "https://github.com/other/cfKanban/releases/tag/2.0.0",
    `${RELEASES_URL}/tag/2.0.0?next=https://attacker.test`, `${RELEASES_URL}/tag/2.0.0#fragment`, `${RELEASES_URL}/tag/2.0.0/extra`,
    `${RELEASES_URL}/tag/%32.0.0`, `${RELEASES_URL}/tag/v2.0.0`, `${RELEASES_URL}/tag/nightly`, `${RELEASES_URL}/tag/2.0.0+build`,
    `${RELEASES_URL}/tag/2.0.0-rc.01`, `${RELEASES_URL}/latest`, "//github.com/breakstring/cfKanban/releases/tag/2.0.0",
    "https://github.com/other/../breakstring/cfKanban/releases/tag/2.0.0",
  ]) assert.throws(() => trustedReleaseLink(link), undefined, link);
});

test("发行时间必须是有效UTC日历时间，HTML读取按实际字节有界且不接受非HTML", async () => {
  for (const value of ["2026-10-06T00:00:00Z", "2026-10-06T00:00:00.123Z"]) assert.equal(releaseTimestamp(value), value);
  for (const value of ["2026-02-30T00:00:00Z", "yesterday", "2026-10-06", "2026-10-06T00:00:00+01:00"]) assert.throws(() => releaseTimestamp(value));
  const html = body => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  assert.equal(await readReleaseHtml(html("<h1>public</h1>"), AbortSignal.timeout(1000)), "<h1>public</h1>");
  await assert.rejects(readReleaseHtml(new Response("{}", { headers: { "content-type": "application/json" } }), AbortSignal.timeout(1000)));
  await assert.rejects(readReleaseHtml(html("x".repeat(MAX_RELEASE_PAGE_BYTES + 1)), AbortSignal.timeout(1000)), /too_large/);
  await assert.rejects(readReleaseHtml(new Response("small", { headers: { "content-type": "text/html", "content-length": String(MAX_RELEASE_PAGE_BYTES + 1) } }), AbortSignal.timeout(1000)), /invalid_release_page/);
  await assert.rejects(readReleaseHtml(html(new Uint8Array([0xff, 0xfe])), AbortSignal.timeout(1000)));
});

test("总deadline也限制不响应AbortSignal的上游及迟迟不结束的body", async () => {
  const deadline = () => { const controller = new AbortController(); setTimeout(() => controller.abort(), 15); return controller.signal; };
  await assert.rejects(beforeDeadline(new Promise(() => {}), deadline()), /timeout/);
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/html" } });
  await assert.rejects(readReleaseHtml(response, deadline()), /timeout/);
  assert.equal(cancelled, true);
});

test("冷读合并且首次失败明确未知，至少60秒退避并不转发身份", async () => {
  let now = 1_000_000;
  const calls = [];
  const read = createReleaseUpdatesReader(async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status: url.endsWith("/latest") ? 429 : 503 });
  }, () => now);
  const results = await Promise.all([read(), read(), read()]);
  assert.equal(calls.length, 2);
  assert.equal(results[0].stable.status, "unavailable"); assert.equal(results[0].stable.error, "rate_limited");
  assert.equal(results[0].prereleases.error, "query_failed");
  for (const channel of [results[0].stable, results[0].prereleases]) {
    assert.equal(channel.checked_at, null); assert.deepEqual(channel.releases, []);
    assert.equal(channel.retry_at, new Date(now + 60_000).toISOString());
  }
  await read(); assert.equal(calls.length, 2);
  now += 60_000; await read(); assert.equal(calls.length, 4);
  for (const { url, init } of calls) {
    assert.ok(url === RELEASES_URL || url === `${RELEASES_URL}/latest`);
    assert.equal(init.redirect, "manual"); assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual([...new Headers(init.headers)], [["accept", "text/html"], ["user-agent", "cfKanban-release-discovery"]]);
  }
});

test("固定latest404为空stable，失败通道单独重试且成功通道保留15分钟TTL", async () => {
  let now = 1_000_000, stableCalls = 0, prereleaseCalls = 0;
  const read = createReleaseUpdatesReader(async url => {
    if (url.endsWith("/latest")) { stableCalls++; return new Response(null, { status: 404 }); }
    prereleaseCalls++; return new Response(null, { status: 403 });
  }, () => now);
  const first = await read();
  assert.equal(first.stable.status, "fresh"); assert.deepEqual(first.stable.releases, []);
  assert.equal(first.prereleases.error, "rate_limited");
  now += 60_001; const second = await read();
  assert.equal(stableCalls, 1); assert.equal(prereleaseCalls, 2); assert.deepEqual(second.stable, first.stable);
  now += 15 * 60_000; await read(); assert.equal(stableCalls, 2);
});

test("恶意重定向与列表重定向立即拒绝，不请求目标", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = [];
    const result = await createReleaseUpdatesReader(async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status, headers: { location: "https://attacker.test/release" } });
    }, () => 1_000_000)();
    assert.equal(calls.length, 2);
    for (const channel of [result.stable, result.prereleases]) {
      assert.equal(channel.status, "unavailable"); assert.equal(channel.error, "query_failed"); assert.deepEqual(channel.releases, []);
    }
  }
});

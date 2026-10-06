import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const release = (version, prerelease = false) => ({ tag_name: version, prerelease, draft: false, published_at: "2026-10-01T00:00:00Z", html_url: `https://github.com/breakstring/cfKanban/releases/tag/${version}` });
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

test("发行查询请求选项在真实workerd中兼容且拒绝跟随重定向", async () => {
  let redirectedRequests = 0;
  const calls = [];
  const sink = createServer((_request, response) => { redirectedRequests++; response.end("unexpected redirect"); });
  const source = createServer((request, response) => {
    calls.push({ url: request.url, headers: request.headers });
    if (request.url.startsWith("/redirect/")) {
      response.writeHead(302, { location: `http://127.0.0.1:${sink.address().port}/sink` });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url.endsWith("/latest") ? release("2.0.0") : [release("2.1.0-rc.1", true)]));
    }
  });
  let runtime;
  try {
    await listen(sink); await listen(source);
    const output = await build({
      stdin: {
        resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
        contents: `
          import { createReleaseUpdatesReader } from './apps/worker/src/services/release-updates.ts';
          export default { async fetch(request) {
            const scenario = new URL(request.url).pathname;
            const read = createReleaseUpdatesReader((url, options) => {
              const upstream = new URL(url);
              return fetch('http://127.0.0.1:${source.address().port}' + scenario + upstream.pathname + upstream.search, options);
            }, () => 1000000);
            return Response.json(await read());
          }};
        `,
      },
      bundle: true, format: "esm", platform: "browser", write: false,
    });
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: "2026-08-29", script: output.outputFiles[0].text }));
    const success = await (await runtime.dispatchFetch("http://localhost/success")).json();
    assert.equal(success.stable.status, "fresh");
    assert.equal(success.prereleases.status, "fresh");
    assert.equal(success.stable.releases[0].version, "2.0.0");
    assert.equal(success.prereleases.releases[0].version, "2.1.0-rc.1");
    const redirected = await (await runtime.dispatchFetch("http://localhost/redirect")).json();
    for (const channel of [redirected.stable, redirected.prereleases]) {
      assert.equal(channel.status, "unavailable");
      assert.equal(channel.error, "query_failed");
      assert.equal(channel.checked_at, null);
      assert.deepEqual(channel.releases, []);
    }
    assert.equal(calls.length, 4);
    assert.equal(redirectedRequests, 0);
    for (const call of calls) {
      assert.equal(call.headers.accept, "application/vnd.github+json");
      assert.equal(call.headers["user-agent"], "cfKanban-release-discovery");
      assert.equal(call.headers["x-github-api-version"], "2022-11-28");
      assert.equal(call.headers.authorization, undefined);
      assert.equal(call.headers.cookie, undefined);
    }
  } finally {
    await runtime?.dispose();
    await Promise.all([source, sink].map(server => new Promise(resolve => server.close(resolve))));
  }
});

import { createServer } from "node:http";
import { resolveSystemBrowserOpener } from "./capability-delivery.mjs";
import { safeBrowserFailureCode, toolError } from "./errors.mjs";

export async function preflightBrowser({ delivery = "host_browser", onRelayReady, browserOpener, timeoutMs = 60_000 } = {}) {
  if (!["host_browser", "system_browser"].includes(delivery)) {
    throw toolError("INVALID_DELIVERY", "Browser preflight supports host_browser or system_browser");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw toolError("INVALID_PROBE_TIMEOUT", "Browser preflight timeout must be between 1 and 60000 milliseconds");
  }
  if (delivery === "host_browser" && typeof onRelayReady !== "function") {
    throw toolError("BROWSER_DELIVERY_UNAVAILABLE", "Browser preflight requires an event consumer");
  }
  const opener = delivery === "system_browser" ? browserOpener ?? await resolveSystemBrowserOpener() : null;
  let finish;
  const reached = new Promise((resolve) => { finish = resolve; });
  let rejectedCrossSite = false;
  const server = createServer((request, response) => {
    const crossSite = request.headers["sec-fetch-site"] === "cross-site";
    const valid = request.method === "GET" && request.url === "/probe"
      && request.headers.host === `127.0.0.1:${server.address()?.port}`
      && !request.headers.origin && !crossSite;
    rejectedCrossSite ||= crossSite;
    response.writeHead(valid ? 200 : 404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(valid ? "cfKanban browser preflight OK / 本机连通性检查成功" : "Not found", () => {
      if (valid) finish({ reachable: true });
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(toolError("BROWSER_RELAY_FAILED", "Browser preflight could not bind to loopback")));
    server.listen(0, "127.0.0.1", resolve);
  });
  let timer;
  try {
    const localUrl = `http://127.0.0.1:${server.address().port}/probe`;
    const outcome = await Promise.race([
      Promise.resolve().then(() => delivery === "system_browser" ? opener.open(localUrl) : onRelayReady({
        event: "browser_probe_ready", channel: delivery, local_url: localUrl,
        expires_in_seconds: Math.ceil(timeoutMs / 1000), classification: "non_sensitive_connectivity_probe",
      })).then(() => reached),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ reachable: false, cause_code: "BROWSER_OPEN_TIMEOUT" }), timeoutMs); }),
    ]).catch((error) => ({ reachable: false, cause_code: safeBrowserFailureCode(error) }));
    return { ...outcome, channel: delivery, rejected_cross_site: rejectedCrossSite, remote_writes: false,
      browser_identity_verified: false, recovery: outcome.reachable ? "verify_requested_browser_and_visible_probe" : "diagnose_delivery_before_creating_launch" };
  } finally {
    clearTimeout(timer);
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}

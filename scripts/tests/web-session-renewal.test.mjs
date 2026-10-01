import assert from "node:assert/strict";
import test, { after } from "node:test";
import { build } from "esbuild";
import "vue";

const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
const events = new EventTarget();
globalThis.window = { navigator: { languages: ["en"] }, addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) };
globalThis.document = { cookie: "cfkanban_csrf=session-renewal-test", documentElement: {} };
const output = await build({ stdin: { contents: `export * from './apps/web/src/lib/session-renewal.ts'; export { apiRequest, hasUncertainWrite } from './apps/web/src/lib/api.ts';`, resolveDir: new URL("../../", import.meta.url).pathname }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [{ name: "external-vue", setup(builder) { builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL("../../node_modules/vue/index.mjs", import.meta.url).href, external: true })); } }] });
const { SessionRenewalController, hasSessionRenewal, isSessionRenewalResult, mergeSessionFacts, apiRequest, hasUncertainWrite } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
after(() => Object.assign(globalThis, saved));
const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-10-01T00:00:00.000Z");
const iso = value => new Date(value).toISOString();
const facts = (overrides = {}) => ({ session_id: "session-a", version: 1, expires_at: iso(START + 8 * HOUR), renewal: { renew_after: iso(START + HOUR / 2), absolute_expires_at: iso(START + 7 * 24 * HOUR) }, principal: { id: "principal-a", display_name: "Pat", version: 1 }, source: { kind: "credential", id: "source" }, allowed_scope: { kind: "project_selection", projects: [] }, target: { kind: "project_selection" }, ...overrides });
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function clock() {
  let now = START, next = 0;
  const jobs = new Map();
  return { now: () => now, set: (callback, delay) => { const id = ++next; jobs.set(id, { callback, at: now + delay }); return id; }, clear: id => jobs.delete(id),
    advance: async value => { now += value; const ready = [...jobs.entries()].filter(([, job]) => job.at <= now); for (const [id, job] of ready) { jobs.delete(id); job.callback(); } await flush(); }, jobs };
}
function harness(overrides = {}) {
  const timer = clock(), calls = [], accepted = [];
  let server = facts(), active = server, visible = true, expired = 0, notified = 0;
  const controller = new SessionRenewalController({ now: timer.now, set: timer.set, clear: timer.clear, visible: () => visible,
    read: async signal => { calls.push({ kind: "GET", signal }); return server; },
    renew: async (version, sessionId, signal) => { calls.push({ kind: "POST", version, sessionId, signal }); server = { ...server, version: version + 1, expires_at: iso(Math.min(timer.now() + 8 * HOUR, Date.parse(server.renewal.absolute_expires_at))), renewal: { ...server.renewal, renew_after: iso(timer.now() + HOUR / 2) } }; },
    accept: value => { accepted.push(value); active = value; controller.setSession(value); },
    expire: () => { expired++; active = null; controller.setSession(null); }, accessFailure: error => error.auth === true, versionConflict: error => error.conflict === true, notify: () => notified++, ...overrides });
  controller.setSession(server);
  return { timer, controller, calls, accepted, get active() { return active; }, get expired() { return expired; }, get notified() { return notified; }, set visible(value) { visible = value; }, set server(value) { server = value; }, close: () => controller.setSession(null) };
}

test("default browser timers retain their global receiver during renewal, hints and cancellation", async () => {
  const timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timer = clock(), calls = [];
  let controller, server = facts(), pendingRead;
  globalThis.setTimeout = function(callback, delay) {
    assert.ok(this === globalThis, "native browser timers require the global receiver");
    return timer.set(callback, delay);
  };
  globalThis.clearTimeout = function(handle) {
    assert.ok(this === globalThis, "native browser timer cleanup requires the global receiver");
    timer.clear(handle);
  };
  try {
    controller = new SessionRenewalController({ now: timer.now, visible: () => true,
      read: async signal => { calls.push({ kind: "GET", signal }); return pendingRead ? new Promise(() => {}) : server; },
      renew: async () => { calls.push({ kind: "POST" }); server = facts({ version: 2, expires_at: iso(timer.now() + 8 * HOUR), renewal: { ...server.renewal, renew_after: iso(timer.now() + HOUR / 2) } }); },
      accept: value => controller.setSession(value), expire: () => assert.fail("the active session must not expire"),
      accessFailure: () => false, versionConflict: () => false });
    controller.setSession(server);
    await timer.advance(HOUR);
    controller.activity({ type: "keydown", isTrusted: true }); await flush();
    assert.deepEqual(calls.map(call => call.kind), ["POST", "GET"]);
    assert.equal(timer.jobs.size, 1, "successful renewal clears its request timeout and replaces the deadline timer");
    controller.hint(); await flush(); controller.hint();
    await timer.advance(30_000);
    assert.equal(calls.filter(call => call.kind === "GET").length, 3);
    pendingRead = true;
    const canceled = controller.revalidate();
    controller.setSession(null); await canceled;
    assert.equal(calls.at(-1).signal.aborted, true);
    assert.equal(timer.jobs.size, 0, "logout cancels the request and deadline timers");
    controller.setSession(server);
    const timedOut = controller.revalidate();
    await timer.advance(5_000); await timedOut;
    assert.equal(calls.at(-1).signal.aborted, true);
  } finally {
    controller?.setSession(null);
    Object.assign(globalThis, timers);
  }
});

for (const kind of ["credential", "web_authenticator"]) test(`${kind}: only trusted visible interaction renews after the server throttle`, async () => {
  const value = harness(); value.server = facts({ source: { kind, id: "source" } });
  value.controller.setSession(facts({ source: { kind, id: "source" } }));
  try {
    value.controller.activity({ type: "keydown", isTrusted: true });
    await value.timer.advance(HOUR / 2);
    assert.equal(value.calls.length, 0, "an earlier interaction cannot renew an idle page later");
    for (const type of ["focus", "visibilitychange", "pageshow"]) value.controller.activity({ type, isTrusted: true });
    value.controller.activity({ type: "input", isTrusted: false });
    value.visible = false; value.controller.activity({ type: "keydown", isTrusted: true });
    await flush(); assert.equal(value.calls.length, 0);
    value.visible = true; value.controller.activity({ type: "input", isTrusted: true });
    value.controller.activity({ type: "wheel", isTrusted: true });
    await flush(); assert.deepEqual(value.calls.map(call => call.kind), ["POST", "GET"]);
    assert.equal(value.active.version, 2); assert.equal(value.active.expires_at, iso(START + 8.5 * HOUR));
    assert.equal(value.notified, 1);
    value.controller.activity({ type: "keydown", isTrusted: true }); await flush();
    assert.equal(value.calls.length, 2, "continuous editing is bounded by server renew_after");
  } finally { value.close(); }
});

test("legacy metadata and the absolute cap do not initiate renewal", async () => {
  const value = harness();
  try {
    const legacy = facts(); delete legacy.version; delete legacy.renewal;
    assert.equal(hasSessionRenewal(legacy), false); value.controller.setSession(legacy);
    await value.timer.advance(HOUR); value.controller.activity({ type: "keydown", isTrusted: true });
    const capped = facts({ expires_at: iso(START + 8 * HOUR), renewal: { renew_after: iso(START), absolute_expires_at: iso(START + 8 * HOUR) } });
    value.controller.setSession(capped); value.controller.activity({ type: "keydown", isTrusted: true }); await flush();
    assert.equal(value.calls.length, 0);
  } finally { value.close(); }
});

test("a renewal approaching the absolute limit adopts only the capped server GET deadline", async () => {
  const value = harness();
  try {
    const absolute = START + 9 * HOUR;
    const capped = facts({ renewal: { renew_after: iso(START + HOUR / 2), absolute_expires_at: iso(absolute) } });
    value.server = capped; value.controller.setSession(capped);
    await value.timer.advance(2 * HOUR); value.controller.activity({ type: "keydown", isTrusted: true }); await flush();
    assert.equal(value.active.expires_at, iso(absolute));
    await value.timer.advance(HOUR / 2); value.controller.activity({ type: "keydown", isTrusted: true }); await flush();
    assert.equal(value.calls.filter(call => call.kind === "POST").length, 1);
  } finally { value.close(); }
});

test("deadline checks remain read-only and a hung offline read is bounded before expiry cleanup", async () => {
  let reads = 0;
  const value = harness({ read: async () => { reads++; return new Promise(() => {}); } });
  try {
    await value.timer.advance(8 * HOUR);
    const expired = value.controller.deadline();
    assert.equal(reads, 1, "pre-deadline and deadline share the same in-flight read");
    await value.timer.advance(5_000); await expired;
    assert.equal(value.expired, 1); assert.equal(value.calls.length, 0);
  } finally { value.close(); }
});

test("tab hints read facts only and revoke the old deadline check", async () => {
  const value = harness();
  try {
    const old = [...value.timer.jobs.keys()];
    value.server = facts({ version: 2, expires_at: iso(START + 12 * HOUR), renewal: { renew_after: iso(START + HOUR), absolute_expires_at: iso(START + 7 * 24 * HOUR) } });
    value.controller.hint(); value.controller.hint(); await flush();
    assert.deepEqual(value.calls.map(call => call.kind), ["GET"]);
    assert.equal(value.active.expires_at, iso(START + 12 * HOUR));
    assert.ok(old.every(id => !value.timer.jobs.has(id)));
    await value.timer.advance(8 * HOUR); await value.controller.deadline();
    assert.equal(value.expired, 0, "the original cutoff does not clear a verified extended session");
    assert.ok(value.calls.every(call => call.kind === "GET"));
  } finally { value.close(); }
});

test("tab hints inside the read throttle coalesce into a later read instead of losing logout notice", async () => {
  const value = harness();
  try {
    value.controller.hint(); await flush();
    value.controller.hint(); value.controller.hint(); await flush();
    assert.equal(value.calls.length, 1);
    await value.timer.advance(30_000); assert.equal(value.calls.length, 2);
    assert.ok(value.calls.every(call => call.kind === "GET"));
  } finally { value.close(); }
});

test("deadline validation joins one pending renewal, then accepts independent GET facts", async () => {
  let release;
  const value = harness({ renew: () => new Promise(resolve => { release = resolve; }) });
  try {
    await value.timer.advance(HOUR); value.controller.activity({ type: "keydown", isTrusted: true });
    value.server = facts({ version: 2, expires_at: iso(START + 12 * HOUR) });
    const check = value.controller.deadline(); release(); await check; await flush();
    assert.equal(value.expired, 0); assert.equal(value.active.version, 2);
    assert.equal(value.calls.filter(call => call.kind === "GET").length, 1);
  } finally { value.close(); }
});

test("logout and identity switches discard delayed renewal GET and auth errors", async () => {
  for (const replaced of [null, facts({ session_id: "session-b", principal: { id: "principal-b" } })]) {
    let release;
    const value = harness({ read: () => new Promise(resolve => { release = resolve; }) });
    await value.timer.advance(HOUR); value.controller.activity({ type: "keydown", isTrusted: true }); await flush();
    value.controller.setSession(replaced); release(facts({ version: 99 })); await flush();
    assert.equal(value.accepted.length, 0); assert.equal(value.expired, 0); value.close();
  }
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  let current = true, invalid = 0;
  const listener = () => invalid++; events.addEventListener("cfkanban:session-invalid", listener);
  const request = apiRequest("/api/v1/web-session", { authorizationCurrent: () => current });
  current = false;
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  release(Response.json({ source: "service", category: "authentication", code: "UNAUTHORIZED", details: {}, message: "Ended", recovery: "reauthenticate", request_id: id, retryable: false }, { status: 401, headers: { "x-request-id": id } }));
  await assert.rejects(request); assert.equal(invalid, 0); events.removeEventListener("cfkanban:session-invalid", listener);
});

test("CAS conflicts refresh once and stale replay facts never lower version or expiry", async () => {
  const value = harness({ renew: async () => { throw { conflict: true }; } });
  try {
    value.server = facts({ version: 4, expires_at: iso(START + 10 * HOUR) });
    await value.timer.advance(HOUR); value.controller.activity({ type: "keydown", isTrusted: true }); await flush();
    assert.equal(value.active.version, 4); assert.equal(value.calls.length, 1);
    assert.equal(mergeSessionFacts(value.active, facts()).version, 4);
    assert.equal(mergeSessionFacts(value.active, facts()).expires_at, value.active.expires_at);
  } finally { value.close(); }
});

test("offline renewal leaves the last verified deadline and retries only the original request on later activity", async () => {
  const versions = [];
  const value = harness({ renew: async version => { versions.push(version); throw new Error("offline"); } });
  try {
    await value.timer.advance(HOUR); value.controller.activity({ type: "keydown", isTrusted: true }); await flush();
    assert.equal(value.active.version, 1); assert.equal(value.expired, 0);
    value.controller.activity({ type: "keydown", isTrusted: true }); await flush(); assert.deepEqual(versions, [1]);
    await value.timer.advance(30_000); value.controller.activity({ type: "keydown", isTrusted: true }); await flush();
    assert.deepEqual(versions, [1, 1]); assert.equal(value.calls.length, 0);
  } finally { value.close(); }
});

test("renewal uses fresh CSRF and keeps one idempotency key across malformed responses", async () => {
  const headers = [];
  globalThis.fetch = async (_path, init) => { headers.push(init.headers); return Response.json({ malformed: true }); };
  const path = "/api/v1/web-session/renew";
  const options = { method: "POST", body: { expected_version: 11 }, validateResponse: value => isSessionRenewalResult(value, "session-a") };
  await assert.rejects(apiRequest(path, options));
  assert.equal(hasUncertainWrite(path), true);
  document.cookie = "cfkanban_csrf=updated-test";
  await assert.rejects(apiRequest(path, options));
  assert.equal(headers[0].get("idempotency-key"), headers[1].get("idempotency-key"));
  assert.equal(headers[1].get("x-csrf-token"), "updated-test");
  assert.equal(isSessionRenewalResult({ event_cursor: "event", idempotent_replay: false, resource: { session_id: "session-a", version: 12, renewed: true, expires_at: iso(START + 8 * HOUR), renew_after: iso(START + HOUR / 2), absolute_expires_at: iso(START + 7 * 24 * HOUR) } }, "session-a"), true);
});

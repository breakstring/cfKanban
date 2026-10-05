import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { IssueMentions, MENTIONS_TOOL } from "../src/mentions.mjs";

function fixture(admission = {}) {
  const ids = { instance: randomUUID(), principal: randomUUID(), project: randomUUID(), workspace: randomUUID(), issue: randomUUID() };
  const origin = "https://mentions.fixture.invalid";
  let currentPrincipal = ids.principal;
  let candidates = [{ instance_id: ids.instance, trusted_api_origin: origin }];
  let handler;
  let data = { id: ids.issue, identifier: "CFK-601", title: "Mention 中文", project: { id: ids.project, display_name: "Project" }, workspace: { id: ids.workspace, display_name: "Workspace" }, body: "Current body", body_truncated: false, body_bytes: 12, version: 1, updated_at: "2026-10-05T01:00:00.000Z", status: { key: "todo", display_name: "Todo" }, priority: "none", comments: ["must not leak"], hidden_field: "PRIVATE_MARKER" };
  const calls = [];
  const createFacade = (config = {}) => ({
    callTool: async (name, args, { signal } = {}) => {
      calls.push({ name, args, signal });
      assert.equal(name, "cfkanban_connection_inspect"); assert.deepEqual(args, {});
      return { ok: true, data: { candidates } };
    },
    readIssueReference: async (args, { signal } = {}) => {
      calls.push({ name: "reference", args, signal, binding: config.binding });
      if (handler) return handler(args, signal);
      if (config.binding && config.binding.expected_principal_id !== currentPrincipal) return { ok: false, status: 0, error: { code: "MCP_PRINCIPAL_BINDING_MISMATCH" } };
      return { ok: true, status: 200, data: structuredClone(data), reference_identity: { instance_id: ids.instance, principal_id: currentPrincipal, trusted_api_origin: origin } };
    },
  });
  const mentions = new IssueMentions({ facade: createFacade(), createFacade, admission });
  return { ids, origin, calls, mentions, createFacade, candidates: value => { candidates = value; }, principal: value => { currentPrincipal = value; }, handler: value => { handler = value; }, data: value => { data = { ...data, ...value }; } };
}
const link = result => result.structuredContent.items[0].uri;

test("mentions metadata follows the strict app-only official query schema", () => {
  assert.deepEqual(MENTIONS_TOOL._meta, { "openai/extensions": { "mentions/search": {} }, ui: { visibility: ["app"] } });
  assert.deepEqual(Object.keys(MENTIONS_TOOL.inputSchema.properties), ["query"]);
  assert.equal(MENTIONS_TOOL.annotations.readOnlyHint, true);
});

test("empty, prefix, invalid and malformed links make no remote or local connection reads", async t => {
  const f = fixture(); t.after(() => f.mentions.dispose());
  for (const query of ["", " ", "CFK-", "CFK-0", "CFK-01", "CFK-9007199254740992", "Title search", "CFK-601 extra", "http://unknown/app/issues/CFK-601", "https://unknown/app/issues/CFK-601?secret=value", "https://user:password@unknown/app/issues/CFK-601", "https://unknown/app/issues/CFK-601#fragment"]) {
    assert.deepEqual((await f.mentions.search({ query })).structuredContent, { items: [] });
  }
  assert.equal((await f.mentions.search({ query: "CFK-601", instance_id: f.ids.instance })).isError, true);
  assert.equal((await f.mentions.search({ query: "a".repeat(4097) })).isError, true);
  assert.equal(f.calls.length, 0);
});

test("instance ambiguity and untrusted links never fan out; trusted canonical links select exactly one instance", async t => {
  const f = fixture(); t.after(() => f.mentions.dispose());
  f.candidates([{ instance_id: f.ids.instance, trusted_api_origin: f.origin }, { instance_id: randomUUID(), trusted_api_origin: "https://another.fixture.invalid" }]);
  assert.equal((await f.mentions.search({ query: "CFK-601" })).structuredContent.error.code, "MCP_MENTION_SCOPE_REQUIRED");
  assert.equal((await f.mentions.search({ query: "https://arbitrary.invalid/app/issues/CFK-601" })).structuredContent.error.code, "MCP_MENTION_UNTRUSTED_ORIGIN");
  assert.equal(f.calls.some(call => call.name === "reference"), false);
  const result = await f.mentions.search({ query: `${f.origin}/app/issues/CFK-601` });
  assert.equal(result.isError, false);
  assert.equal(f.calls.filter(call => call.name === "reference").length, 1);
  assert.equal(f.calls.at(-1).args.instance_id, f.ids.instance);
  assert.equal(f.calls.at(-1).args.projection, "mention");
  assert.equal(result.structuredContent.items.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /Current body|PRIVATE_MARKER|must not leak/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
});

test("resources revalidate exact identity and target, omit history and fail after a restart or target drift", async t => {
  const f = fixture({ rate: 100 }); t.after(() => f.mentions.dispose());
  const uri = link(await f.mentions.search({ query: "CFK-601" }));
  const resource = await f.mentions.read(uri);
  const data = JSON.parse(resource.contents[0].text);
  assert.equal(data.body, "Current body"); assert.equal(data.content_trust, "untrusted");
  assert.doesNotMatch(JSON.stringify(resource), /PRIVATE_MARKER|must not leak/);
  assert.deepEqual(f.calls.at(-1).binding, { instance_id: f.ids.instance, expected_principal_id: f.ids.principal, project_ids: [f.ids.project] });
  f.principal(randomUUID());
  await assert.rejects(f.mentions.read(uri), { code: "MCP_PRINCIPAL_BINDING_MISMATCH" });
  f.principal(f.ids.principal); f.data({ id: randomUUID() });
  await assert.rejects(f.mentions.read(uri), { code: "MCP_PROJECT_BINDING_MISMATCH" });
  const fresh = new IssueMentions({ facade: f.createFacade(), createFacade: f.createFacade }); t.after(() => fresh.dispose());
  const count = f.calls.length;
  await assert.rejects(fresh.read(uri), { code: "MCP_MENTION_REFERENCE_UNKNOWN" });
  await assert.rejects(f.mentions.read("cfkanban://issue/arbitrary"), { code: "MCP_MENTION_REFERENCE_UNKNOWN" });
  assert.equal(f.calls.length, count);
});

test("resource payload has a hard byte cap including JSON escapes and marks additional body truncation", async t => {
  const f = fixture(); t.after(() => f.mentions.dispose());
  f.data({ body: "\u0000".repeat(8192), body_bytes: 65536, body_truncated: true });
  const uri = link(await f.mentions.search({ query: "CFK-601" }));
  const resource = await f.mentions.read(uri);
  assert.ok(Buffer.byteLength(JSON.stringify(resource)) <= 32768);
  const data = JSON.parse(resource.contents[0].text);
  assert.equal(data.body_truncated, true); assert.equal(data.body_bytes, 65536);
  assert.ok(Buffer.byteLength(data.body) < 8192);
});

test("no match differs from backend/permission failures and deadline aborts real I/O", async t => {
  const f = fixture({ rate: 100, timeoutMs: 30 }); t.after(() => f.mentions.dispose());
  f.handler(async () => ({ ok: false, status: 404, error: { code: "NOT_FOUND" } }));
  assert.deepEqual((await f.mentions.search({ query: "CFK-601" })).structuredContent, { items: [] });
  for (const [status, code] of [[503, "PLATFORM_UNAVAILABLE"], [403, "FORBIDDEN"]]) {
    f.handler(async () => ({ ok: false, status, error: { code } }));
    assert.equal((await f.mentions.search({ query: "CFK-601" })).structuredContent.error.code, code);
  }
  for (const code of ["X".repeat(60000), "\u0000bad", { secret: "must not leak" }]) {
    f.handler(async () => ({ ok: false, status: 403, error: { code } }));
    const result = await f.mentions.search({ query: "CFK-601" });
    assert.equal(result.structuredContent.error.code, "MCP_MENTION_READ_FAILED");
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  }
  let aborted = false;
  f.handler((args, signal) => new Promise((resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true })));
  assert.equal((await f.mentions.search({ query: "CFK-601" })).structuredContent.error.code, "MCP_MENTIONS_TIMEOUT");
  assert.equal(aborted, true);
});

test("bounded concurrency, frequency and queue keep each request's cancellation independent", async t => {
  const f = fixture({ concurrency: 2, queueLimit: 2, rate: 100, timeoutMs: 1000 }); t.after(() => f.mentions.dispose());
  const running = []; let active = 0, maximum = 0;
  f.handler((args, signal) => new Promise((resolve, reject) => {
    active++; maximum = Math.max(maximum, active);
    const finish = () => { active--; resolve({ ok: false, status: 404 }); };
    running.push(finish);
    signal.addEventListener("abort", () => { active--; reject(signal.reason); }, { once: true });
  }));
  const abort = new AbortController();
  const first = f.mentions.search({ query: "CFK-601" }, { signal: abort.signal });
  const second = f.mentions.search({ query: "CFK-601" });
  await new Promise(resolve => setImmediate(resolve));
  const third = f.mentions.search({ query: "CFK-601" });
  const queuedAbort = new AbortController();
  const fourth = f.mentions.search({ query: "CFK-601" }, { signal: queuedAbort.signal });
  assert.equal((await f.mentions.search({ query: "CFK-601" })).structuredContent.error.code, "MCP_MENTIONS_BUSY");
  queuedAbort.abort(); assert.equal((await fourth).structuredContent.error.code, "MCP_OPERATION_CANCELLED");
  abort.abort(); assert.equal((await first).structuredContent.error.code, "MCP_OPERATION_CANCELLED");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.name === "reference").length, 3);
  assert.equal(f.calls.filter(call => call.name === "reference")[1].signal.aborted, false);
  running[1](); running[2](); await Promise.all([second, third]);
  assert.equal(maximum, 2);
  const rate = fixture({ rate: 2, windowMs: 40, timeoutMs: 500 }); t.after(() => rate.mentions.dispose());
  const starts = [];
  rate.handler(async () => { starts.push(Date.now()); return { ok: false, status: 404 }; });
  await Promise.all([1, 2, 3, 4].map(() => rate.mentions.search({ query: "CFK-601" })));
  assert.ok(starts[2] - starts[0] >= 35);
});

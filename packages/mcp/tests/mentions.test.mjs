import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
    inspectSearchIdentity: async (args, { signal } = {}) => {
      calls.push({ name: "identity", args, signal });
      return { ok: true, data: { instance_id: ids.instance, principal_id: currentPrincipal, trusted_api_origin: origin, origin_version: 1 } };
    },
    readIssueReference: async (args, { signal } = {}) => {
      calls.push({ name: "reference", args, signal, binding: config.binding });
      if (handler) return handler(args, signal);
      if (config.binding && config.binding.expected_principal_id !== currentPrincipal) return { ok: false, status: 0, error: { code: "MCP_PRINCIPAL_BINDING_MISMATCH" } };
      return { ok: true, status: 200, data: structuredClone(data), reference_identity: { instance_id: ids.instance, principal_id: currentPrincipal, trusted_api_origin: origin } };
    },
  });
  const identity = () => ({ instance_id: ids.instance, principal_id: currentPrincipal, trusted_api_origin: origin, origin_version: 1 });
  const searchIndex = {
    search: async (args, { signal } = {}) => {
      calls.push({ name: "search", args, signal });
      if (handler) return handler(args, signal);
      return { ok: true, data: { items: [structuredClone(data)] }, reference_identity: identity() };
    },
    start: args => { calls.push({ name: "start", args }); }, hint: args => { calls.push({ name: "hint", args }); }, dispose: () => {},
  };
  const mentions = new IssueMentions({ facade: createFacade(), createFacade, searchIndex, admission: { startIntervalMs: 0, ...admission } });
  return { ids, origin, calls, mentions, createFacade, searchIndex, identity, issue: () => structuredClone(data), candidates: value => { candidates = value; }, principal: value => { currentPrincipal = value; }, handler: value => { handler = value; }, data: value => { data = { ...data, ...value }; } };
}
const link = result => result.structuredContent.items[0].uri;

// Codex 优先使用服务端 capability；只有工具 metadata 时会走带 path 的旧协议。
function composerProvider(capabilities, tools) {
  const capability = capabilities.extensions?.["openai/mentions"] ?? capabilities.experimental?.["openai/mentions"];
  if (capability) {
    assert.deepEqual(Object.keys(capability), ["searchTool"]);
    assert.equal(typeof capability.searchTool, "string");
    return { name: capability.searchTool, arguments: query => ({ query }) };
  }
  const legacy = tools.find(tool => tool._meta?.["openai/extensions"]?.["mentions/search"]);
  assert.ok(legacy);
  return { name: legacy.name, arguments: query => ({ query, path: [] }) };
}

test("mentions metadata follows the strict app-only official query schema", () => {
  assert.deepEqual(MENTIONS_TOOL._meta, { "openai/extensions": { "mentions/search": {} }, ui: { visibility: ["app"] } });
  assert.match(MENTIONS_TOOL.description, /CFK-60 or 60/);
  assert.deepEqual(Object.keys(MENTIONS_TOOL.inputSchema.properties), ["query"]);
  assert.equal(MENTIONS_TOOL.annotations.readOnlyHint, true);
});

test("Composer capability negotiation selects query-only search and reads the exact selected Issue", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cfkanban-mcp-mentions-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "server.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], outfile: entry, bundle: true, format: "esm", platform: "node", loader: { ".svg": "text" }, banner: { js: "import { createRequire } from 'node:module';const require = createRequire(import.meta.url);" } });
  const { createCfKanbanMcpServer } = await import(pathToFileURL(entry).href);
  const f = fixture();
  const localFacade = f.createFacade();
  const server = createCfKanbanMcpServer({
    facade: { ...localFacade, listTools: () => [], callTool: (name, args, options) => name.startsWith("cfkanban_issues_") || name === "cfkanban_comments_create" ? Promise.resolve({ ok: args.idempotency_key !== "refused", data: {} }) : localFacade.callTool(name, args, options) }, createFacade: f.createFacade, searchIndex: f.searchIndex,
    preferences: { load: async () => { throw new Error("Mentions must not read workbench preferences"); }, save: async () => { throw new Error("Mentions must not write workbench preferences"); } },
    uiHtml: "<!doctype html><title>Isolated mentions fixture</title>",
  });
  const client = new Client({ name: "isolated-composer-fixture", version: "1.0.0" }, { capabilities: {} });
  t.after(async () => { f.mentions.dispose(); await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  assert.equal(client.getServerVersion().title, "cfkanban-search");
  assert.equal(client.getServerVersion().name, "cfkanban-mcp");
  const tools = (await client.listTools()).tools;
  const provider = composerProvider(client.getServerCapabilities(), tools);
  const result = await client.callTool({ name: provider.name, arguments: provider.arguments("CFK-601") });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.items.length, 1);
  const selected = result.structuredContent.items[0];
  assert.equal(selected.type, "resource_link");
  assert.equal(selected.name, "CFK-601");
  assert.equal(selected.uri, `cfkanban://issue/${f.ids.instance}/${f.ids.principal}/${f.ids.project}/${f.ids.issue}/CFK-601`);
  const resource = await client.readResource({ uri: selected.uri });
  const context = JSON.parse(resource.contents[0].text);
  assert.equal(resource.contents[0].uri, selected.uri);
  assert.equal(context.id, f.ids.issue); assert.equal(context.identifier, "CFK-601");
  assert.equal(context.project.id, f.ids.project); assert.equal(context.instance_id, f.ids.instance);
  assert.equal(context.body, "Current body"); assert.equal(context.content_trust, "untrusted");
  assert.deepEqual(f.calls.filter(call => call.name === "reference").map(call => call.args.projection), ["resource"]);
  assert.deepEqual(f.calls.at(-1).binding, { instance_id: f.ids.instance, expected_principal_id: f.ids.principal, project_ids: [f.ids.project] });
  const legacy = composerProvider({ tools: {}, resources: {} }, tools);
  const count = f.calls.length;
  const rejected = await client.callTool({ name: legacy.name, arguments: legacy.arguments("CFK-601") });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, "MCP_INVALID_ARGUMENTS");
  assert.equal(f.calls.length, count);
  assert.deepEqual(f.calls.filter(call => call.name === "start").map(call => call.args), [{ instance_id: f.ids.instance }]);
  const target = { instance_id: f.ids.instance, identifier: "CFK-601", expected_version: 1, idempotency_key: "accepted" };
  await client.callTool({ name: "cfkanban_issues_create", arguments: { ...target, workspace_id: f.ids.workspace, project_id: f.ids.project, title: "New Issue" } });
  await client.callTool({ name: "cfkanban_issues_update", arguments: { ...target, changes: { title: "New title" } } });
  await client.callTool({ name: "cfkanban_issues_update", arguments: { ...target, changes: { body: "New body" } } });
  await client.callTool({ name: "cfkanban_comments_create", arguments: { ...target, body: "New Comment" } });
  await client.callTool({ name: "cfkanban_issues_update", arguments: { ...target, idempotency_key: "refused", changes: { title: "Refused title" } } });
  assert.deepEqual(f.calls.filter(call => call.name === "hint").map(call => call.args), [{ instance_id: f.ids.instance }, { instance_id: f.ids.instance }]);
});

test("short, invalid and malformed input makes no remote, local connection or cache reads", async t => {
  const f = fixture(); t.after(() => f.mentions.dispose());
  for (const query of ["", " ", "a", "搜", "6", "CFK-", "CFK-0", "CFK-01", "CFK-9007199254740992", "CFK-601 extra", "http://unknown/app/issues/CFK-601", "https://unknown/app/issues/CFK-601?secret=value", "https://user:password@unknown/app/issues/CFK-601", "https://unknown/app/issues/CFK-601#fragment", "https://"]) {
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
  assert.equal(f.calls.some(call => call.name === "search"), false);
  const result = await f.mentions.search({ query: `${f.origin}/app/issues/CFK-601` });
  assert.equal(result.isError, false);
  assert.equal(f.calls.filter(call => call.name === "search").length, 1);
  assert.equal(f.calls.at(-1).args.instance_id, f.ids.instance);
  assert.deepEqual(f.calls.at(-1).args.query, { kind: "identifier", identifier: "CFK-601", exactOnly: true });
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
  const fresh = new IssueMentions({ facade: f.createFacade(), createFacade: f.createFacade, searchIndex: f.searchIndex }); t.after(() => fresh.dispose());
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

test("no match differs from cache failures and deadline aborts local I/O", async t => {
  const f = fixture({ rate: 100, timeoutMs: 30 }); t.after(() => f.mentions.dispose());
  f.handler(async () => ({ ok: true, data: { items: [] }, reference_identity: f.identity() }));
  assert.deepEqual((await f.mentions.search({ query: "CFK-601" })).structuredContent, { items: [] });
  for (const [status, code] of [[0, "MCP_SEARCH_INDEX_WARMING"], [0, "MCP_SEARCH_INDEX_UNAVAILABLE"]]) {
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
  const first = f.mentions.search({ query: "11" }, { signal: abort.signal });
  const second = f.mentions.search({ query: "12" });
  await new Promise(resolve => setImmediate(resolve));
  const third = f.mentions.search({ query: "13" });
  const queuedAbort = new AbortController();
  const fourth = f.mentions.search({ query: "14" }, { signal: queuedAbort.signal });
  assert.equal((await f.mentions.search({ query: "15" })).structuredContent.error.code, "MCP_MENTIONS_BUSY");
  queuedAbort.abort(); assert.equal((await fourth).structuredContent.error.code, "MCP_OPERATION_CANCELLED");
  abort.abort(); assert.equal((await first).structuredContent.error.code, "MCP_OPERATION_CANCELLED");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.name === "search").length, 3);
  assert.equal(f.calls.filter(call => call.name === "search")[1].signal.aborted, false);
  running[1](); running[2](); await Promise.all([second, third]);
  assert.equal(maximum, 2);
  const rate = fixture({ startIntervalMs: 25, timeoutMs: 500 }); t.after(() => rate.mentions.dispose());
  const starts = [];
  rate.handler(async () => { starts.push(Date.now()); return { ok: false, status: 404 }; });
  await Promise.all([11, 12, 13, 14].map(query => rate.mentions.search({ query: String(query) })));
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 23);
});

test("input admission bounds local connection/identity checks before the SQLite search", async t => {
  const f = fixture({ concurrency: 2, queueLimit: 2, startIntervalMs: 25, timeoutMs: 1000 }); t.after(() => f.mentions.dispose());
  const original = f.mentions.facade.callTool;
  const releases = [], starts = [];
  let active = 0, maximum = 0, secondStarted, thirdStarted;
  const secondReady = new Promise(resolve => { secondStarted = resolve; });
  const thirdReady = new Promise(resolve => { thirdStarted = resolve; });
  f.mentions.facade.callTool = async (name, args, options) => {
    starts.push(Date.now()); active++; maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve, reject) => {
        releases.push(resolve);
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        if (releases.length === 2) secondStarted();
        if (releases.length === 3) thirdStarted();
      });
      return await original(name, args, options);
    } finally { active--; }
  };
  f.handler(async () => ({ ok: true, data: { items: [] }, reference_identity: f.identity() }));
  const first = f.mentions.search({ query: "11" });
  const second = f.mentions.search({ query: "12" });
  await secondReady;
  const third = f.mentions.search({ query: "13" });
  const cancel = new AbortController();
  const fourth = f.mentions.search({ query: "14" }, { signal: cancel.signal });
  assert.equal((await f.mentions.search({ query: "15" })).structuredContent.error.code, "MCP_MENTIONS_BUSY");
  assert.equal(starts.length, 2); assert.equal(f.calls.filter(call => call.name === "identity").length, 0);
  cancel.abort(); assert.equal((await fourth).structuredContent.error.code, "MCP_OPERATION_CANCELLED");
  releases[0](); releases[1]();
  await thirdReady; releases[2]();
  await Promise.all([first, second, third]);
  assert.equal(maximum, 2); assert.equal(starts.length, 3);
  assert.equal(f.calls.filter(call => call.name === "identity").length, 3);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 23);
});

test("prefix results are exact first and title matching uses Unicode normalization", async t => {
  const f = fixture(); t.after(() => f.mentions.dispose());
  const issues = [601, 60, 600].map(number => ({ ...f.issue(), id: randomUUID(), identifier: `CFK-${number}`, title: "ＡＢ 搜索" }));
  f.handler(async () => ({ ok: true, data: { items: issues }, reference_identity: f.identity() }));
  for (const query of ["CFK-60", "60", "ａｂ", "搜索"]) {
    const result = await f.mentions.search({ query });
    assert.deepEqual(result.structuredContent.items.map(item => item.name), ["CFK-60", "CFK-600", "CFK-601"]);
  }
  assert.deepEqual(f.calls.filter(call => call.name === "search").map(call => call.args.query), [{ kind: "identifier", identifier: "CFK-60" }, { kind: "prefix", prefix: "60" }, { kind: "title", text: "ab" }, { kind: "title", text: "搜索" }]);
  f.handler(null); f.data({ identifier: "CFK-6" });
  assert.equal((await f.mentions.search({ query: "CFK-6" })).structuredContent.items.length, 1);
});

test("equal locally validated queries coalesce and subscriber cancellation preserves other chats", async t => {
  const f = fixture({ timeoutMs: 1000 }); t.after(() => f.mentions.dispose());
  let complete, ioSignal;
  f.handler((_args, signal) => new Promise(resolve => { complete = resolve; ioSignal = signal; }));
  const cancelled = new AbortController();
  const first = f.mentions.search({ query: "CFK-601" }, { signal: cancelled.signal });
  const second = f.mentions.search({ query: "CFK-601" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.name === "identity").length, 2);
  assert.equal(f.calls.filter(call => call.name === "search").length, 1);
  cancelled.abort();
  assert.equal((await first).structuredContent.error.code, "MCP_OPERATION_CANCELLED");
  assert.equal(ioSignal.aborted, false);
  complete({ ok: true, data: { items: [f.issue()] }, reference_identity: f.identity() });
  assert.equal((await second).isError, false);
  const all = new AbortController();
  const third = f.mentions.search({ query: "CFK-601" }, { signal: all.signal });
  await new Promise(resolve => setImmediate(resolve)); all.abort();
  assert.equal((await third).structuredContent.error.code, "MCP_OPERATION_CANCELLED");
  assert.equal(ioSignal.aborted, true);
});

test("candidate byte cap includes escaped text and invalid later items do not register any reference", async t => {
  const f = fixture(); t.after(() => f.mentions.dispose());
  const issues = Array.from({ length: 10 }, (_, index) => ({ ...f.issue(), id: randomUUID(), identifier: `CFK-${600 + index}`, title: "\u0000".repeat(1024), project: { id: f.ids.project, display_name: "\u0000".repeat(1024) }, workspace: { id: f.ids.workspace, display_name: "\u0000".repeat(1024) } }));
  f.handler(async () => ({ ok: true, data: { items: issues }, reference_identity: f.identity() }));
  const result = await f.mentions.search({ query: "60" });
  assert.equal(result.isError, false);
  assert.ok(result.structuredContent.items.length >= 1 && result.structuredContent.items.length < 10);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
  const before = f.mentions.references.size;
  f.handler(async () => ({ ok: true, data: { items: [f.issue(), { ...f.issue(), id: randomUUID(), identifier: "bad" }] }, reference_identity: f.identity() }));
  assert.equal((await f.mentions.search({ query: "CFK-601" })).structuredContent.error.code, "MCP_INVALID_SERVICE_RESOURCE");
  assert.equal(f.mentions.references.size, before);
});

test("reference insertion refreshes existing selections before eviction", async t => {
  const f = fixture(); t.after(() => f.mentions.dispose());
  const first = link(await f.mentions.search({ query: "CFK-601" }));
  for (let number = 1000; number < 1511; number++) {
    f.data({ id: randomUUID(), identifier: `CFK-${number}` });
    await f.mentions.search({ query: `CFK-${number}` });
  }
  assert.equal(f.mentions.references.size, 512);
  const retained = f.mentions.references.get(first).issue;
  f.handler(async () => ({ ok: true, data: { items: [retained] }, reference_identity: f.identity() }));
  await f.mentions.search({ query: "CFK-601" });
  f.handler(null); f.data({ id: randomUUID(), identifier: "CFK-2000" });
  await f.mentions.search({ query: "CFK-2000" });
  assert.equal(f.mentions.references.size, 512); assert.equal(f.mentions.references.has(first), true);
});

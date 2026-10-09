import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { createMcpFacade, MCP_TOOLS } from "../../packages/skill-runtime/src/mcp-facade.mjs";
import { getInstancePaths, withCredentialStateLock } from "../../packages/skill-runtime/src/state.mjs";
import { atomicWriteJson } from "../../packages/skill-runtime/src/utils.mjs";
import { createMcpStateFixture } from "./mcp-fixture.mjs";

function serviceError(code, category, status) {
  const requestId = randomUUID();
  return Response.json({ code, category, source: "service", message: "Service decision", recovery: "refresh_resource", request_id: requestId, retryable: false, details: {} }, { status, headers: { "x-request-id": requestId } });
}
function fixtureFetch(fixture, handler) {
  return async (url, options) => {
    assert.equal(url.origin, fixture.origin);
    assert.equal(options.redirect, "manual");
    assert.equal(options.signal instanceof AbortSignal, true);
    if (url.pathname === "/.well-known/cfkanban-instance.json") {
      assert.equal(new Headers(options.headers).get("authorization"), null);
      return Response.json(fixture.discovery);
    }
    assert.equal(new Headers(options.headers).get("authorization")?.startsWith("Bearer cfk_v1_"), true);
    return handler(url, options);
  };
}
const digest = options => createHash("sha256").update(new Headers(options.headers).get("authorization").slice(7)).digest("hex");

test("catalog exposes only bounded strict daily tools and rejects API/state/file passthrough", async () => {
  assert.equal(MCP_TOOLS.length, 24);
  assert.equal(new Set(MCP_TOOLS.map(tool => tool.name)).size, 24);
  assert.ok(MCP_TOOLS.every(tool => /^cfkanban_[a-z_]+$/.test(tool.name) && tool.inputSchema.additionalProperties === false));
  assert.ok(MCP_TOOLS.every(tool => !tool.inputSchema.properties.apiPath && !tool.inputSchema.properties.stateRoot));
  const facade = createMcpFacade({ fetchImpl: () => { throw new Error("Should not reach network"); } });
  for (const field of ["apiPath", "stateRoot", "filePath", "origin", "authorizationToken"]) {
    const result = await facade.callTool("cfkanban_issues_get", { instance_id: randomUUID(), identifier: "CFK-1", [field]: "forbidden" });
    assert.equal(result.error.code, "MCP_INVALID_ARGUMENTS");
  }
  assert.equal((await facade.callTool("cfkanban_admin_passthrough", {})).error.code, "MCP_TOOL_NOT_FOUND");
});

test("bounded filters, cursor, allowed_actions and resolved_scope pass through without scanning", async t => {
  const f = await createMcpStateFixture(t);
  const calls = [];
  const data = { items: [{ identifier: "CFK-1", version: 4, allowed_actions: ["read", "update"] }], next_cursor: "opaque", has_more: true, resolved_scope: { projects: [f.projectId], warnings: ["invalid_target"] } };
  const facade = createMcpFacade({ ...f, fetchImpl: fixtureFetch(f, (url, options) => { calls.push({ url, options }); return Response.json(data); }) });
  const args = { instance_id: f.instanceId, project_ids: [f.projectId], status: ["todo", "in_progress"], priority: ["high"], assignee: ["unassigned"], q: "Title", q_mode: "typed", cursor: "same filter", limit: 8 };
  const result = await facade.callTool("cfkanban_issues_list", args);
  assert.deepEqual(result.data, data);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get("project"), f.projectId);
  assert.deepEqual(calls[0].url.searchParams.getAll("status"), args.status);
  assert.equal(calls[0].url.searchParams.get("cursor"), args.cursor);
  assert.equal(calls[0].url.searchParams.get("q_mode"), "typed");
  assert.equal((await facade.callTool("cfkanban_issues_list", { ...args, q_mode: "legacy" })).error.code, "MCP_INVALID_ARGUMENTS");
  assert.equal((await facade.callTool("cfkanban_issues_list", { instance_id: f.instanceId })).error.code, "MCP_EXPLICIT_SCOPE_REQUIRED");
  assert.equal((await facade.callTool("cfkanban_issues_list", { instance_id: f.instanceId, limit: 101, project_ids: [f.projectId] })).error.code, "MCP_INVALID_ARGUMENTS");
  const aggregate = await facade.callTool("cfkanban_issues_list", { instance_id: f.instanceId, allow_unfiltered: true });
  assert.equal(aggregate.scope_expanded, true);
});

test("assignee pages use an explicit bound Project and strict bounded public arguments", async t => {
  const f = await createMcpStateFixture(t);
  const calls = [];
  const page = { items: [{ principal_id: randomUUID(), display_name: "Fixture writer" }], next_cursor: "opaque-page", has_more: true };
  const facade = createMcpFacade({ ...f, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] }, fetchImpl: fixtureFetch(f, (url, options) => {
    calls.push({ path: url.pathname, query: url.search, method: options.method });
    return Response.json(url.pathname === "/api/v1/me" ? f.me(f.credential) : page);
  }) });
  const args = { instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId, limit: 20, cursor: "current-page" };
  assert.deepEqual((await facade.callTool("cfkanban_assignees_list", args)).data, page);
  assert.deepEqual(calls.at(-1), { path: `/api/v1/workspaces/${f.workspaceId}/projects/${f.projectId}/assignees`, query: "?cursor=current-page&limit=20", method: "GET" });
  const count = calls.length;
  for (const extra of [{ limit: 101 }, { project_id: "session-" + f.projectId }, { filePath: "/arbitrary" }, { deleted: "only" }, { display_name: "Unspecified lookup" }]) assert.equal((await facade.callTool("cfkanban_assignees_list", { ...args, ...extra })).error.code, "MCP_INVALID_ARGUMENTS");
  assert.equal(calls.length, count);
  assert.equal((await facade.callTool("cfkanban_assignees_list", { ...args, project_id: randomUUID() })).error.code, "MCP_PROJECT_BINDING_MISMATCH");
  assert.equal(calls.filter(row => row.path.endsWith("/assignees")).length, 1);
});

test("locale saves authenticate only the current Principal and expose no profile or identity passthrough", async t => {
  const f = await createMcpStateFixture(t);
  const calls = [];
  let wrongPrincipal = false;
  const facade = createMcpFacade({ ...f, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [] }, fetchImpl: fixtureFetch(f, (url, options) => {
    calls.push({ path: url.pathname, method: options.method, body: options.body, key: new Headers(options.headers).get("idempotency-key") });
    if (options.method === "GET") return Response.json({ ...f.me(f.credential), ...(wrongPrincipal ? { id: randomUUID() } : {}), locale: "zh-CN", theme: "blue" });
    return Response.json({ resource: { id: f.principalId, locale: "en", theme: "blue", version: 2 } });
  }) });
  const args = { instance_id: f.instanceId, locale: "en", expected_version: 1, idempotency_key: "same-locale-key" };
  const inspected = await facade.callTool("cfkanban_connection_inspect", { instance_id: f.instanceId });
  assert.equal(inspected.data.principal.locale, "zh-CN"); assert.equal(inspected.data.principal.theme, "blue");
  assert.equal(Object.hasOwn(inspected.data.principal, "credential"), false);
  assert.equal((await facade.callTool("cfkanban_profile_locale_set", args)).ok, true);
  assert.deepEqual(calls.at(-1), { path: "/api/v1/me", method: "PATCH", body: JSON.stringify({ locale: "en", expected_version: 1 }), key: args.idempotency_key });
  assert.equal(calls.filter(row => row.method !== "GET").length, 1);
  const before = calls.length;
  for (const extra of [{ locale: "fr" }, { principal_id: randomUUID() }, { theme: "orange" }, { changes: { locale: "en" } }, { display_name: "Another name" }, { apiPath: "/api/v1/admin" }, { expected_version: 0 }]) assert.equal((await facade.callTool("cfkanban_profile_locale_set", { ...args, ...extra })).error.code, "MCP_INVALID_ARGUMENTS");
  assert.equal(calls.length, before);
  wrongPrincipal = true;
  assert.equal((await facade.callTool("cfkanban_profile_locale_set", args)).error.code, "MCP_PRINCIPAL_BINDING_MISMATCH");
  assert.equal(calls.filter(row => row.method !== "GET").length, 1);
});

test("label lists stay in the explicit active Project and label associations cannot cross an Issue binding", async t => {
  const f = await createMcpStateFixture(t);
  const labelId = randomUUID(); const calls = [];
  let issueProject = f.projectId;
  const facade = createMcpFacade({ ...f, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] }, fetchImpl: fixtureFetch(f, (url, options) => {
    calls.push({ path: url.pathname, query: url.search, method: options.method });
    if (url.pathname === "/api/v1/me") return Response.json(f.me(f.credential));
    if (url.pathname === "/api/v1/issues/CFK-1") return Response.json({ identifier: "CFK-1", project: { id: issueProject }, version: 1 });
    if (url.pathname.endsWith("/labels")) return Response.json({ items: [{ id: labelId, name: "Existing label" }], next_cursor: "bounded-page" });
    return Response.json({ resource: { version: 2 } });
  }) });
  const list = { instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId, limit: 20, cursor: "current-page" };
  assert.equal((await facade.callTool("cfkanban_labels_list", list)).ok, true);
  assert.deepEqual(calls.at(-1), { path: `/api/v1/workspaces/${f.workspaceId}/projects/${f.projectId}/labels`, query: "?cursor=current-page&limit=20", method: "GET" });
  const before = calls.length;
  for (const extra of [{ deleted: "only" }, { limit: 101 }, { name: "Create me" }, { color: "red" }, { filePath: "/arbitrary" }]) assert.equal((await facade.callTool("cfkanban_labels_list", { ...list, ...extra })).error.code, "MCP_INVALID_ARGUMENTS");
  assert.equal(calls.length, before);
  assert.equal((await facade.callTool("cfkanban_labels_list", { ...list, project_id: randomUUID() })).error.code, "MCP_PROJECT_BINDING_MISMATCH");
  issueProject = randomUUID();
  for (const name of ["cfkanban_issues_labels_add", "cfkanban_issues_labels_remove"]) assert.equal((await facade.callTool(name, { instance_id: f.instanceId, identifier: "CFK-1", label_id: labelId, expected_version: 1, idempotency_key: "same-label-key" })).error.code, "MCP_PROJECT_BINDING_MISMATCH");
  assert.equal(calls.filter(row => row.method !== "GET").length, 0);
});

test("lost locale and label responses keep the exact tool, payload, CAS and key for explicit recovery", async t => {
  const f = await createMcpStateFixture(t);
  const labelId = randomUUID();
  const facade = createMcpFacade({ ...f, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] }, fetchImpl: fixtureFetch(f, (url, options) => {
    if (options.method !== "GET") throw new Error("Untrusted network exception");
    return Response.json(url.pathname === "/api/v1/me" ? f.me(f.credential) : { identifier: "CFK-1", project: { id: f.projectId }, version: 1 });
  }) });
  for (const [name, args] of [
    ["cfkanban_profile_locale_set", { instance_id: f.instanceId, locale: "zh-CN", expected_version: 1, idempotency_key: "lost-locale-key" }],
    ...["cfkanban_issues_labels_add", "cfkanban_issues_labels_remove"].map(name => [name, { instance_id: f.instanceId, identifier: "CFK-1", label_id: labelId, expected_version: 1, idempotency_key: "lost-label-key" }]),
  ]) {
    const result = await facade.callTool(name, args);
    assert.equal(result.outcome_unknown, true);
    assert.equal(result.recovery_request.tool, name); assert.deepEqual(result.recovery_request.arguments, args);
    assert.equal(result.recovery_request.idempotency_key, args.idempotency_key);
    assert.doesNotMatch(JSON.stringify(result), /Untrusted network exception/);
  }
});

test("all representative writes map to exactly one atomic API operation with stable keys and CAS", async t => {
  const f = await createMcpStateFixture(t);
  const calls = [];
  const facade = createMcpFacade({ ...f, fetchImpl: fixtureFetch(f, (url, options) => { calls.push({ url, options }); return Response.json({ resource: { version: 3 }, idempotent_replay: false, event_cursor: "event" }); }) });
  const common = { instance_id: f.instanceId, identifier: "CFK-1", idempotency_key: "stable-operation-key" };
  const relationId = randomUUID();
  const labelId = randomUUID();
  const cases = [
    ["issues_create", { instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId, title: "MCP", idempotency_key: common.idempotency_key }, "POST", `/api/v1/workspaces/${f.workspaceId}/projects/${f.projectId}/issues`, { title: "MCP" }],
    ["issues_update", { ...common, expected_version: 2, changes: { priority_key: "high" } }, "PATCH", "/api/v1/issues/CFK-1", { expected_version: 2, priority_key: "high" }],
    ["issues_labels_add", { ...common, expected_version: 2, label_id: labelId }, "POST", "/api/v1/issues/CFK-1/commands/add-label", { expected_version: 2, label_id: labelId }],
    ["issues_labels_remove", { ...common, expected_version: 2, label_id: labelId }, "POST", "/api/v1/issues/CFK-1/commands/remove-label", { expected_version: 2, label_id: labelId }],
    ["comments_create", { ...common, body: "Evidence" }, "POST", "/api/v1/issues/CFK-1/comments", { body: "Evidence" }],
    ["relations_create", { ...common, kind: "blocks", target_identifier: "CFK-2", source_expected_version: 2, target_expected_version: 7 }, "POST", "/api/v1/issues/CFK-1/relations", { kind: "blocks", target_identifier: "CFK-2", source_expected_version: 2, target_expected_version: 7 }],
    ["relations_delete", { instance_id: f.instanceId, relation_id: relationId, expected_version: 1, source_expected_version: 2, target_expected_version: 7, idempotency_key: common.idempotency_key }, "DELETE", `/api/v1/relations/${relationId}`, undefined],
    ["issues_complete", { ...common, expected_version: 2, summary: "Implemented", verification: ["isolated check"] }, "POST", "/api/v1/issues/CFK-1/commands/complete", { expected_version: 2, summary: "Implemented", verification: ["isolated check"] }],
  ];
  for (const [name, args, method, pathname, body] of cases) {
    const before = calls.length;
    assert.equal((await facade.callTool(`cfkanban_${name}`, args)).ok, true);
    assert.equal(calls.length, before + 1);
    const call = calls.at(-1);
    assert.equal(call.options.method, method);
    assert.equal(call.url.pathname, pathname);
    assert.equal(new Headers(call.options.headers).get("idempotency-key"), common.idempotency_key);
    assert.deepEqual(call.options.body === undefined ? undefined : JSON.parse(call.options.body), body);
    const missingKey = { ...args }; delete missingKey.idempotency_key;
    assert.equal((await facade.callTool(`cfkanban_${name}`, missingKey)).error.code, "MCP_INVALID_ARGUMENTS");
  }
  assert.equal(calls.at(-2).url.searchParams.get("source_expected_version"), "2");
});

test("reader denial, unauthorized Project, revoked Credential and CAS errors preserve service decision", async t => {
  const f = await createMcpStateFixture(t);
  for (const [code, category, status] of [["FORBIDDEN", "authorization", 403], ["PROJECT_ACCESS_DENIED", "authorization", 403], ["CREDENTIAL_REVOKED", "authentication", 401], ["VERSION_CONFLICT", "conflict", 409], ["IDEMPOTENCY_KEY_REUSED", "conflict", 409]]) {
    const facade = createMcpFacade({ ...f, fetchImpl: fixtureFetch(f, () => serviceError(code, category, status)) });
    const result = await facade.callTool("cfkanban_issues_update", { instance_id: f.instanceId, identifier: "CFK-1", expected_version: 2, changes: { title: "Changed" }, idempotency_key: "same" });
    assert.equal(result.status, status);
    assert.equal(result.error.code, code);
    assert.equal(result.error.category, category);
    assert.equal(result.error.source, "service");
    assert.equal(result.outcome_unknown, undefined);
  }
});

test("untrusted discovery migration and instance mismatch never send Credentials", async t => {
  const f = await createMcpStateFixture(t);
  for (const discovery of [{ ...f.discovery, instance_id: randomUUID() }, { ...f.discovery, preferred_api_origin: "https://attacker.invalid", origin_version: 2 }]) {
    let count = 0;
    const facade = createMcpFacade({ ...f, fetchImpl: async (_url, options) => { count++; assert.equal(new Headers(options.headers).get("authorization"), null); return Response.json(discovery); } });
    const result = await facade.callTool("cfkanban_issues_get", { instance_id: f.instanceId, identifier: "CFK-1" });
    assert.equal(result.ok, false);
    assert.match(result.error.code, /^DISCOVERY_/);
    assert.equal(count, 1);
  }
});

test("private state failures, symlinks and permission drift redact paths and underlying failures", async t => {
  const f = await createMcpStateFixture(t);
  const paths = getInstancePaths({ stateRoot: f.stateRoot, instanceId: f.instanceId });
  const facade = createMcpFacade({ ...f, fetchImpl: () => { throw new Error(`private ${f.home}`); } });
  await chmod(paths.currentSecret, 0o644);
  let result = await facade.callTool("cfkanban_issues_get", { instance_id: f.instanceId, identifier: "CFK-1" });
  assert.equal(result.error.code, "STATE_PERMISSION_DRIFT");
  assert.equal(JSON.stringify(result).includes(f.home), false);
  await chmod(paths.currentSecret, 0o600);
  await writeFile(paths.currentMetadata, "invalid JSON");
  result = await facade.callTool("cfkanban_issues_get", { instance_id: f.instanceId, identifier: "CFK-1" });
  assert.equal(JSON.stringify(result).includes(f.home), false);
  const f2 = await createMcpStateFixture(t);
  const linkHome = await createMcpStateFixture(t);
  await symlink(f2.stateRoot, `${linkHome.home}/link`);
  result = await createMcpFacade({ home: linkHome.home, stateRoot: `${linkHome.home}/link` }).callTool("cfkanban_connection_inspect", {});
  assert.equal(result.error.code, "STATE_SYMLINK_REJECTED");
});

test("discovery failure preserves rate-limit cooldown but never authorizes another request", async t => {
  const f = await createMcpStateFixture(t);
  for (const response of [
    () => Response.json(f.discovery, { status: 429, headers: { "retry-after": "120" } }),
    () => new Response('{malformed', { status: 429, headers: { "content-type": "application/json", "retry-after": "120" } }),
    () => new Response('<html>rate limit</html>', { status: 429, headers: { "retry-after": "120" } }),
  ]) {
    let requests = 0;
    const facade = createMcpFacade({ ...f, fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url.pathname, "/.well-known/cfkanban-instance.json");
      assert.equal(new Headers(options.headers).get("authorization"), null);
      return response();
    } });
    const result = await facade.readSearchStatus({ instance_id: f.instanceId });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429);
    assert.equal(result.error.retry_after_seconds, 120);
    assert.equal(requests, 1);
    assert.equal(result.data, undefined);
  }
});

test("redirects and malformed successful discovery never become trusted via error normalization", async t => {
  const f = await createMcpStateFixture(t);
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: "https://untrusted.invalid", "retry-after": "1" } }),
    () => new Response('{malformed', { headers: { "content-type": "application/json" } }),
    () => Response.json({ ...f.discovery, instance_id: randomUUID() }),
  ]) {
    let requests = 0;
    const facade = createMcpFacade({ ...f, fetchImpl: async (_url, options) => { requests++; assert.equal(options.redirect, "manual"); assert.equal(new Headers(options.headers).get("authorization"), null); return response(); } });
    const result = await facade.readSearchStatus({ instance_id: f.instanceId });
    assert.equal(result.ok, false);
    assert.equal(result.data, undefined);
    assert.equal(requests, 1);
  }
});

test("Host binding checks authenticated snapshot identity and actual Issue Project before writing", async t => {
  const f = await createMcpStateFixture(t);
  let credential = f.credential;
  let actualProject = randomUUID();
  const calls = [];
  const fetchImpl = fixtureFetch(f, (url, options) => {
    calls.push({ url, options });
    if (url.pathname === "/api/v1/me") return Response.json(f.me(credential));
    if (options.method === "GET") return Response.json({ identifier: "CFK-1", project: { id: actualProject }, version: 1 });
    return Response.json({ resource: { version: 2 } });
  });
  const facade = createMcpFacade({ ...f, fetchImpl, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] } });
  const args = { instance_id: f.instanceId, identifier: "CFK-1", expected_version: 1, changes: { title: "Bound" }, idempotency_key: "bound-key" };
  assert.equal((await facade.callTool("cfkanban_issues_update", args)).error.code, "MCP_PROJECT_BINDING_MISMATCH");
  assert.ok(calls.every(call => call.options.method === "GET"));
  actualProject = f.projectId;
  assert.equal((await facade.callTool("cfkanban_issues_update", args)).ok, true);
  assert.equal((await facade.callTool("cfkanban_issues_list", { instance_id: f.instanceId, allow_unfiltered: true })).error.code, "MCP_PROJECT_BINDING_MISMATCH");
  const paths = getInstancePaths({ stateRoot: f.stateRoot, instanceId: f.instanceId });
  credential = { ...credential, principal_id: randomUUID() };
  await atomicWriteJson(paths.currentMetadata, credential);
  const before = calls.length;
  assert.equal((await facade.callTool("cfkanban_issues_update", args)).error.code, "MCP_PRINCIPAL_BINDING_MISMATCH");
  assert.equal(calls.length, before);
});

test("multiple facade sessions read current rotation each call while a bound call uses one credential snapshot", async t => {
  const f = await createMcpStateFixture(t);
  let credential = f.credential;
  let rotateDuringMe = false;
  const observed = [];
  const fetchImpl = fixtureFetch(f, async (url, options) => {
    observed.push({ pathname: url.pathname, tokenDigest: digest(options) });
    if (url.pathname === "/api/v1/me") {
      const me = f.me(credential);
      if (rotateDuringMe) { rotateDuringMe = false; credential = await f.rotate(); }
      return Response.json(me);
    }
    return Response.json({ project: { id: f.projectId }, version: 1, resource: { version: 2 } });
  });
  const options = { ...f, fetchImpl, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] } };
  const first = createMcpFacade(options), second = createMcpFacade(options);
  const args = { instance_id: f.instanceId, identifier: "CFK-1", body: "One atomic comment", idempotency_key: "rotation-operation" };
  const oldDigest = credential.token_digest;
  rotateDuringMe = true;
  assert.equal((await first.callTool("cfkanban_comments_create", args)).ok, true);
  assert.ok(observed.every(call => call.tokenDigest === oldDigest));
  observed.length = 0;
  assert.equal((await second.callTool("cfkanban_issues_get", { instance_id: f.instanceId, identifier: "CFK-1" })).ok, true);
  assert.ok(observed.every(call => call.tokenDigest === credential.token_digest));
  await withCredentialStateLock({ stateRoot: f.stateRoot, instanceId: f.instanceId }, async () => {
    const result = await first.callTool("cfkanban_issues_get", { instance_id: f.instanceId, identifier: "CFK-1" });
    // The lock owner itself may read; another async context is covered by the separate-process test.
    assert.equal(result.ok, true);
  });
});

test("lost write response preserves original request/key, never retries, and explicit same-key replay resolves", async t => {
  const f = await createMcpStateFixture(t);
  let sent = 0, committed = false;
  const facade = createMcpFacade({ ...f, fetchImpl: fixtureFetch(f, (_url, options) => {
    if (options.method === "GET") return Response.json({ version: committed ? 2 : 1 });
    sent++;
    if (!committed) { committed = true; throw new Error("network response lost"); }
    return Response.json({ resource: { version: 2 }, idempotent_replay: true });
  }) });
  const args = { instance_id: f.instanceId, identifier: "CFK-1", expected_version: 1, changes: { title: "Committed" }, idempotency_key: "original-key" };
  const uncertain = await facade.callTool("cfkanban_issues_update", args);
  assert.equal(uncertain.outcome_unknown, true);
  assert.equal(sent, 1);
  assert.deepEqual(uncertain.recovery_request.arguments, args);
  assert.equal((await facade.callTool("cfkanban_issues_get", { instance_id: f.instanceId, identifier: "CFK-1" })).data.version, 2);
  const resolved = await facade.callTool(uncertain.recovery_request.tool, uncertain.recovery_request.arguments);
  assert.equal(resolved.data.idempotent_replay, true);
  assert.equal(sent, 2);
});

test("cancellation and deadline bound transports that ignore abort and mark sent write outcome unknown", async t => {
  const f = await createMcpStateFixture(t);
  let sent = 0, seenSignal;
  const facade = createMcpFacade({ ...f, timeoutMs: 35, fetchImpl: fixtureFetch(f, (_url, options) => { sent++; seenSignal = options.signal; return new Promise(() => {}); }) });
  const start = performance.now();
  const args = { instance_id: f.instanceId, identifier: "CFK-1", body: "Pending", idempotency_key: "cancel-original" };
  const result = await facade.callTool("cfkanban_comments_create", args);
  assert.ok(performance.now() - start < 1000);
  assert.equal(seenSignal.aborted, true);
  assert.equal(result.outcome_unknown, true);
  assert.equal(sent, 1);
  const controller = new AbortController(); controller.abort();
  const cancelled = await facade.callTool("cfkanban_comments_create", args, { signal: controller.signal });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, "MCP_OPERATION_CANCELLED");
  assert.equal(cancelled.outcome_unknown, undefined);
  assert.equal(sent, 1);
});

test("connection inspect exposes explicit identity and only non-secret candidates", async t => {
  const f = await createMcpStateFixture(t);
  const facade = createMcpFacade({ ...f, fetchImpl: fixtureFetch(f, () => Response.json(f.me(f.credential))) });
  await mkdir(`${f.stateRoot}/instances/${randomUUID()}`, { mode: 0o700 });
  const candidates = await facade.callTool("cfkanban_connection_inspect", {});
  assert.deepEqual(candidates.data.candidates, [{ instance_id: f.instanceId, trusted_api_origin: f.origin }]);
  const result = await facade.callTool("cfkanban_connection_inspect", { instance_id: f.instanceId });
  assert.equal(result.data.principal.principal_id, f.principalId);
  assert.equal(result.data.principal.credential, undefined);
  const rawSecret = JSON.parse(await readFile(getInstancePaths({ stateRoot: f.stateRoot, instanceId: f.instanceId }).currentSecret, "utf8")).token;
  assert.equal(JSON.stringify(result).includes(rawSecret), false);
  const echoFacade = createMcpFacade({ ...f, fetchImpl: fixtureFetch(f, () => Response.json({ body: rawSecret })) });
  assert.equal((await echoFacade.callTool("cfkanban_issues_get", { instance_id: f.instanceId, identifier: "CFK-1" })).data.body, "[REDACTED]");
});

test("identity-only binding permits discovery reads and refuses Issue scope expansion", async t => {
  const f = await createMcpStateFixture(t);
  const facade = createMcpFacade({ ...f, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [] }, fetchImpl: fixtureFetch(f, url => Response.json(url.pathname === "/api/v1/me" ? f.me(f.credential) : { items: [], next_cursor: null })) });
  for (const [name, args] of [["connection_inspect", { instance_id: f.instanceId }], ["workspaces_list", { instance_id: f.instanceId }], ["projects_list", { instance_id: f.instanceId, workspace_id: f.workspaceId }]]) assert.equal((await facade.callTool(`cfkanban_${name}`, args)).ok, true);
  for (const [name, args] of [["issues_get", { instance_id: f.instanceId, identifier: "CFK-1" }], ["statuses_list", { instance_id: f.instanceId, workspace_id: f.workspaceId, project_id: f.projectId }]]) assert.equal((await facade.callTool(`cfkanban_${name}`, args)).error.code, "MCP_EXPLICIT_SCOPE_REQUIRED");
});

test("bound Relation delete verifies actual nested endpoint contract and preserves returned endpoint CAS order", async t => {
  const f = await createMcpStateFixture(t);
  const relationId = randomUUID();
  const visited = [];
  const facade = createMcpFacade({ ...f, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] }, fetchImpl: fixtureFetch(f, (url, options) => {
    visited.push(url.pathname);
    if (url.pathname === "/api/v1/me") return Response.json(f.me(f.credential));
    if (options.method === "DELETE") {
      assert.equal(url.searchParams.get("source_expected_version"), "8");
      assert.equal(url.searchParams.get("target_expected_version"), "3");
      return Response.json({ resource: { id: relationId, deleted_at: "2026-10-02T00:00:00Z", version: 2 } });
    }
    if (url.pathname === `/api/v1/relations/${relationId}`) return Response.json({ id: relationId, kind: "related", version: 1, source: { identifier: "CFK-2", project_id: f.projectId }, target: { identifier: "CFK-1", project_id: f.projectId } });
    return Response.json({ identifier: url.pathname.endsWith("CFK-2") ? "CFK-2" : "CFK-1", project: { id: f.projectId }, version: url.pathname.endsWith("CFK-2") ? 8 : 3 });
  }) });
  const result = await facade.callTool("cfkanban_relations_delete", { instance_id: f.instanceId, relation_id: relationId, expected_version: 1, source_expected_version: 8, target_expected_version: 3, idempotency_key: "canonical-endpoint-delete" });
  assert.equal(result.ok, true);
  assert.deepEqual(visited, ["/api/v1/me", `/api/v1/relations/${relationId}`, "/api/v1/issues/CFK-2", "/api/v1/issues/CFK-1", `/api/v1/relations/${relationId}`]);
});

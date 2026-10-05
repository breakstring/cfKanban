import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createMcpFacade } from "../../skill-runtime/src/mcp-facade.mjs";
import { createMcpStateFixture } from "../../../scripts/tests/mcp-fixture.mjs";

function referenceFixture(fixture, handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ path: url.pathname, query: url.search, signal: options.signal });
    assert.equal(url.origin, fixture.origin); assert.equal(options.redirect, "manual");
    assert.equal(options.signal instanceof AbortSignal, true);
    if (url.pathname === "/.well-known/cfkanban-instance.json") return Response.json({ ...fixture.discovery, capabilities: { issue_reference: true } });
    if (url.pathname === "/api/v1/me") return Response.json(fixture.me(fixture.credential));
    return handler(url, options);
  };
  return { calls, fetchImpl };
}

test("reference reads verify the current identity and use only discovery/me/the lightweight endpoint", async t => {
  const f = await createMcpStateFixture(t);
  const io = referenceFixture(f, url => {
    assert.equal(url.pathname, "/api/v1/issues/CFK-601/reference");
    assert.equal(url.searchParams.get("projection"), "mention");
    return Response.json({ id: randomUUID(), identifier: "CFK-601", project: { id: f.projectId }, body: "must not be normal get" });
  });
  const facade = createMcpFacade({ ...f, fetchImpl: io.fetchImpl, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] } });
  const result = await facade.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "mention" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reference_identity, { instance_id: f.instanceId, principal_id: f.principalId, trusted_api_origin: f.origin });
  assert.deepEqual(io.calls.map(call => call.path), ["/.well-known/cfkanban-instance.json", "/api/v1/me", "/api/v1/issues/CFK-601/reference"]);
  assert.equal((await facade.callTool("cfkanban_reference_get", { instance_id: f.instanceId, identifier: "CFK-601", projection: "mention" })).error.code, "MCP_TOOL_NOT_FOUND");
  assert.equal((await facade.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "mention", origin: "https://arbitrary.invalid" })).error.code, "MCP_INVALID_ARGUMENTS");
  const oldIdentity = createMcpFacade({ ...f, fetchImpl: io.fetchImpl, binding: { instance_id: f.instanceId, expected_principal_id: randomUUID(), project_ids: [f.projectId] } });
  const count = io.calls.length;
  assert.equal((await oldIdentity.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "resource" })).error.code, "MCP_PRINCIPAL_BINDING_MISMATCH");
  assert.equal(io.calls.length, count);
});

test("reference identity/Project failures never retry a broader read and secrets stay inside the runtime", async t => {
  const f = await createMcpStateFixture(t);
  const io = referenceFixture(f, () => Response.json({ project: { id: randomUUID() } }));
  const facade = createMcpFacade({ ...f, fetchImpl: io.fetchImpl, binding: { instance_id: f.instanceId, expected_principal_id: f.principalId, project_ids: [f.projectId] } });
  const result = await facade.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "mention" });
  assert.equal(result.error.code, "MCP_PROJECT_BINDING_MISMATCH"); assert.equal(io.calls.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /cfk_v1_|Bearer|fingerprint|credential_id/);
  const altered = createMcpFacade({ ...f, fetchImpl: async (url, options) => url.pathname === "/api/v1/me" ? Response.json({ ...f.me(f.credential), principal_id: randomUUID() }) : io.fetchImpl(url, options) });
  assert.equal((await altered.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "resource" })).error.code, "MCP_PRINCIPAL_BINDING_MISMATCH");
});

test("old instances fail explicitly before any credential-bearing reference request", async t => {
  const f = await createMcpStateFixture(t);
  const calls = [];
  const facade = createMcpFacade({ ...f, fetchImpl: async (url, options) => {
    calls.push(url.pathname);
    assert.equal(new Headers(options.headers).get("authorization"), null);
    return Response.json(f.discovery);
  } });
  const result = await facade.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "mention" });
  assert.equal(result.error.code, "MCP_ISSUE_REFERENCE_UNSUPPORTED");
  assert.deepEqual(calls, ["/.well-known/cfkanban-instance.json"]);
});

test("streaming byte budgets refuse oversized responses without draining the whole body", async t => {
  const f = await createMcpStateFixture(t);
  let bytes = 0, cancelled = false;
  const io = referenceFixture(f, () => new Response(new ReadableStream({
    pull(controller) { bytes += 8192; controller.enqueue(new Uint8Array(8192)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } }));
  const facade = createMcpFacade({ ...f, fetchImpl: io.fetchImpl });
  const result = await facade.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "resource" });
  assert.equal(result.error.code, "MCP_REFERENCE_RESPONSE_TOO_LARGE");
  assert.equal(cancelled, true); assert.ok(bytes <= 81920);
});

test("caller cancellation reaches the real fetch AbortSignal, with no fallback or replay", async t => {
  const f = await createMcpStateFixture(t);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let ioSignal;
  const io = referenceFixture(f, (url, options) => new Promise((resolve, reject) => {
    ioSignal = options.signal; started();
    ioSignal.addEventListener("abort", () => reject(ioSignal.reason), { once: true });
  }));
  const controller = new AbortController();
  const facade = createMcpFacade({ ...f, fetchImpl: io.fetchImpl });
  const result = facade.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "resource" }, { signal: controller.signal });
  await ready; controller.abort();
  assert.equal((await result).error.code, "MCP_OPERATION_CANCELLED");
  assert.equal(ioSignal.aborted, true); assert.equal(io.calls.length, 3);
});

test("an uncooperative response cancel cannot hold admission beyond the byte limit or deadline", async t => {
  const f = await createMcpStateFixture(t);
  let cancelled = false, ioSignal;
  const io = referenceFixture(f, (_url, options) => {
    ioSignal = options.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(70000)); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    }), { headers: { "content-type": "application/json" } });
  });
  const facade = createMcpFacade({ ...f, fetchImpl: io.fetchImpl, timeoutMs: 20 });
  const result = await facade.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "resource" });
  assert.equal(result.error.code, "MCP_REFERENCE_RESPONSE_TOO_LARGE");
  assert.equal(cancelled, true); assert.equal(ioSignal.aborted, true);
  let discoverySignal;
  const discovery = createMcpFacade({ ...f, fetchImpl: async (_url, options) => {
    discoverySignal = options.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20000)); },
      cancel() { return new Promise(() => {}); },
    }), { headers: { "content-type": "application/json" } });
  } });
  assert.equal((await discovery.readIssueReference({ instance_id: f.instanceId, identifier: "CFK-601", projection: "mention" })).error.code, "MCP_REFERENCE_RESPONSE_TOO_LARGE");
  assert.equal(discoverySignal.aborted, true);
});

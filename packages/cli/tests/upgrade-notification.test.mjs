import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { COMMANDS } from "../src/catalog.mjs";
import { createCliRuntime } from "../src/runtime.mjs";
import { createMcpStateFixture } from "../../../scripts/tests/mcp-fixture.mjs";

const command = name => { const found = COMMANDS.find(entry => entry.name === name); assert.ok(found, name); return found; };
const fetchFixture = f => async url => Response.json(new URL(url).pathname === "/.well-known/cfkanban-instance.json" ? f.discovery : f.me(f.credential));
const input = f => ({ instanceId: f.instanceId, previous_release_version: "1.9.0", release_version: "1.10.0-rc.1", deployment_id: randomUUID(), worker_version_id: randomUUID() });

test("CLI实际发布从准确发行有界读回，notification ID不符保持可恢复", async t => {
  const f = await createMcpStateFixture(t), notificationId = randomUUID(), calls = []; let wrongReadback = true;
  const requestImpl = async options => {
    calls.push(options);
    if(options.apiPath === "/api/v1/admin/upgrade-notification-settings") return { ok: true, status: 200, data: { enabled: true, version: 1 } };
    if (options.method === "POST") return { ok: true, status: 200, data: { resource: { ...options.body, status: "published", notification_id: notificationId } } };
    assert.equal(options.apiPath, "/api/v1/admin/notifications/upgrade-releases/1.10.0-rc.1");
    return { ok: true, status: 200, data: { release_version: "1.10.0-rc.1", notification_id: wrongReadback ? randomUUID() : notificationId } };
  };
  const runtime = createCliRuntime({ ...f, fetchImpl: fetchFixture(f), requestImpl });
  const first = await runtime.execute(command("admin upgrade-notification publish"), input(f));
  assert.equal(first.committed_unverified, true); assert.equal(calls.filter(call => call.method === "POST").length, 1);
  wrongReadback = false;
  const recovered = await runtime.execute(command("operation recover"), { instanceId: f.instanceId, operationId: first.recovery.operation_id });
  assert.equal(recovered.operation.phase, "verified"); assert.equal(calls.filter(call => call.method === "POST").length, 1);
});

test("CLI关闭结果用原key冻结snapshot核验，不从现在的开关推断", async t => {
  const f = await createMcpStateFixture(t), posts = [];
  const requestImpl = async options => {
    if(options.method === "GET") { assert.equal(options.apiPath, "/api/v1/admin/upgrade-notification-settings"); return { ok: true, status: 200, data: { enabled: true, version: 1 } }; }
    assert.equal(options.method, "POST"); posts.push(options);
    return { ok: true, status: 200, data: { idempotent_replay: posts.length > 1, resource: { ...options.body, status: "disabled", notification_id: null } } };
  };
  const runtime = createCliRuntime({ ...f, fetchImpl: fetchFixture(f), requestImpl });
  const result = await runtime.execute(command("admin upgrade-notification publish"), input(f));
  assert.equal(result.operation.phase, "verified"); assert.equal(result.readback.verification_kind, "original_idempotent_snapshot"); assert.equal(posts.length, 2); assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey); assert.deepEqual(posts[0].body, posts[1].body);
});

test("CLI未知通知只以原request/key恢复，GET记录存在不代替原commit证据", async t => {
  const f = await createMcpStateFixture(t), posts = [], notificationId = randomUUID(); let lostResponse = true;
  const requestImpl = async options => {
    if (options.method === "GET") return { ok: true, status: 200, data: { release_version: "1.10.0-rc.1", notification_id: notificationId } };
    posts.push(options);
    if (lostResponse) return { ok: false, status: 0, error: { code: "PLATFORM_UNAVAILABLE", category: "platform_failure", source: "client_transport" } };
    return { ok: true, status: 200, data: { idempotent_replay: true, resource: { ...options.body, status: "published", notification_id: notificationId } } };
  };
  const options = { ...f, fetchImpl: fetchFixture(f), requestImpl };
  const first = await createCliRuntime(options).execute(command("admin upgrade-notification publish"), input(f)); assert.equal(first.outcome_unknown, true);
  lostResponse = false;
  const recovered = await createCliRuntime(options).execute(command("operation recover"), { instanceId: f.instanceId, operationId: first.recovery.operation_id });
  assert.equal(recovered.operation.phase, "verified"); assert.equal(posts.length, 2); assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey); assert.deepEqual(posts[0].body, posts[1].body);
});

import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { readUsage, collectUsageStatistics, refreshUsage } from "../../apps/worker/src/services/usage.ts";
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.attachments-test.jsonc" }] });
const worker = server.getWorker();
let env;
const owner = { kind: "bearer", isOwner: true };
const now = Date.parse("2026-09-19T12:30:00Z");
const configuration = { USAGE_ANALYTICS_ENABLED: "true", USAGE_ACCOUNT_ID: "account", USAGE_D1_DATABASE_ID: "database", USAGE_R2_BUCKET_NAME: "bucket", USAGE_ANALYTICS_TOKEN: "never-expose-this" };
const data = (kind = "d1") => ({ data: { viewer: { accounts: [{ activity: [{ sum: kind === "d1" ? { rowsRead: 0, rowsWritten: 12 } : { requests: 3 } }], storage: [{ max: kind === "d1" ? { databaseSizeBytes: 100 } : { payloadSize: 20, metadataSize: 2, objectCount: 1 }, dimensions: { datetime: "2026-09-19T11:00:00Z" } }] }] } } });
const success = async (_url, options) => new Response(JSON.stringify(data(JSON.parse(options.body).query.includes("UsageD1") ? "d1" : "r2")));
const read = (time = now) => readUsage(env, owner, time);
before(async () => { await server.listen(); await worker.applyD1Migrations("DB"); env = await worker.getEnv(); });
after(() => server.close());
test("Owner control and no-config attachment budget", async () => {
  await assert.rejects(readUsage(env, { ...owner, isOwner: false }), (error) => error.status === 403);
  await assert.rejects(readUsage(env, { ...owner, kind: "cookie", targetKind: "project" }), (error) => error.status === 403);
  assert.equal((await readUsage(env, { ...owner, kind: "cookie", targetKind: "admin" })).cloudflare.status, "not_configured");
  await env.DB.prepare("UPDATE attachment_storage SET reserved_bytes = 123 WHERE singleton = 1").run();
  const result = await readUsage({ ...env, ATTACHMENTS: undefined }, owner, now);
  assert.deepEqual(result.attachments, { enabled: false, reserved_bytes: 123, limit_bytes: null, limit_configured: false, settings_version: 1 });
});
test("fixed endpoint, scope, UTC windows, latest capacity, zero vs unknown", async () => {
  Object.assign(env, configuration);
  assert.equal((await read()).cloudflare.status, "pending");
  const calls = [];
  await collectUsageStatistics(env, now, async (url, options) => { calls.push(JSON.parse(options.body)); assert.equal(url, "https://api.cloudflare.com/client/v4/graphql"); assert.equal(options.redirect, "error"); return success(url, options); });
  assert.equal(calls.length, 2); assert.equal(calls[0].variables.database, "database"); assert.equal(calls[0].variables.date, "2026-09-19"); assert.equal(calls[1].variables.bucket, "bucket"); assert.equal(calls[1].variables.start, "2026-09-19T00:00:00.000Z"); assert.equal(calls[1].variables.storageEnd, "2026-09-19T12:00:00.000Z");
  const result = await read(); assert.equal(result.cloudflare.status, "fresh"); assert.deepEqual(result.cloudflare.metrics.map((item) => item.value), [100, 0, 12, 22, 1, 3]); assert.equal(result.cloudflare.metrics[0].observed_at, "2026-09-19T11:00:00.000Z"); assert.equal(result.cloudflare.metrics[1].observed_at, null);
  assert.equal((await read(now + 7200001)).cloudflare.status, "stale");
  assert.ok(!JSON.stringify(result).includes(configuration.USAGE_ANALYTICS_TOKEN));
  await collectUsageStatistics(env, now + 15 * 60_000, async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ activity: [], storage: [] }] } } })));
  assert.ok((await read()).cloudflare.metrics.every((item) => item.value === null));
});
test("failures retain successful snapshot and expose only safe categories", async () => {
  const cases = [[429, {}, "rate_limited"], [403, {}, "permission_denied"], [200, { errors: [{ message: configuration.USAGE_ANALYTICS_TOKEN }], ...data() }, "graphql_error"], [200, { data: { viewer: { accounts: [{ activity: [] }] } } }, "invalid_response"]];
  for (const [index, [status, body, expected]] of cases.entries()) {
    await collectUsageStatistics(env, now + (30 + index) * 60_000, async () => new Response(JSON.stringify(body), { status }));
    const result = await read(); assert.equal(result.cloudflare.status, "stale"); assert.equal(result.cloudflare.error, expected); assert.equal(result.cloudflare.collected_at, new Date(now + 15 * 60_000).toISOString()); assert.ok(!JSON.stringify(result).includes(configuration.USAGE_ANALYTICS_TOKEN));
  }
  const disabled = await readUsage({ ...env, USAGE_ANALYTICS_ENABLED: "false" }, owner); assert.equal(disabled.cloudflare.status, "not_configured"); assert.deepEqual(disabled.cloudflare.metrics, []);
});
test("older in-flight response cannot overwrite a newer completed attempt", async () => {
  let release, started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const old = collectUsageStatistics(env, now + 40 * 60_000, async (url, options) => { if (JSON.parse(options.body).query.includes("UsageD1")) { started(); await new Promise((resolve) => { release = resolve; }); } return success(url, options); });
  await startedPromise;
  await collectUsageStatistics(env, now + 41 * 60_000, async () => new Response("{}", { status: 429 }));
  release(); await old;
  const result = await read(); assert.equal(result.cloudflare.error, "rate_limited"); assert.equal(result.cloudflare.attempted_at, new Date(now + 41 * 60_000).toISOString()); assert.equal(result.cloudflare.collected_at, new Date(now + 15 * 60_000).toISOString());
});
test("changed resources discard previous snapshot and missing configuration does no I/O", async () => {
  const changed = { ...env, USAGE_D1_DATABASE_ID: "other-database", USAGE_R2_BUCKET_NAME: undefined };
  assert.equal((await readUsage(changed, owner)).cloudflare.status, "pending");
  await collectUsageStatistics(changed, now + 50 * 60_000, async () => new Response("{}", { status: 403 }));
  const result = await readUsage(changed, owner); assert.equal(result.cloudflare.status, "error"); assert.deepEqual(result.cloudflare.metrics, []);
  await collectUsageStatistics({ ...env, USAGE_ANALYTICS_TOKEN: undefined }, now + 60 * 60_000, () => { throw new Error("must not fetch"); });
});
test("response size is bounded and timed out requests preserve safe error", async () => {
  await collectUsageStatistics(env, now + 70 * 60_000, async () => new Response("x".repeat(65537)));
  assert.equal((await read()).cloudflare.error, "invalid_response");
  await collectUsageStatistics(env, now + 71 * 60_000, async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("secret upstream detail")))));
  assert.equal((await read()).cloudflare.error, "timeout");
});

test("Web and Skill refresh modes share fresh cache and concurrent cooldown", async () => {
  await env.DB.prepare("UPDATE usage_statistics SET attempted_at=NULL, collected_at=NULL, error=NULL, metrics_json=NULL, config_key=NULL").run();
  const defaultEnabled = { ...env, USAGE_ANALYTICS_ENABLED: undefined };
  let calls = 0;
  const count = async (...args) => { calls++; return success(...args); };
  await collectUsageStatistics(defaultEnabled, now, count, "stale");
  assert.equal(calls, 2);
  await collectUsageStatistics(defaultEnabled, now + 60_000, count, "stale");
  assert.equal(calls, 2);
  await collectUsageStatistics(defaultEnabled, now + 60_000, count, "manual");
  assert.equal(calls, 2);
  await collectUsageStatistics(defaultEnabled, now + 60_001, count, "manual");
  assert.equal(calls, 2);
  assert.equal((await readUsage(defaultEnabled, owner, now + 60_001)).cloudflare.collected_at, new Date(now).toISOString());
  let release, started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const inFlight = collectUsageStatistics(defaultEnabled, now + 16 * 60_000, async (...args) => { if (JSON.parse(args[1].body).query.includes("UsageD1")) { started(); await new Promise(resolve => { release=resolve; }); } return success(...args); }, "stale");
  await startedPromise;
  const pending = await readUsage(defaultEnabled, owner, now + 16 * 60_000 + 1);
  assert.equal(pending.cloudflare.status, "stale"); assert.equal(pending.cloudflare.refreshing, true);
  await collectUsageStatistics(defaultEnabled, now + 16 * 60_000 + 1, () => { throw new Error("concurrent request must be suppressed"); }, "manual");
  release(); await inFlight;
  assert.equal((await readUsage(defaultEnabled, owner, now + 16 * 60_000 + 2)).cloudflare.refreshing, false);
  assert.equal((await readUsage(defaultEnabled, owner, now + 31 * 60_000)).cloudflare.status, "stale");
});

test("HTTP owner bearer/admin cookie access, no-store, CSRF and validation", async () => {
  const ownerId=randomUUID(), credentialId=randomUUID(), token=`cfk_v1_owner_${"A".repeat(43)}`;
  const hash = value => createHash("sha256").update(value).digest("hex");
  await bootstrapInstance(env.DB, { instanceId: randomUUID(), operationId: randomUUID(), ownerCredentialId: credentialId, ownerCredentialToken: token, ownerDisplayName: "Usage Owner", ownerPrincipalId: ownerId, preferredApiOrigin: "https://usage.example.test" });
  const now=Date.now(), csrf="C".repeat(32);
  await env.DB.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES (?1,?2,?3,'credential',?4,'admin',?5,?6,?7)`).bind(randomUUID(),hash("U".repeat(43)),ownerId,credentialId,JSON.stringify({kind:"admin",entry_path:"/app/admin",section:"overview"}),now+3600000,now).run();
  const local = { ...env, USAGE_ANALYTICS_ENABLED:"false" };
  const call = (method="GET", headers={}, body) => fetchWorker(new Request(`https://usage.example.test/api/v1/admin/usage${method==="POST"?"/refresh":""}`, { method, headers:{...headers,...(body?{"content-type":"application/json"}:{})}, ...(body?{body:JSON.stringify(body)}:{}) }),local);
  const bearer={authorization:`Bearer ${token}`};
  let response=await call("GET",bearer); assert.equal(response.status,200); assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal((await call()).status,401);
  assert.equal((await call("POST",bearer,{mode:"manual"})).status,200);
  assert.equal((await call("POST",bearer,{mode:"invalid"})).status,400);
  const cookie={cookie:`cfkanban_session=${"U".repeat(43)}; cfkanban_csrf=${csrf}`};
  assert.equal((await call("GET",cookie)).status,200);
  assert.equal((await call("POST",cookie,{mode:"stale"})).status,403);
  assert.equal((await call("POST",{...cookie,origin:"https://usage.example.test","x-csrf-token":csrf},{mode:"stale"})).status,200);
  const workspaceId=randomUUID(), projectId=randomUUID();
  await env.DB.prepare("UPDATE web_sessions SET target_kind='project',target_json=?1 WHERE token_digest=?2").bind(JSON.stringify({kind:"project",workspace_id:workspaceId,project_id:projectId,entry_path:`/app/w/${workspaceId}/p/${projectId}`}),hash("U".repeat(43))).run();
  assert.equal((await call("GET",cookie)).status,403);
  assert.equal((await call("POST",{...cookie,origin:"https://usage.example.test","x-csrf-token":csrf},{mode:"manual"})).status,403);
  const participant=randomUUID(), participantToken=`cfk_v1_writer_${"B".repeat(43)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals(id,display_name,created_at,updated_at) VALUES (?1,'Participant',?2,?2)").bind(participant,now),
    env.DB.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,'writer',?3,?4,?5)").bind(randomUUID(),participant,hash(participantToken),now,randomUUID()),
  ]);
  assert.equal((await call("GET",{authorization:`Bearer ${participantToken}`})).status,403);
  assert.equal((await call("POST",{authorization:`Bearer ${participantToken}`},{mode:"manual"})).status,403);
  await env.DB.prepare("UPDATE usage_statistics SET attempted_at=?1,collected_at=NULL,error=NULL").bind(now-60000).run();
  const interrupted=await readUsage(env,owner,now); assert.equal(interrupted.cloudflare.status,"error"); assert.equal(interrupted.cloudflare.error,"collection_interrupted"); assert.equal(interrupted.cloudflare.refreshing,false);
  await env.DB.prepare("UPDATE usage_statistics SET collected_at=?1").bind(now-120000).run();
  await collectUsageStatistics(env,now,async () => new Response(JSON.stringify({data:{viewer:{accounts:[{activity:[],storage:[]}]}}})),"stale");
  assert.equal((await readUsage(env,owner,now)).cloudflare.collected_at,new Date(now).toISOString());
});

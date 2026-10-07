import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { fetchWorker } from "../../apps/worker/src/index.ts";
import { collectUsageHistory, readUsageHistory } from "../../apps/worker/src/services/usage-history.ts";

// 本地测试配置使用固定占位 D1 ID；所有采集均禁用或显式传入内存响应，不连接 Cloudflare。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.attachments-test.jsonc" }] });
const worker = server.getWorker();
let env;
before(async () => { await server.listen(); await worker.applyD1Migrations("DB"); env = await worker.getEnv(); });
after(() => server.close());

test("history HTTP access requires current Owner/admin session, strict query/body and cookie CSRF", async () => {
  const ownerId = randomUUID(), credentialId = randomUUID(), token = `cfk_v1_owner_${"A".repeat(43)}`, csrf = "C".repeat(32), session = "H".repeat(43), now = Date.now();
  const hash = value => createHash("sha256").update(value).digest("hex");
  await bootstrapInstance(env.DB, { instanceId: randomUUID(), operationId: randomUUID(), ownerCredentialId: credentialId, ownerCredentialToken: token, ownerDisplayName: "History_Owner", ownerPrincipalId: ownerId, preferredApiOrigin: "https://history.example.test" });
  await env.DB.prepare("INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at) VALUES (?1,?2,?3,'credential',?4,'admin',?5,?6,?7)").bind(randomUUID(), hash(session), ownerId, credentialId, JSON.stringify({ kind: "admin", entry_path: "/app/admin", section: "overview" }), now + 3_600_000, now).run();
  const local = { ...env, USAGE_HISTORY_ENABLED: "false" }, bearer = { authorization: `Bearer ${token}` }, cookie = { cookie: `cfkanban_session=${session}; cfkanban_csrf=${csrf}` };
  const call = (path = "", method = "GET", headers = bearer, body) => fetchWorker(new Request(`https://history.example.test/api/v1/admin/usage/history${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), local);
  let response = await call("?days=7"); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal((await response.json()).missing_days.length, 7);
  assert.equal((await call("", "GET", {})).status, 401);
  for (const query of ["?days=0", "?days=91", "?days=01", "?days=1.5", "?days=7&days=8", "?days="]) assert.equal((await call(query)).status, 400, query);
  const day = new Date(Math.floor(now / 86_400_000) * 86_400_000 - 86_400_000).toISOString().slice(0, 10);
  assert.equal((await call("/collect", "POST", bearer, { day })).status, 200);
  for (const body of [{}, { day, token: "must-be-rejected" }, { day: "2026-02-30" }]) assert.equal((await call("/collect", "POST", bearer, body)).status, 400);
  assert.equal((await call("", "GET", cookie)).status, 200);
  assert.equal((await call("/collect", "POST", cookie, { day })).status, 403);
  const protectedCookie = { ...cookie, origin: "https://history.example.test", "x-csrf-token": csrf };
  assert.equal((await call("/collect", "POST", protectedCookie, { day })).status, 200);
  const workspaceId = randomUUID(), projectId = randomUUID();
  await env.DB.prepare("UPDATE web_sessions SET target_kind='project',target_json=?1 WHERE token_digest=?2").bind(JSON.stringify({ kind: "project", workspace_id: workspaceId, project_id: projectId, entry_path: `/app/w/${workspaceId}/p/${projectId}` }), hash(session)).run();
  assert.equal((await call("", "GET", cookie)).status, 403); assert.equal((await call("/collect", "POST", protectedCookie, { day })).status, 403);
  const participant = randomUUID(), participantToken = `cfk_v1_writer_${"B".repeat(43)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'Participant',lower('Participant'),?2,?2)").bind(participant, now),
    env.DB.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'writer',?3,?4,?5)").bind(randomUUID(), participant, hash(participantToken), now, randomUUID()),
  ]);
  const ordinary = { authorization: `Bearer ${participantToken}` };
  assert.equal((await call("", "GET", ordinary)).status, 403); assert.equal((await call("/collect", "POST", ordinary, { day })).status, 403);
});

test("real D1 read cost stays bounded at the global row cap for dense and empty 90-day histories", async () => {
  const now = Date.parse("2026-10-07T12:00:00Z"), today = Date.parse("2026-10-07T00:00:00Z"), owner = { kind: "bearer", isOwner: true };
  const configuration = { USAGE_HISTORY_ENABLED: "true", USAGE_ACCOUNT_ID: "local-account", USAGE_D1_DATABASE_ID: "local-database", USAGE_ANALYTICS_TOKEN: "synthetic-local-only" };
  const key = JSON.stringify([configuration.USAGE_ACCOUNT_ID, configuration.USAGE_D1_DATABASE_ID, null, null, false]);
  await env.DB.prepare("DELETE FROM usage_history").run();
  const statements = [];
  for (let index = 0; index < 630; index++) {
    const day = new Date(today - (index % 90 + 1) * 86_400_000).toISOString().slice(0, 10), metrics = [{ key: "d1_rows_read", value: 0, unit: "count", source: "cloudflare", scope: "instance", period_start: `${day}T00:00:00.000Z`, period_end: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString(), observed_at: null }];
    statements.push(env.DB.prepare("INSERT INTO usage_history(config_key,day,attempted_at,collected_at,metrics_json) VALUES(?1,?2,?3,?3,?4)").bind(index < 90 ? key : `old-config-${index}`, day, now - 60_001, JSON.stringify(metrics)));
  }
  for (let index = 0; index < statements.length; index += 100) await env.DB.batch(statements.slice(index, index + 100));
  const costs = [];
  const DB = { prepare(sql) {
    let statement = env.DB.prepare(sql);
    return { bind(...values) { statement = statement.bind(...values); return this; }, first(...args) { return statement.first(...args); }, async all() { const result = await statement.all(); costs.push({ sql, ...result.meta }); return result; }, async run() { const result = await statement.run(); costs.push({ sql, ...result.meta }); return result; } };
  } };
  const local = { ...env, ...configuration, DB };
  let result = await readUsageHistory(local, owner, 90, now); assert.equal(result.items.length, 90); assert.deepEqual(result.missing_days, []); assert.ok(costs.at(-1).rows_read <= 91, JSON.stringify(costs.at(-1)));
  result = await readUsageHistory({ ...local, USAGE_D1_DATABASE_ID: "missing-config" }, owner, 90, now); assert.equal(result.items.length, 0); assert.equal(result.missing_days.length, 90); assert.ok(costs.at(-1).rows_read <= 1, JSON.stringify(costs.at(-1)));
  costs.length = 0;
  await collectUsageHistory(local, owner, "2026-10-06", now, async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ activity: [{ sum: { rowsRead: 0, rowsWritten: 0 } }], storage: [] }] } } })));
  const removals = costs.filter(value => value.sql.startsWith("DELETE")); assert.ok(removals.every(value => value.changes <= 7)); assert.ok(removals.every(value => value.rows_read <= 200), JSON.stringify(removals));
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS count FROM usage_history").first()).count, 623);
  assert.equal((await readUsageHistory(local, owner, 90, now)).items.length, 90);
});

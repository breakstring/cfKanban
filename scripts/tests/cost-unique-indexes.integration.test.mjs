import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";

// 全零 D1 ID、127.0.0.1:0、persist:false；只使用合成身份和隔离本地 D1。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker(), principal = randomUUID();
const digest = value => createHash("sha256").update(value).digest("hex");
const indexes = [["credentials", "token_digest", "idx_credentials_token_digest"],
  ["browser_launches", "code_digest", "idx_browser_launches_code_digest"],
  ["web_sessions", "token_digest", "idx_web_sessions_token_digest"]];
let db;
before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); ({ DB: db } = await worker.getEnv());
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'Synthetic','synthetic',1,1)").bind(principal).run();
});
after(() => server.close());

async function insertResources() {
  const credential = randomUUID(), launch = randomUUID(), session = randomUUID();
  const target = JSON.stringify({ kind: "admin", section: "overview", entry_path: "/app/admin" });
  const queries = [
    db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'synthetic',?3,1,?1)").bind(credential, principal, digest(credential)),
    db.prepare(`INSERT INTO browser_launches(id,code_prefix,code_digest,principal_id,source_credential_id,target_kind,target_json,expires_at,created_at,created_operation_id)
      VALUES(?1,'synthetic',?2,?3,?4,'admin',?5,10,1,?1)`).bind(launch, digest(launch), principal, credential, target),
    db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at,created_operation_id)
      VALUES(?1,?2,?3,'credential',?4,'admin',?5,10,1,?1)`).bind(session, digest(session), principal, credential, target),
  ];
  const result = [];
  for (const query of queries) result.push((await query.run()).meta);
  return result;
}

test("去掉重复摘要索引后每次创建少写一条索引记录，摘要点查及唯一性保留", async t => {
  for (const [table, column, name] of indexes) await db.prepare(`CREATE UNIQUE INDEX ${name} ON ${table}(${column})`).run();
  const before = await insertResources();
  for (const [, , name] of indexes) await db.prepare(`DROP INDEX ${name}`).run();
  const after = await insertResources();
  const costs = indexes.map(([table], index) => ({ table, before: before[index].rows_written, after: after[index].rows_written }));
  for (const cost of costs) assert.equal(cost.before - cost.after, 1, cost.table);
  for (const [table, column] of indexes) {
    const row = await db.prepare(`SELECT id,${column} AS digest FROM ${table} LIMIT 1`).first();
    const read = await db.prepare(`SELECT id FROM ${table} WHERE ${column}=?1`).bind(row.digest).all();
    assert.deepEqual(read.results, [{ id: row.id }]); assert.ok(read.meta.rows_read <= 2);
  }
  t.diagnostic(JSON.stringify({ scenario: "local-d1-duplicate-unique-indexes", costs }));
  t.diagnostic("本地 D1 meta 不代表线上计费保证；唯一约束和迁移回滚另由 schema 22 测试覆盖。");
});

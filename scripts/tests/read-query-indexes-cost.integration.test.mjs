import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";

// 仅量化索引的本地 SQL 成本；服务测试另行保障授权、配额、原子审计及完整事务。
// 全零 D1 ID、127.0.0.1:0、persist:false，全部身份与数据为合成 fixture。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker(), ownerId = randomUUID(), fixtureSize = 1000, now = Date.now();
const hash = value => createHash("sha256").update(value).digest("hex");
const id = (family, n) => `600000${family}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const sqlId = (family, expression = "n") => `printf('600000${family}-0000-4000-8000-%012x',${expression})`;
const workspaceId = id("02", 1), projectId = id("03", 1), sourceIssueId = id("04", 1);
const migration = await readFile(new URL("../../migrations/0018_read_query_indexes.sql", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const definitions = [...migration.matchAll(/CREATE INDEX\s+(\w+)\s+ON\s+(\w+)\s*[^;]+;/gu)]
  .map(match => ({ name: match[1], table: match[2], sql: match[0] }));
let db;
const run = async (sql, values = []) => db.prepare(sql).bind(...values).run();
const sequence = `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<${fixtureSize})`;

before(async () => {
  await server.listen(); await worker.applyD1Migrations("DB"); ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: ownerId,
    ownerCredentialId: randomUUID(), ownerCredentialToken: `cfk_v1_cost_${"A".repeat(43)}`,
    ownerDisplayName: "IndexCostOwner", preferredApiOrigin: "https://index-cost.example.test" });
  assert.equal(definitions.length, 11);
  // 只在此隔离 fixture 删除 0018 的索引，保留已应用的 schema 元数据和约束。
  for (const definition of definitions) await db.prepare(`DROP INDEX ${definition.name}`).run();
  await run(`${sequence} INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at)
    SELECT ${sqlId("01")},printf('CostMember%d',n),printf('costmember%d',n),?1,?1 FROM seq`, [now]);
  await run(`${sequence} INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id,deleted_at,deleted_by_principal_id)
    SELECT ${sqlId("02")},printf('Cost workspace %d',n),?1,?1,?2,?2,printf('workspace-%d',n),
      CASE WHEN n%2=0 THEN ?1 ELSE NULL END,CASE WHEN n%2=0 THEN ?2 ELSE NULL END FROM seq`, [now, ownerId]);
  await run(`${sequence} INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    SELECT ${sqlId("03")},?1,printf('Cost project %d',n),?2,?2,?3,?3,printf('project-%d',n) FROM seq`, [workspaceId, now, ownerId]);
  await run(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<=${fixtureSize})
    INSERT INTO issues(id,project_id,title,title_search,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    SELECT ${sqlId("04")},?1,printf('Cost issue %d',n),printf('cost issue %d',n),?2,?2,?3,?3,printf('issue-%d',n) FROM seq`, [projectId, now, ownerId]);
  await run(`${sequence} INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id,revoked_at,revoked_by_principal_id)
    SELECT ${sqlId("05")},?1,'synthetic',printf('%064x',n),?2+n,printf('credential-%d',n),
      CASE WHEN n%100<>0 THEN ?2 ELSE NULL END,CASE WHEN n%100<>0 THEN ?1 ELSE NULL END FROM seq`, [ownerId, now]);
  await run(`${sequence} INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id,revoked_at,revoked_by_principal_id)
    SELECT ${sqlId("06")},${sqlId("01")},${sqlId("03")},'reader',?1,?1,printf('grant-%d',n),
      CASE WHEN n%2=0 THEN ?1 ELSE NULL END,CASE WHEN n%2=0 THEN ?2 ELSE NULL END FROM seq`, [now, ownerId]);
  await run(`${sequence} INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,created_at,updated_at,created_operation_id,revoked_at)
    SELECT ${sqlId("07")},${sqlId("01")},?1,CASE WHEN n%2=0 THEN ${sqlId("03")} ELSE NULL END,
      printf('generation-%d',n),?2,?2,printf('administrator-%d',n),CASE WHEN n%3=0 THEN ?2 ELSE NULL END FROM seq`, [workspaceId, now]);
  await run(`${sequence} INSERT INTO invitations(id,kind,code_prefix,code_digest,expires_at,created_at,created_by_owner_principal_id,created_operation_id)
    SELECT ${sqlId("08")},'project_grant','synthetic',printf('%064x',n),?1+86400000,?1,?2,printf('invitation-%d',n) FROM seq`, [now, ownerId]);
  await run(`${sequence} INSERT INTO invitation_project_grants(invitation_id,project_id,role)
    SELECT ${sqlId("08")},${sqlId("03")},'reader' FROM seq`);
  await run(`${sequence} INSERT INTO labels(id,project_id,name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id,deleted_at,deleted_by_principal_id)
    SELECT ${sqlId("09")},?1,printf('Cost label %d',n),?2,?2,?3,?3,printf('label-%d',n),
      CASE WHEN n%2=0 THEN ?2 ELSE NULL END,CASE WHEN n%2=0 THEN ?3 ELSE NULL END FROM seq`, [projectId, now, ownerId]);
  await run(`${sequence} INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id,deleted_at,deleted_by_principal_id)
    SELECT ${sqlId("10")},?1,'related',?2,${sqlId("04", "n+1")},?3,?3,?4,?5,printf('relation-%d',n),
      CASE WHEN n%2=0 THEN ?4 ELSE NULL END,CASE WHEN n%2=0 THEN ?5 ELSE NULL END FROM seq`, [workspaceId, sourceIssueId, projectId, now, ownerId]);
  await run(`${sequence} INSERT INTO attachment_objects(id,object_key,size_bytes,sha256,state,expires_at,created_at,created_operation_id,garbage_at,budget_released_at)
    SELECT ${sqlId("11")},printf('attachments/fixture-%d',n),1,?1,'garbage',?2,?2,printf('object-%d',n),?2,?2 FROM seq`, [hash("synthetic"), now]);
  await run(`${sequence} INSERT INTO issue_attachments(id,issue_id,filename,content_type,uploaded_by_principal_id,created_at,created_operation_id,deleted_at,deleted_by_principal_id)
    SELECT ${sqlId("11")},?1,'synthetic.log','text/plain',?2,?3,printf('attachment-%d',n),
      CASE WHEN n%2=0 THEN ?3 ELSE NULL END,CASE WHEN n%2=0 THEN ?2 ELSE NULL END FROM seq`, [sourceIssueId, ownerId, now]);
  await run(`${sequence} INSERT INTO web_authenticators(id,principal_id,credential_id,public_key_cose,algorithm,user_handle,backup_eligible,backup_state,rp_id,created_at,created_operation_id,revoked_at,revoked_by_principal_id)
    SELECT ${sqlId("12")},?1,printf('authenticator-%d',n),'synthetic',-7,'synthetic',0,0,'index-cost.example.test',?2,
      printf('passkey-%d',n),CASE WHEN n%100<>0 THEN ?2 ELSE NULL END,CASE WHEN n%100<>0 THEN ?1 ELSE NULL END FROM seq`, [ownerId, now]);
});
after(() => server.close());

async function typicalWrites() {
  const costs = new Map();
  const measure = async (name, sql, values = []) => {
    const result = await run(sql, values); assert.equal(result.meta.changes, 1, name);
    costs.set(name, { read: result.meta.rows_read, written: result.meta.rows_written });
  };
  const principal = randomUUID(), workspace = randomUUID(), credential = randomUUID(), grant = randomUUID();
  const administrator = randomUUID(), workspaceAdministrator = randomUUID(), invitation = randomUUID(), label = randomUUID();
  const targetIssue = randomUUID(), relation = randomUUID(), attachment = randomUUID(), authenticator = randomUUID();
  await run("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,?2,?2,?3,?3)", [principal, `cost_${principal}`, now]);
  await run(`INSERT INTO issues(id,project_id,title,title_search,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,'Cost target','cost target',?3,?3,?4,?4,?1)`, [targetIssue, projectId, now, ownerId]);
  await measure("workspace.insert", `INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,'Cost workspace',?2,?2,?3,?3,?1)`, [workspace, now, ownerId]);
  await measure("workspace.rename", "UPDATE workspaces SET display_name='Renamed workspace',version=version+1 WHERE id=?1", [workspace]);
  await measure("workspace.archive", "UPDATE workspaces SET deleted_at=?2,deleted_by_principal_id=?3,version=version+1 WHERE id=?1", [workspace, now, ownerId]);
  await measure("credential.insert", `INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id)
    VALUES(?1,?2,'synthetic',?3,?4,?1)`, [credential, principal, hash(credential), now]);
  await measure("credential.revoke", "UPDATE credentials SET revoked_at=?2,revoked_by_principal_id=?3 WHERE id=?1", [credential, now, ownerId]);
  await measure("grant.insert", `INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,'reader',?4,?4,?1)`, [grant, principal, projectId, now]);
  await measure("grant.revoke", "UPDATE project_grants SET revoked_at=?2,revoked_by_principal_id=?3,version=version+1 WHERE id=?1", [grant, now, ownerId]);
  for (const [name, target, project] of [["project", administrator, projectId], ["workspace", workspaceAdministrator, null]]) {
    await measure(`administrator.${name}.insert`, `INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,created_at,updated_at,created_operation_id)
      VALUES(?1,?2,?3,?4,?1,?5,?5,?1)`, [target, principal, workspaceId, project, now]);
    await measure(`administrator.${name}.revoke`, "UPDATE scoped_administrator_grants SET revoked_at=?2,revoked_by_principal_id=?3,version=version+1 WHERE id=?1", [target, now, ownerId]);
  }
  await measure("invitation.insert", `INSERT INTO invitations(id,kind,code_prefix,code_digest,expires_at,created_at,created_by_owner_principal_id,created_operation_id)
    VALUES(?1,'project_grant','synthetic',?2,?3,?4,?5,?1)`, [invitation, hash(invitation), now + 86400000, now, ownerId]);
  await measure("invitation.target.insert", "INSERT INTO invitation_project_grants(invitation_id,project_id,role) VALUES(?1,?2,'reader')", [invitation, projectId]);
  await measure("invitation.revoke", "UPDATE invitations SET revoked_at=?2,revoked_by_principal_id=?3 WHERE id=?1", [invitation, now, ownerId]);
  await measure("label.insert.active", `INSERT INTO labels(id,project_id,name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,?1,?3,?3,?4,?4,?1)`, [label, projectId, now, ownerId]);
  await measure("label.rename", "UPDATE labels SET name=?2,version=version+1 WHERE id=?1", [label, `renamed_${label}`]);
  await measure("label.delete", "UPDATE labels SET deleted_at=?2,deleted_by_principal_id=?3,version=version+1 WHERE id=?1", [label, now, ownerId]);
  await measure("label.restore", "UPDATE labels SET deleted_at=NULL,deleted_by_principal_id=NULL,version=version+1 WHERE id=?1", [label]);
  await measure("relation.insert.active", `INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id)
    VALUES(?1,?2,'related',?3,?4,?5,?5,?6,?7,?1)`, [relation, workspaceId, sourceIssueId, targetIssue, projectId, now, ownerId]);
  await measure("relation.delete", "UPDATE issue_relations SET deleted_at=?2,deleted_by_principal_id=?3,version=version+1 WHERE id=?1", [relation, now, ownerId]);
  await measure("relation.restore", "UPDATE issue_relations SET deleted_at=NULL,deleted_by_principal_id=NULL,version=version+1 WHERE id=?1", [relation]);
  await run(`INSERT INTO attachment_objects(id,object_key,size_bytes,sha256,state,expires_at,created_at,created_operation_id)
    VALUES(?1,?2,1,?3,'ready',?4,?5,?1)`, [attachment, `attachments/${attachment}`, hash("synthetic"), now + 86400000, now]);
  await run("UPDATE attachment_storage SET reserved_bytes=reserved_bytes+1 WHERE singleton=1");
  await measure("attachment.insert.active", `INSERT INTO issue_attachments(id,issue_id,filename,content_type,uploaded_by_principal_id,created_at,created_operation_id)
    VALUES(?1,?2,'synthetic.log','text/plain',?3,?4,?1)`, [attachment, sourceIssueId, ownerId, now]);
  await measure("attachment.delete", "UPDATE issue_attachments SET deleted_at=?2,deleted_by_principal_id=?3,version=version+1 WHERE id=?1", [attachment, now, ownerId]);
  await measure("attachment.restore", "UPDATE issue_attachments SET deleted_at=NULL,deleted_by_principal_id=NULL,version=version+1 WHERE id=?1", [attachment]);
  await measure("passkey.insert", `INSERT INTO web_authenticators(id,principal_id,credential_id,public_key_cose,algorithm,user_handle,backup_eligible,backup_state,rp_id,created_at,created_operation_id)
    VALUES(?1,?2,?1,'synthetic',-7,'synthetic',0,0,'index-cost.example.test',?3,?1)`, [authenticator, principal, now]);
  await measure("passkey.revoke", "UPDATE web_authenticators SET revoked_at=?2,revoked_by_principal_id=?3,version=version+1 WHERE id=?1", [authenticator, now, ownerId]);
  return costs;
}

test("0018 的 11 个索引一次构建成本及同形业务写入放大可复现", async t => {
  const baseline = await typicalWrites(), creationCosts = [];
  for (const definition of definitions) {
    const where = /\bWHERE\s+([^;]+);$/u.exec(definition.sql)?.[1];
    const indexedRows = (await db.prepare(`SELECT COUNT(*) AS n FROM ${definition.table}${where ? ` WHERE ${where}` : ""}`).first()).n;
    const tableRows = (await db.prepare(`SELECT COUNT(*) AS n FROM ${definition.table}`).first()).n;
    const result = await db.prepare(definition.sql).run();
    for (const value of [result.meta.rows_read, result.meta.rows_written]) assert.ok(Number.isSafeInteger(value) && value >= 0);
    creationCosts.push({ index: definition.name, table_rows: tableRows, indexed_rows: indexedRows,
      rows_read: result.meta.rows_read, rows_written: result.meta.rows_written });
  }
  const indexed = await typicalWrites();
  const expectedDelta = {
    "workspace.insert": 1, "workspace.rename": 1, "workspace.archive": 1,
    "credential.insert": 1, "credential.revoke": 0, "grant.insert": 1, "grant.revoke": 0,
    "administrator.project.insert": 1, "administrator.project.revoke": 0,
    "administrator.workspace.insert": 1, "administrator.workspace.revoke": 0,
    "invitation.insert": 1, "invitation.target.insert": 1, "invitation.revoke": 0,
    "label.insert.active": 1, "label.rename": 1, "label.delete": 0, "label.restore": 1,
    "relation.insert.active": 2, "relation.delete": 0, "relation.restore": 2,
    "attachment.insert.active": 0, "attachment.delete": 1, "attachment.restore": 0,
    "passkey.insert": 1, "passkey.revoke": 0,
  };
  assert.deepEqual([...baseline.keys()], [...indexed.keys()]);
  const writes = [...baseline].map(([operation, before]) => {
    const after = indexed.get(operation), delta = after.written - before.written;
    return { operation, baseline_rows_written: before.written, indexed_rows_written: after.written, added_rows_written: delta };
  });
  assert.equal((await db.prepare("SELECT schema_version FROM instance_meta WHERE singleton=1").first()).schema_version, manifest.schema_version);
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  t.diagnostic(JSON.stringify({ scenario: "local-d1-index-build", fixture_rows_per_family: fixtureSize, indexes: creationCosts }));
  t.diagnostic(JSON.stringify({ scenario: "local-d1-index-write-amplification", operations: writes }));
  for (const row of writes) assert.equal(row.added_rows_written, expectedDelta[row.operation], row.operation);
  t.diagnostic("本地 D1 meta 是观测结果，不代表线上计费、迁移耗时或完整 API 事务写入量保证。");
});

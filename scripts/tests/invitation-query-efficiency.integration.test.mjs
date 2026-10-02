import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { authenticateBearer } from "../../apps/worker/src/kernel/auth.ts";
import { createCursorContext, encodeCursor } from "../../apps/worker/src/kernel/cursor.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { listInvitations } from "../../apps/worker/src/services/invitations.ts";

const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const ids = Object.fromEntries(["owner", "manager", "ownerCredential", "managerCredential", "workspace", "hiddenWorkspace", "project", "hiddenProject", "administrator"].map(name => [name, randomUUID()]));
const ownerToken = `cfk_v1_inviteowner_${"A".repeat(43)}`, managerToken = `cfk_v1_invitemanager_${"B".repeat(43)}`;
const digest = value => createHash("sha256").update(value).digest("hex");
const now = Date.now(), generation = randomUUID();
const visible = Array.from({ length: 60 }, () => randomUUID()), hidden = Array.from({ length: 600 }, () => randomUUID());
let db, owner, manager;

function observe(afterQuery = async () => {}) {
  const queries = [];
  const wrap = (statement, sql, values = []) => new Proxy(statement, { get(target, key) {
    if (key === "bind") return (...args) => wrap(target.bind(...args), sql, args);
    if (["all", "first"].includes(key)) return async (...args) => {
      const result = await target.all();
      queries.push({ sql, values, rows_read: result.meta.rows_read });
      await afterQuery(sql, result);
      if (key === "all") return result;
      const row = result.results[0] ?? null;
      return row === null || args[0] === undefined ? row : row[args[0]];
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { queries, database: new Proxy(db, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}
async function seed(sql, values) {
  for (let offset = 0; offset < values.length; offset += 100) await db.batch(values.slice(offset, offset + 100).map(row => db.prepare(sql).bind(...row)));
}
function url(parameters = "") { return new URL(`https://kanban.example.test/api/v1/admin/invitations?limit=20&${parameters}`); }

before(async () => {
  await server.listen(); const worker = server.getWorker(); await worker.applyD1Migrations("DB"); ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: ids.owner,
    ownerCredentialId: ids.ownerCredential, ownerCredentialToken: ownerToken, ownerDisplayName: "InvitationOwner", preferredApiOrigin: "https://kanban.example.test" });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'InvitationManager','invitationmanager',1,1)").bind(ids.manager).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'invitemanager',?3,1,?4)")
    .bind(ids.managerCredential, ids.manager, digest(managerToken), randomUUID()).run();
  await seed(`INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,1,1,?3,?3,?4)`, [[ids.workspace, "Managed", ids.owner, randomUUID()], [ids.hiddenWorkspace, "Hidden", ids.owner, randomUUID()]]);
  await seed(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,?3,1,1,?4,?4,?5)`, [[ids.project, ids.workspace, "Managed", ids.owner, randomUUID()], [ids.hiddenProject, ids.hiddenWorkspace, "Hidden", ids.owner, randomUUID()]]);
  await db.prepare(`INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,?4,?5,1,1,?5)`).bind(ids.administrator, ids.manager, ids.workspace, ids.project, generation).run();
  await seed(`INSERT INTO invitations(id,kind,code_prefix,code_digest,expires_at,created_at,created_by_owner_principal_id,created_operation_id)
    VALUES(?1,'project_grant','test',?2,?3,?4,?5,?6)`, [...visible.map(id => [id, digest(id), now + 86400000, now - 1, ids.owner, randomUUID()]),
    ...hidden.map(id => [id, digest(id), now + 86400000, now, ids.owner, randomUUID()])]);
  await seed("INSERT INTO invitation_project_grants(invitation_id,project_id,role) VALUES(?1,?2,'writer')",
    [...visible.map(id => [id, ids.project]), ...hidden.map(id => [id, ids.hiddenProject])]);
  owner = await authenticateBearer(db, `Bearer ${ownerToken}`); manager = await authenticateBearer(db, `Bearer ${managerToken}`);
});
after(() => server.close());

test("稀疏 Project 邀请从目标索引读取，管理校验次数不随页内重复目标增加", async () => {
  const filtered = observe();
  const page = await listInvitations(filtered.database, owner, url(`project_id=${ids.project}`), now);
  assert.deepEqual(page.items.map(row => row.id), visible.toSorted().reverse().slice(0, 20));
  const main = filtered.queries.find(query => query.sql.includes("FROM invitations AS i"));
  const chronological = await db.prepare(`SELECT i.*, bound.display_name AS bound_display_name
    FROM invitations i LEFT JOIN principals bound ON bound.id=i.bound_principal_id
    WHERE EXISTS (SELECT 1 FROM invitation_project_grants target WHERE target.invitation_id=i.id AND target.project_id=?1)
    ORDER BY i.created_at DESC,i.id DESC LIMIT 21`).bind(ids.project).all();
  assert.deepEqual(page.items.map(row => row.id), chronological.results.slice(0, 20).map(row => row.id));
  assert.ok(main.rows_read < chronological.meta.rows_read, `sparse target read ${main.rows_read}, chronological ${chronological.meta.rows_read}`);
  for (const limit of [20, 100]) {
    const measured = observe(), targetUrl = url(); targetUrl.searchParams.set("limit", String(limit));
    const result = await listInvitations(measured.database, manager, targetUrl, now);
    assert.equal(result.items.length, Math.min(limit, visible.length));
    assert.equal(measured.queries.length, 5);
    assert.ok(result.items.every(item => item.grants.length === 1 && item.grants[0].project_id === ids.project));
    assert.ok(measured.queries.reduce((sum, query) => sum + query.rows_read, 0) < 2000);
    console.log(JSON.stringify({ cost: "invitation-managed-page", limit, queries: measured.queries.length, rows_read: measured.queries.reduce((sum, query) => sum + query.rows_read, 0) }));
  }
  console.log(JSON.stringify({ cost: "invitation-sparse-target", rows_read: main.rows_read, chronological_rows_read: chronological.meta.rows_read }));
});

test("邀请续页在同时间戳下无重复遗漏，并从tuple位置seek", async () => {
  let cursor = null, seen = [], firstRead, deepRead;
  do {
    const measured = observe(), target = url(); if (cursor) target.searchParams.set("cursor", cursor);
    const result = await listInvitations(measured.database, owner, target, now);
    const read = measured.queries.find(query => query.sql.includes("FROM invitations AS i")).rows_read;
    firstRead ??= read; deepRead = read; assert.ok(read < 50, `continuation reads ${read}`);
    seen.push(...result.items.map(row => row.id)); cursor = result.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, [...hidden.toSorted().reverse(), ...visible.toSorted().reverse()]);
  assert.equal(new Set(seen).size, seen.length);
  console.log(JSON.stringify({ cost: "invitation-history", first_read: firstRead, deep_read: deepRead }));
});

test("混合隐藏目标仍不可列出，投影后的generation变化、撤权和归档拒绝返回", async () => {
  const mixed = randomUUID();
  await db.prepare(`INSERT INTO invitations(id,kind,code_prefix,code_digest,expires_at,created_at,created_by_owner_principal_id,created_operation_id)
    VALUES(?1,'project_grant','test',?2,?3,?4,?5,?6)`).bind(mixed, digest(mixed), now + 86400000, now + 1, ids.owner, randomUUID()).run();
  await seed("INSERT INTO invitation_project_grants(invitation_id,project_id,role) VALUES(?1,?2,'writer')", [[mixed, ids.project], [mixed, ids.hiddenProject]]);
  assert.ok(!(await listInvitations(db, manager, url(), now)).items.some(item => item.id === mixed));
  for (const [mutation, restore, expected] of [
    [() => db.prepare("UPDATE scoped_administrator_grants SET generation=?1 WHERE id=?2").bind(randomUUID(), ids.administrator).run(), () => db.prepare("UPDATE scoped_administrator_grants SET generation=?1 WHERE id=?2").bind(generation, ids.administrator).run(), 404],
    [() => db.prepare("UPDATE scoped_administrator_grants SET revoked_at=?1,revoked_by_principal_id=?2 WHERE id=?3").bind(now, ids.owner, ids.administrator).run(), () => db.prepare("UPDATE scoped_administrator_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(ids.administrator).run(), 404],
    [() => db.prepare("UPDATE projects SET deleted_at=?1,deleted_by_principal_id=?2 WHERE id=?3").bind(now, ids.owner, ids.project).run(), () => db.prepare("UPDATE projects SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1").bind(ids.project).run(), 404],
    [() => db.prepare("UPDATE credentials SET revoked_at=?1 WHERE id=?2").bind(now, ids.managerCredential).run(), () => db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(ids.managerCredential).run(), 401],
  ]) {
    let changed = false;
    const measured = observe(async sql => {
      if (!changed && sql.includes("FROM invitation_project_grants AS ipg")) { changed = true; await mutation(); }
    });
    try { await assert.rejects(listInvitations(measured.database, manager, url(), now), error => error.status === expected); }
    finally { await restore(); }
    assert.equal(changed, true);
  }
  const missingGeneration = { ...manager, managementGrants: manager.managementGrants.map(grant => ({ ...grant, generation: null })) };
  await assert.rejects(listInvitations(db, missingGeneration, url(), now), error => error.status === 404);
});

test("密集项目的首页和同时间戳深页不读取全部目标历史，空页仍正确", async () => {
  const project = randomUUID(), administrator = randomUUID(), time = now + 10;
  const denseId = n => `e1000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  await db.prepare(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,'Dense',1,1,?3,?3,?1)`).bind(project, ids.workspace, ids.owner).run();
  await db.prepare(`INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,?4,?1,1,1,?1)`).bind(administrator, ids.manager, ids.workspace, project).run();
  const denseManager = await authenticateBearer(db, `Bearer ${managerToken}`);
  const context = await createCursorContext("invitations", { project_id: project }, [`owner:${owner.principalId}`], owner.principalId);
  const costs = [];
  for (const [start, end] of [[1, 10000], [10001, 20000]]) {
    await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM seq WHERE n<?2)
      INSERT INTO invitations(id,kind,code_prefix,code_digest,expires_at,created_at,created_by_owner_principal_id,created_operation_id)
      SELECT printf('e1000000-0000-4000-8000-%012x',n),'project_grant','dense',printf('%064x',n),?3+86400000,?3,?4,printf('dense-%d',n) FROM seq`)
      .bind(start, end, time, ids.owner).run();
    await db.prepare(`WITH RECURSIVE seq(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM seq WHERE n<?2)
      INSERT INTO invitation_project_grants(invitation_id,project_id,role)
      SELECT printf('e1000000-0000-4000-8000-%012x',n),?3,'writer' FROM seq`).bind(start, end, project).run();
    const legacy = await db.prepare(`SELECT i.*, bound.display_name AS bound_display_name FROM invitations AS i
      JOIN invitation_project_grants filtered_target ON filtered_target.invitation_id=i.id AND filtered_target.project_id=?1
      LEFT JOIN principals bound ON bound.id=i.bound_principal_id ORDER BY i.created_at DESC,i.id DESC LIMIT 21`).bind(project).all();
    for (const [actor, filter, last] of [[owner, true, null], [owner, true, 5000], [denseManager, true, null], [denseManager, false, null]]) {
      const measured = observe(), target = url(filter ? `project_id=${project}` : "");
      if (last !== null) target.searchParams.set("cursor", encodeCursor(context, [time, denseId(last)]));
      const result = await listInvitations(measured.database, actor, target, now);
      const main = measured.queries.find(query => query.sql.includes("WITH history_probe"));
      const high = last === null ? end : last - 1;
      assert.deepEqual(result.items.map(row => row.id), Array.from({ length: 20 }, (_, n) => denseId(high - n)));
      assert.ok(result.has_more); assert.ok(main.rows_read < 500, `dense ${end} read ${main.rows_read}`);
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${main.sql}`).bind(...main.values).all()).results.map(row => row.detail);
      assert.ok(plan.some(detail => /SCAN gate/.test(detail)), plan.join("\n"));
      costs.push({ size: end, actor: actor.isOwner ? "owner" : "manager", project_filter: filter, deep: last !== null, rows_read: main.rows_read, legacy_project_first_page_rows_read: legacy.meta.rows_read });
    }
  }
  for (let n = 0; n < 4; n++) assert.ok(Math.abs(costs[n].rows_read - costs[n + 4].rows_read) < 10, "dense history growth must not grow page reads");
  const end = url(`project_id=${project}`);
  end.searchParams.set("cursor", encodeCursor(context, [time, denseId(1)]));
  const measured = observe(), empty = await listInvitations(measured.database, owner, end, now);
  assert.deepEqual(empty.items, []); assert.equal(empty.has_more, false); assert.equal(empty.next_cursor, null);
  const emptyLegacy = await db.prepare(`SELECT i.*, bound.display_name AS bound_display_name FROM invitations AS i
    JOIN invitation_project_grants filtered_target ON filtered_target.invitation_id=i.id AND filtered_target.project_id=?1
    LEFT JOIN principals bound ON bound.id=i.bound_principal_id
    WHERE (i.created_at,i.id)<(?2,?3) ORDER BY i.created_at DESC,i.id DESC LIMIT 21`).bind(project, time, denseId(1)).all();
  const emptyRead = measured.queries.find(query => query.sql.includes("WITH history_probe")).rows_read;
  // 全局范围仍有无关历史时，空结果会启用反查；其目标历史成本需保留，不能称为固定上界。
  assert.ok(emptyRead < emptyLegacy.meta.rows_read + 500, `empty fallback ${emptyRead}, legacy ${emptyLegacy.meta.rows_read}`);
  console.log(JSON.stringify({ cost: "invitation-dense-project", pages: costs, empty_rows_read: emptyRead, empty_legacy_rows_read: emptyLegacy.meta.rows_read }));
});

test("探测和反查的边界不丢失混合目标或并列记录，目标去重在分页前完成", async () => {
  const additional = randomUUID(), grant = randomUUID(), time = now + 20;
  await db.prepare(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,'Additional',1,1,?3,?3,?1)`).bind(additional, ids.workspace, ids.owner).run();
  await db.prepare(`INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,?4,?1,1,1,?1)`).bind(grant, ids.manager, ids.workspace, additional).run();
  const actor = await authenticateBearer(db, `Bearer ${managerToken}`);
  const values = Array.from({ length: 96 }, (_, n) => `e2000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);
  await seed(`INSERT INTO invitations(id,kind,code_prefix,code_digest,expires_at,created_at,created_by_owner_principal_id,created_operation_id)
    VALUES(?1,'project_grant','boundary',?2,?3,?4,?5,?1)`, values.map(id => [id, digest(id), time + 86400000, time, ids.owner]));
  await seed("INSERT INTO invitation_project_grants(invitation_id,project_id,role) VALUES(?1,?2,'writer')", values.flatMap((id, n) => n % 4 === 0
    ? [[id, ids.project], [id, additional]] : [[id, ids.project], [id, ids.hiddenProject]]));
  const wanted = values.filter((_, n) => n % 4 === 0).toSorted().reverse();
  const selected = [];
  let cursor = null;
  // 此时间范围比此前 fixture 新，第一页只有 8 个合法探测结果，剩余页项来自反查。
  for (let page = 0; page < 3; page++) {
    const target = url(`project_id=${additional}`); target.searchParams.set("limit", "10");
    if (cursor) target.searchParams.set("cursor", cursor);
    const result = await listInvitations(db, actor, target, now);
    selected.push(...result.items.map(item => item.id)); cursor = result.next_cursor;
  }
  assert.deepEqual(selected, wanted); assert.equal(cursor, null);
  const multi = await listInvitations(db, actor, url(), now);
  assert.deepEqual(multi.items.map(item => item.id), wanted.slice(0, 20));
  assert.equal(new Set(multi.items.map(item => item.id)).size, multi.items.length);
  assert.ok(multi.items.every(item => item.grants.every(target => target.project_id !== ids.hiddenProject)));
  const empty = randomUUID();
  await db.prepare(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,'No invitations',1,1,?3,?3,?1)`).bind(empty, ids.workspace, ids.owner).run();
  const result = await listInvitations(db, owner, url(`project_id=${empty}`), now);
  assert.deepEqual(result.items, []); assert.equal(result.has_more, false);
});

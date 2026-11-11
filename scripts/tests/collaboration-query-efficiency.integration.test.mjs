import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { authenticateBearer, authenticateCookieSession } from "../../apps/worker/src/kernel/auth.ts";
import { createCursorContext, encodeCursor } from "../../apps/worker/src/kernel/cursor.ts";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { getIssue, getIssueContext } from "../../apps/worker/src/services/issues.ts";
import { listLabels } from "../../apps/worker/src/services/labels.ts";
import { listIssueRelations } from "../../apps/worker/src/services/relations.ts";

const server = createTestHarness({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  workers: [{ configPath: "wrangler.wp02-test.jsonc" }],
});
const owner = randomUUID(), credential = randomUUID(), member = randomUUID(), memberCredential = randomUUID();
const workspace = randomUUID(), projects = [randomUUID(), randomUUID(), randomUUID()], issue = randomUUID(), emptyIssue = randomUUID();
const grants = [randomUUID(), randomUUID()];
const passkey = randomUUID(), cookieSessions = [];
const ownerToken = `cfk_v1_collaboration_${"A".repeat(43)}`;
const memberToken = `cfk_v1_collaborationmember_${"B".repeat(43)}`;
const uuid = (family, n) => `${family}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "https://collaboration.example.test";
const url = (parameters = {}) => {
  const result = new URL(`${origin}/api/v1`);
  for (const [key, value] of Object.entries(parameters)) result.searchParams.set(key, String(value));
  return result;
};
let db, auth, memberAuth, identifier, emptyIdentifier;

async function cookieSession(sourceKind, sourceId, target) {
  const id = randomUUID(), token = randomUUID().replaceAll("-", "") + "C".repeat(12);
  const createdAt = Date.now() - 60_000, expiresAt = createdAt + 28_800_000;
  await db.prepare(`INSERT INTO web_sessions
    (id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,created_at,expires_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`)
    .bind(id,createHash("sha256").update(token).digest("hex"),owner,sourceKind,sourceId,target.kind,JSON.stringify(target),createdAt,expiresAt).run();
  const current = await authenticateCookieSession(db,new Request(origin,{headers:{cookie:`cfkanban_session=${token}`}}));
  return { id, sourceKind, sourceId, createdAt, expiresAt, auth:current };
}

function observe({ beforeQuery = async () => {}, afterQuery = async () => {} } = {}) {
  const queries = [];
  const wrap = (statement, sql, values = []) => new Proxy(statement, { get(target, property) {
    if (property === "bind") return (...bound) => wrap(target.bind(...bound), sql, bound);
    if (["all", "first", "run"].includes(property)) return async (...args) => {
      await beforeQuery(sql);
      const result = await target[property](...args);
      queries.push({ sql, values, result, read: result?.meta?.rows_read });
      await afterQuery(sql, result);
      return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { queries, db: new Proxy(db, { get(target, property) {
    if (property === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}

async function seed(from, to) {
  const sample = "WITH RECURSIVE sample(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM sample WHERE n+1 < ?2) ";
  await db.prepare(sample + `INSERT INTO issues
    (id,project_id,title,title_search,status_key,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    SELECT printf('d1000000-0000-4000-8000-%012d',n), CASE WHEN n % 50 < 2 THEN ?3 ELSE ?4 END,
           'endpoint','endpoint',CASE WHEN n % 5 = 0 THEN 'done' ELSE 'todo' END,
           1000+CAST(n/8 AS INTEGER),1000+CAST(n/8 AS INTEGER),?5,?5,'collaboration-issue-'||n FROM sample`)
    .bind(from,to,projects[1],projects[2],owner).run();
  await db.prepare(sample + `INSERT INTO issue_relations
    (id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id)
    SELECT printf('d2000000-0000-4000-8000-%012d',n),?3,
           CASE CAST(n/2 AS INTEGER) % 4 WHEN 0 THEN 'blocks' WHEN 1 THEN 'parent' WHEN 2 THEN 'duplicate' ELSE 'related' END,
           CASE WHEN n % 2 = 0 THEN ?4 ELSE printf('d1000000-0000-4000-8000-%012d',n) END,
           CASE WHEN n % 2 = 0 THEN printf('d1000000-0000-4000-8000-%012d',n) ELSE ?4 END,
           CASE WHEN n % 2 = 0 THEN ?5 WHEN n % 50 < 2 THEN ?6 ELSE ?7 END,
           CASE WHEN n % 2 != 0 THEN ?5 WHEN n % 50 < 2 THEN ?6 ELSE ?7 END,
           1000+CAST(n/8 AS INTEGER),?8,'collaboration-relation-'||n FROM sample`)
    .bind(from,to,workspace,issue,projects[0],projects[1],projects[2],owner).run();
  for (const deleted of [false, true]) {
    await db.prepare(sample + `INSERT INTO labels
      (id,project_id,name,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
      SELECT printf('${deleted ? "d4" : "d3"}000000-0000-4000-8000-%012d',n),?3,
             CASE WHEN ?5 = 1 THEN 'Deleted ' WHEN n % 2 = 0 THEN 'Label ' ELSE 'label ' END || printf('%06d',n),
             CASE WHEN ?5 = 1 THEN 1000+CAST(n/8 AS INTEGER) ELSE NULL END, CASE WHEN ?5 = 1 THEN ?4 ELSE NULL END,
             1000+CAST(n/8 AS INTEGER),1000+CAST(n/8 AS INTEGER),?4,?4,'collaboration-label-'||?5||'-'||n FROM sample`)
      .bind(from,to,projects[0],owner,deleted ? 1 : 0).run();
    await db.prepare(sample + `INSERT INTO comments
      (id,issue_id,kind,author_principal_id,body,completion_json,created_at,created_operation_id,deleted_at,deleted_by_principal_id)
      SELECT printf('${deleted ? "d6" : "d5"}000000-0000-4000-8000-%012d',n),?3,
             CASE WHEN ?5 = 0 AND n % 1000 = 999 THEN 'completion' ELSE 'standard' END,?4,
             CASE WHEN ?5 = 0 AND n % 1000 = 999 THEN '{"summary":"","verification":[],"artifacts":[],"follow_ups":[]}' ELSE 'bounded comment' END,
             CASE WHEN ?5 = 0 AND n % 1000 = 999 THEN '{"summary":"","verification":[],"artifacts":[],"follow_ups":[]}' ELSE NULL END,
             1000+CAST(n/8 AS INTEGER),'collaboration-comment-'||?5||'-'||n,
             CASE WHEN ?5 = 1 THEN 1000+CAST(n/8 AS INTEGER) ELSE NULL END,CASE WHEN ?5 = 1 THEN ?4 ELSE NULL END FROM sample`)
      .bind(from,to,issue,owner,deleted ? 1 : 0).run();
  }
}

before(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations("DB");
  ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner,
    ownerCredentialId: credential, ownerCredentialToken: ownerToken, ownerDisplayName: "Collaboration_Owner", preferredApiOrigin: origin });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'Collaboration_Member','collaboration_member',1,1)").bind(member).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'collaborationmember',?3,1,?4)")
    .bind(memberCredential,member,createHash("sha256").update(memberToken).digest("hex"),randomUUID()).run();
  await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'Collaboration',1,1,?2,?2,?3)")
    .bind(workspace,owner,randomUUID()).run();
  for (const project of projects) {
    await db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Collaboration',1,1,?3,?3,?4)")
      .bind(project,workspace,owner,randomUUID()).run();
  }
  for (const [index, grant] of grants.entries()) {
    await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'writer',1,1,?4)")
      .bind(grant,member,projects[index],randomUUID()).run();
  }
  for (const id of [issue, emptyIssue]) {
    await db.prepare("INSERT INTO issues(id,project_id,title,title_search,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Main','main',1,1,?3,?3,?4)")
      .bind(id,projects[0],owner,randomUUID()).run();
  }
  identifier = `CFK-${(await db.prepare("SELECT number FROM issues WHERE id=?1").bind(issue).first()).number}`;
  emptyIdentifier = `CFK-${(await db.prepare("SELECT number FROM issues WHERE id=?1").bind(emptyIssue).first()).number}`;
  auth = await authenticateBearer(db, `Bearer ${ownerToken}`);
  memberAuth = await authenticateBearer(db, `Bearer ${memberToken}`);
  await db.prepare(`INSERT INTO web_authenticators
    (id,principal_id,credential_id,public_key_cose,algorithm,user_handle,backup_eligible,backup_state,rp_id,created_at,created_operation_id)
    VALUES(?1,?2,?3,'test-public-key',-7,'test-user',0,0,?4,1,?5)`)
    .bind(passkey,owner,randomUUID(),new URL(origin).hostname,randomUUID()).run();
  for (const [sourceKind, sourceId] of [["credential",credential],["web_authenticator",passkey]]) {
    cookieSessions.push(await cookieSession(sourceKind,sourceId,{kind:"admin",entry_path:"/app/admin",section:"overview"}));
  }
});
after(() => server.close());

function previousLabelSql(query, deleted) {
  const oldPredicate = deleted
    ? "AND (?2 IS NULL OR label.deleted_at < ?2 OR (label.deleted_at = ?2 AND label.id < ?3))"
    : "AND (?2 IS NULL OR label.name > ?2 COLLATE NOCASE OR (label.name = ?2 COLLATE NOCASE AND label.id > ?3))";
  const range = deleted ? "AND (label.deleted_at, label.id) < (?2, ?3)" : "AND label.name > ?2 COLLATE NOCASE";
  const sql = deleted ? query.sql : query.sql.replace("FROM labels label INDEXED BY idx_labels_active_name", "FROM labels label INDEXED BY idx_labels_project_name");
  return sql.includes(range) ? sql.replace(range,oldPredicate)
    : sql.replace(deleted ? "AND label.deleted_at IS NOT NULL" : "AND label.deleted_at IS NULL", match => `${match} ${oldPredicate}`);
}

function previousRelationSql(query, withCursor) {
  const prefix = query.sql.split("), source_candidates AS (")[0] + ")";
  const projection = query.sql.slice(query.sql.indexOf("\n  SELECT relation.id", query.sql.indexOf("candidate_relations AS")))
    .replace("FROM candidate_relations candidate\n  CROSS JOIN issue_relations relation ON relation.id = candidate.id", "FROM issue_relations relation")
    .replaceAll("\n  CROSS JOIN ", "\n  JOIN ")
    .replace("ORDER BY relation.created_at ASC, relation.id ASC", `AND (relation.source_issue_id = ?1 OR relation.target_issue_id = ?1)
      ${withCursor ? "AND (?3 IS NULL OR relation.created_at > ?3 OR (relation.created_at = ?3 AND relation.id > ?4))" : ""}
      ORDER BY relation.created_at ASC, relation.id ASC LIMIT ${withCursor ? "?5" : "?3"}`);
  return prefix + projection;
}

async function assertRelationProjectCursorBudget(query) {
  const { results } = await db.prepare(`EXPLAIN ${query.sql}`).bind(...query.values).all();
  const singleColumnCursors = new Set(results.filter(row => row.opcode === "OpenEphemeral" && row.p2 === 1).map(row => row.p1));
  const duplicateCursors = results.filter(row => row.opcode === "OpenDup" && singleColumnCursors.has(row.p2)).map(row => row.p1);
  assert.ok(duplicateCursors.length > 0);
  // 这条关系查询重复引用单列项目 CTE，保留其展开后的 D1 编译预算。
  assert.ok(Math.max(...duplicateCursors) < 100,`Relation project cursor high-water mark: ${Math.max(...duplicateCursors)}`);
}

const oldCommentsSql = `SELECT c.id,c.kind,c.body,c.completion_json,c.author_principal_id,
  author.display_name AS author_display_name,c.version,c.created_at,COUNT(*) OVER () AS total_count
  FROM comments c JOIN principals author ON author.id=c.author_principal_id
  WHERE c.issue_id=?1 AND c.deleted_at IS NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 10`;

test("标签、双向 Relation 与评论摘要在数据增长后保持结果，记录实际读取量", async t => {
  let previous = 0;
  const costs = [];
  for (const size of [250,1000,5000]) {
    await seed(previous,size); previous = size;
    for (const deleted of [false,true]) {
      const context = await createCursorContext("labels", { deleted: deleted ? "only" : "exclude", project_id: projects[0] }, [projects[0]], owner);
      for (const deep of [false,true]) {
        const midpoint = Math.floor(size/2);
        const queryUrl = url({ limit: 20, ...(deleted ? { deleted: "only" } : {}) });
        if (deep) queryUrl.searchParams.set("cursor",encodeCursor(context,deleted
          ? [1000+Math.floor(midpoint/8),uuid("d4",midpoint)]
          : [`${midpoint % 2 === 0 ? "Label" : "label"} ${String(midpoint).padStart(6,"0")}`,uuid("d3",midpoint)]));
        const measured = observe();
        const page = await listLabels(measured.db,auth,workspace,projects[0],queryUrl);
        const query = measured.queries.find(row => row.sql.includes("FROM labels label"));
        const old = await db.prepare(previousLabelSql(query,deleted)).bind(...query.values).all();
        assert.deepEqual(query.result.results,old.results);
        assert.equal(page.items.length,20);
        const plan = await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all();
        const detail = plan.results.map(row => row.detail).join("\n");
        assert.ok(query.read < 40,`labels ${size}/${deleted}/${deep}: ${query.read}`);
        assert.match(detail,deleted ? /idx_labels_project_tombstones/ : /idx_labels_active_name/);
        if (deep) assert.match(detail,deleted ? /deleted_at[,<]/ : /name[>]/);
        costs.push({ size,query:`labels-${deleted ? "deleted" : "active"}-${deep ? "deep" : "first"}`,old:old.meta.rows_read,current:query.read,
          ...(size === 5000 && deep ? {plan:plan.results.filter(row => row.detail.includes("SEARCH label")).map(row => row.detail)} : {}) });
      }
    }
    const relationContext = await createCursorContext("relations",{ deleted:"exclude",issue_id:issue },projects,owner);
    for (const deep of [false,true]) {
      const midpoint = Math.floor(size/2), queryUrl = url({limit:20});
      if (deep) queryUrl.searchParams.set("cursor",encodeCursor(relationContext,[1000+Math.floor(midpoint/8),uuid("d2",midpoint)]));
      const measured = observe();
      const page = await listIssueRelations(measured.db,auth,identifier,queryUrl);
      const query = measured.queries.find(row => row.sql.includes("candidate_relations AS MATERIALIZED"));
      const old = await db.prepare(previousRelationSql(query,deep)).bind(...query.values).all();
      assert.deepEqual(query.result.results,old.results);
      assert.equal(page.items.length,20);
      assert.ok(query.read < 600,`relations ${size}/${deep}: ${query.read}`);
      assert.ok(query.read < old.meta.rows_read,`${query.read} < ${old.meta.rows_read}`);
      const plan = await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all();
      const detail = plan.results.map(row => row.detail).join("\n");
      assert.match(detail,/idx_issue_relations_source_active_order/);
      assert.match(detail,/idx_issue_relations_target_active_order/);
      if (deep) assert.match(detail,/created_at[>,]/);
      costs.push({size,query:`relations-${deep ? "deep" : "first"}`,old:old.meta.rows_read,current:query.read,
        ...(size === 5000 && deep ? {plan:plan.results.filter(row => /active_order|SCAN candidate|SEARCH relation /.test(row.detail)).map(row => row.detail)} : {})});
    }
    const measured = observe();
    const detail = await getIssue(measured.db,auth,identifier,url());
    const commentQueries = measured.queries.filter(row => row.sql.includes("WITH recent_comments AS MATERIALIZED"));
    assert.equal(commentQueries.length,1);
    const old = await db.prepare(oldCommentsSql).bind(issue).all();
    assert.deepEqual(commentQueries[0].result.results,old.results);
    assert.ok(commentQueries[0].read < size+100);
    assert.ok(commentQueries[0].read < old.meta.rows_read);
    const commentPlan = await db.prepare(`EXPLAIN QUERY PLAN ${commentQueries[0].sql}`).bind(issue).all();
    assert.match(commentPlan.results.map(row => row.detail).join("\n"),/COVERING INDEX idx_comments_issue_list/);
    assert.equal(detail.comments.length,10);
    assert.equal(detail.comment_continuation,`/api/v1/issues/${identifier}/comments`);
    const context = await getIssueContext(db,auth,identifier);
    assert.deepEqual(context.sections.comments.items,detail.comments);
    assert.equal(context.sections.comments.omitted_count,size-10);
    assert.equal(context.sections.relations.omitted_count,size-50);
    assert.deepEqual(context.sections.relations.items,detail.relations.slice(0,50));
    assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 64*1024);
    if (size >= 1000) assert.ok(detail.comments.some(comment => comment.kind === "completion" && comment.body === "" && comment.completion.summary === ""));
    costs.push({size,query:"comment-summary-exact-count",old:old.meta.rows_read,current:commentQueries[0].read,
      ...(size === 5000 ? {plan:commentPlan.results.filter(row => row.detail.includes("idx_comments_issue_list")).map(row => row.detail)} : {})});
  }
  for (const cost of costs) t.diagnostic(JSON.stringify(cost));
});

test("双向时间戳并列无重复遗漏，稀疏权限与空结果仍执行完整过滤", async t => {
  const expected = (await db.prepare("SELECT id FROM issue_relations WHERE source_issue_id=?1 OR target_issue_id=?1 ORDER BY created_at,id").bind(issue).all()).results.map(row => row.id);
  const actual = [], queryUrl = url({limit:100});
  do {
    const page = await listIssueRelations(db,auth,identifier,queryUrl);
    actual.push(...page.items.map(row => row.id));
    if (!page.has_more) break;
    queryUrl.searchParams.set("cursor",page.next_cursor);
  } while (true);
  assert.deepEqual(actual,expected);
  const measured = observe(), sparse = await listIssueRelations(measured.db,memberAuth,identifier,url({limit:20}));
  assert.equal(sparse.items.length,20);
  assert.ok(sparse.items.every(row => [projects[0],projects[1]].includes(row.source.project.id) && [projects[0],projects[1]].includes(row.target.project.id)));
  const query = measured.queries.find(row => row.sql.includes("candidate_relations AS MATERIALIZED"));
  const old = await db.prepare(previousRelationSql(query,false)).bind(...query.values).all();
  assert.deepEqual(query.result.results,old.results);
  assert.ok(query.read < old.meta.rows_read);
  const context = await getIssueContext(db,memberAuth,identifier);
  assert.equal(context.sections.relations.items.length,50);
  assert.equal(context.sections.relations.omitted_count,150);
  const empty = await getIssueContext(db,auth,emptyIdentifier);
  assert.deepEqual(empty.sections.comments.items,[]);
  assert.equal(empty.sections.comments.omitted_count,0);
  assert.equal(empty.sections.comments.continuation,null);
  assert.equal(empty.sections.relations.omitted_count,0);
  assert.equal(empty.sections.relations.continuation,null);
  assert.deepEqual((await listIssueRelations(db,auth,emptyIdentifier,url())).items,[]);
  const labelContext = await createCursorContext("labels",{deleted:"exclude",project_id:projects[0]},[projects[0]],owner);
  const emptyLabels = observe();
  assert.deepEqual((await listLabels(emptyLabels.db,auth,workspace,projects[0],url({cursor:encodeCursor(labelContext,["zzzz",randomUUID()])}))).items,[]);
  assert.ok(emptyLabels.queries.find(row => row.sql.includes("FROM labels label")).read < 10);
  await db.prepare("UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2").bind(owner,grants[1]).run();
  try {
    const hidden = observe();
    assert.deepEqual((await listIssueRelations(hidden.db,memberAuth,identifier,url())).items,[]);
    t.diagnostic(JSON.stringify({query:"sparse-relations",old:old.meta.rows_read,current:query.read,empty_hidden_read:hidden.queries.find(row => row.sql.includes("candidate_relations AS MATERIALIZED")).read}));
  } finally {
    await db.prepare("UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(grants[1]).run();
  }
});

test("Relation 页在 SQL 前与投影后权限变化时拒绝旧范围，删除父容器不漏数据", async () => {
  for (const phase of ["beforeQuery","afterQuery"]) {
    let changed = false;
    const measured = observe({[phase]:async sql => {
      if (!changed && sql.includes("candidate_relations AS MATERIALIZED")) {
        changed = true;
        await db.prepare("UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2").bind(owner,grants[1]).run();
      }
    }});
    try {
      await assert.rejects(listIssueRelations(measured.db,memberAuth,identifier,url()),error => error.code === "CURSOR_SCOPE_MISMATCH");
    } finally {
      await db.prepare("UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1").bind(grants[1]).run();
    }
  }
  for (const phase of ["beforeQuery","afterQuery"]) {
    let changed = false;
    const credentialRace = observe({[phase]:async sql => {
      if (!changed && sql.includes("candidate_relations AS MATERIALIZED")) {
        changed = true;
        await db.prepare("UPDATE credentials SET revoked_at=2 WHERE id=?1").bind(memberCredential).run();
      }
    }});
    try {
      await assert.rejects(listIssueRelations(credentialRace.db,memberAuth,identifier,url()),error => error.code === "UNAUTHORIZED");
    } finally {
      await db.prepare("UPDATE credentials SET revoked_at=NULL WHERE id=?1").bind(memberCredential).run();
    }
  }
  let changed = false;
  const parentRace = observe({beforeQuery:async sql => {
    if (!changed && sql.includes("candidate_relations AS MATERIALIZED")) {
      changed = true;
      await db.prepare("UPDATE projects SET deleted_at=2,deleted_by_principal_id=?1 WHERE id=?2").bind(owner,projects[1]).run();
    }
  }});
  try {
    await assert.rejects(listIssueRelations(parentRace.db,memberAuth,identifier,url()),error => error.code === "CURSOR_SCOPE_MISMATCH");
    const query = parentRace.queries.find(row => row.sql.includes("candidate_relations AS MATERIALIZED"));
    assert.deepEqual(query.result.results,[]);
  } finally {
    await db.prepare("UPDATE projects SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1").bind(projects[1]).run();
  }
  for (const endpointIndex of [0,1]) {
    changed = false;
    const endpointRace = observe({beforeQuery:async sql => {
      if (!changed && sql.includes("candidate_relations AS MATERIALIZED")) {
        changed = true;
        await db.prepare("UPDATE issues SET deleted_at=2,deleted_by_principal_id=?1 WHERE id=?2").bind(owner,uuid("d1",endpointIndex)).run();
      }
    }});
    try {
      const result = await listIssueRelations(endpointRace.db,memberAuth,identifier,url());
      assert.equal(result.items.length,20);
      assert.ok(result.items.every(row => row.id !== uuid("d2",endpointIndex)));
    } finally {
      await db.prepare("UPDATE issues SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1").bind(uuid("d1",endpointIndex)).run();
    }
  }
});

test("Credential 与 Passkey Cookie 的 Relation 首屏、游标、空结果和固定 Project 范围保持一致", async () => {
  const firstMeasured = observe();
  const first = await listIssueRelations(firstMeasured.db,auth,identifier,url({limit:20}));
  await assertRelationProjectCursorBudget(firstMeasured.queries.find(row => row.sql.includes("candidate_relations AS MATERIALIZED")));
  assert.equal(first.items.length,20);
  assert.equal(first.has_more,true);
  const nextUrl = url({limit:20,cursor:first.next_cursor});
  const nextMeasured = observe();
  const next = await listIssueRelations(nextMeasured.db,auth,identifier,nextUrl);
  await assertRelationProjectCursorBudget(nextMeasured.queries.find(row => row.sql.includes("candidate_relations AS MATERIALIZED")));
  assert.equal(next.items.length,20);
  assert.ok(next.items.every(row => !first.items.some(previous => previous.id === row.id)));
  for (const session of cookieSessions) {
    for (const [pageUrl, expected] of [[url({limit:20}),first],[nextUrl,next]]) {
      const measured = observe();
      assert.deepEqual(await listIssueRelations(measured.db,session.auth,identifier,pageUrl),expected);
      await assertRelationProjectCursorBudget(measured.queries.find(row => row.sql.includes("candidate_relations AS MATERIALIZED")));
    }
    assert.deepEqual((await listIssueRelations(db,session.auth,emptyIdentifier,url())).items,[]);
  }
  const sameProject = randomUUID(), otherProject = randomUUID();
  for (const [id, targetId, targetProject] of [[sameProject,issue,projects[0]],[otherProject,uuid("d1",0),projects[1]]]) {
    await db.prepare(`INSERT INTO issue_relations
      (id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id)
      VALUES(?1,?2,'related',?3,?4,?5,?6,1,?7,?8)`)
      .bind(id,workspace,emptyIssue,targetId,projects[0],targetProject,owner,randomUUID()).run();
  }
  assert.equal((await listIssueRelations(db,auth,emptyIdentifier,url())).items.length,2);
  for (const session of cookieSessions) {
    const fixed = await cookieSession(session.sourceKind,session.sourceId,{
      kind:"project",workspace_id:workspace,project_id:projects[0],entry_path:`/app/w/${workspace}/p/${projects[0]}`,
    });
    const page = await listIssueRelations(db,fixed.auth,emptyIdentifier,url());
    assert.deepEqual(page.items.map(row => row.id),[sameProject]);
    assert.equal(page.has_more,false);
    assert.deepEqual(page.resolved_scope.visible_project_ids,[projects[0]]);
  }
});

test("Cookie Relation 在查询前或投影后撤销 Session 和两种来源时拒绝，过期 Session 不返回结果", async () => {
  for (const session of cookieSessions) {
    const sourceTable = session.sourceKind === "credential" ? "credentials" : "web_authenticators";
    for (const target of ["source","session"]) for (const phase of ["beforeQuery","afterQuery"]) {
      const table = target === "source" ? sourceTable : "web_sessions";
      const id = target === "source" ? session.sourceId : session.id;
      const actor = table === "web_authenticators" ? ",revoked_by_principal_id=?2" : "";
      let changed = false;
      const measured = observe({[phase]:async sql => {
        if (!changed && sql.includes("candidate_relations AS MATERIALIZED")) {
          changed = true;
          await db.prepare(`UPDATE ${table} SET revoked_at=2${actor} WHERE id=?1`)
            .bind(id,...(actor ? [owner] : [])).run();
        }
      }});
      try {
        await assert.rejects(listIssueRelations(measured.db,session.auth,identifier,url({limit:20})),error => error.code === "UNAUTHORIZED");
        assert.equal(changed,true);
        const query = measured.queries.find(row => row.sql.includes("candidate_relations AS MATERIALIZED"));
        assert.equal(query.result.results.length,phase === "beforeQuery" ? 0 : 21);
        assert.ok(query.read < 600,`${session.sourceKind}/${target}/${phase}: ${query.read}`);
      } finally {
        await db.prepare(`UPDATE ${table} SET revoked_at=NULL${actor ? ",revoked_by_principal_id=NULL" : ""} WHERE id=?1`).bind(id).run();
      }
    }
    for (const field of ["expires_at","created_at"]) {
      const now = Date.now();
      await db.prepare(`UPDATE web_sessions SET ${field}=?2 WHERE id=?1`)
        .bind(session.id,field === "expires_at" ? now : now - 7 * 86_400_000).run();
      try {
        const measured = observe();
        await assert.rejects(listIssueRelations(measured.db,session.auth,identifier,url(),now),error => error.code === "UNAUTHORIZED");
        assert.deepEqual(measured.queries.find(row => row.sql.includes("candidate_relations AS MATERIALIZED")).result.results,[]);
      } finally {
        await db.prepare(`UPDATE web_sessions SET ${field}=?2 WHERE id=?1`)
          .bind(session.id,field === "expires_at" ? session.expiresAt : session.createdAt).run();
      }
    }
  }
});

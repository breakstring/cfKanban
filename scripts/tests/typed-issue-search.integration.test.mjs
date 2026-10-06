import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { countProjectIssues, listIssues, listIssueCandidates, listProjectIssues } from "../../apps/worker/src/services/issues.ts";
import { issueNumberRanges } from "../../packages/shared/issue-search.ts";

// 临时 127.0.0.1:0、persist:false；只使用全零本地 D1 配置。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const owner = randomUUID(), credential = randomUUID(), member = randomUUID(), memberCredential = randomUUID();
const workspace = randomUUID(), projects = [randomUUID(), randomUUID()], label = randomUUID(), grant = randomUUID();
const auth = { kind: "bearer", isOwner: true, principalId: owner, credentialId: credential, credentialFingerprint: "test", displayName: "TypedOwner", principalVersion: 1 };
const reader = { ...auth, isOwner: false, principalId: member, credentialId: memberCredential, displayName: "TypedReader" };
const rows = [];
let db;
function url(params = {}) {
  const result = new URL("https://kanban.example.test/api/v1/issues");
  for (const [name, value] of Object.entries(params)) for (const item of Array.isArray(value) ? value : [value]) result.searchParams.append(name, item);
  return result;
}
function list(params = {}, context = auth, database = db) { return listProjectIssues(database, context, workspace, projects[0], url({ q_mode: "typed", ...params })); }
function counts(params = {}, context = auth, database = db) { return countProjectIssues(database, context, workspace, projects[0], url({ q_mode: "typed", ...params })); }
const order = (a,b) => b.updated - a.updated || b.number - a.number;
function expected(prefix, params = {}) {
  return rows.filter(row => row.project === projects[0] && !row.deleted && String(row.number).startsWith(prefix)
    && (!params.priority || row.priority === params.priority) && (!params.status || row.status === params.status)
    && (!params.label || row.label) && (!params.assignee || row.assignee === (params.assignee === "unassigned" ? null : params.assignee))).sort(order);
}
async function batches(statements) { for (let n=0;n<statements.length;n+=80) await db.batch(statements.slice(n,n+80)); }
function instrument(database, hook = async () => {}) {
  const queries = [];
  function wrap(statement, sql, values = []) {
    return new Proxy(statement, { get(target, key) {
      if (key === "bind") return (...args) => wrap(target.bind(...args), sql, args);
      if (key === "all") return async (...args) => {
        await hook(sql, "before");
        const started = performance.now(), result = await target.all(...args);
        const query = { sql, values, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written, returned: result.results.length, duration_ms: performance.now() - started };
        queries.push(query);
        await hook(sql, "after");
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  return { queries, db: new Proxy(database, { get(target, key) {
    if (key === "prepare") return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) };
}
before(async () => {
  await server.listen(); await server.getWorker().applyD1Migrations("DB"); ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner, ownerCredentialId: credential, ownerCredentialToken: `cfk_v1_typed_${"A".repeat(43)}`, ownerDisplayName: "TypedOwner", preferredApiOrigin: "https://kanban.example.test" });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'TypedReader','typedreader',1,1)").bind(member).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'test',?3,1,?4)").bind(memberCredential, member, "b".repeat(64), randomUUID()).run();
  await db.prepare("INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,'Typed',1,1,?2,?2,?3)").bind(workspace, owner, randomUUID()).run();
  for (const project of projects) await db.prepare("INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'Typed',1,1,?3,?3,?4)").bind(project, workspace, owner, randomUUID()).run();
  await db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,'reader',1,1,?4)").bind(grant,member,projects[0],randomUUID()).run();
  await db.prepare("INSERT INTO labels(id,project_id,name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,'TypedLabel',1,1,?3,?3,?4)").bind(label,projects[0],owner,randomUUID()).run();
  const statements = [];
  for (let number=1;number<=3600;number++) {
    const row = { number, id: randomUUID(), project: number<=300 || number%3 ? projects[0] : projects[1], title: number%29 === 0 ? "62 numeric title" : number%499 === 0 ? "needle 登录" : `ordinary title ${number}`, status: number%4 === 0 ? "backlog" : "todo", priority: number%7 === 0 ? "high" : "none", assignee: number%2 ? owner : null, deleted: number===621, label: number%5 === 0, updated: 1000+Math.floor(number/3) };
    rows.push(row);
    statements.push(db.prepare("INSERT INTO issues(number,id,project_id,title,title_search,status_key,priority_key,priority_rank,assignee_principal_id,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?8,?9,?10,?1,?11,?12,?12,?13)").bind(number,row.id,row.project,row.title,row.status,row.priority,row.priority==="high"?1:4,row.assignee,row.deleted?2:null,row.deleted?owner:null,row.updated,owner,randomUUID()));
  }
  await batches(statements);
  await batches(rows.filter(row=>row.label).map(row=>db.prepare("INSERT INTO issue_labels VALUES(?1,?2,1,?3,?4)").bind(row.id,label,owner,randomUUID())));
});
after(() => server.close());

test('typed prefixes, title normalization and legacy q remain distinct within current Project', async () => {
  for (const q of ['62','CFK-62','cfk-62','ＣＦＫ－６２']) {
    const page = await list({q,limit:100}); assert.deepEqual(page.items.map(row=>row.number), expected('62').map(row=>row.number));
    const total = await counts({q}); assert.equal(total.total_count, expected('62').length);
    assert.equal(total.resolved_scope.filters.q_mode,'typed');
    assert.equal(total.resolved_scope.filters.q,q.normalize('NFKC').toLowerCase());
  }
  assert.equal((await list({q:'CFK-621',limit:100})).items.length,0,'deleted exact prefix does not match numeric titles');
  assert.deepEqual((await list({q:'CFK-6',limit:100})).items.map(row=>row.number),expected('6').slice(0,100).map(row=>row.number));
  const titles = await list({q:'ＮＥＥＤＬＥ',limit:100});
  assert.deepEqual(titles.items.map(row=>row.number),rows.filter(row=>row.project===projects[0] && row.title.includes('needle')).sort(order).map(row=>row.number));
  const old = await listProjectIssues(db,auth,workspace,projects[0],url({q:'62',limit:100}));
  assert.ok(old.items.some(row=>!String(row.number).startsWith('62')),'legacy numeric q still searches titles');
  const oldExact = await listProjectIssues(db,auth,workspace,projects[0],url({q:'CFK-62',limit:100}));
  assert.deepEqual(oldExact.items.map(row=>row.number),[62]);
  const foreign = rows.find(row=>row.project===projects[1]);
  assert.deepEqual((await list({q:`CFK-${foreign.number}`,limit:100})).items.map(row=>row.number),expected(String(foreign.number)).map(row=>row.number));
  assert.deepEqual((await listIssues(db,reader,url({q_mode:'typed',q:`CFK-${foreign.number}`,project:projects[1]}))).items,[]);
});

test('typed combinations match counts, paginated list order and candidate assignment policy', async () => {
  for (const params of [{},{priority:'high'},{status:'todo',assignee:'unassigned'},{label},{priority:'high',label}]) {
    const matching=expected('62',params); const total=await counts({q:'62',...params},reader);
    assert.equal(total.total_count,matching.length);
    let cursor=null, seen=[];
    do { const page=await list({q:'62',...params,limit:2,...(cursor?{cursor}:{})},reader); seen.push(...page.items.map(row=>row.number)); cursor=page.next_cursor; } while(cursor);
    assert.deepEqual(seen,matching.map(row=>row.number)); assert.equal(new Set(seen).size,seen.length);
  }
  const candidate=await listIssueCandidates(db,auth,url({project:projects[0],q_mode:'typed',q:'62',assignment:'mine',blocked:'include',limit:100}));
  assert.deepEqual(candidate.items.map(row=>row.number),expected('62').filter(row=>row.status==='todo'&&row.assignee===owner)
    .sort((a,b)=>(a.priority==='high'?1:4)-(b.priority==='high'?1:4)||a.number-b.number).map(row=>row.number));
});

test('typed mode validates input and binds every cursor without changing legacy cursors', async () => {
  for(const q of ['1','a','01','CFK-x','9007199254740992','a'.repeat(129),'登'.repeat(43),'']) await assert.rejects(list({q}),error=>error.code==='VALIDATION_ERROR');
  for(const q_mode of ['legacy','other',['typed','typed']]) await assert.rejects(list({q:'62',q_mode}),error=>error.code==='VALIDATION_ERROR');
  await assert.rejects(list({q:['62','63']}),error=>error.code==='VALIDATION_ERROR');
  const page=await list({q:'62',limit:1}); assert.ok(page.next_cursor);
  for(const params of [{q:'63'},{q:'ordinary'},{priority:'high'}]) await assert.rejects(list({q:'62',cursor:page.next_cursor,...params}),error=>error.code==='CURSOR_SCOPE_MISMATCH');
  await assert.rejects(listProjectIssues(db,auth,workspace,projects[0],url({q:'62',cursor:page.next_cursor})),error=>error.code==='CURSOR_SCOPE_MISMATCH');
  const legacy=await listProjectIssues(db,auth,workspace,projects[0],url({q:'ordinary',limit:1}));
  await assert.rejects(list({q:'ordinary',cursor:legacy.next_cursor}),error=>error.code==='CURSOR_SCOPE_MISMATCH');
  assert.deepEqual(issueNumberRanges('9007199254740991'),[[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]]);
  assert.equal(issueNumberRanges('9').at(-1)[1],Number.MAX_SAFE_INTEGER);
});

test('prefix range and sparse/empty title queries record local D1 reads, deep pages and no write amplification', async t => {
  const evidence=[];
  let first;
  for(const params of [{q:'62',limit:3},{q:'62',priority:'high',limit:3},{q:'9999',limit:3},{q:'needle',limit:3},{q:'no matching title',limit:3}]) {
    const measured=instrument(db); const page=await list(params,auth,measured.db);
    const query=measured.queries.find(row=>row.sql.includes('issue_page(number)')); assert.ok(query);
    const plan=(await db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.values).all()).results.map(row=>row.detail);
    assert.equal(query.rows_written,0); assert.ok(query.values.length<=100);
    if(/^[0-9]+$/.test(params.q)) assert.ok(plan.some(detail=>/prefix_issue USING INTEGER PRIMARY KEY.*rowid>\?.*rowid<\?/.test(detail)),JSON.stringify(plan));
    if(params.q==='9999') assert.ok(query.rows_read<200,'empty numeric prefix seeks ranges instead of scanning 3600 Issues');
    evidence.push({params,rows_read:query.rows_read,rows_written:query.rows_written,returned:page.items.length,duration_ms:query.duration_ms,plan:plan.filter(detail=>/prefix_issue|SEARCH i |TEMP B-TREE/.test(detail))});
    if(params.q==='62'&&!params.priority) first=page;
  }
  const deep=instrument(db); await list({q:'62',limit:3,cursor:first.next_cursor},auth,deep.db);
  const query=deep.queries.find(row=>row.sql.includes('issue_page(number)')); evidence.push({name:'prefix-next-page',rows_read:query.rows_read,rows_written:query.rows_written,returned:query.returned});
  const countRead=instrument(db); await counts({q:'62'},auth,countRead.db); const aggregate=countRead.queries.find(row=>row.sql.includes('GROUP BY i.status_key'));
  assert.equal(aggregate.rows_written,0); evidence.push({name:'prefix-counts',rows_read:aggregate.rows_read,rows_written:aggregate.rows_written,returned:aggregate.returned});
  t.diagnostic(`Local workerd only, 3600 Issues across two Projects; no new schema/index or writes: ${JSON.stringify(evidence)}`);
});

test('current Project grant revocation removes typed candidates and counts before returning', async () => {
  const measured=instrument(db,async(sql,stage)=>{if(sql.includes('issue_page(number)')&&stage==='before') await db.prepare('UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2').bind(owner,grant).run();});
  await assert.rejects(list({q:'62'},reader,measured.db),error=>['CURSOR_SCOPE_MISMATCH','NOT_FOUND'].includes(error.code));
  await assert.rejects(counts({q:'62'},reader),error=>error.code==='NOT_FOUND');
});

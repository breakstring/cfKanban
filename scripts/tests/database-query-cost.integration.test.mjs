import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { bootstrapInstance } from '../../apps/worker/src/services/bootstrap.ts';
import { resolveVisibleProjects, requireVisibleProject } from '../../apps/worker/src/kernel/authorization.ts';
import { listPrincipals } from '../../apps/worker/src/services/access.ts';
import { listIssues, listIssueCandidates } from '../../apps/worker/src/services/issues.ts';

const server = createTestHarness({ root: fileURLToPath(new URL('../../', import.meta.url)), workers: [{ configPath: 'wrangler.wp02-test.jsonc' }] });
const owner = randomUUID(), credential = randomUUID(), workspace = randomUUID(), project = randomUUID(), otherProject = randomUUID();
const members = Array.from({ length: 5 }, () => randomUUID());
const auth = { kind: 'bearer', isOwner: true, principalId: owner, credentialId: credential, credentialFingerprint: 'test', displayName: 'CostOwner', principalVersion: 1 };
let db;

function measure(database) {
  const queries = [];
  const wrap = (statement, sql, values = []) => new Proxy(statement, {
    get(target, key) {
      if (key === 'bind') return (...args) => wrap(target.bind(...args), sql, args);
      if (key === 'all') return async (...args) => {
        const result = await target.all(...args);
        queries.push({ sql, values, read: result.meta.rows_read, returned: result.results.length });
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { queries, db: new Proxy(database, { get(target, key) {
    if (key === 'prepare') return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

before(async () => {
  await server.listen();
  await server.getWorker().applyD1Migrations('DB');
  ({ DB: db } = await server.getWorker().getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner,
    ownerCredentialId: credential, ownerCredentialToken: `cfk_v1_cost_${'A'.repeat(43)}`, ownerDisplayName: 'CostOwner', preferredApiOrigin: 'https://kanban.example.test' });
  await db.batch(members.map((id, n) => db.prepare('INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,?2,?3,1,1)').bind(id, `CostMember${n}`, `costmember${n}`)));
  await db.prepare('INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,\'Cost\',1,1,?2,?2,?3)').bind(workspace, owner, randomUUID()).run();
  const projects = [project, otherProject, ...Array.from({ length: 94 }, () => randomUUID())];
  await db.batch(projects.map((id, n) => db.prepare('INSERT INTO projects(id,workspace_id,display_name,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id) VALUES(?1,?2,\'Cost\',?3,?4,1,1,?5,?5,?6)').bind(id, workspace, n < 2 ? null : 2, n < 2 ? null : owner, owner, randomUUID())));
  await db.batch(members.map(id => db.prepare('INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES(?1,?2,?3,\'writer\',1,1,?4)').bind(randomUUID(), id, project, randomUUID())));
  for (let offset = 0; offset < 1200; offset += 100) {
    await db.batch(Array.from({ length: 100 }, (_, j) => {
      const n = offset + j, deleted = n >= 600;
      return db.prepare(`INSERT INTO issues(id,project_id,title,title_search,status_key,assignee_principal_id,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
        VALUES(?1,?2,?3,?4,'todo',?5,?6,?7,?8,?8,?9,?9,?10)`)
        .bind(randomUUID(), project, `Cost task ${n}`, `cost task ${n}`, n % 10 === 0 ? members[n % members.length] : null, deleted ? 3 : null, deleted ? owner : null, 1000 + Math.floor(n / 3), owner, randomUUID());
    }));
  }
});
after(() => server.close());

test('project authorization bounds reads and intersects fixed Session targets', async () => {
  const m = measure(db);
  assert.equal((await requireVisibleProject(m.db, auth, workspace, project)).projectId, project);
  assert.ok(m.queries[0].read <= 4, `point authorization read ${m.queries[0].read}`);
  const all = measure(db);
  assert.equal((await resolveVisibleProjects(all.db, auth)).length, 2);
  assert.ok(all.queries[0].read < 15, `active projects scanned tombstones: ${all.queries[0].read}`);
  const fixed = { ...auth, kind: 'cookie', targetKind: 'project', target: { workspace_id: workspace, project_id: project } };
  await assert.rejects(requireVisibleProject(db, fixed, workspace, otherProject), error => error.code === 'NOT_FOUND');
  const issue = await db.prepare('SELECT number FROM issues WHERE project_id=?1 LIMIT 1').bind(project).first();
  const fixedIssue = { ...fixed, targetKind: 'issue', target: { identifier: `CFK-${issue.number}` } };
  assert.equal((await requireVisibleProject(db, fixedIssue, workspace, project)).projectId, project);
  await assert.rejects(requireVisibleProject(db, fixedIssue, workspace, otherProject), error => error.code === 'NOT_FOUND');
  await assert.rejects(requireVisibleProject(db, { ...fixed, targetKind: 'workspace', target: { workspace_id: '' } }, workspace, project), error => error.code === 'NOT_FOUND');
  console.log(JSON.stringify({ cost: 'project-authorization', point_rows_read: m.queries[0].read, active_list_rows_read: all.queries[0].read }));
});

test('principal statistics read assignments rather than scanning every Issue per Principal', async () => {
  const m = measure(db);
  const result = await listPrincipals(m.db, auth, new URL('https://kanban.example.test/api/v1/admin/principals?limit=50'));
  assert.equal(result.items.length, 6);
  assert.equal(result.items.reduce((sum, row) => sum + row.assignee_count, 0), 60);
  assert.ok(m.queries[0].read < 150, `principal stats read ${m.queries[0].read}`);
  let cursor = null, seen = [];
  do {
    const url = new URL('https://kanban.example.test/api/v1/admin/principals?limit=2');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await listPrincipals(db, auth, url);
    seen.push(...page.items.map(item => item.id)); cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 6); assert.equal(new Set(seen).size, 6);
  const filteredIds = [];
  cursor = null;
  do {
    const url = new URL(`https://kanban.example.test/api/v1/admin/principals?project_id=${project}&q=CostMember&limit=2`);
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await listPrincipals(db, auth, url);
    filteredIds.push(...page.items.map(item => item.id)); cursor = page.next_cursor;
    assert.ok(page.items.every(item => item.active_grant_count === 1));
  } while (cursor);
  assert.deepEqual(filteredIds.toSorted(), members.toSorted());
  console.log(JSON.stringify({ cost: 'principal-statistics', rows_read: m.queries[0].read }));
});

test('Issue first and deep pages keep bounded reads and preserve tie ordering and filters', async () => {
  const url = new URL(`https://kanban.example.test/api/v1/issues?project=${project}&limit=20`);
  let cursor = null, seen = [], firstCost, lastCost;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    if (cursor) url.searchParams.set('cursor', cursor);
    const m = measure(db);
    const page = await listIssues(m.db, auth, url);
    const query = m.queries.find(row => row.sql.includes('WITH current_result_projects'));
    assert.ok(query, 'measured the final guarded Issue query');
    firstCost ??= query.read; lastCost = query.read;
    assert.ok(query.read < 300, `page ${pageIndex} read ${query.read}`);
    assert.equal(page.items.length, 20);
    seen.push(...page.items.map(row => row.number)); cursor = page.next_cursor;
    assert.ok(cursor);
  }
  assert.equal(new Set(seen).size, 400);
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a));
  assert.ok(lastCost <= firstCost + 30, `deep page grows with skipped prefix: ${firstCost} -> ${lastCost}`);
  const filtered = await listIssues(db, auth, new URL(`https://kanban.example.test/api/v1/issues?project=${project}&assignee=${members[0]}&status=todo&limit=100`));
  assert.equal(filtered.items.length, 60);
  const multiFilterUrl = new URL(`https://kanban.example.test/api/v1/issues?project=${project}&assignee=${members[0]}&assignee=${members[1]}&status=todo&status=in_progress&limit=100`);
  const multiFiltered = await listIssues(db, auth, multiFilterUrl);
  assert.deepEqual(multiFiltered.items.map(item => item.number), filtered.items.map(item => item.number));
  multiFilterUrl.searchParams.delete('status'); multiFilterUrl.searchParams.append('status', 'done'); multiFilterUrl.searchParams.append('status', 'backlog');
  assert.deepEqual((await listIssues(db, auth, multiFilterUrl)).items, []);
  const multiple = await listIssues(db, auth, new URL(`https://kanban.example.test/api/v1/issues?project=${project}&project=${otherProject}&limit=20`));
  assert.deepEqual(multiple.items.map(row => row.number), seen.slice(0,20));
  const deleted = await listIssues(db, auth, new URL(`https://kanban.example.test/api/v1/issues?project=${project}&deleted=only&limit=20`));
  assert.equal(deleted.items.length,20); assert.ok(deleted.items.every(row => row.deleted_at !== null));
  console.log(JSON.stringify({ cost: 'issue-list', first_page_rows_read: firstCost, twentieth_page_rows_read: lastCost }));
});

test('candidate continuation keeps equal-priority timestamp ties and explicit assignment', async () => {
  const url = new URL(`https://kanban.example.test/api/v1/issues/candidates?project=${project}&assignment=unassigned&blocked=include&limit=20`);
  const first = await listIssueCandidates(db, auth, url);
  url.searchParams.set('cursor', first.next_cursor);
  const next = await listIssueCandidates(db, auth, url);
  assert.equal(first.items.length, 20); assert.equal(next.items.length,20);
  const ids = [...first.items, ...next.items].map(row => row.number);
  assert.equal(new Set(ids).size,40); assert.deepEqual(ids,[...ids].sort((a,b)=>a-b));
  assert.ok([...first.items, ...next.items].every(row => row.assignee === null));
});

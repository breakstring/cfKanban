import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { authenticateBearer } from '../../apps/worker/src/kernel/auth.ts';
import { createCursorContext, encodeCursor } from '../../apps/worker/src/kernel/cursor.ts';
import { bootstrapInstance } from '../../apps/worker/src/services/bootstrap.ts';
import { getProject, listProjects, listWorkspaces } from '../../apps/worker/src/services/containers.ts';
import { listPrincipalCredentials, listProjectGrants } from '../../apps/worker/src/services/access.ts';
import { activeProjectPrincipalCountSql } from '../../apps/worker/src/services/project-members.ts';
import { getPublicJoinPolicy } from '../../apps/worker/src/services/public-join.ts';
import { listAdministrators, listProjectMembers } from '../../apps/worker/src/services/scoped-administrators.ts';

const server = createTestHarness({ root: fileURLToPath(new URL('../../', import.meta.url)), workers: [{ configPath: 'wrangler.wp02-test.jsonc' }] });
const owner = randomUUID(), ownerCredential = randomUUID(), workspace = randomUUID(), otherWorkspace = randomUUID();
const ownerToken = `cfk_v1_efficiency_${'A'.repeat(43)}`;
const people = Array.from({ length: 1500 }, () => randomUUID());
const projects = Array.from({ length: 600 }, () => randomUUID());
const project = projects[0], otherProject = randomUUID(), historyProject = randomUUID();
const archivedProjects = Array.from({ length: 60 }, () => randomUUID());
const workspaces = [workspace, otherWorkspace, ...Array.from({ length: 498 }, () => randomUUID())];
const archivedWorkspaces = Array.from({ length: 60 }, () => randomUUID());
const scope = { workspaceId: workspace, projectId: project };
let db, auth;

function measure(database, afterQuery = null) {
  const queries = [];
  const wrap = (statement, sql, values = []) => new Proxy(statement, {
    get(target, key) {
      if (key === 'bind') return (...args) => wrap(target.bind(...args), sql, args);
      if (key === 'all') return async (...args) => {
        const result = await target.all(...args);
        queries.push({ sql, values, read: result.meta.rows_read, returned: result.results.length });
        await afterQuery?.(sql, result);
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

async function batch(sql, values) {
  for (let offset = 0; offset < values.length; offset += 100) {
    await db.batch(values.slice(offset, offset + 100).map(row => db.prepare(sql).bind(...row)));
  }
}

async function administrator(principal, projectId = null, revoked = false) {
  const id = randomUUID(), operation = randomUUID();
  await db.prepare(`INSERT INTO scoped_administrator_grants
    (id,principal_id,workspace_id,project_id,generation,revoked_at,revoked_by_principal_id,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,?4,?5,?6,?7,1,1,?5)`)
    .bind(id, principal, workspace, projectId, operation, revoked ? 2 : null, revoked ? owner : null).run();
  return id;
}

before(async () => {
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations('DB');
  ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner,
    ownerCredentialId: ownerCredential, ownerCredentialToken: ownerToken, ownerDisplayName: 'EfficiencyOwner', preferredApiOrigin: 'https://kanban.example.test' });
  auth = await authenticateBearer(db, `Bearer ${ownerToken}`);
  await batch('INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,?2,?3,1,1)',
    people.map((id, n) => [id, `EfficiencyMember${n}`, `efficiencymember${n}`]));
  await batch(`INSERT INTO workspaces(id,display_name,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,?3,?4,1,1,?5,?5,?6)`, [
    ...workspaces.map((id, n) => [id, `Workspace${String(Math.floor(n / 3)).padStart(4, '0')}`, null, null, owner, randomUUID()]),
    ...archivedWorkspaces.map(id => [id, 'Archived', 5, owner, owner, randomUUID()]),
  ]);
  await batch(`INSERT INTO projects(id,workspace_id,display_name,deleted_at,deleted_by_principal_id,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,?3,?4,?5,1,1,?6,?6,?7)`, [
    ...projects.map((id, n) => [id, workspace, `Project${String(Math.floor(n / 3)).padStart(4, '0')}`, null, null, owner, randomUUID()]),
    [otherProject, otherWorkspace, 'Other', null, null, owner, randomUUID()],
    [historyProject, workspace, 'ZHistory', null, null, owner, randomUUID()],
    ...archivedProjects.map(id => [id, workspace, 'Archived', 5, owner, owner, randomUUID()]),
  ]);
  await batch(`INSERT INTO project_grants(id,principal_id,project_id,role,revoked_at,revoked_by_principal_id,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?7,?8)`, [
    ...people.map((id, n) => [randomUUID(), id, n < 100 ? project : otherProject, n % 2 ? 'writer' : 'reader', n === 3 ? 2 : null, n === 3 ? owner : null, 1, randomUUID()]),
    ...people.slice(0, 600).map((id, n) => [randomUUID(), id, historyProject, 'writer', 2, owner, 1000 + Math.floor(n / 3), randomUUID()]),
  ]);
  await administrator(people[0]);
  await administrator(people[0], project);
  await administrator(people[100]);
  await administrator(people[101], project);
  await administrator(people[102], project, true);
  await batch(`INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,revoked_at,revoked_by_principal_id,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,?4,?5,2,?6,1,1,?5)`, people.slice(0, 600).map(id => [randomUUID(), id, workspace, historyProject, randomUUID(), owner]));
  await batch(`INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,revoked_at,created_operation_id)
    VALUES(?1,?2,'fixture',?3,?4,?5,?6)`, Array.from({ length: 600 }, (_, n) => {
    const id = randomUUID();
    return [id, people[0], createHash('sha256').update(id).digest('hex'), 1000 + Math.floor(n / 3), n % 2 ? 3 : null, randomUUID()];
  }));
});
after(() => server.close());

test('project members start from project candidates and preserve Owner, role precedence and overlapping sources', async () => {
  const legacy = await db.prepare(`SELECT p.id AS principal_id,p.display_name,
    CASE WHEN p.id=im.owner_principal_id THEN 'owner' ELSE g.role END AS effective_role
    FROM principals p JOIN instance_meta im ON im.singleton=1
    LEFT JOIN effective_project_grants g ON g.principal_id=p.id AND g.project_id=?1
    WHERE p.id=im.owner_principal_id OR g.principal_id IS NOT NULL ORDER BY p.id LIMIT 21`).bind(project).all();
  const m = measure(db);
  const first = await listProjectMembers(m.db, auth, scope, new URL('https://kanban.example.test/x?limit=20'), Date.now());
  const cost = m.queries.find(row => row.sql.includes('WITH member_sources'));
  assert.deepEqual(first.items.map(({ sources, ...row }) => row), legacy.results.slice(0, 20));
  assert.ok(cost.read < 1200, `candidate page read ${cost.read}`);
  assert.ok(cost.read * 4 < legacy.meta.rows_read, `candidate ${cost.read}, legacy ${legacy.meta.rows_read}`);
  let cursor = null, items = [];
  do {
    const url = new URL('https://kanban.example.test/x?limit=20');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await listProjectMembers(db, auth, scope, url, Date.now());
    items.push(...page.items); cursor = page.next_cursor;
  } while (cursor);
  assert.equal(items.length, 102);
  assert.equal(new Set(items.map(row => row.principal_id)).size, items.length);
  assert.deepEqual(items.map(row => row.principal_id), items.map(row => row.principal_id).toSorted());
  assert.equal(items.find(row => row.principal_id === owner).effective_role, 'owner');
  const overlapping = items.find(row => row.principal_id === people[0]);
  assert.equal(overlapping.effective_role, 'writer');
  assert.deepEqual(overlapping.sources.map(row => row.kind).toSorted(), ['project_admin', 'project_grant', 'workspace_admin']);
  assert.ok(!items.some(row => row.principal_id === people[3] || row.principal_id === people[102]));
  await assert.rejects(listProjectMembers(db, auth, { workspaceId: workspace, projectId: historyProject },
    new URL(`https://kanban.example.test/x?limit=20&cursor=${encodeURIComponent(first.next_cursor)}`), Date.now()), error => error.code === 'CURSOR_SCOPE_MISMATCH');
  console.log(JSON.stringify({ cost: 'project-member-candidates', rows_read: cost.read, legacy_rows_read: legacy.meta.rows_read }));
});

test('bounded exact count deduplicates active sources and retains archived project usage', async () => {
  for (const id of [project, projects[1], historyProject, archivedProjects[0], otherProject]) {
    const expected = await db.prepare('SELECT COUNT(*) AS count FROM effective_project_grants WHERE project_id=?1').bind(id).first();
    const result = await db.prepare(`SELECT ${activeProjectPrincipalCountSql('?1')} AS count`).bind(id).all();
    assert.deepEqual(result.results[0], expected);
    if (id !== otherProject && id !== historyProject) assert.ok(result.meta.rows_read < 160, `project ${id} count read ${result.meta.rows_read}`);
  }
  const m = measure(db);
  const page = await listProjects(m.db, auth, workspace, new URL('https://kanban.example.test/x?limit=20'), Date.now());
  const query = m.queries.find(row => row.sql.includes('COALESCE(pu.active_principal_count'));
  assert.ok(page.items.every(row => row.active_usage.principals > 0));
  assert.ok(query.read < 400, `missing-usage project page read ${query.read}`);
  const policy = await getPublicJoinPolicy(db, auth, project, Date.now());
  assert.equal(policy.active_usage.principals, 101);
  await db.prepare('INSERT INTO project_usage(project_id,active_issue_count,active_comment_count,active_principal_count,updated_at) VALUES(?1,0,0,0,1)').bind(project).run();
  const recompute = await db.prepare(`UPDATE project_usage SET active_principal_count=${activeProjectPrincipalCountSql('project_usage.project_id')} WHERE project_id=?1`).bind(project).run();
  assert.equal(recompute.meta.rows_written, 1);
  assert.ok(recompute.meta.rows_read < 170, `recompute read ${recompute.meta.rows_read}`);
  assert.equal((await db.prepare('SELECT active_principal_count FROM project_usage WHERE project_id=?1').bind(project).first()).active_principal_count, 101);
  console.log(JSON.stringify({ cost: 'project-usage', absent_usage_page_rows_read: query.read, recompute_rows_read: recompute.meta.rows_read, recompute_rows_written: recompute.meta.rows_written }));
});

test('exact count preserves the effective-view treatment of anomalous sources and an actual Owner source', async () => {
  const sourceProject = randomUUID(), direct = randomUUID();
  await db.prepare(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,'ZSource',1,1,?3,?3,?4)`).bind(sourceProject, workspace, owner, randomUUID()).run();
  // 历史数据库中的实际 Owner 来源仍沿用原视图计数；API 的 Owner 授权禁令不受 helper 影响。
  await db.prepare(`INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,'reader',1,1,?4)`).bind(randomUUID(), owner, sourceProject, randomUUID()).run();
  await db.prepare(`INSERT INTO scoped_administrator_grants(id,principal_id,workspace_id,project_id,generation,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,?4,?5,1,1,?5)`).bind(randomUUID(), people[104], otherWorkspace, sourceProject, randomUUID()).run();
  const check = async count => {
    const expected = await db.prepare('SELECT COUNT(*) AS count FROM effective_project_grants WHERE project_id=?1').bind(sourceProject).first();
    const actual = await db.prepare(`SELECT ${activeProjectPrincipalCountSql('?1')} AS count`).bind(sourceProject).first();
    assert.deepEqual(actual, expected); assert.equal(actual.count, count);
  };
  await check(3);
  await db.prepare(`INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,'reader',1,1,?4)`).bind(direct, people[105], sourceProject, randomUUID()).run();
  const admin = await administrator(people[105], sourceProject);
  await check(4);
  await db.prepare('UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2').bind(owner, direct).run();
  await check(4);
  await db.prepare('UPDATE scoped_administrator_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2').bind(owner, admin).run();
  await check(3);
  await db.prepare('UPDATE projects SET deleted_at=3,deleted_by_principal_id=?1 WHERE id=?2').bind(owner, sourceProject).run();
  await check(3);
});

async function verifyPages(fetchPage, matchSql, direction, expectedLength, limit = 20) {
  let cursor = null, ids = [], firstCost, lastCost;
  for (let pageIndex = 0; pageIndex < expectedLength / limit; pageIndex++) {
    const url = new URL(`https://kanban.example.test/x?limit=${limit}`);
    if (cursor) url.searchParams.set('cursor', cursor);
    const m = measure(db), page = await fetchPage(m.db, url);
    const cost = m.queries.find(row => row.sql.includes(matchSql));
    assert.ok(cost, `measured ${matchSql}`);
    firstCost ??= cost.read; lastCost = cost.read;
    assert.ok(cost.read < 120, `page ${pageIndex} read ${cost.read} for ${matchSql}`);
    ids.push(...page.items.map(row => row.id)); cursor = page.next_cursor;
    if (pageIndex + 1 < expectedLength / limit) assert.ok(cursor);
  }
  assert.equal(ids.length, expectedLength);
  assert.equal(new Set(ids).size, expectedLength);
  assert.ok(lastCost <= firstCost + 15, `deep pages read skipped prefix: ${firstCost} -> ${lastCost}`);
  if (direction) assert.deepEqual(ids, direction === 'ascending' ? ids.toSorted() : ids.toSorted().reverse());
  return { firstCost, lastCost, ids };
}

test('first and deep credential, Grant and administrator pages seek their complete historical scope', async () => {
  const credentials = await verifyPages((database, url) => listPrincipalCredentials(database, auth, people[0], url), 'WHERE c.principal_id = ?1', null, 600);
  const grants = await verifyPages((database, url) => listProjectGrants(database, auth, historyProject, url), 'WHERE g.project_id = ?1', null, 600);
  const administrators = await verifyPages((database, url) => listAdministrators(database, auth, { workspaceId: workspace, projectId: historyProject }, url, Date.now()), 'SELECT a.*, p.display_name', 'ascending', 600);
  const expectedCredentials = (await db.prepare('SELECT id FROM credentials WHERE principal_id=?1 ORDER BY issued_at DESC,id DESC').bind(people[0]).all()).results.map(row => row.id);
  const expectedGrants = (await db.prepare('SELECT id FROM project_grants WHERE project_id=?1 ORDER BY created_at,id').bind(historyProject).all()).results.map(row => row.id);
  assert.deepEqual(credentials.ids, expectedCredentials); assert.deepEqual(grants.ids, expectedGrants);
  console.log(JSON.stringify({ cost: 'identity-history-pages', credentials, grants, administrators }, (key, value) => key === 'ids' ? undefined : value));
});

test('container continuation preserves equal-name and equal-timestamp ordering without scanning page prefixes', async () => {
  // 有 usage 的页单独验证 seek，避免将精确人数统计成本归到分页范围。
  await batch('INSERT INTO project_usage(project_id,active_issue_count,active_comment_count,active_principal_count,updated_at) VALUES(?1,0,0,2,1)',
    [...projects.filter(id => id !== project), ...archivedProjects].map(id => [id]));
  const active = await verifyPages((database, url) => listProjects(database, auth, workspace, url, Date.now()), 'COALESCE(pu.active_principal_count', null, 400);
  const expected = (await db.prepare('SELECT id FROM projects WHERE workspace_id=?1 AND deleted_at IS NULL ORDER BY display_name,id LIMIT 400').bind(workspace).all()).results.map(row => row.id);
  assert.deepEqual(active.ids, expected);
  const workspacesPage = await verifyPages((database, url) => listWorkspaces(database, auth, url, Date.now()), 'FROM workspaces ', null, 400);
  assert.deepEqual(workspacesPage.ids, (await db.prepare('SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY display_name,id LIMIT 400').all()).results.map(row => row.id));
  const archived = await verifyPages((database, url) => { url.searchParams.set('deleted', 'only'); return listProjects(database, auth, workspace, url, Date.now()); }, 'COALESCE(pu.active_principal_count', 'descending', 60);
  assert.deepEqual(archived.ids, archivedProjects.toSorted().reverse());
  const archivedWorkspace = await verifyPages((database, url) => { url.searchParams.set('deleted', 'only'); return listWorkspaces(database, auth, url, Date.now()); }, 'FROM workspaces ', 'descending', 60);
  assert.deepEqual(archivedWorkspace.ids, archivedWorkspaces.toSorted().reverse());
  console.log(JSON.stringify({ cost: 'container-pages', active, workspaces: workspacesPage, archived, archived_workspaces: archivedWorkspace }, (key, value) => key === 'ids' ? undefined : value));
});

test('member reads recheck live management after selection and point reads retain fixed Session scope', async () => {
  const token = `cfk_v1_liverevoke_${'B'.repeat(43)}`;
  await db.prepare('INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,\'liverevoke\',?3,1,?4)')
    .bind(randomUUID(), people[110], createHash('sha256').update(token).digest('hex'), randomUUID()).run();
  const grant = await administrator(people[110], project);
  const manager = await authenticateBearer(db, `Bearer ${token}`);
  let selected;
  const m = measure(db, async (sql, result) => {
    if (!sql.includes('WITH member_sources')) return;
    selected = result.results;
    await db.prepare('UPDATE scoped_administrator_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2').bind(owner, grant).run();
  });
  await assert.rejects(listProjectMembers(m.db, manager, scope, new URL('https://kanban.example.test/x?limit=20'), Date.now()), error => error.status === 404);
  assert.equal(selected.length, 21);
  const fixed = { ...auth, kind: 'cookie', targetKind: 'project', target: { workspace_id: workspace, project_id: project } };
  assert.equal((await getProject(db, fixed, workspace, project, new URL('https://kanban.example.test/x'))).id, project);
  await assert.rejects(getProject(db, fixed, workspace, projects[1], new URL('https://kanban.example.test/x')), error => error.status === 404);
});

test('project-list request scope reuse still rejects removal of its last live Grant and allows an empty final page', async () => {
  const pointWorkspace = randomUUID(), pointProject = randomUUID(), grant = randomUUID();
  const token = `cfk_v1_pointreader_${'C'.repeat(43)}`;
  await db.prepare(`INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,'Point',1,1,?2,?2,?3)`).bind(pointWorkspace, owner, randomUUID()).run();
  await db.prepare(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,'Point',1,1,?3,?3,?4)`).bind(pointProject, pointWorkspace, owner, randomUUID()).run();
  await db.prepare(`INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,'reader',1,1,?4)`).bind(grant, people[1491], pointProject, randomUUID()).run();
  await db.prepare(`INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id)
    VALUES(?1,?2,'pointreader',?3,1,?4)`).bind(randomUUID(), people[1491], createHash('sha256').update(token).digest('hex'), randomUUID()).run();
  const reader = await authenticateBearer(db, `Bearer ${token}`);
  let revoked = false;
  const m = measure(db, async sql => {
    if (revoked || !sql.includes('SELECT p.id AS project_id')) return;
    revoked = true;
    await db.prepare('UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2').bind(owner, grant).run();
  });
  await assert.rejects(listProjects(m.db, reader, pointWorkspace, new URL('https://kanban.example.test/x'), Date.now()), error => error.status === 404);
  assert.equal(revoked, true);
  await db.prepare('UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1').bind(grant).run();
  const context = await createCursorContext('projects', { deleted: 'exclude', workspace_id: pointWorkspace }, [otherProject, pointProject], reader.principalId);
  const end = new URL('https://kanban.example.test/x');
  end.searchParams.set('cursor', encodeCursor(context, ['Point', pointProject]));
  const page = await listProjects(db, reader, pointWorkspace, end, Date.now());
  assert.deepEqual(page.items, []); assert.equal(page.has_more, false); assert.equal(page.next_cursor, null);
});

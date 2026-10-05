import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { authenticateBearer, authenticateCookieSession } from '../../apps/worker/src/kernel/auth.ts';
import { bootstrapInstance } from '../../apps/worker/src/services/bootstrap.ts';
import { getInstanceDiscovery, getMeta } from '../../apps/worker/src/services/identity.ts';
import { getIssueReference } from '../../apps/worker/src/services/issues.ts';

const server = createTestHarness({ root: fileURLToPath(new URL('../../', import.meta.url)), workers: [{ configPath: 'wrangler.wp02-test.jsonc' }] });
const origin = 'https://kanban.example.test';
const owner = randomUUID(), reader = randomUUID(), ownerCredential = randomUUID(), readerCredential = randomUUID();
const workspace = randomUUID(), otherWorkspace = randomUUID(), project = randomUUID(), otherProject = randomUUID();
const ownerToken = `cfk_v1_referenceowner_${'A'.repeat(43)}`, readerToken = `cfk_v1_referencereader_${'R'.repeat(43)}`;
const readerGrant = randomUUID(), targetId = randomUUID(), otherId = randomUUID();
let db, worker, auth;
const digest = value => createHash('sha256').update(value).digest('hex');
const headers = { authorization: `Bearer ${readerToken}` };
const referenceUrl = (identifier, projection = 'mention') => new URL(`/api/v1/issues/${identifier}/reference?projection=${projection}`, origin);

function measure(database, afterQuery) {
  const queries = [];
  const wrap = (statement, sql, values = []) => new Proxy(statement, { get(target, key) {
    if (key === 'bind') return (...args) => wrap(target.bind(...args), sql, args);
    if (key === 'all' || key === 'first') return async (...args) => {
      const result = await target.all();
      queries.push({ sql, values, rows_read: result.meta.rows_read, rows_written: result.meta.rows_written });
      await afterQuery?.(sql);
      if (key === 'all') return result;
      const row = result.results[0] ?? null;
      return args[0] === undefined ? row : row?.[args[0]] ?? null;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { queries, db: new Proxy(database, { get(target, key) {
    if (key === 'prepare') return sql => wrap(target.prepare(sql), sql);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}

async function insertBatch(sql, rows) {
  for (let offset = 0; offset < rows.length; offset += 100) {
    await db.batch(rows.slice(offset, offset + 100).map(values => db.prepare(sql).bind(...values)));
  }
}
const issueInsert = `INSERT INTO issues(number,id,project_id,title,title_search,body,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
  VALUES(?1,?2,?3,?4,?4,?5,1,1,?6,?6,?7)`;

before(async () => {
  await server.listen();
  worker = server.getWorker();
  await worker.applyD1Migrations('DB');
  ({ DB: db } = await worker.getEnv());
  await bootstrapInstance(db, { instanceId: randomUUID(), operationId: randomUUID(), ownerPrincipalId: owner,
    ownerCredentialId: ownerCredential, ownerCredentialToken: ownerToken, ownerDisplayName: 'ReferenceOwner', preferredApiOrigin: origin });
  await db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?1,'ReferenceReader','referencereader',1,1)").bind(reader).run();
  await db.prepare("INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES(?1,?2,'referencereader',?3,1,?4)").bind(readerCredential, reader, digest(readerToken), randomUUID()).run();
  await insertBatch(`INSERT INTO workspaces(id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,1,1,?3,?3,?4)`, [[workspace, 'Reference workspace', owner, randomUUID()], [otherWorkspace, 'Other workspace', owner, randomUUID()]]);
  await insertBatch(`INSERT INTO projects(id,workspace_id,display_name,created_at,updated_at,created_by_principal_id,updated_by_principal_id,created_operation_id)
    VALUES(?1,?2,?3,1,1,?4,?4,?5)`, [[project, workspace, 'Reference project', owner, randomUUID()], [otherProject, otherWorkspace, 'Other project', owner, randomUUID()]]);
  await insertBatch(`INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id)
    VALUES(?1,?2,?3,'reader',1,1,?4)`, [[readerGrant, reader, project, randomUUID()], [randomUUID(), reader, otherProject, randomUUID()]]);
  await insertBatch(issueInsert, [[1, targetId, project, 'Reference target', 'Current body', owner, randomUUID()], [2, otherId, otherProject, 'Other target', '', owner, randomUUID()]]);
  await db.prepare("INSERT INTO project_status_names(project_id,status_key,display_name,updated_at,updated_by_principal_id) VALUES(?1,'backlog','Waiting',1,?2)").bind(project, owner).run();
  auth = await authenticateBearer(db, `Bearer ${readerToken}`);
});
after(() => server.close());

test('discovery and metadata statically declare Issue reference support without extra D1 reads', async () => {
  for (const [read, pathname, options] of [
    [database => getInstanceDiscovery(database, origin), '/.well-known/cfkanban-instance.json', {}],
    [database => getMeta(database, auth, origin), '/api/v1/meta', { headers }],
  ]) {
    const measured = measure(db);
    const result = await read(measured.db);
    assert.equal(result.capabilities.issue_reference, true);
    assert.equal(measured.queries.length, 2, 'existing instance/homepage or instance/scope reads only');
    const response = await worker.fetch(new URL(pathname, origin), options);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).capabilities.issue_reference, true);
  }
});

async function probe(identifier, projection, history) {
  const measured = measure(db);
  const result = await getIssueReference(measured.db, auth, identifier, referenceUrl(identifier, projection));
  const started = performance.now();
  const response = await worker.fetch(referenceUrl(identifier, projection), { headers });
  const text = await response.text();
  const elapsed = performance.now() - started;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(JSON.parse(text), result);
  assert.ok(Buffer.byteLength(text) <= (projection === 'mention' ? 4096 : 16384));
  assert.equal(measured.queries.length, 3);
  assert.ok(measured.queries.every(row => row.rows_written === 0));
  assert.ok(measured.queries.every(row => !/\b(?:FROM|JOIN)\s+(?:comments|issue_relations|issue_labels|labels)\b/iu.test(row.sql)));
  console.log(JSON.stringify({ cost: 'issue-reference', history, projection, http_requests: 1,
    d1_queries: measured.queries.length, rows_read: measured.queries.reduce((sum, row) => sum + row.rows_read, 0),
    response_bytes: Buffer.byteLength(text), latency_ms: Number(elapsed.toFixed(2)) }));
  return { result, queries: measured.queries };
}

async function probeInputSequence(history) {
  const samples = [];
  for (const identifier of ['CFK-6', 'CFK-60', 'CFK-600']) {
    const measured = measure(db);
    let result = null, status = 200;
    try {
      result = await getIssueReference(measured.db, auth, identifier, referenceUrl(identifier));
    } catch (error) {
      assert.equal(error.status, 404);
      assert.equal(error.code, 'NOT_FOUND');
      status = 404;
    }
    const started = performance.now();
    const response = await worker.fetch(referenceUrl(identifier), { headers });
    const text = await response.text();
    const elapsed = performance.now() - started;
    assert.equal(response.status, status);
    if (status === 200) assert.deepEqual(JSON.parse(text), result);
    else assert.equal(JSON.parse(text).code, 'NOT_FOUND');
    assert.ok(Buffer.byteLength(text) <= 4096);
    assert.ok(measured.queries.every(row => row.rows_written === 0));
    assert.ok(measured.queries.every(row => !/\b(?:FROM|JOIN)\s+(?:comments|issue_relations|issue_labels|labels)\b/iu.test(row.sql)));
    samples.push({ identifier, status, d1_queries: measured.queries.length,
      rows_read: measured.queries.reduce((sum, row) => sum + row.rows_read, 0),
      response_bytes: Buffer.byteLength(text), end_to_end_latency_ms: Number(elapsed.toFixed(2)) });
  }
  console.log(JSON.stringify({ cost: 'issue-reference-input-sequence', history, http_requests: samples.length, samples }));
  return samples;
}

test('exact reference projections stay bounded as Issue, Comment and Relation history grows', async () => {
  const baseline = {};
  for (const projection of ['mention', 'resource']) baseline[projection] = await probe('CFK-1', projection, '2 issues, no comments or relations');
  assert.deepEqual(Object.keys(baseline.mention.result).sort(), ['id', 'identifier', 'project', 'title', 'workspace']);
  assert.equal(baseline.resource.result.body, 'Current body');
  assert.equal(baseline.resource.result.body_bytes, 12);
  assert.equal(baseline.resource.result.body_truncated, false);
  assert.deepEqual(baseline.resource.result.status, { key: 'backlog', display_name: 'Waiting' });
  assert.equal(baseline.resource.result.priority, 'none');
  assert.equal(baseline.resource.result.version, 1);
  assert.equal(baseline.resource.result.updated_at, '1970-01-01T00:00:00.001Z');
  assert.ok(baseline.mention.queries.every(row => !/\bi\.body\b/u.test(row.sql)), 'mention never reads the body');
  assert.match(baseline.resource.queries.at(-1).sql, /hex\(substr\(CAST\(i\.body AS BLOB\), 1, 8192\)\)/u);
  const zeroBefore = measure(db);
  await assert.rejects(getIssueReference(zeroBefore.db, auth, 'CFK-999999', referenceUrl('CFK-999999')), error => error.status === 404);
  const smallSequence = await probeInputSequence('2 issues, no comments or relations');
  for (const sample of smallSequence) {
    assert.equal(sample.status, 404);
    assert.equal(sample.d1_queries, zeroBefore.queries.length);
    assert.equal(sample.rows_read, zeroBefore.queries.reduce((sum, row) => sum + row.rows_read, 0));
  }

  const issueIds = Array.from({ length: 1600 }, () => randomUUID());
  await insertBatch(issueInsert, issueIds.map((id, index) => [index + 3, id, project, `Historical ${index}`, 'x'.repeat(4096), owner, randomUUID()]));
  await insertBatch(`INSERT INTO comments(id,issue_id,kind,author_principal_id,body,created_at,created_operation_id)
    VALUES(?1,?2,'standard',?3,'Historical comment',1,?4)`, Array.from({ length: 3200 }, () => [randomUUID(), targetId, owner, randomUUID()]));
  await insertBatch(`INSERT INTO issue_relations(id,workspace_id,kind,source_issue_id,target_issue_id,source_project_id,target_project_id,created_at,created_by_principal_id,created_operation_id)
    VALUES(?1,?2,'related',?3,?4,?5,?5,1,?6,?7)`, issueIds.map(id => [randomUUID(), workspace, targetId, id, project, owner, randomUUID()]));
  for (const projection of ['mention', 'resource']) {
    const large = await probe('CFK-1', projection, '1602 issues, 3200 comments, 1600 relations');
    assert.deepEqual(large.result, baseline[projection].result);
    assert.deepEqual(large.queries.map(row => row.rows_read), baseline[projection].queries.map(row => row.rows_read), 'actual D1 point-read cost must remain constant');
  }
  const zeroAfter = measure(db);
  await assert.rejects(getIssueReference(zeroAfter.db, auth, 'CFK-999999', referenceUrl('CFK-999999')), error => error.status === 404);
  assert.deepEqual(zeroAfter.queries.map(row => row.rows_read), zeroBefore.queries.map(row => row.rows_read));
  const largeSequence = await probeInputSequence('1602 issues, 3200 comments, 1600 relations');
  for (const sample of largeSequence) {
    assert.equal(sample.status, 200);
    assert.equal(sample.d1_queries, baseline.mention.queries.length);
    assert.equal(sample.rows_read, baseline.mention.queries.reduce((sum, row) => sum + row.rows_read, 0));
  }
  console.log(JSON.stringify({ cost: 'issue-reference-zero-match', d1_queries: zeroAfter.queries.length,
    rows_read: zeroAfter.queries.reduce((sum, row) => sum + row.rows_read, 0) }));
});

test('resource bodies preserve Unicode boundaries, original byte lengths and escaped JSON budgets', async () => {
  for (const source of ['a'.repeat(8191) + '🙂z', '你'.repeat(3000), '\uFEFF' + 'x'.repeat(9000), '\u0001'.repeat(8192)]) {
    await db.prepare('UPDATE issues SET body=?1 WHERE id=?2').bind(source, targetId).run();
    const { result } = await probe('CFK-1', 'resource', 'bounded UTF-8 and JSON escaping');
    assert.equal(result.body_bytes, Buffer.byteLength(source));
    assert.equal(result.body_truncated, true);
    assert.ok(Buffer.byteLength(result.body) <= 8192);
    assert.ok(source.startsWith(result.body));
    assert.equal(result.body.includes('\uFFFD'), false);
    if (source.startsWith('\uFEFF')) assert.ok(result.body.startsWith('\uFEFF'), 'preserve a source BOM as content');
  }
  await db.prepare('UPDATE issues SET body=?1 WHERE id=?2').bind('Current body', targetId).run();
  const response = await worker.fetch(new URL('/api/v1/issues/CFK-1/reference', origin), { headers });
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(await response.json(), 'body'), false, 'default projection is mention');
  for (const query of ['projection=context', 'projection=mention&projection=resource']) {
    assert.equal((await worker.fetch(new URL(`/api/v1/issues/CFK-1/reference?${query}`, origin), { headers })).status, 400);
  }
});

test('maximum metadata lengths remain below the mention JSON ceiling after escaping', async () => {
  await db.batch([
    db.prepare('UPDATE issues SET title=?1,title_search=?1 WHERE id=?2').bind('\u0001'.repeat(256), targetId),
    db.prepare('UPDATE projects SET display_name=?1 WHERE id=?2').bind('\u0001'.repeat(128), project),
    db.prepare('UPDATE workspaces SET display_name=?1 WHERE id=?2').bind('\u0001'.repeat(128), workspace),
  ]);
  try {
    const { result } = await probe('CFK-1', 'mention', 'maximum escaped metadata');
    assert.equal(result.title.length, 256);
    assert.equal(result.project.display_name.length, 128);
    assert.equal(result.workspace.display_name.length, 128);
  } finally {
    await db.batch([
      db.prepare("UPDATE issues SET title='Reference target',title_search='Reference target' WHERE id=?1").bind(targetId),
      db.prepare("UPDATE projects SET display_name='Reference project' WHERE id=?1").bind(project),
      db.prepare("UPDATE workspaces SET display_name='Reference workspace' WHERE id=?1").bind(workspace),
    ]);
  }
});

test('reference reads enforce current Grants, Credential revocation and paused containers', async () => {
  const cases = [
    ["UPDATE project_grants SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2", [owner, readerGrant], 'UPDATE project_grants SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1', [readerGrant], 404],
    ["UPDATE credentials SET revoked_at=2,revoked_by_principal_id=?1 WHERE id=?2", [owner, readerCredential], 'UPDATE credentials SET revoked_at=NULL,revoked_by_principal_id=NULL WHERE id=?1', [readerCredential], 401],
    ["UPDATE projects SET deleted_at=2,deleted_by_principal_id=?1 WHERE id=?2", [owner, project], 'UPDATE projects SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1', [project], 404],
    ["UPDATE workspaces SET deleted_at=2,deleted_by_principal_id=?1 WHERE id=?2", [owner, workspace], 'UPDATE workspaces SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1', [workspace], 404],
    ["UPDATE issues SET deleted_at=2,deleted_by_principal_id=?1 WHERE id=?2", [owner, targetId], 'UPDATE issues SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1', [targetId], 404],
  ];
  for (const [pause, pauseValues, restore, restoreValues, status] of cases) {
    await db.prepare(pause).bind(...pauseValues).run();
    try {
      for (const projection of ['mention', 'resource']) assert.equal((await worker.fetch(referenceUrl('CFK-1', projection), { headers })).status, status);
    } finally { await db.prepare(restore).bind(...restoreValues).run(); }
    let revoked = false;
    const raced = measure(db, async sql => {
      if (!revoked && sql.includes('ORDER BY w.id, p.id')) {
        revoked = true;
        await db.prepare(pause).bind(...pauseValues).run();
      }
    });
    try {
      await assert.rejects(getIssueReference(raced.db, auth, 'CFK-1', referenceUrl('CFK-1', 'resource')), error => error.status === status);
      assert.equal(revoked, true, 'fixture changes live authorization after selection and before final projection');
    } finally { await db.prepare(restore).bind(...restoreValues).run(); }
  }
});

test('Cookie Session scope cannot widen to another otherwise readable Project', async () => {
  const now = Date.now(), session = randomUUID(), cookie = 'S'.repeat(43);
  const target = { kind: 'project', workspace_id: workspace, project_id: project, entry_path: `/app/w/${workspace}/p/${project}` };
  await db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at)
    VALUES(?1,?2,?3,'credential',?4,'project',?5,?6,?7)`)
    .bind(session, digest(cookie), reader, readerCredential, JSON.stringify(target), now + 3600000, now).run();
  for (const projection of ['mention', 'resource']) {
    const cookieHeaders = { cookie: `cfkanban_session=${cookie}` };
    assert.equal((await worker.fetch(referenceUrl('CFK-1', projection), { headers: cookieHeaders })).status, 200);
    assert.equal((await worker.fetch(referenceUrl('CFK-2', projection), { headers })).status, 200);
    assert.equal((await worker.fetch(referenceUrl('CFK-2', projection), { headers: cookieHeaders })).status, 404);
  }
  await db.prepare('UPDATE web_sessions SET revoked_at=?1 WHERE id=?2').bind(now, session).run();
  assert.equal((await worker.fetch(referenceUrl('CFK-1'), { headers: { cookie: `cfkanban_session=${cookie}` } })).status, 401);
});

test('Issue-scoped Cookie reference reads recheck their live anchor after the scope pre-read', async () => {
  const now = Date.now(), session = randomUUID(), cookie = 'I'.repeat(43);
  const anchorId = randomUUID(), peerId = randomUUID(), anchorIdentifier = 'CFK-900001', peerIdentifier = 'CFK-900002';
  await insertBatch(issueInsert, [
    [900001, anchorId, project, 'Session anchor', '', owner, randomUUID()],
    [900002, peerId, project, 'Same Project reference', 'Peer body', owner, randomUUID()],
  ]);
  const target = { kind: 'issue', identifier: anchorIdentifier, issue_id: anchorId,
    workspace_id: workspace, project_id: project, entry_path: `/app/issues/${anchorIdentifier}` };
  await db.prepare(`INSERT INTO web_sessions(id,token_digest,principal_id,source_kind,source_id,target_kind,target_json,expires_at,created_at)
    VALUES(?1,?2,?3,'credential',?4,'issue',?5,?6,?7)`)
    .bind(session, digest(cookie), reader, readerCredential, JSON.stringify(target), now + 3600000, now).run();
  const cookieHeaders = { cookie: `cfkanban_session=${cookie}` };
  const cookieAuth = await authenticateCookieSession(db, new Request(referenceUrl(peerIdentifier), { headers: cookieHeaders }));
  const mutations = [
    ["UPDATE issues SET deleted_at=2,deleted_by_principal_id=?1 WHERE id=?2", [owner, anchorId],
      'UPDATE issues SET deleted_at=NULL,deleted_by_principal_id=NULL WHERE id=?1', [anchorId]],
    ['UPDATE issues SET project_id=?1 WHERE id=?2', [otherProject, anchorId],
      'UPDATE issues SET project_id=?1 WHERE id=?2', [project, anchorId]],
  ];
  for (const projection of ['mention', 'resource']) {
    const result = await getIssueReference(db, cookieAuth, peerIdentifier, referenceUrl(peerIdentifier, projection));
    assert.equal(result.id, peerId, 'Issue Session permits another Issue in the current anchor Project');
    for (const [mutate, mutationValues, restore, restoreValues] of mutations) {
      let changed = false;
      const raced = measure(db, async sql => {
        if (!changed && sql.includes('ORDER BY w.id, p.id')) {
          changed = true;
          await db.prepare(mutate).bind(...mutationValues).run();
        }
      });
      try {
        await assert.rejects(getIssueReference(raced.db, cookieAuth, peerIdentifier, referenceUrl(peerIdentifier, projection)), error => error.status === 404);
        assert.equal(changed, true, 'anchor changes after live scope was initially authorized');
        assert.match(raced.queries.find(row => row.sql.includes('reference_anchor')).sql, /reference_anchor\.project_id = i\.project_id/u);
        assert.equal((await worker.fetch(referenceUrl(peerIdentifier, projection), { headers: cookieHeaders })).status, 404);
      } finally { await db.prepare(restore).bind(...restoreValues).run(); }
    }
  }
});

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import contract from '../../contracts/openapi.json' with { type: 'json' };
import { bootstrapInstance } from '../../apps/worker/src/services/bootstrap.ts';
import { main, EXIT_CODES } from '../../packages/cli/src/main.mjs';
import { createCliRuntime } from '../../packages/cli/src/runtime.mjs';
import { dispatch } from '../../packages/skill-runtime/src/cli.mjs';
import { loadCurrentCredentialSecret, loadPendingCredentialSecret } from '../../packages/skill-runtime/src/state.mjs';
import { approveOwnerDevice, prepareOwnerDevice, restorePreviousOwnerDeviceIdentity, verifyOwnerDevice } from '../../packages/skill-runtime/src/owner-devices.mjs';
import { createMcpStateFixture } from './mcp-fixture.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const resolveSchema = schema => schema?.$ref ? schema.$ref.slice(2).split('/').reduce((value, key) => value[key], contract) : schema;
function conforms(value, inputSchema) {
  const schema = resolveSchema(inputSchema);
  if (!schema) return false;
  if (schema.anyOf && !schema.anyOf.some(option => conforms(value, option))) return false;
  if (schema.oneOf && schema.oneOf.filter(option => conforms(value, option)).length !== 1) return false;
  if (schema.allOf && !schema.allOf.every(option => conforms(value, option))) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (Array.isArray(schema.type)) return schema.type.some(type => conforms(value, { ...schema, type }));
  if (schema.type === 'null') return value === null;
  if (schema.type === 'string') return typeof value === 'string'
    && [...value].length >= (schema.minLength ?? 0) && [...value].length <= (schema.maxLength ?? Infinity)
    && (!schema.pattern || new RegExp(schema.pattern, 'u').test(value))
    && (schema.format !== 'uuid' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value));
  if (schema.type === 'integer' || schema.type === 'number') return typeof value === 'number' && Number.isFinite(value)
    && (schema.type !== 'integer' || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity)
    && (!schema.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length)
    && value.every(item => conforms(item, schema.items));
  if (schema.type === 'object' || schema.properties) return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length >= (schema.minProperties ?? 0)
    && (schema.required ?? []).every(key => Object.hasOwn(value, key))
    && Object.entries(value).every(([key, item]) => schema.properties?.[key] ? conforms(item, schema.properties[key]) : schema.additionalProperties !== false);
  return true;
}
function assertServiceResult(operationId, result) {
  const operation = Object.values(contract.paths).flatMap(methods => Object.values(methods)).find(value => value.operationId === operationId);
  assert.ok(operation, `Public operation ${operationId} must be documented`);
  const response = resolveSchema(operation.responses[String(result.status)]);
  assert.ok(conforms(result.ok ? result.data : result.error, response?.content?.['application/json']?.schema), `${operationId} response must conform to the public Service schema`);
}
const resource = result => result.data.resource ?? result.data;
async function assertPrivateOperations(fixture, tokens, pendingOperationId) {
  const directory = path.join(fixture.stateRoot, 'instances', fixture.instanceId, 'cli-operations');
  const files = await readdir(directory);
  assert.ok(files.some(name => name.endsWith('.json')));
  if (pendingOperationId) {
    const pending = JSON.parse(await readFile(path.join(directory, 'pending.json'), 'utf8'));
    assert.equal(pending.operation_id, pendingOperationId, 'Unknown writes must retain the original instance mutation gate');
  } else assert.ok(!files.includes('pending.json'), 'Definite accepted or rejected operations must release the unknown-write gate');
  for (const name of files) {
    const raw = await readFile(path.join(directory, name), 'utf8');
    assert.ok(tokens.every(token => !raw.includes(token)), 'Private operation records must not copy fixture Credentials');
    assert.ok(!/cfk_v1_[a-f0-9]{16}_[A-Za-z0-9_-]{43}/u.test(raw));
    assert.equal((await lstat(path.join(directory, name))).mode & 0o077, 0);
  }
}

test('public CLI uses the isolated real Worker for Owner configuration, Issue lifecycle, CAS and reader refusals', async t => {
  const configuration = JSON.parse(await readFile(path.join(repositoryRoot, 'wrangler.wp02-test.jsonc'), 'utf8'));
  assert.equal(configuration.d1_databases[0].database_id, '00000000-0000-0000-0000-000000000000');
  assert.equal(configuration.d1_databases[0].database_name, 'cfkanban-wp02-test');
  const owner = await createMcpStateFixture(t);
  const server = createTestHarness({ root: repositoryRoot, workers: [{ configPath: 'wrangler.wp02-test.jsonc' }] });
  t.after(() => server.close());
  await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations('DB');
  const { DB: db } = await worker.getEnv();
  const ownerCredential = await loadCurrentCredentialSecret(owner);
  await bootstrapInstance(db, {
    instanceId: owner.instanceId, operationId: randomUUID(), ownerCredentialId: ownerCredential.metadata.credential_id,
    ownerCredentialToken: ownerCredential.token, ownerDisplayName: 'CLI_Owner', ownerPrincipalId: owner.principalId, preferredApiOrigin: owner.origin,
  });
  const requests = [];
  const tokens = [ownerCredential.token];
  const fetchImpl = (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, owner.origin, 'Integration requests must stay inside the local Worker harness');
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const secretDigests = {};
    const safeBody = body && Object.fromEntries(Object.entries(body).map(([key, value]) => {
      if ((key.endsWith('_token') || key === 'invite_code') && typeof value === 'string') {
        tokens.push(value);
        secretDigests[key] = digest(value);
        return [key, '[REDACTED]'];
      }
      return [key, value];
    }));
    requests.push({ method: init.method ?? 'GET', pathname: target.pathname, query: target.search,
      idempotency_key: headers.get('idempotency-key'), caller_digest: headers.has('authorization') ? digest(headers.get('authorization')) : null,
      ...(body ? { body: safeBody } : {}), ...(Object.keys(secretDigests).length ? { secret_digests: secretDigests } : {}) });
    return worker.fetch(target.href, init);
  };
  const invokeFor = (fixture, requestFetch = fetchImpl) => {
    // fixture 的临时 HOME 已获明确测试授权；只确认这一环境条件，安全脚本和 HTTP 仍真实执行。
    const dispatchImpl = (name, input) => dispatch(name, { ...input, ...(name === 'credential prepare' ? { persistenceConfirmed: true } : {}) });
    const runtime = createCliRuntime({ ...fixture, fetchImpl: requestFetch, dispatchImpl });
    return async (argv, { operationId, code = EXIT_CODES.success, errorCode, body = '' } = {}) => {
      let stdout = '', stderr = '';
      const actual = await main([...argv, '--instance', fixture.instanceId, '--json'], {
        runtime, stdin: Readable.from(body ? [body] : []), stdout: { write: value => stdout += value }, stderr: { write: value => stderr += value },
      });
      assert.ok(tokens.every(token => !stdout.includes(token) && !stderr.includes(token)), 'CLI output must not expose fixture Credentials');
      assert.ok(!/cfk_v1_[a-f0-9]{16}_[A-Za-z0-9_-]{43}/u.test(stdout + stderr));
      const diagnostic = JSON.parse(stdout || stderr);
      assert.equal(actual, code, `Public command ${argv.slice(0, 2).join(' ')} must return its documented exit code (${diagnostic.error_code ?? diagnostic.result?.error?.code ?? 'no error'})`);
      if (errorCode) {
        assert.equal(stdout, '');
        assert.equal(stderr.trim().split('\n').length, 1);
        assert.equal(diagnostic.schema_version, 1);
        assert.equal(diagnostic.ok, false);
        assert.equal(diagnostic.error_code, errorCode);
        return diagnostic.result;
      }
      assert.equal(stderr, '', 'Service results belong in the stable stdout JSON envelope');
      assert.equal(stdout.trim().split('\n').length, 1);
      const envelope = JSON.parse(stdout);
      assert.deepEqual(Object.keys(envelope).sort(), ['ok', 'result', 'schema_version']);
      assert.equal(envelope.schema_version, 1);
      assert.equal(envelope.ok, code === EXIT_CODES.success);
      if (typeof envelope.result.ok === 'boolean') assert.equal(envelope.result.ok, code === EXIT_CODES.success);
      if (operationId) assertServiceResult(operationId, envelope.result);
      return envelope.result;
    };
  };
  const run = invokeFor(owner);
  let workspace, project, issue, recoveredIssue, outside, lifecycleReady = false;

  await t.test('Owner container configuration and Issue lifecycle preserve public JSON, readback and CAS', async () => {
    const profile = await run(['profile', 'show'], { operationId: 'getMe' });
    assert.equal(profile.data.id, owner.principalId);
    assert.equal(profile.data.is_owner, true);
    workspace = resource(await run(['workspace', 'create', '--display-name', 'CLI workspace', '--description', '  CLI 工作区描述\n  '], { operationId: 'createWorkspace' }));
    assert.equal(workspace.description, '  CLI 工作区描述\n  ');
    const renamedWorkspace = await run(['workspace', 'update', '--workspace-id', workspace.id, '--display-name', 'CLI workspace configured'], { operationId: 'updateWorkspace' });
    assert.equal(renamedWorkspace.readback.data.display_name, 'CLI workspace configured');
    assert.equal(renamedWorkspace.readback.data.description, workspace.description);
    const describedWorkspace = await run(['workspace', 'update', '--workspace-id', workspace.id, '--description', 'Updated description'], { operationId: 'updateWorkspace' });
    assert.equal(describedWorkspace.readback.data.display_name, 'CLI workspace configured');
    assert.equal(describedWorkspace.readback.data.description, 'Updated description');
    const clearedWorkspace = await run(['workspace', 'update', '--workspace-id', workspace.id, '--description', 'null'], { operationId: 'updateWorkspace' });
    assert.equal(clearedWorkspace.readback.data.description, null);
    project = resource(await run(['project', 'create', '--workspace-id', workspace.id, '--display-name', 'CLI project'], { operationId: 'createProject' }));
    const configuredProject = await run(['project', 'update', '--workspace-id', workspace.id, '--project-id', project.id, '--context', '## Local fixture\n\nVerified public CLI project context.'], { operationId: 'updateProject' });
    assert.match(configuredProject.readback.data.context, /Verified public CLI/);
    const status = await run(['project', 'status', 'rename', '--workspace-id', workspace.id, '--project-id', project.id, '--status-key', 'todo', '--display-name', 'Ready'], { operationId: 'updateProjectStatusName' });
    assert.ok(status.readback.data.items.some(value => value.key === 'todo' && value.display_name === 'Ready'));
    const created = await run(['issue', 'create', '--workspace-id', workspace.id, '--project-id', project.id, '--title', 'CLI lifecycle', '--status-key', 'todo', '--priority-key', 'high'], { operationId: 'createIssue' });
    issue = resource(created);
    assert.equal(created.operation.phase, 'verified');
    assert.equal(created.readback.data.identifier, issue.identifier);
    const listed = await run(['issue', 'list', '--project', project.id, '--status', 'todo', '--priority', 'high', '--limit', '1'], { operationId: 'listIssues' });
    assert.equal(listed.data.items[0].identifier, issue.identifier);
    assert.deepEqual(listed.data.resolved_scope.projects.map(value => value.project_id), [project.id]);
    const updated = await run(['issue', 'update', '--identifier', issue.identifier, '--status-key', 'in_progress'], { operationId: 'updateIssue' });
    assert.equal(updated.readback.data.status.key, 'in_progress');
    const conflict = await run(['issue', 'update', '--identifier', issue.identifier, '--expected-version', String(issue.version), '--title', 'Rejected stale title'], { operationId: 'updateIssue', code: EXIT_CODES.conflict });
    assert.equal(conflict.error.code, 'VERSION_CONFLICT');
    assert.equal(conflict.outcome_unknown, undefined);
    assert.equal((await run(['issue', 'show', '--identifier', issue.identifier], { operationId: 'getIssue' })).data.title, 'CLI lifecycle');
    const recoveryId = randomUUID(), recoveryKey = `cli-service-drop-${recoveryId}`;
    let loseResponse = true;
    const interrupted = invokeFor(owner, async (url, init) => {
      const response = await fetchImpl(url, init);
      if (loseResponse && init.method === 'POST' && new URL(url).pathname === `/api/v1/workspaces/${workspace.id}/projects/${project.id}/issues`) {
        loseResponse = false;
        await response.text();
        throw new Error('Isolated fixture drops the response after the Worker committed');
      }
      return response;
    });
    const unknown = await interrupted(['issue', 'create', '--workspace-id', workspace.id, '--project-id', project.id, '--title', 'CLI recovered creation', '--operation-id', recoveryId, '--idempotency-key', recoveryKey], { code: EXIT_CODES.outcome_unknown });
    assert.equal(unknown.outcome_unknown, true);
    assert.equal(unknown.recovery.operation_id, recoveryId);
    const recovered = await invokeFor(owner)(['operation', 'recover', '--operation-id', recoveryId], { operationId: 'createIssue' });
    assert.equal(recovered.operation.phase, 'verified');
    assert.equal(recovered.data.idempotent_replay, true);
    recoveredIssue = resource(recovered);
    assert.equal(recovered.readback.data.title, 'CLI recovered creation');
    const attempts = requests.filter(value => value.method === 'POST' && value.idempotency_key === recoveryKey);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].body, attempts[1].body);
    const comment = await run(['comment', 'create', '--identifier', issue.identifier, '--body-stdin'], { operationId: 'createComment', body: '## Evidence\n\nReal isolated Worker and D1.' });
    assert.match(comment.readback.data.body, /Real isolated Worker/);
    const completed = await run(['issue', 'complete', '--identifier', issue.identifier, '--summary', 'CLI completion evidence', '--verification', 'real isolated Worker'], { operationId: 'completeIssue' });
    assert.equal(completed.readback.data.status.key, 'done');
    const comments = await run(['comment', 'list', '--identifier', issue.identifier], { operationId: 'listComments' });
    assert.ok(comments.data.items.some(value => value.kind === 'completion' && value.completion.summary === 'CLI completion evidence'));
    const reopenId = randomUUID();
    const reopened = await run(['issue', 'reopen', '--identifier', issue.identifier, '--status-key', 'todo', '--operation-id', reopenId], { operationId: 'updateIssue' });
    assert.equal(reopened.readback.data.status.key, 'todo');
    assert.equal(reopened.operation.operation_id, reopenId);
    const deleted = await run(['issue', 'delete', '--identifier', issue.identifier], { operationId: 'deleteIssue' });
    assert.notEqual(deleted.readback.data.deleted_at, null);
    const tombstone = await run(['issue', 'show', '--identifier', issue.identifier, '--deleted', 'only'], { operationId: 'getIssue' });
    assert.notEqual(tombstone.data.deleted_at, null);
    const restored = await run(['issue', 'restore', '--identifier', issue.identifier], { operationId: 'restoreIssue' });
    assert.equal(restored.readback.data.deleted_at, null);
    const other = resource(await run(['project', 'create', '--workspace-id', workspace.id, '--display-name', 'Outside reader scope'], { operationId: 'createProject' }));
    outside = resource(await run(['issue', 'create', '--workspace-id', workspace.id, '--project-id', other.id, '--title', 'Outside reader scope'], { operationId: 'createIssue' }));
    assert.ok(requests.some(value => value.method === 'GET' && value.pathname === `/api/v1/issues/${issue.identifier}` && value.query === '?deleted=only'));
    lifecycleReady = true;
  });

  if (!lifecycleReady) return;
  await t.test('Reader can query its project but cannot write or discover another project', async () => {
    const reader = await createMcpStateFixture(t, { instanceId: owner.instanceId, origin: owner.origin });
    const credential = await loadCurrentCredentialSecret(reader);
    tokens.push(credential.token);
    const now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES (?1,'CLI_Reader','cli_reader',?2,?2)").bind(reader.principalId, now),
      db.prepare('INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?6)').bind(credential.metadata.credential_id, reader.principalId, credential.token.split('_')[2], credential.metadata.token_digest, now, randomUUID()),
      db.prepare("INSERT INTO project_grants(id,principal_id,project_id,role,created_at,updated_at,created_operation_id) VALUES (?1,?2,?3,'reader',?4,?4,?5)").bind(randomUUID(), reader.principalId, project.id, now, randomUUID()),
    ]);
    const read = invokeFor(reader);
    assert.equal((await read(['issue', 'show', '--identifier', issue.identifier], { operationId: 'getIssue' })).data.identifier, issue.identifier);
    const listed = await read(['issue', 'list', '--project', project.id], { operationId: 'listIssues' });
    assert.deepEqual(listed.data.items.map(value => value.identifier).sort(), [issue.identifier, recoveredIssue.identifier].sort());
    for (const [argv, operationId] of [
      [['issue', 'update', '--identifier', issue.identifier, '--title', 'Reader rejected'], 'updateIssue'],
      [['comment', 'create', '--identifier', issue.identifier, '--body-stdin'], 'createComment'],
      [['project', 'update', '--workspace-id', workspace.id, '--project-id', project.id, '--context', 'Reader rejected'], 'updateProject'],
      [['workspace', 'create', '--display-name', 'Reader rejected'], 'createWorkspace'],
      [['workspace', 'update', '--workspace-id', workspace.id, '--description', 'Reader rejected'], 'updateWorkspace'],
    ]) {
      const denied = await read(argv, { operationId, code: EXIT_CODES.authorization, body: 'Reader rejected' });
      assert.equal(denied.status, 403);
      assert.equal(denied.error.source, 'service');
      assert.equal(denied.outcome_unknown, undefined);
    }
    const hidden = await read(['issue', 'show', '--identifier', outside.identifier], { operationId: 'getIssue', code: EXIT_CODES.not_found });
    assert.equal(hidden.status, 404);
    await assertPrivateOperations(reader, tokens);
    const unchanged = await run(['issue', 'show', '--identifier', issue.identifier], { operationId: 'getIssue' });
    assert.equal(unchanged.data.title, 'CLI lifecycle');
    assert.equal((await run(['workspace', 'list'], { operationId: 'listWorkspaces' })).data.items.length, 1);
  });
  for (const settings of [
    {
      command: ['admin', 'homepage'], path: '/api/v1/admin/homepage-settings', showOperation: 'getHomepageSettings', updateOperation: 'updateHomepageSettings',
      flags: ['--notice-en', 'CLI verified notice', '--notice-zh-cn', 'CLI 已验证公告'],
      conflictFlags: ['--notice-en', 'Rejected changed notice', '--notice-zh-cn', '拒绝变更'],
      assertResource: value => { assert.equal(value.notice_en, 'CLI verified notice'); assert.equal(value.notice_zh_cn, 'CLI 已验证公告'); },
    },
    {
      command: ['admin', 'attachment-capacity'], path: '/api/v1/admin/attachment-settings', showOperation: 'getAttachmentSettings', updateOperation: 'updateAttachmentSettings',
      flags: ['--limit-bytes', '1048576'], conflictFlags: ['--limit-bytes', '2097152'],
      assertResource: value => { assert.equal(value.limit_bytes, 1048576); assert.equal(value.configured, true); },
    },
  ]) await t.test(`${settings.command.join(' ')} uses real Service idempotency and CAS`, async () => {
    const before = await run([...settings.command, 'show'], { operationId: settings.showOperation });
    const key = `cli-settings-${randomUUID()}`;
    const argv = [...settings.command, 'update', '--expected-version', String(before.data.version), '--idempotency-key', key];
    const changed = await run([...argv, ...settings.flags], { operationId: settings.updateOperation });
    assert.equal(changed.data.idempotent_replay, false);
    assert.equal(changed.operation.phase, 'verified');
    settings.assertResource(changed.readback.data);
    const replay = await run([...argv, ...settings.flags], { operationId: settings.updateOperation });
    assert.equal(replay.data.idempotent_replay, true);
    assert.deepEqual(replay.data.resource, changed.data.resource);
    assert.equal(replay.data.event_cursor, changed.data.event_cursor);
    const attempts = requests.filter(value => value.method === 'PATCH' && value.pathname === settings.path && value.idempotency_key === key);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].body, attempts[1].body);
    const keyConflict = await run([...argv, ...settings.conflictFlags], { operationId: settings.updateOperation, code: EXIT_CODES.conflict });
    assert.equal(keyConflict.error.code, 'IDEMPOTENCY_CONFLICT');
    const stale = await run([...settings.command, 'update', '--expected-version', String(before.data.version), '--idempotency-key', `cli-stale-${randomUUID()}`, ...settings.conflictFlags], { operationId: settings.updateOperation, code: EXIT_CODES.conflict });
    assert.equal(stale.error.code, 'VERSION_CONFLICT');
    const current = await run([...settings.command, 'show'], { operationId: settings.showOperation });
    assert.equal(current.data.version, before.data.version + 1);
    settings.assertResource(current.data);
  });
  await t.test('Profile optional retry keys and seeded self Passkey revocation replay through the real Service', async () => {
    const before = await run(['profile', 'show'], { operationId: 'getMe' });
    const profileKey = `cli-profile-${randomUUID()}`;
    const profileArgs = ['profile', 'update', '--display-name', 'CLI_ConfiguredOwner', '--expected-version', String(before.data.version), '--idempotency-key', profileKey];
    const changed = await run(profileArgs, { operationId: 'updateMe' });
    assert.equal(changed.readback.data.display_name, 'CLI_ConfiguredOwner');
    const replay = await run(profileArgs, { operationId: 'updateMe' });
    assert.equal(replay.data.idempotent_replay, true);
    assert.deepEqual(replay.data.resource, changed.data.resource);
    assert.equal(replay.data.event_cursor, changed.data.event_cursor);
    const profileAttempts = requests.filter(value => value.method === 'PATCH' && value.pathname === '/api/v1/me' && value.idempotency_key === profileKey);
    assert.equal(profileAttempts.length, 2);
    assert.deepEqual(profileAttempts[0].body, profileAttempts[1].body);

    const passkeyId = randomUUID();
    // 合成 Authenticator 仅覆盖管理已有 Passkey；不模拟 WebAuthn 注册仪式。
    await db.prepare("INSERT INTO web_authenticators(id,principal_id,credential_id,public_key_cose,algorithm,user_handle,backup_eligible,backup_state,rp_id,created_at,created_operation_id) VALUES(?1,?2,?3,'test-public-key-material',-7,'test-user-handle',0,0,?4,?5,?6)")
      .bind(passkeyId, owner.principalId, randomUUID(), new URL(owner.origin).hostname, Date.now(), randomUUID()).run();
    const list = await run(['passkey', 'list'], { operationId: 'listMyPasskeys' });
    const passkey = list.data.items.find(value => value.id === passkeyId);
    assert.equal(passkey.version, 1);
    const passkeyKey = `cli-passkey-${randomUUID()}`;
    const passkeyArgs = ['passkey', 'revoke', '--passkey-id', passkeyId, '--expected-version', String(passkey.version), '--idempotency-key', passkeyKey];
    const revoked = await run(passkeyArgs, { operationId: 'revokeMyPasskey' });
    assert.equal(revoked.operation.phase, 'verified');
    assert.equal(typeof revoked.data.resource.revoked_at, 'string');
    const revokeReplay = await run(passkeyArgs, { operationId: 'revokeMyPasskey' });
    assert.equal(revokeReplay.data.idempotent_replay, true);
    assert.deepEqual(revokeReplay.data.resource, revoked.data.resource);
    assert.equal(revokeReplay.data.event_cursor, revoked.data.event_cursor);
    const deleteAttempts = requests.filter(value => value.method === 'DELETE' && value.pathname === `/api/v1/me/passkeys/${passkeyId}` && value.idempotency_key === passkeyKey);
    assert.equal(deleteAttempts.length, 2);
    assert.equal(deleteAttempts[0].query, deleteAttempts[1].query);
    const after = await run(['passkey', 'list'], { operationId: 'listMyPasskeys' });
    const observed = after.data.items.find(value => value.id === passkeyId);
    assert.equal(observed.version, 2);
    assert.notEqual(observed.revoked_at, null);
    assert.equal((await run(['profile', 'show'], { operationId: 'getMe' })).data.id, owner.principalId);
  });
  await t.test('Unknown current_principal Public Join recovery remains bound to its original caller and key', async () => {
    const joining = await createMcpStateFixture(t, { instanceId: owner.instanceId, origin: owner.origin });
    const caller = await loadCurrentCredentialSecret(joining);
    tokens.push(caller.token);
    const now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES (?1,'CLI_JoinCaller','cli_joincaller',?2,?2)").bind(joining.principalId, now),
      db.prepare('INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?6)').bind(caller.metadata.credential_id, joining.principalId, caller.token.split('_')[2], caller.metadata.token_digest, now, randomUUID()),
    ]);
    const publicProject = resource(await run(['project', 'create', '--workspace-id', workspace.id, '--display-name', 'CLI bounded Public Join'], { operationId: 'createProject' }));
    const enabled = await run(['admin', 'public-join', 'enable', '--project-id', publicProject.id, '--expected-version', String(publicProject.version), '--public-summary', 'Isolated CLI recovery fixture', '--issue-limit', '10', '--comment-limit', '20', '--principal-limit', '3'], { operationId: 'enablePublicJoin' });
    const publicId = enabled.data.resource.public_id;
    const operationId = randomUUID(), key = `cli-current-join-${operationId}`;
    const apiPath = `/api/v1/public-joins/${publicId}/redeem`;
    let loseResponse = true;
    const interrupted = invokeFor(joining, async (url, init) => {
      const response = await fetchImpl(url, init);
      if (loseResponse && init.method === 'POST' && new URL(url).pathname === apiPath) {
        loseResponse = false;
        await response.text();
        throw new Error('Isolated fixture drops the committed current_principal Join response');
      }
      return response;
    });
    const unknown = await interrupted(['join', 'public', '--public-id', publicId, '--role', 'reader', '--redeem-as', 'current_principal', '--operation-id', operationId, '--idempotency-key', key], { code: EXIT_CODES.outcome_unknown });
    assert.equal(unknown.outcome_unknown, true);
    assert.equal(unknown.recovery.operation_id, operationId);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM project_grants WHERE project_id=?1 AND principal_id=?2').bind(publicProject.id, joining.principalId).first()).count, 1);

    // 安全模块模拟其他客户端批准的身份切换；未直接复制或改写凭据槽位。
    const prepared = await prepareOwnerDevice({ ...joining, fetchImpl, apiOrigin: owner.origin, ownerPrincipalId: owner.principalId,
      deviceName: 'CLI recovery caller switch', operationId: randomUUID(), idempotencyKey: `cli-pairing-${randomUUID()}`,
      persistenceConfirmed: true, replaceCurrent: true, expectedCurrentPrincipalId: joining.principalId, expectedCurrentCredentialId: caller.metadata.credential_id });
    const approved = await approveOwnerDevice({ ...owner, fetchImpl, request: prepared.pairing_request });
    assert.equal(approved.operation.ok, true);
    const verified = await verifyOwnerDevice({ ...joining, fetchImpl });
    assert.equal(verified.verification.ok, true);
    const switched = await loadCurrentCredentialSecret(joining);
    tokens.push(switched.token);
    assert.equal(switched.metadata.principal_id, owner.principalId);
    const attemptsBefore = requests.filter(value => value.method === 'POST' && value.pathname === apiPath).length;
    await invokeFor(joining)(['operation', 'recover', '--operation-id', operationId], { code: EXIT_CODES.conflict, errorCode: 'CLI_RECOVERY_IDENTITY_CHANGED' });
    assert.equal(requests.filter(value => value.method === 'POST' && value.pathname === apiPath).length, attemptsBefore);
    await assertPrivateOperations(joining, tokens, operationId);

    const restored = await restorePreviousOwnerDeviceIdentity({ ...joining, fetchImpl, expectedCurrentPrincipalId: owner.principalId, expectedCurrentCredentialId: switched.metadata.credential_id });
    assert.equal(restored.verification.ok, true);
    assert.equal((await loadCurrentCredentialSecret(joining)).metadata.credential_id, caller.metadata.credential_id);
    const recovered = await invokeFor(joining)(['operation', 'recover', '--operation-id', operationId]);
    assert.equal(recovered.operation.ok, true);
    assertServiceResult('redeemPublicJoin', recovered.operation);
    assert.equal(recovered.operation.data.idempotent_replay, true);
    assert.equal(recovered.operation.data.resource.principal.principal_id, joining.principalId);
    const attempts = requests.filter(value => value.method === 'POST' && value.pathname === apiPath);
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every(value => value.idempotency_key === key && value.caller_digest === digest(`Bearer ${caller.token}`)));
    assert.deepEqual(attempts[0].body, attempts[1].body);
    const record = JSON.parse(await readFile(path.join(joining.stateRoot, 'instances', joining.instanceId, 'cli-operations', `${operationId}.json`), 'utf8'));
    assert.equal(record.identity.principal_id, joining.principalId);
    assert.equal(record.identity.credential_id, caller.metadata.credential_id);
    assert.equal(record.phase, 'verified');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM project_grants WHERE project_id=?1').bind(publicProject.id).first()).count, 1);
    await assertPrivateOperations(joining, tokens);
  });
  let rotationRecovered = false;
  await t.test('A committed Owner rotation recovers its original pending Credential and releases the CLI gate', async () => {
    const current = await loadCurrentCredentialSecret(owner);
    const operationId = randomUUID(), key = `cli-owner-rotation-${operationId}`;
    const apiPath = '/api/v1/admin/owner-credentials/rotate';
    let loseResponse = true;
    const interrupted = invokeFor(owner, async (url, init) => {
      const response = await fetchImpl(url, init);
      if (loseResponse && init.method === 'POST' && new URL(url).pathname === apiPath) {
        loseResponse = false;
        await response.text();
        throw new Error('Isolated fixture drops the committed Owner rotation response');
      }
      return response;
    });
    const unknown = await interrupted(['owner', 'rotate', '--operation-id', operationId, '--idempotency-key', key], { code: EXIT_CODES.outcome_unknown });
    assert.equal(unknown.outcome_unknown, true);
    assert.equal(loseResponse, false, `The fixture must drop a real rotation POST (${unknown.error?.code ?? unknown.operation?.error?.code ?? 'no error'})`);
    assert.equal(unknown.credential?.state, 'pending', `A dropped rotation response must retain pending state (${unknown.error?.code ?? unknown.operation?.error?.code ?? 'no error'})`);
    const pending = await loadPendingCredentialSecret(owner);
    tokens.push(pending.token);
    assert.equal(pending.metadata.operation_id, operationId);
    assert.equal(pending.metadata.idempotency_key, key);
    assert.equal(pending.metadata.purpose, 'owner_rotation');
    assert.equal(pending.metadata.principal_id, owner.principalId);
    await assertPrivateOperations(owner, tokens, operationId);
    const oldBearer = await fetchImpl(new URL('/api/v1/me', owner.origin), { method: 'GET', headers: { authorization: `Bearer ${current.token}` }, signal: new AbortController().signal });
    assert.equal(oldBearer.status, 401);
    await oldBearer.text();
    const recoveryStart = requests.length;
    const recovered = await invokeFor(owner)(['operation', 'recover', '--operation-id', operationId]);
    assert.equal(recovered.operation.ok, true);
    assert.equal(recovered.operation.data.idempotent_replay, true);
    assert.equal(recovered.verification.ok, true);
    assert.equal(recovered.credential.state, 'current');
    const promoted = await loadCurrentCredentialSecret(owner);
    assert.ok(promoted.token === pending.token, 'Recovery must promote the exact original pending Credential');
    assert.equal(promoted.metadata.principal_id, owner.principalId);
    assert.equal(promoted.metadata.fingerprint, pending.metadata.fingerprint);
    assert.equal(promoted.metadata.operation_id, operationId);
    assert.equal(promoted.metadata.idempotency_key, key);
    assert.notEqual(promoted.metadata.credential_id, current.metadata.credential_id);
    assert.equal(requests.slice(recoveryStart).filter(value => value.pathname === '/api/v1/me' && value.caller_digest === digest(`Bearer ${current.token}`)).length, 0);
    const attempts = requests.filter(value => value.method === 'POST' && value.pathname === apiPath && value.idempotency_key === key);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0].body, { new_credential_token: '[REDACTED]' });
    assert.deepEqual(attempts[0].secret_digests, attempts[1].secret_digests);
    assert.ok(attempts.every(value => value.secret_digests.new_credential_token === pending.metadata.token_digest));
    await assertPrivateOperations(owner, tokens);
    const again = await invokeFor(owner)(['operation', 'recover', '--operation-id', operationId]);
    assert.equal(again.credential.state, 'current');
    assert.equal(requests.filter(value => value.method === 'POST' && value.pathname === apiPath && value.idempotency_key === key).length, 2);
    const profile = await run(['profile', 'show'], { operationId: 'getMe' });
    await run(['profile', 'update', '--expected-version', String(profile.data.version), '--theme', 'blue'], { operationId: 'updateMe' });

    await owner.rotate();
    const unrelated = await loadCurrentCredentialSecret(owner);
    tokens.push(unrelated.token);
    await db.prepare('INSERT INTO credentials(id,principal_id,token_prefix,token_digest,issued_at,created_operation_id) VALUES (?1,?2,?3,?4,?5,?6)')
      .bind(unrelated.metadata.credential_id, owner.principalId, unrelated.token.split('_')[2], unrelated.metadata.token_digest, Date.now(), randomUUID()).run();
    assert.equal((await run(['profile', 'show'], { operationId: 'getMe' })).data.is_owner, true);
    await invokeFor(owner)(['operation', 'recover', '--operation-id', operationId], { code: EXIT_CODES.conflict, errorCode: 'CLI_RECOVERY_IDENTITY_CHANGED' });
    assert.equal(requests.filter(value => value.method === 'POST' && value.pathname === apiPath && value.idempotency_key === key).length, 2);
    await assertPrivateOperations(owner, tokens);
    rotationRecovered = true;
  });
  if (!rotationRecovered) return;
  await assertPrivateOperations(owner, tokens);
  await t.test('A lost committed CAS response remains unknown after replay conflict', async () => {
    const operationId = randomUUID();
    const before = await run(['issue', 'show', '--identifier', issue.identifier], { operationId: 'getIssue' });
    const requestStart = requests.length;
    let loseResponse = true;
    const interrupted = invokeFor(owner, async (url, init) => {
      const response = await fetchImpl(url, init);
      if (loseResponse && init.method === 'PATCH' && new URL(url).pathname === `/api/v1/issues/${issue.identifier}`) {
        loseResponse = false;
        await response.text();
        throw new Error('Isolated fixture drops the response after the Worker committed');
      }
      return response;
    });
    const unknown = await interrupted(['issue', 'update', '--identifier', issue.identifier, '--priority-key', 'urgent', '--operation-id', operationId], { code: EXIT_CODES.outcome_unknown });
    assert.equal(unknown.recovery.operation_id, operationId);
    const recovered = await invokeFor(owner)(['operation', 'recover', '--operation-id', operationId], { code: EXIT_CODES.outcome_unknown });
    assert.equal(recovered.outcome_unknown, true);
    assert.equal(recovered.recovery.operation_id, operationId);
    const retained = JSON.parse(await readFile(path.join(owner.stateRoot, 'instances', owner.instanceId, 'cli-operations', `${operationId}.json`), 'utf8'));
    assert.equal(retained.operation_id, operationId);
    assert.equal(retained.phase, 'unknown');
    assert.equal(retained.request.body.expected_version, before.data.version);
    const attempts = requests.slice(requestStart).filter(value => value.method === 'PATCH' && value.pathname === `/api/v1/issues/${issue.identifier}`);
    assert.ok(attempts.length >= 1 && attempts.length <= 2);
    for (const attempt of attempts) {
      assert.equal(attempt.idempotency_key, null, 'CAS-only writes must not claim server idempotency');
      assert.deepEqual(attempt.body, retained.request.body);
    }
    if (attempts.length === 2) {
      assert.equal(recovered.error.code, 'VERSION_CONFLICT');
      assert.deepEqual(attempts[0].body, attempts[1].body);
    }
    const current = await run(['issue', 'show', '--identifier', issue.identifier], { operationId: 'getIssue' });
    assert.equal(current.data.priority, 'urgent');
    await assertPrivateOperations(owner, tokens, operationId);
  });
});

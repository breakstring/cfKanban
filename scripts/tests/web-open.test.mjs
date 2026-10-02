import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { openWeb } from '../../packages/skill-runtime/src/web-open.mjs';
import { getCommandCatalog } from '../../packages/skill-runtime/src/cli.mjs';
import { initializeStateRoot } from '../../packages/skill-runtime/src/state.mjs';
import { installVerifiedSkillBundle, treeDigest } from '../../packages/skill-runtime/src/skill-update.mjs';
import { sha256Bytes } from '../../packages/skill-runtime/src/utils.mjs';
import { writeDeterministicZip } from '../lib/deterministic-zip.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });

async function projectionFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cfkanban-git-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'isolated home');
  await mkdir(home);
  const stateRoot = path.join(home, '.cfkanban');
  await initializeStateRoot({ home, stateRoot, persistenceConfirmed: true });
  const projectionRoot = path.join(root, 'Git plugin cache with spaces');
  const source = path.join(root, 'canonical source');
  for (const entry of ['packages/skill-runtime', 'skills', '.codex-plugin']) {
    for (const destination of [source, projectionRoot]) {
      await mkdir(path.dirname(path.join(destination, entry)), { recursive: true });
      await cp(path.join(repositoryRoot, entry), path.join(destination, entry), { recursive: true });
    }
  }
  const version = JSON.parse(await readFile(path.join(repositoryRoot, 'release/version.json'), 'utf8')).version;
  await mkdir(path.join(projectionRoot, 'release'));
  await writeJson(path.join(projectionRoot, 'release/version.json'), { version });
  const runtimeRoot = path.join(source, 'local-runtime');
  await mkdir(path.join(runtimeRoot, 'embedded'), { recursive: true });
  const files = {};
  for (const entry of ['server.mjs', 'launcher.mjs', 'browser.mjs', 'workbench.mjs', 'THIRD_PARTY_NOTICES.txt', 'embedded/embedded.html', 'embedded/embedded-build.json']) {
    const bytes = Buffer.from(entry === 'launcher.mjs' ? 'export async function openLocalWorkbench(input) { return { mode: "local", canonical: true, directory: input.directory }; }\n' : 'Isolated nonexecuted artifact fixture\n');
    await writeFile(path.join(runtimeRoot, entry), bytes);
    files[entry] = { sha256: sha256Bytes(bytes), size_bytes: bytes.length };
  }
  await writeJson(path.join(runtimeRoot, 'build-metadata.json'), { schema_version: 1, protocol: 1, release_version: version, node_range: '>=22.12.0', files });
  const zip = path.join(root, 'fixture.zip');
  await writeDeterministicZip({ root: source, outputPath: zip, prefix: `cfkanban-skills-${version}/` });
  const releaseRoot = path.join(stateRoot, 'skill-releases');
  const installed = await installVerifiedSkillBundle({ bundlePath: zip, version, expectedSha256: sha256Bytes(await readFile(zip)), publisher: 'https://github.com', source: `https://github.com/breakstring/cfKanban/releases/download/${version}/cfkanban-skills-${version}.zip`, releaseRoot });
  const activePath = path.join(releaseRoot, 'active.json');
  const receiptPath = path.join(installed.release_path, '.cfkanban-release.json');
  const json = async file => JSON.parse(await readFile(file, 'utf8'));
  const rewrite = async (file, patch) => writeJson(file, { ...await json(file), ...patch });
  const run = async () => {
    const moduleUrl = pathToFileURL(path.join(projectionRoot, 'packages/skill-runtime/src/web-open.mjs')).href;
    const script = `globalThis.fetch = () => { throw new Error("Network forbidden in fixture"); };\ntry { const { openWeb } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({ ok: true, result: await openWeb({ directory: "/trusted caller project" }) })); } catch (error) { console.log(JSON.stringify({ ok: false, code: error.code, details: error.details })); }`;
    const env = { HOME: home, USERPROFILE: home, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^SystemRoot$/i.test(key))) };
    const output = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { env, timeout: 15_000, encoding: 'utf8', maxBuffer: 64 * 1024 });
    return JSON.parse(output.stdout);
  };
  return { home, stateRoot, projectionRoot, releaseRoot, activePath, receiptPath, installed, version, run, rewrite, json };
}

test('web open defaults to local and preserves exact caller context without online fallback', async () => {
  const input = { directory: '/a project with spaces', instanceId: 'exact-instance', target: { kind: 'issue', identifier: 'CFK-42' }, delivery: 'host_browser', onRelayReady() {} };
  const calls = [];
  const localLauncher = async () => ({ openLocalWorkbench: async options => { calls.push(options); return { ok: true, mode: 'local' }; } });
  const onlineLauncher = () => { throw Error('Must not select online implicitly'); };
  assert.equal((await openWeb(input, { localLauncher, onlineLauncher })).mode, 'local');
  assert.deepEqual(calls, [input]);
  await assert.rejects(openWeb(input, { localLauncher: async () => { throw Error('Missing build'); }, onlineLauncher }), /Missing build/);
});

test('local management and sensitive online-only options reject before launcher starts', async () => {
  const localLauncher = () => { throw Error('Must reject before launcher'); };
  for (const target of [{ kind: 'admin', section: 'overview' }, { kind: 'workspace', workspace_id: 'id' }]) await assert.rejects(openWeb({ directory: '/project', target }, { localLauncher }), e => e.code === 'LOCAL_TARGET_UNSUPPORTED');
  for (const extra of [{ token: 'must-reject' }, { stateRoot: '/other' }, { idempotencyKey: 'key' }, { sensitiveOutputAcknowledgement: 'ack' }]) await assert.rejects(openWeb({ directory: '/project', ...extra }, { localLauncher }), e => e.code === 'INVALID_WEB_OPEN_INPUT');
});

test('explicit online delegates dedicated delivery and requires stable key', async () => {
  const input = { mode: 'online', instanceId: 'exact-instance', target: { kind: 'admin', section: 'overview' }, delivery: 'system_browser', idempotencyKey: 'stable-key' };
  let received;
  await openWeb(input, { localLauncher: () => { throw Error('Must not start local'); }, onlineLauncher: async options => { received = options; return { ok: true }; } });
  assert.equal(received.instanceId, input.instanceId);
  assert.equal(received.target, input.target);
  assert.equal(received.idempotencyKey, input.idempotencyKey);
  await assert.rejects(openWeb({ ...input, idempotencyKey: undefined }), e => e.code === 'INVALID_INPUT');
  for (const surface of ['daily', 'admin']) assert.ok(getCommandCatalog({ surface }).commands.some(c => c.name === 'web open'));
  assert.ok(!getCommandCatalog({ surface: 'deploy' }).commands.some(c => c.name === 'web open'));
});

test('a Git host projection without prebuilt entries uses only its verified same-version canonical installation', async t => {
  const f = await projectionFixture(t);
  await assert.rejects(readFile(path.join(f.projectionRoot, 'packages/local-runtime/dist/launcher.mjs')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.projectionRoot, 'local-runtime/launcher.mjs')), { code: 'ENOENT' });
  // 身份目录刻意不可读且不是有效状态；解析 runtime 无需也不能碰 Credential。
  await writeFile(path.join(f.stateRoot, 'instances', 'invalid.secret.json'), 'not credential JSON', { mode: 0o000 });
  const before = await readFile(f.activePath, 'utf8');
  assert.deepEqual(await f.run(), { ok: true, result: { mode: 'local', canonical: true, directory: '/trusted caller project' } });
  assert.equal(await readFile(f.activePath, 'utf8'), before);
});

test('canonical fallback refuses missing, modified, mismatched or untrusted host and release evidence', async t => {
  const cases = [
    ['missing active receipt', 'LOCAL_RUNTIME_NOT_INSTALLED', f => rm(f.activePath)],
    ['active version differs', 'LOCAL_RUNTIME_VERSION_MISMATCH', f => f.rewrite(f.activePath, { version: '0.0.0' })],
    ['projection declarations differ', 'LOCAL_RUNTIME_VERSION_MISMATCH', f => f.rewrite(path.join(f.projectionRoot, 'release/version.json'), { version: '0.0.0' })],
    ['projection repository differs', 'LOCAL_RUNTIME_SOURCE_MISMATCH', f => f.rewrite(path.join(f.projectionRoot, '.codex-plugin/plugin.json'), { repository: 'https://other.invalid/cfKanban' })],
    ['publisher continuity lost', 'LOCAL_RUNTIME_SOURCE_MISMATCH', f => f.rewrite(f.receiptPath, { publisher: 'https://other.invalid' })],
    ['artifact source changed', 'LOCAL_RUNTIME_SOURCE_MISMATCH', f => f.rewrite(f.receiptPath, { source: 'https://github.com/other/cfKanban/releases/download/skills.zip' })],
    ['receipt artifact differs', 'LOCAL_RUNTIME_UNVERIFIED', f => f.rewrite(f.receiptPath, { artifact_sha256: '0'.repeat(64) })],
    ['canonical tree modified', 'LOCAL_SKILL_MODIFIED', f => writeFile(path.join(f.installed.path, 'local-runtime/launcher.mjs'), 'throw Error("Do not execute modified canonical code");')],
    ['canonical file omitted', 'LOCAL_SKILL_MODIFIED', f => rm(path.join(f.installed.path, 'local-runtime/browser.mjs'))],
    ['projection runtime modified', 'LOCAL_SKILL_MODIFIED', f => writeFile(path.join(f.projectionRoot, 'packages/skill-runtime/src/extra.mjs'), '// Extra projected runtime content\n')],
    ['projection Skill modified', 'LOCAL_SKILL_MODIFIED', f => writeFile(path.join(f.projectionRoot, 'skills/cfkanban/SKILL.md'), '# Changed projected Skill\n')],
    ['active path escapes private release', 'LOCAL_RUNTIME_UNVERIFIED', f => f.rewrite(f.activePath, { path: f.projectionRoot })],
    ['canonical runtime symlink', 'LOCAL_SKILL_MODIFIED', async f => { const launcher = path.join(f.installed.path, 'local-runtime/launcher.mjs'); await rm(launcher); await symlink(path.join(f.projectionRoot, 'packages/skill-runtime/src/web-open.mjs'), launcher); }],
    ['active receipt symlink', 'LOCAL_RUNTIME_UNVERIFIED', async f => { const other = path.join(f.home, 'active-copy.json'); await cp(f.activePath, other); await rm(f.activePath); await symlink(other, f.activePath); }],
    ['private state permission drift', 'LOCAL_RUNTIME_UNVERIFIED', f => chmod(f.stateRoot, 0o755)],
    ['built version differs despite a valid complete receipt', 'LOCAL_RUNTIME_VERSION_MISMATCH', async f => {
      await f.rewrite(path.join(f.installed.path, 'local-runtime/build-metadata.json'), { release_version: '0.0.0' });
      await f.rewrite(f.activePath, { tree_digest: await treeDigest(f.installed.release_path) });
    }],
  ];
  for (const [name, code, change] of cases) await t.test(name, async t => {
    const f = await projectionFixture(t);
    await change(f);
    assert.deepEqual(await f.run(), { ok: false, code, details: {} });
  });
});

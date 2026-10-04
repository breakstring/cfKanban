import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { inspectCliInstallation, installCliLauncher, rollbackCliRelease, uninstallCliLauncher } from '../../packages/skill-runtime/src/cli-install.mjs';
import { treeDigest, withSkillReleaseLock } from '../../packages/skill-runtime/src/skill-update.mjs';
import { atomicWriteJson } from '../../packages/skill-runtime/src/utils.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cfkanban-cli-install-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, 'private', 'skill-releases');
  const commandDirectory = path.join(root, 'Unicode 命令 space', 'bin');
  await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
  async function release(version, previous = null, { cli = true } = {}) {
    const releasePath = path.join(releaseRoot, 'versions', version);
    await mkdir(path.join(releasePath, 'cli'), { recursive: true, mode: 0o700 });
    if (cli) {
      await writeFile(path.join(releasePath, 'cli', 'cfkanban.mjs'), `export async function main(args){process.stdout.write(JSON.stringify({version:${JSON.stringify(version)},args}));return 0;}`);
      await writeFile(path.join(releasePath, 'cli', 'build-metadata.json'), JSON.stringify({ schema_version: 1, name: 'cfkanban-cli', release_version: version, node_range: '>=22.12.0' }));
    }
    const receipt = { schema_version: 1, kind: 'skill_bundle', version, artifact_sha256: 'a'.repeat(64) };
    await atomicWriteJson(path.join(releasePath, '.cfkanban-release.json'), receipt);
    const active = { schema_version: 1, version, artifact_sha256: receipt.artifact_sha256, path: releasePath, release_path: releasePath, tree_digest: await treeDigest(releasePath), previous };
    await atomicWriteJson(path.join(releaseRoot, 'active.json'), active);
    return active;
  }
  const active = await release('1.10.0-rc.1');
  return { root, releaseRoot, commandDirectory, active, release };
}

test('verified launcher runs independently of cwd, follows active, rolls back and preserves identity on uninstall', async t => {
  const f = await fixture(t);
  const options = { releaseRoot: f.releaseRoot, commandDirectory: f.commandDirectory };
  const installed = await installCliLauncher(options);
  assert.equal(installed.installed, true);
  assert.equal(installed.path_change_required, true);
  const command = path.join(f.commandDirectory, 'cfkanban');
  const result = await run(command, ['--version', '中文 with spaces'], { cwd: f.root });
  assert.deepEqual(JSON.parse(result.stdout), { version: f.active.version, args: ['--version', '中文 with spaces'] });
  await f.release('1.10.0-rc.2', f.active);
  assert.equal(JSON.parse((await run(command, [])).stdout).version, '1.10.0-rc.2');
  assert.equal((await rollbackCliRelease({ releaseRoot: f.releaseRoot })).version, f.active.version);
  assert.equal(JSON.parse((await run(command, [])).stdout).version, f.active.version);
  assert.equal((await installCliLauncher(options)).installed, true);
  assert.equal((await inspectCliInstallation(options)).running_mcp_updated, false);
  const identity = path.join(f.root, 'identity.json');
  await writeFile(identity, 'existing private identity');
  assert.equal((await uninstallCliLauncher(options)).removed, true);
  assert.equal(await readFile(identity, 'utf8'), 'existing private identity');
  assert.equal((await uninstallCliLauncher(options)).removed, false);
  assert.equal(JSON.parse(await readFile(path.join(f.releaseRoot, 'active.json'), 'utf8')).version, f.active.version);
});

test('same-name commands and modified launchers are never overwritten or removed', async t => {
  const f = await fixture(t);
  await mkdir(f.commandDirectory, { recursive: true });
  const command = path.join(f.commandDirectory, 'cfkanban');
  await writeFile(command, 'other command');
  const options = { releaseRoot: f.releaseRoot, commandDirectory: f.commandDirectory };
  await assert.rejects(installCliLauncher(options), { code: 'CLI_COMMAND_CONFLICT' });
  assert.equal(await readFile(command, 'utf8'), 'other command');
  await rm(command);
  await installCliLauncher(options);
  await writeFile(command, 'user modification');
  await assert.rejects(installCliLauncher(options), { code: 'CLI_LAUNCHER_MODIFIED' });
  await assert.rejects(uninstallCliLauncher(options), { code: 'CLI_LAUNCHER_MODIFIED' });
  assert.equal(await readFile(command, 'utf8'), 'user modification');
});

test('tampered active payload fails closed before executing release code', async t => {
  const f = await fixture(t);
  await installCliLauncher(f);
  await writeFile(path.join(f.active.path, 'cli/cfkanban.mjs'), 'process.stdout.write("MUST_NOT_RUN");');
  await assert.rejects(installCliLauncher(f), { code: 'LOCAL_SKILL_MODIFIED' });
  await assert.rejects(run(path.join(f.commandDirectory, 'cfkanban'), ['--version']), error => {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, '');
    assert.doesNotMatch(error.stderr, /MUST_NOT_RUN/);
    return true;
  });
});

test('release lock rejects concurrent registration and rollback leaves unsupported previous version inactive', async t => {
  const f = await fixture(t);
  await withSkillReleaseLock(f.releaseRoot, async () => {
    await assert.rejects(installCliLauncher(f), { code: 'SKILL_RELEASE_LOCKED' });
  });
  const previous = await f.release('1.9.0', null, { cli: false });
  const current = await f.release('1.10.0-rc.3', previous);
  await assert.rejects(rollbackCliRelease(f), { code: 'CLI_RELEASE_UNSUPPORTED' });
  assert.equal(JSON.parse(await readFile(path.join(f.releaseRoot, 'active.json'), 'utf8')).version, current.version);
});

test('symlink directories and unsafe Windows Node paths are rejected', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'target');
  await mkdir(target);
  const linked = path.join(f.root, 'linked');
  await symlink(target, linked);
  await assert.rejects(installCliLauncher({ ...f, commandDirectory: path.join(linked, 'bin') }), { code: 'CLI_UNSAFE_PATH' });
  const win = { ...f, platform: 'win32' };
  await installCliLauncher(win);
  const cmd = await readFile(path.join(f.commandDirectory, 'cfkanban.cmd'), 'utf8');
  assert.match(cmd, /"%~dp0cfkanban-launcher\.mjs" %\*/);
  assert.match(await readFile(path.join(f.commandDirectory, 'cfkanban.ps1'), 'utf8'), /@args/);
  assert.equal((await uninstallCliLauncher(win)).removed, true);
});

test('rollback rejects a tree-external entry and mismatched receipt without changing active', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(path.join(outside, 'cli'), { recursive: true });
  await writeFile(path.join(outside, 'cli/cfkanban.mjs'), 'export async function main(){return 0;}');
  const current = await f.release('1.10.0-rc.2', { ...f.active, path: outside });
  await assert.rejects(rollbackCliRelease(f), { code: 'CLI_RECEIPT_INVALID' });
  assert.equal(JSON.parse(await readFile(path.join(f.releaseRoot, 'active.json'), 'utf8')).version, current.version);
  await atomicWriteJson(path.join(f.releaseRoot, 'active.json'), { ...current, previous: { ...f.active, version: '9.9.9' } });
  await assert.rejects(rollbackCliRelease(f), { code: 'CLI_RECEIPT_INVALID' });
  assert.equal(JSON.parse(await readFile(path.join(f.releaseRoot, 'active.json'), 'utf8')).version, current.version);
});

test('runtime rejects a release directory replaced by a symlink even when tree bytes match', async t => {
  const f = await fixture(t);
  await installCliLauncher(f);
  const moved = path.join(f.root, 'moved-release');
  await rename(f.active.path, moved);
  await symlink(moved, f.active.path);
  await assert.rejects(run(path.join(f.commandDirectory, 'cfkanban'), []), error => {
    assert.equal(error.code, 2);
    assert.equal(error.stdout, '');
    return true;
  });
});

test('canonical active symlink and permission drift fail before importing release code', async t => {
  const f = await fixture(t);
  await installCliLauncher(f);
  const command = path.join(f.commandDirectory, 'cfkanban');
  const activePath = path.join(f.releaseRoot, 'active.json');
  const moved = path.join(f.releaseRoot, 'moved-active.json');
  await rename(activePath, moved);
  await symlink(moved, activePath);
  await assert.rejects(inspectCliInstallation(f), { code: 'STATE_PATH_INVALID' });
  await assert.rejects(run(command, []), error => error.code === 2 && error.stdout === '');
  await rm(activePath);
  await rename(moved, activePath);
  if (process.platform !== 'win32') {
    await chmod(activePath, 0o644);
    await assert.rejects(inspectCliInstallation(f), { code: 'STATE_PERMISSION_DRIFT' });
    await assert.rejects(run(command, []), error => error.code === 2 && error.stdout === '');
    await chmod(activePath, 0o600);
    const current = await f.release('1.10.0-rc.2', f.active);
    await chmod(f.active.release_path, 0o755);
    await assert.rejects(rollbackCliRelease(f), { code: 'STATE_PERMISSION_DRIFT' });
    assert.equal(JSON.parse(await readFile(activePath, 'utf8')).version, current.version);
  }
});

test('launcher permissions and registration receipt symlinks are refused', async t => {
  const f = await fixture(t);
  await installCliLauncher(f);
  if (process.platform !== 'win32') {
    await chmod(f.commandDirectory, 0o777);
    await assert.rejects(inspectCliInstallation(f), { code: 'STATE_PERMISSION_DRIFT' });
    await assert.rejects(run(path.join(f.commandDirectory, 'cfkanban'), []), error => error.code === 2 && error.stdout === '');
    await chmod(f.commandDirectory, 0o700);
    const stub = path.join(f.commandDirectory, 'cfkanban-launcher.mjs');
    await chmod(stub, 0o666);
    await assert.rejects(inspectCliInstallation(f), { code: 'STATE_PERMISSION_DRIFT' });
    await assert.rejects(run(path.join(f.commandDirectory, 'cfkanban'), []), error => error.code === 2 && error.stdout === '');
    await chmod(stub, 0o600);
    const executable = path.join(f.commandDirectory, 'cfkanban');
    await chmod(executable, 0o777);
    await assert.rejects(inspectCliInstallation(f), { code: 'STATE_PERMISSION_DRIFT' });
    await chmod(executable, 0o755);
  }
  const receiptPath = path.join(f.releaseRoot, 'cli-launcher.json');
  const moved = path.join(f.root, 'moved-launcher.json');
  await rename(receiptPath, moved);
  await symlink(moved, receiptPath);
  await assert.rejects(inspectCliInstallation(f), { code: 'STATE_PATH_INVALID' });
  await assert.rejects(installCliLauncher(f), { code: 'STATE_PATH_INVALID' });
  await assert.rejects(uninstallCliLauncher(f), { code: 'STATE_PATH_INVALID' });
});

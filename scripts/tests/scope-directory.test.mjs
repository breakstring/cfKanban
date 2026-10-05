import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { dispatch, getCommandCatalog } from "../../packages/skill-runtime/src/cli.mjs";
import { inspectScopeDirectory, mergeRepoScope, readRepoScope, SCOPE_FILE_NAME } from "../../packages/skill-runtime/src/scope.mjs";
import { canonicalDigest } from "../../packages/skill-runtime/src/utils.mjs";

const execFileAsync = promisify(execFile);
const target = {
  instance_id: "00000000-0000-4000-8000-000000000001",
  workspace_id: "00000000-0000-4000-8000-000000000002",
  project_id: "00000000-0000-4000-8000-000000000003",
};
const scope = { schema_version: 2, targets: [target] };

test("daily command dispatch exposes read-only directory inspection", async (t) => {
  const { directory, git } = await fixture(t);
  await git(directory, ["init", "--quiet"]);
  const definition = getCommandCatalog({ surface: "daily" }).commands.find(command => command.name === "scope inspect-directory");
  assert.equal(definition.effect, "read_only");
  assert.deepEqual(definition.input_fields, ["directory"]);
  const result = await dispatch("scope inspect-directory", { directory }, { surface: "daily" });
  assert.equal(result.git.status, "repository");
  assert.equal(result.scope_directory, await realpath(directory));
  assert.equal(result.workbench_context_key, canonicalDigest({ directory: result.scope_directory }));
  assert.equal(result.association_recommended, true);
  assert.equal(await readRepoScope({ repoRoot: directory }), null);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cfkanban-scope-directory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const emptyConfig = path.join(directory, "empty-git-config");
  await writeFile(emptyConfig, "");
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key))),
    GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, args) => execFileAsync("git", args, {
    cwd, env: environment, shell: false, windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024,
  });
  return { directory, git };
}

async function snapshot(directory, prefix = "") {
  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) entries.push([relative, "directory"], ...await snapshot(absolute, relative));
    else entries.push([relative, createHash("sha256").update(await readFile(absolute)).digest("hex")]);
  }
  return entries;
}

test("Git root detection is read-only and recommends association only when its scope is missing", async (t) => {
  const { directory, git } = await fixture(t);
  const repository = path.join(directory, "repo with spaces");
  await mkdir(repository);
  await git(repository, ["-c", "init.defaultBranch=main", "init"]);
  const before = await snapshot(directory);
  const result = await inspectScopeDirectory({ directory: repository });
  const root = await realpath(repository);
  assert.deepEqual(result, {
    directory: repository, git: { status: "repository", root }, scope_directory: root,
    workbench_context_key: canonicalDigest({ directory: root }),
    scope_file: path.join(root, SCOPE_FILE_NAME), scope: null, association_recommended: true,
  });
  assert.deepEqual(await snapshot(directory), before);
});

test("Git subdirectories read the root association while explicit read and merge retain their exact-directory semantics", async (t) => {
  const { directory, git } = await fixture(t);
  const repository = path.join(directory, "repository");
  const child = path.join(repository, "src", "nested");
  await mkdir(child, { recursive: true });
  await git(repository, ["-c", "init.defaultBranch=main", "init"]);
  await writeFile(path.join(repository, SCOPE_FILE_NAME), JSON.stringify(scope));
  await writeFile(path.join(child, SCOPE_FILE_NAME), JSON.stringify({ schema_version: 2, targets: [] }));
  const before = await snapshot(directory);
  const result = await inspectScopeDirectory({ directory: child });
  assert.equal(result.git.root, await realpath(repository));
  assert.equal(result.workbench_context_key, canonicalDigest({ directory: result.git.root }));
  assert.deepEqual(result.scope, scope);
  assert.equal(result.association_recommended, false);
  assert.deepEqual(await snapshot(directory), before);
  assert.deepEqual(await readRepoScope({ repoRoot: child }), { schema_version: 2, targets: [] });
  await mergeRepoScope({ repoRoot: child, targets: [target] });
  assert.deepEqual(await readRepoScope({ repoRoot: child }), scope);
  assert.equal(await readFile(path.join(repository, SCOPE_FILE_NAME), "utf8"), JSON.stringify(scope));
});

test("linked worktrees use their own worktree root without walking into the main repository", async (t) => {
  const { directory, git } = await fixture(t);
  const repository = path.join(directory, "main-repository");
  const worktree = path.join(directory, "linked-worktree");
  await mkdir(repository);
  await git(repository, ["-c", "init.defaultBranch=main", "init"]);
  await git(repository, ["-c", "user.name=ScopeTest", "-c", "user.email=scope-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
  await git(repository, ["worktree", "add", "-b", "scope-test", worktree]);
  await writeFile(path.join(repository, SCOPE_FILE_NAME), JSON.stringify(scope));
  const child = path.join(worktree, "nested");
  await mkdir(child);
  const before = await snapshot(directory);
  const result = await inspectScopeDirectory({ directory: child });
  assert.deepEqual(result.git, { status: "repository", root: await realpath(worktree) });
  assert.equal(result.workbench_context_key, canonicalDigest({ directory: await realpath(worktree) }));
  assert.notEqual(result.workbench_context_key, canonicalDigest({ directory: await realpath(repository) }));
  assert.equal(result.scope, null);
  assert.equal(result.association_recommended, true);
  assert.deepEqual(await snapshot(directory), before);
});

test("non-Git directories retain their own existing scope but never recommend creating one", async (t) => {
  const { directory } = await fixture(t);
  const unassociated = await inspectScopeDirectory({ directory });
  assert.deepEqual(unassociated.git, { status: "not_repository", root: null });
  assert.equal(unassociated.scope_directory, directory);
  assert.equal(unassociated.workbench_context_key, null);
  assert.equal(unassociated.association_recommended, false);
  assert.equal(unassociated.scope, null);
  await writeFile(path.join(directory, SCOPE_FILE_NAME), JSON.stringify(scope));
  const before = await snapshot(directory);
  const associated = await inspectScopeDirectory({ directory });
  assert.deepEqual(associated.scope, scope);
  assert.equal(associated.workbench_context_key, null);
  assert.equal(associated.association_recommended, false);
  assert.deepEqual(await snapshot(directory), before);
});

test("bare repositories are confirmed outside a Git worktree", async (t) => {
  const { directory, git } = await fixture(t);
  const repository = path.join(directory, "bare-repository");
  await mkdir(repository);
  await git(repository, ["-c", "init.defaultBranch=main", "init", "--bare"]);
  const result = await inspectScopeDirectory({ directory: repository });
  assert.deepEqual(result.git, { status: "not_repository", root: null });
  assert.equal(result.workbench_context_key, null);
  assert.equal(result.association_recommended, false);
});

test("unavailable Git and other failures preserve existing directory scope without exposing stderr", async (t) => {
  const { directory } = await fixture(t);
  await writeFile(path.join(directory, SCOPE_FILE_NAME), JSON.stringify(scope));
  const before = await snapshot(directory);
  for (const [error, expected] of [
    [Object.assign(new Error("private-detail"), { code: "ENOENT", stderr: "private-stderr" }), "unavailable"],
    [Object.assign(new Error("private-detail"), { code: "EACCES", stderr: "private-stderr" }), "unknown"],
    [Object.assign(new Error("private-detail"), { code: 128, stderr: "fatal: detected dubious ownership in private-path" }), "unknown"],
    [Object.assign(new Error("private-detail"), { code: 128, killed: true, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" }), "unknown"],
    [Object.assign(new Error("private-detail"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderr: "private-stderr" }), "unknown"],
  ]) {
    const result = await inspectScopeDirectory({ directory }, { gitRunner: async () => { throw error; } });
    assert.deepEqual(result.git, { status: expected, root: null });
    assert.equal(result.scope_directory, directory);
    assert.equal(result.workbench_context_key, null);
    assert.deepEqual(result.scope, scope);
    assert.equal(result.association_recommended, false);
    assert.equal(JSON.stringify(result).includes("private-detail"), false);
    assert.equal(JSON.stringify(result).includes("private-stderr"), false);
    assert.equal(JSON.stringify(result).includes("private-path"), false);
  }
  assert.deepEqual(await snapshot(directory), before);
});

test("invalid paths and malformed or inconsistent Git output remain unknown", async (t) => {
  const { directory } = await fixture(t);
  const missing = path.join(directory, "does-not-exist");
  const absent = await inspectScopeDirectory({ directory: missing }, { gitRunner: () => assert.fail("Missing cwd must not run Git") });
  assert.deepEqual(absent.git, { status: "unknown", root: null });
  assert.equal(absent.workbench_context_key, null);
  assert.equal(absent.association_recommended, false);
  for (const outputs of [["unexpected\n"], ["true\n", "relative-root\n"], ["true\n", `${directory}\nextra\n`]]) {
    let call = 0;
    const result = await inspectScopeDirectory({ directory }, { gitRunner: async () => ({ stdout: outputs[call++] }) });
    assert.deepEqual(result.git, { status: "unknown", root: null });
    assert.equal(result.workbench_context_key, null);
    assert.equal(result.association_recommended, false);
  }
  let call = 0;
  const lost = await inspectScopeDirectory({ directory }, { gitRunner: async () => {
    if (call++ === 0) return { stdout: "true\n" };
    throw Object.assign(new Error("unavailable root"), { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" });
  } });
  assert.deepEqual(lost.git, { status: "unknown", root: null });
});

test("Git probes are bounded, shell-free and Windows-compatible, and remove repository-addressing environment", async (t) => {
  const { directory } = await fixture(t);
  const calls = [];
  const environment = {
    PATH: process.env.PATH, GIT_DIR: "unrelated-repository", GIT_WORK_TREE: "unrelated-worktree",
    GIT_COMMON_DIR: "unrelated-common-dir", GIT_CEILING_DIRECTORIES: "/", GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: "unrelated-worktree", git_dir: "windows-case-variant",
    LC_ALL: "zh_CN.UTF-8", LANG: "zh_CN.UTF-8", LANGUAGE: "zh_CN",
  };
  const result = await inspectScopeDirectory({ directory }, { environment, gitRunner: async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: calls.length === 1 ? "true\r\n" : `${directory}\r\n` };
  } });
  assert.equal(result.git.status, "repository");
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: "git", args: ["rev-parse", "--is-inside-work-tree"] },
    { command: "git", args: ["rev-parse", "--show-toplevel"] },
  ]);
  for (const { options } of calls) {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.cwd, directory);
    assert.equal(options.timeout, 5_000);
    assert.equal(options.maxBuffer, 64 * 1024);
    assert.equal(options.encoding, "utf8");
    assert.equal(options.killSignal, "SIGKILL");
    assert.deepEqual(options.env, { PATH: process.env.PATH, LC_ALL: "C", LANG: "C", LANGUAGE: "C" });
  }
  assert.equal(environment.GIT_DIR, "unrelated-repository", "Inspecting must not mutate the caller's environment");
});

test("real Git ignores inherited GIT_DIR and GIT_WORK_TREE when inspecting the requested directory", async (t) => {
  const { directory, git } = await fixture(t);
  const repository = path.join(directory, "repository");
  const other = path.join(directory, "other");
  await mkdir(repository);
  await mkdir(other);
  await git(repository, ["-c", "init.defaultBranch=main", "init"]);
  await git(other, ["-c", "init.defaultBranch=main", "init"]);
  const result = await inspectScopeDirectory({ directory: repository }, {
    environment: { ...process.env, GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other, GIT_CEILING_DIRECTORIES: repository },
  });
  assert.deepEqual(result.git, { status: "repository", root: await realpath(repository) });
});

test("invalid existing scope is reported instead of treating the directory as unassociated", async (t) => {
  const { directory, git } = await fixture(t);
  await git(directory, ["-c", "init.defaultBranch=main", "init"]);
  await writeFile(path.join(directory, SCOPE_FILE_NAME), JSON.stringify({ schema_version: 1, targets: [] }));
  await assert.rejects(inspectScopeDirectory({ directory }), { code: "INVALID_SCOPE" });
});

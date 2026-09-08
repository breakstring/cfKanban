import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWebInstance } from "../../packages/skill-runtime/src/web-resolve.mjs";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfkanban-web-resolve-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const stateRoot = path.join(home, ".cfkanban");
  return { home, stateRoot };
}
async function addInstance(options, id, { current = true } = {}) {
  const directory = path.join(options.stateRoot, "instances", id, "credentials");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, "..", "instance.json"), JSON.stringify({ instance_id: id, trusted_api_origin: `https://${id[0]}.example.test` }), { mode: 0o600 });
  if (current) {
    await writeFile(path.join(directory, "current.json"), JSON.stringify({ instance_id: id, principal_id: first, credential_id: second, state: "current" }), { mode: 0o600 });
    // Deliberately invalid JSON proves resolution never parses the secret.
    await writeFile(path.join(directory, "current.secret.json"), "DO NOT READ THIS SECRET", { mode: 0o600 });
  }
  return directory;
}
async function scope(options, ids) {
  const repoRoot = path.join(options.home, "repo");
  await mkdir(repoRoot);
  await writeFile(path.join(repoRoot, ".cfkanban-scope.json"), JSON.stringify({ schema_version: 1, targets: ids.map((id) => ({ instance_id: id, workspace_key: "work", project_key: "PR" })) }));
  return repoRoot;
}

test("empty home stays read-only and a unique current slot resolves without reading secret", async (t) => {
  const options = await fixture(t);
  assert.equal((await resolveWebInstance(options)).status, "credential_required");
  assert.deepEqual(await readdir(options.home), []);
  await addInstance(options, first);
  await addInstance(options, second, { current: false });
  const result = await resolveWebInstance(options);
  assert.equal(result.status, "resolved");
  assert.equal(result.instance.instance_id, first);
  assert.equal(JSON.stringify(result).includes("DO NOT READ"), false);
  assert.deepEqual(Object.keys(result.instance).sort(), ["instance_id", "trusted_api_origin"]);
});

test("multiple instances require selection unless an explicit trusted target identifies one", async (t) => {
  const options = await fixture(t);
  await addInstance(options, first);
  await addInstance(options, second);
  assert.equal((await resolveWebInstance(options)).status, "selection_required");
  assert.equal((await resolveWebInstance({ ...options, instanceId: second })).instance.instance_id, second);
  assert.equal((await resolveWebInstance({ ...options, origin: "https://1.example.test/" })).instance.instance_id, first);
  await assert.rejects(resolveWebInstance({ ...options, instanceId: first, origin: "https://2.example.test" }), { code: "WEB_INSTANCE_TARGET_CONFLICT" });
});

test("unknown or unavailable explicit target never falls back to a different credential", async (t) => {
  const options = await fixture(t);
  await addInstance(options, first);
  for (const selection of [{ instanceId: second }, { origin: "https://unknown.example.test" }]) {
    assert.equal((await resolveWebInstance({ ...options, ...selection })).status, "credential_required");
  }
  await addInstance(options, second, { current: false });
  assert.equal((await resolveWebInstance({ ...options, instanceId: second })).status, "credential_required");
});

test("repository scope is explicit, takes priority over inventory, and preserves unresolved targets", async (t) => {
  const options = await fixture(t);
  await addInstance(options, first);
  await addInstance(options, second);
  const repoRoot = await scope(options, [second]);
  assert.equal((await resolveWebInstance({ ...options, repoRoot })).instance.instance_id, second);
  assert.equal((await resolveWebInstance({ ...options, repoRoot, instanceId: first })).instance.instance_id, first);
  await rm(path.join(options.stateRoot, "instances", second), { recursive: true });
  assert.equal((await resolveWebInstance({ ...options, repoRoot })).status, "credential_required");
  await writeFile(path.join(repoRoot, ".cfkanban-scope.json"), JSON.stringify({ schema_version: 1, targets: [first, second].map((id) => ({ instance_id: id, workspace_key: "work", project_key: "PR" })) }));
  const result = await resolveWebInstance({ ...options, repoRoot });
  assert.equal(result.status, "selection_required");
  assert.equal(result.candidates.length, 2);
});

test("permission drift and secret symlinks stop selection before launch", { skip: process.platform === "win32" }, async (t) => {
  const options = await fixture(t);
  const directory = await addInstance(options, first);
  await chmod(path.join(directory, "current.secret.json"), 0o644);
  await assert.rejects(resolveWebInstance(options), { code: "STATE_PERMISSION_DRIFT" });
  await rm(path.join(directory, "current.secret.json"));
  await symlink(path.join(directory, "current.json"), path.join(directory, "current.secret.json"));
  await assert.rejects(resolveWebInstance(options), { code: "STATE_SYMLINK_REJECTED" });
});

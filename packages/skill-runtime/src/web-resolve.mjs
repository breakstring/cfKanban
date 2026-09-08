import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { resolveStateRoot } from "./paths.mjs";
import { readRepoScope } from "./scope.mjs";
import { getInstancePaths, validatePrivatePath } from "./state.mjs";
import { assertNoSymlinkPath, pathType, readJson, requireHttpsOrigin, requireUuid } from "./utils.mjs";

async function readCandidate(stateRoot, instanceId) {
  const paths = getInstancePaths({ stateRoot, instanceId });
  await assertNoSymlinkPath(paths.instanceMetadata, stateRoot);
  if (await pathType(paths.instanceRoot) === "missing") return null;
  await validatePrivatePath(paths.instanceRoot, "directory");
  await validatePrivatePath(paths.instanceMetadata, "file");
  const metadata = await readJson(paths.instanceMetadata);
  if (metadata.instance_id !== instanceId) throw toolError("STATE_INSTANCE_CONFLICT", "Instance metadata does not match its immutable state slot", { instanceId });
  return { instance_id: instanceId, trusted_api_origin: requireHttpsOrigin(metadata.trusted_api_origin, "trusted_api_origin") };
}

async function hasCurrentCredential(stateRoot, candidate) {
  const paths = getInstancePaths({ stateRoot, instanceId: candidate.instance_id });
  await assertNoSymlinkPath(paths.currentMetadata, stateRoot);
  await assertNoSymlinkPath(paths.currentSecret, stateRoot);
  if (await pathType(paths.credentialsRoot) === "missing") return false;
  await validatePrivatePath(paths.credentialsRoot, "directory");
  if (await pathType(paths.currentMetadata) === "missing") return false;
  await validatePrivatePath(paths.currentMetadata, "file");
  const metadata = await readJson(paths.currentMetadata);
  if (metadata.instance_id !== candidate.instance_id || metadata.state !== "current") {
    throw toolError("STATE_IDENTITY_CONFLICT", "Current Credential metadata does not match its instance slot", { instanceId: candidate.instance_id });
  }
  requireUuid(metadata.principal_id, "principal_id");
  requireUuid(metadata.credential_id, "credential_id");
  if (await pathType(paths.currentSecret) === "missing") return false;
  // Selection only checks the storage boundary; authentication verifies the secret later.
  await validatePrivatePath(paths.currentSecret, "file");
  return true;
}

export async function resolveWebInstance({ home = os.homedir(), stateRoot = resolveStateRoot({ home }), instanceId = null, origin = null, repoRoot = null } = {}) {
  const explicitId = instanceId === null ? null : requireUuid(instanceId, "instance_id");
  const explicitOrigin = origin === null ? null : requireHttpsOrigin(origin);
  const absoluteRoot = path.resolve(stateRoot);
  const relative = path.relative(path.resolve(home), absoluteRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw toolError("UNSAFE_STATE_PATH", "State root must be a private child of the current home");
  await assertNoSymlinkPath(absoluteRoot, home);
  const instancesRoot = path.join(absoluteRoot, "instances");
  const rootMissing = await pathType(absoluteRoot) === "missing";
  if (!rootMissing) await validatePrivatePath(absoluteRoot, "directory");
  await assertNoSymlinkPath(instancesRoot, absoluteRoot);
  const instancesMissing = rootMissing || await pathType(instancesRoot) === "missing";
  if (!instancesMissing) await validatePrivatePath(instancesRoot, "directory");
  const readOne = async (id) => instancesMissing ? null : readCandidate(absoluteRoot, id);
  const result = (status, source, candidates) => ({ status, source, candidates, ...(status === "resolved" ? { instance: candidates[0] } : {}), secret_values_exposed: false });
  const choose = async (source, candidates) => {
    if (candidates.length > 1) return result("selection_required", source, candidates);
    if (candidates.length === 0 || candidates[0].trusted_api_origin === null || !await hasCurrentCredential(absoluteRoot, candidates[0])) return result("credential_required", source, candidates);
    return result("resolved", source, candidates);
  };
  if (explicitId !== null) {
    const candidate = await readOne(explicitId);
    if (candidate && explicitOrigin !== null && candidate.trusted_api_origin !== explicitOrigin) throw toolError("WEB_INSTANCE_TARGET_CONFLICT", "The requested origin does not match the selected trusted instance");
    return choose("explicit_instance", candidate ? [candidate] : [{ instance_id: explicitId, trusted_api_origin: null }]);
  }
  const list = async () => {
    if (instancesMissing) return [];
    const candidates = [];
    for (const name of (await readdir(instancesRoot)).sort()) {
      let id;
      try { id = requireUuid(name, "instance_id"); } catch { continue; }
      const candidate = await readOne(id);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  };
  if (explicitOrigin !== null) return choose("explicit_origin", (await list()).filter((item) => item.trusted_api_origin === explicitOrigin));
  if (repoRoot !== null) {
    const scope = await readRepoScope({ repoRoot });
    const ids = [...new Set((scope?.targets ?? []).map((item) => item.instance_id))].sort();
    if (ids.length > 0) {
      const candidates = [];
      for (const id of ids) candidates.push(await readOne(id) ?? { instance_id: id, trusted_api_origin: null });
      return choose("repository", candidates);
    }
  }
  const candidates = [];
  for (const candidate of await list()) if (await hasCurrentCredential(absoluteRoot, candidate)) candidates.push(candidate);
  return choose("local_credentials", candidates);
}

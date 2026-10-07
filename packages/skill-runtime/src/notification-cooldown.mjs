import { lstat, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { resolveStateRoot } from "./paths.mjs";
import { getInstancePaths, loadCurrentCredentialSecret, validatePrivatePath } from "./state.mjs";
import { assertNoSymlinkPath, canonicalDigest, ensurePrivateDirectory, readJson, requireHttpsOrigin, requireUuid } from "./utils.mjs";

const COOLDOWN_MS = 45_000;

async function validateClaim(file, stateRoot) {
  await assertNoSymlinkPath(file, stateRoot);
  await validatePrivatePath(file, "file");
  const stat = await lstat(file);
  if (stat.nlink !== 1 || stat.size > 128) throw new Error("Unsafe notification cooldown");
}

async function checkedAt(file, stateRoot) {
  try {
    await validateClaim(file, stateRoot);
    const value = await readJson(file);
    if (!Number.isSafeInteger(value.checked_at) || value.checked_at < 0) throw new Error("Invalid notification cooldown");
    return value.checked_at;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "STATE_PATH_INVALID" && error.details?.actualKind === "missing") return null;
    throw error;
  }
}

export async function claimNotificationAttention(input, { now = Date.now, signal } = {}) {
  const stateRoot = input.stateRoot ?? resolveStateRoot();
  const paths = getInstancePaths({ stateRoot, instanceId: input.instanceId });
  await assertNoSymlinkPath(paths.instanceMetadata, stateRoot);
  for (const directory of [stateRoot, path.join(stateRoot, "instances"), paths.instanceRoot]) await validatePrivatePath(directory, "directory");
  await validatePrivatePath(paths.instanceMetadata, "file");
  const instance = await readJson(paths.instanceMetadata);
  const { metadata } = await loadCurrentCredentialSecret({ stateRoot, instanceId: input.instanceId });
  if (instance.instance_id !== input.instanceId || metadata.instance_id !== input.instanceId || metadata.state !== "current"
    || !Number.isSafeInteger(instance.origin_version) || instance.origin_version < 1) throw new Error("Invalid notification identity");
  const identity = {
    expectedPrincipalId: requireUuid(metadata.principal_id, "principal_id"),
    expectedCredentialId: requireUuid(metadata.credential_id, "credential_id"),
    expectedApiOrigin: requireHttpsOrigin(instance.trusted_api_origin),
  };
  for (const key of ["expectedPrincipalId", "expectedCredentialId", "expectedApiOrigin"]) {
    if (input[key] !== undefined && input[key] !== identity[key]) throw new Error("Notification identity changed");
  }
  const root = path.join(paths.instanceRoot, "notification-attention");
  const directory = path.join(root, canonicalDigest({ principal_id: identity.expectedPrincipalId, origin: identity.expectedApiOrigin, origin_version: instance.origin_version }));
  for (const target of [root, directory]) {
    await assertNoSymlinkPath(target, stateRoot);
    await ensurePrivateDirectory(target);
    await validatePrivatePath(target, "directory");
  }
  signal?.throwIfAborted();
  const started = now();
  const slot = Math.floor(started / COOLDOWN_MS);
  const previous = path.join(directory, `${slot - 1}.json`);
  const recent = async () => {
    const prior = await checkedAt(previous, stateRoot);
    return prior !== null && started - prior < COOLDOWN_MS;
  };
  if (await recent()) return null;
  const file = path.join(directory, `${slot}.json`);
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") return null; throw error; }
  let claimed = false;
  try {
    await handle.writeFile(JSON.stringify({ checked_at: started }));
    await validatePrivatePath(file, "file");
    if ((await handle.stat()).nlink !== 1) throw new Error("Unsafe notification cooldown");
    // 相邻时间窗也遵守完整冷却；进程退出留下的领取记录会自然过期，不抢删活跃锁。
    signal?.throwIfAborted();
    if (Math.floor(now() / COOLDOWN_MS) !== slot || await recent()) return null;
    claimed = true;
  } finally {
    await handle.close();
    if (!claimed) await rm(file, { force: true });
  }
  for (const entry of await readdir(directory)) {
    if (!/^\d{1,15}\.json$/.test(entry) || Number(entry.slice(0, -5)) >= slot - 1) continue;
    const old = path.join(directory, entry);
    try { await validateClaim(old, stateRoot); await rm(old, { force: true }); }
    catch (error) { if (error.code !== "ENOENT" && !(error.code === "STATE_PATH_INVALID" && error.details?.actualKind === "missing")) throw error; }
  }
  return identity;
}

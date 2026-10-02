import { access, lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBrowserLaunchAndDeliver } from "./capability-delivery.mjs";
import { toolError } from "./errors.mjs";
import { resolveSkillReleaseRoot, resolveStateRoot } from "./paths.mjs";
import { treeDigest } from "./skill-update.mjs";
import { validatePrivatePath } from "./state.mjs";
import { assertNoSymlinkPath, canonicalDigest, isPlainObject, pathType, requireString, sha256Bytes } from "./utils.mjs";

const FIELDS = ["mode", "directory", "instanceId", "target", "delivery", "idempotencyKey", "sensitiveOutputAcknowledgement", "onRelayReady"];
const REPOSITORY = "https://github.com/breakstring/cfKanban";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const refuse = (code) => toolError(code, "The matching canonical local Web runtime could not be verified. Reinstall the exact Skill release; no runtime was downloaded or started");

async function fixedJson(root, relative) {
  const file = path.join(root, relative);
  await assertNoSymlinkPath(file, root);
  const stats = await lstat(file);
  if (!stats.isFile() || stats.size > 64 * 1024) throw refuse("LOCAL_RUNTIME_UNVERIFIED");
  return JSON.parse(await readFile(file, "utf8"));
}

async function loadCanonicalLauncher() {
  try {
    // Git 宿主投影没有预构建；只复用同版本、完整校验且来源连续的 canonical 安装。
    const projectionRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const declaration = await fixedJson(projectionRoot, "release/version.json");
    const plugin = await fixedJson(projectionRoot, ".codex-plugin/plugin.json");
    const version = declaration.version;
    if (typeof version !== "string" || !VERSION.test(version) || plugin.version !== version) throw refuse("LOCAL_RUNTIME_VERSION_MISMATCH");
    if (plugin.name !== "cfkanban-agent-skills" || plugin.repository !== REPOSITORY) throw refuse("LOCAL_RUNTIME_SOURCE_MISMATCH");
    const stateRoot = resolveStateRoot();
    const releaseRoot = resolveSkillReleaseRoot();
    if (await pathType(stateRoot) === "missing" || await pathType(path.join(releaseRoot, "active.json")) === "missing") throw refuse("LOCAL_RUNTIME_NOT_INSTALLED");
    await assertNoSymlinkPath(stateRoot, os.homedir());
    for (const directory of [stateRoot, releaseRoot, path.join(releaseRoot, "versions")]) {
      await assertNoSymlinkPath(directory, stateRoot);
      await validatePrivatePath(directory, "directory");
    }
    const activePath = path.join(releaseRoot, "active.json");
    await assertNoSymlinkPath(activePath, stateRoot);
    await validatePrivatePath(activePath, "file");
    const active = await fixedJson(releaseRoot, "active.json");
    if (active.version !== version) throw refuse("LOCAL_RUNTIME_VERSION_MISMATCH");
    const releasePath = path.join(releaseRoot, "versions", version);
    const bundleRoot = path.join(releasePath, `cfkanban-skills-${version}`);
    if (active.schema_version !== 1 || active.release_path !== releasePath || active.path !== bundleRoot || !DIGEST.test(active.artifact_sha256 ?? "") || !DIGEST.test(active.tree_digest ?? "")) throw refuse("LOCAL_RUNTIME_UNVERIFIED");
    await assertNoSymlinkPath(releasePath, stateRoot);
    await validatePrivatePath(releasePath, "directory");
    const receiptPath = path.join(releasePath, ".cfkanban-release.json");
    await assertNoSymlinkPath(receiptPath, stateRoot);
    await validatePrivatePath(receiptPath, "file");
    const receipt = await fixedJson(releasePath, ".cfkanban-release.json");
    if (receipt.schema_version !== 1 || receipt.kind !== "skill_bundle" || receipt.version !== version || receipt.artifact_sha256 !== active.artifact_sha256 || !DIGEST.test(receipt.tree_digest_before_receipt ?? "") || receipt.discovery_smoke?.passed !== true) throw refuse("LOCAL_RUNTIME_UNVERIFIED");
    if (receipt.publisher !== "https://github.com" || receipt.source !== `${REPOSITORY}/releases/download/${version}/cfkanban-skills-${version}.zip` || canonicalDigest(receipt.artifact_origins) !== canonicalDigest(["https://github.com"])) throw refuse("LOCAL_RUNTIME_SOURCE_MISMATCH");
    if (await treeDigest(releasePath) !== active.tree_digest) throw refuse("LOCAL_SKILL_MODIFIED");
    const canonicalPlugin = await fixedJson(bundleRoot, ".codex-plugin/plugin.json");
    if (canonicalDigest(plugin) !== canonicalDigest(canonicalPlugin)) throw refuse("LOCAL_SKILL_MODIFIED");
    for (const relative of ["packages/skill-runtime", "skills"]) {
      await assertNoSymlinkPath(path.join(projectionRoot, relative), projectionRoot);
      if (await treeDigest(path.join(projectionRoot, relative)) !== await treeDigest(path.join(bundleRoot, relative))) throw refuse("LOCAL_SKILL_MODIFIED");
    }
    const runtimeRoot = path.join(bundleRoot, "local-runtime");
    const metadata = await fixedJson(runtimeRoot, "build-metadata.json");
    if (metadata.schema_version !== 1 || metadata.protocol !== 1 || metadata.node_range !== ">=22.12.0" || metadata.release_version !== version) throw refuse("LOCAL_RUNTIME_VERSION_MISMATCH");
    const launcherPath = path.join(runtimeRoot, "launcher.mjs");
    await assertNoSymlinkPath(launcherPath, stateRoot);
    await validatePrivatePath(launcherPath, "file");
    const launcherBytes = await readFile(launcherPath);
    if (metadata.files?.["launcher.mjs"]?.sha256 !== sha256Bytes(launcherBytes) || metadata.files["launcher.mjs"].size_bytes !== launcherBytes.length) throw refuse("LOCAL_SKILL_MODIFIED");
    if (canonicalDigest(await fixedJson(releaseRoot, "active.json")) !== canonicalDigest(active) || canonicalDigest(await fixedJson(releasePath, ".cfkanban-release.json")) !== canonicalDigest(receipt)) throw refuse("LOCAL_RUNTIME_UNVERIFIED");
    return await import(pathToFileURL(launcherPath).href);
  } catch (error) {
    if (["LOCAL_RUNTIME_NOT_INSTALLED", "LOCAL_RUNTIME_VERSION_MISMATCH", "LOCAL_RUNTIME_SOURCE_MISMATCH", "LOCAL_RUNTIME_UNVERIFIED", "LOCAL_SKILL_MODIFIED"].includes(error?.code)) throw refuse(error.code);
    throw refuse("LOCAL_RUNTIME_UNVERIFIED");
  }
}

async function loadLocalLauncher() {
  // 只接受源码预构建和安装工件的固定布局，不接受调用方指定的入口。
  for (const url of [new URL("../../local-runtime/dist/launcher.mjs", import.meta.url), new URL("../../../local-runtime/launcher.mjs", import.meta.url)]) {
    try { await access(url); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    return import(url.href);
  }
  return loadCanonicalLauncher();
}

export async function openWeb(input, { localLauncher = loadLocalLauncher, onlineLauncher = createBrowserLaunchAndDeliver } = {}) {
  if (!isPlainObject(input) || Object.keys(input).some(key => !FIELDS.includes(key))) throw toolError("INVALID_WEB_OPEN_INPUT", "Web open accepts only its documented fields");
  const { mode = "local", directory, instanceId, target, delivery, idempotencyKey, sensitiveOutputAcknowledgement, onRelayReady } = input;
  if (mode !== "local" && mode !== "online") throw toolError("INVALID_WEB_MODE", "Choose local or online Web mode");
  if (mode === "online") {
    if (directory !== undefined) throw toolError("INVALID_WEB_OPEN_INPUT", "Directory applies only to local mode");
    return onlineLauncher({ instanceId, target, delivery, idempotencyKey: requireString(idempotencyKey, "idempotency_key", { max: 128 }), sensitiveOutputAcknowledgement, onRelayReady });
  }
  if (idempotencyKey !== undefined || sensitiveOutputAcknowledgement !== undefined) throw toolError("INVALID_WEB_OPEN_INPUT", "Browser Launch options apply only to online mode");
  if (target !== undefined && !["project", "issue"].includes(target?.kind)) throw toolError("LOCAL_TARGET_UNSUPPORTED", "Management requires explicitly selected online mode");
  const launcher = await localLauncher();
  return launcher.openLocalWorkbench({ directory: requireString(directory, "directory"), instanceId, target, delivery, onRelayReady });
}

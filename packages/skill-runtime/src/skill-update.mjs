import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveSkillReleaseRoot } from "./paths.mjs";
import { atomicWriteJson, canonicalDigest, ensurePrivateDirectory, readJson, requireString, sha256Bytes } from "./utils.mjs";
import { toolError } from "./errors.mjs";

function safeArchiveName(name) {
  const normalized = name.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw toolError("UNSAFE_ARCHIVE_PATH", "Skill bundle contains an unsafe archive path", { name });
  }
  return normalized;
}

async function extractStoredZip(zipPath, targetRoot) {
  const data = await readFile(zipPath);
  let offset = 0;
  let files = 0;
  while (offset + 4 <= data.length && data.readUInt32LE(offset) === 0x04034b50) {
    const flags = data.readUInt16LE(offset + 6);
    const method = data.readUInt16LE(offset + 8);
    const compressedSize = data.readUInt32LE(offset + 18);
    const uncompressedSize = data.readUInt32LE(offset + 22);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    if ((flags & 0x0008) !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      throw toolError("UNSUPPORTED_SKILL_BUNDLE", "Skill update accepts only deterministic stored ZIP bundles");
    }
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const contentEnd = contentStart + compressedSize;
    const name = safeArchiveName(data.subarray(nameStart, nameStart + nameLength).toString("utf8"));
    const destination = path.join(targetRoot, ...name.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data.subarray(contentStart, contentEnd), { mode: 0o600, flag: "wx" });
    files += 1;
    offset = contentEnd;
  }
  if (files === 0) throw toolError("EMPTY_SKILL_BUNDLE", "Skill bundle did not contain files");
  return files;
}

async function collectTree(root, relative = "") {
  const entries = (await readdir(path.join(root, relative))).sort();
  const files = [];
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry) : entry;
    const absolute = path.join(root, child);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) throw toolError("LOCAL_SKILL_MODIFIED", "Installed Skill release contains a symbolic link", { path: child });
    if (stats.isDirectory()) files.push(...await collectTree(root, child));
    else if (stats.isFile()) files.push({ path: child.split(path.sep).join("/"), sha256: sha256Bytes(await readFile(absolute)) });
  }
  return files;
}

export async function treeDigest(root) {
  return canonicalDigest(await collectTree(root));
}

export async function installVerifiedSkillBundle({
  bundlePath,
  version,
  expectedSha256,
  publisher,
  source,
  releaseRoot = resolveSkillReleaseRoot(),
}) {
  const actualSha256 = sha256Bytes(await readFile(bundlePath));
  if (actualSha256 !== expectedSha256) throw toolError("ARTIFACT_DIGEST_MISMATCH", "Skill bundle digest does not match the immutable manifest", { expected: expectedSha256, actual: actualSha256 });
  await ensurePrivateDirectory(releaseRoot);
  const versionsRoot = path.join(releaseRoot, "versions");
  await ensurePrivateDirectory(versionsRoot);
  const safeVersion = requireString(version, "version", { max: 128 });
  if (!/^[0-9A-Za-z.+-]+$/.test(safeVersion)) throw toolError("INVALID_RELEASE_VERSION", "Skill release version contains unsafe path characters");
  const activePath = path.join(releaseRoot, "active.json");
  const active = await readJson(activePath, { allowMissing: true });
  if (active?.path) {
    const currentDigest = await treeDigest(active.release_path || active.path);
    if (currentDigest !== active.tree_digest) throw toolError("LOCAL_SKILL_MODIFIED", "Active Skill release has local modifications; update will not overwrite or merge it", { activePath: active.path });
  }
  const targetPath = path.join(versionsRoot, safeVersion);
  const temporaryPath = path.join(versionsRoot, `.${safeVersion}.${process.pid}.staging`);
  await rm(temporaryPath, { recursive: true, force: true });
  await mkdir(temporaryPath, { mode: 0o700 });
  try {
    const fileCount = await extractStoredZip(bundlePath, temporaryPath);
    const topLevelEntries = await readdir(temporaryPath, { withFileTypes: true });
    const singleRoot = topLevelEntries.length === 1 && topLevelEntries[0].isDirectory() ? topLevelEntries[0].name : null;
    const digest = await treeDigest(temporaryPath);
    const existing = await readJson(path.join(targetPath, ".cfkanban-release.json"), { allowMissing: true }).catch(() => null);
    if (existing !== null) throw toolError("RELEASE_ALREADY_EXISTS", "Target Skill release directory already exists", { targetPath });
    await atomicWriteJson(path.join(temporaryPath, ".cfkanban-release.json"), {
      schema_version: 1,
      kind: "skill_bundle",
      version: safeVersion,
      source,
      publisher,
      artifact_sha256: actualSha256,
      tree_digest_before_receipt: digest,
      installed_at: new Date().toISOString(),
    });
    const finalTreeDigest = await treeDigest(temporaryPath);
    await rename(temporaryPath, targetPath);
    await atomicWriteJson(activePath, {
      schema_version: 1,
      version: safeVersion,
      path: singleRoot === null ? targetPath : path.join(targetPath, singleRoot),
      release_path: targetPath,
      artifact_sha256: actualSha256,
      tree_digest: finalTreeDigest,
      previous: active === null ? null : { version: active.version, path: active.path, release_path: active.release_path || active.path, tree_digest: active.tree_digest },
      switched_at: new Date().toISOString(),
    });
    return { installed: true, version: safeVersion, path: singleRoot === null ? targetPath : path.join(targetPath, singleRoot), release_path: targetPath, file_count: fileCount, previous: active?.version || null };
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

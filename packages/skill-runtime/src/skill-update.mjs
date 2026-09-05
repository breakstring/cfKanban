import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveSkillReleaseRoot } from "./paths.mjs";
import { atomicWriteJson, canonicalDigest, ensurePrivateDirectory, readJson, requireHttpsOrigin, requireString, sha256Bytes } from "./utils.mjs";
import { toolError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

async function verifyDiscoverySmoke(bundleRoot) {
  const checked = [];
  // No inherited secrets or NODE_OPTIONS hooks. This checks trusted release
  // health, not a security sandbox for code from an untrusted publisher.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^SystemRoot$/iu.test(key)));
  for (const [skill, surface] of [["cfkanban", "daily"], ["cfkanban-admin", "admin"], ["cfkanban-deploy", "deploy"]]) {
    try {
      const skillRoot = path.join(bundleRoot, "skills", skill);
      if (!(await lstat(path.join(skillRoot, "SKILL.md"))).isFile()) throw new Error();
      const { stdout } = await execFileAsync(process.execPath, [path.join(skillRoot, "scripts", "cfkanban-tool.mjs"), "help"], {
        cwd: skillRoot, env, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, encoding: "utf8", windowsHide: true,
      });
      const result = JSON.parse(stdout);
      const catalog = result?.result;
      const commands = catalog?.commands;
      if (result?.ok !== true || catalog?.schema_version !== 1 || catalog?.surface !== surface
        || !Array.isArray(commands) || commands.length === 0
        || commands.some((command) => typeof command?.name !== "string" || !command.name.trim()
          || typeof command.effect !== "string" || !Array.isArray(command.input_fields))
        || new Set(commands.map((command) => command.name)).size !== commands.length) throw new Error();
      checked.push({ skill, surface, command_count: commands.length });
    } catch {
      // Child stdout/stderr and spawn errors may contain arbitrary release
      // content; report only our fixed classification and the failed surface.
      throw toolError("SKILL_DISCOVERY_SMOKE_FAILED", "Skill discovery/help failed; the active release was not changed", { skill, surface });
    }
  }
  return { passed: true, checked };
}

function safeArchiveName(name) {
  const normalized = name.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw toolError("UNSAFE_ARCHIVE_PATH", "Skill bundle contains an unsafe archive path", { name });
  }
  return normalized;
}

export async function extractStoredZip(zipPath, targetRoot) {
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

function normalizeHttpsSource(value) {
  let source;
  try {
    source = new URL(requireString(value, "source"));
  } catch (error) {
    throw toolError("INVALID_INPUT", "source must be an HTTPS URL", { field: "source" }, error);
  }
  if (source.protocol !== "https:" || source.username || source.password) {
    throw toolError("INVALID_INPUT", "source must be an HTTPS URL without credentials", { field: "source" });
  }
  return source;
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
  const publisherOrigin = requireHttpsOrigin(publisher, "publisher");
  const sourceUrl = normalizeHttpsSource(source);
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
    const discoverySmoke = await verifyDiscoverySmoke(singleRoot === null ? temporaryPath : path.join(temporaryPath, singleRoot));
    if (await treeDigest(temporaryPath) !== digest) {
      throw toolError("SKILL_DISCOVERY_SMOKE_FAILED", "Skill discovery/help modified the staged bundle; the active release was not changed");
    }
    await atomicWriteJson(path.join(temporaryPath, ".cfkanban-release.json"), {
      schema_version: 1,
      kind: "skill_bundle",
      version: safeVersion,
      source: sourceUrl.href,
      publisher: publisherOrigin,
      artifact_origins: [sourceUrl.origin],
      artifact_sha256: actualSha256,
      tree_digest_before_receipt: digest,
      discovery_smoke: discoverySmoke,
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
    return { installed: true, version: safeVersion, path: singleRoot === null ? targetPath : path.join(targetPath, singleRoot), release_path: targetPath, file_count: fileCount, previous: active?.version || null, discovery_smoke: discoverySmoke };
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

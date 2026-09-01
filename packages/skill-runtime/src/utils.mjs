import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { toolError } from "./errors.mjs";

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

export function normalizeLf(value) {
  return value.replace(/\r\n?/g, "\n");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function canonicalDigest(value) {
  return sha256Text(canonicalJson(value));
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireString(value, name, { min = 1, max = 4096 } = {}) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) {
    throw toolError("INVALID_INPUT", `${name} must be a non-empty string`, { field: name });
  }
  return value;
}

export function requireUuid(value, name) {
  const text = requireString(value, name, { max: 64 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw toolError("INVALID_INPUT", `${name} must be a UUID`, { field: name });
  }
  return text.toLowerCase();
}

export function requireHttpsOrigin(value, name = "origin") {
  let url;
  try {
    url = new URL(requireString(value, name));
  } catch (error) {
    throw toolError("INVALID_ORIGIN", `${name} must be an HTTPS origin`, { field: name }, error);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw toolError("INVALID_ORIGIN", `${name} must be an HTTPS origin without credentials, path, query, or fragment`, { field: name });
  }
  return url.origin;
}

export function assertSafePathSegment(value, name) {
  const text = requireString(value, name, { max: 128 });
  if (!/^[A-Za-z0-9._-]+$/.test(text) || text === "." || text === "..") {
    throw toolError("INVALID_PATH_SEGMENT", `${name} contains unsafe path characters`, { field: name });
  }
  return text;
}

export async function pathType(filePath) {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

export async function assertNoSymlinkPath(targetPath, stopAt) {
  const absoluteTarget = path.resolve(targetPath);
  const absoluteStop = path.resolve(stopAt);
  const relative = path.relative(absoluteStop, absoluteTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw toolError("UNSAFE_STATE_PATH", "Target path escapes the approved state root", { targetPath: absoluteTarget, stopAt: absoluteStop });
  }
  let current = absoluteStop;
  if (await pathType(current) === "symlink") {
    throw toolError("STATE_SYMLINK_REJECTED", "State root must not be a symbolic link", { path: current });
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (await pathType(current) === "symlink") {
      throw toolError("STATE_SYMLINK_REJECTED", "State paths must not contain symbolic links", { path: current });
    }
  }
}

export async function ensurePrivateDirectory(directoryPath) {
  const existing = await pathType(directoryPath);
  if (existing === "symlink") {
    throw toolError("STATE_SYMLINK_REJECTED", "Private directory must not be a symbolic link", { path: directoryPath });
  }
  if (existing !== "missing" && existing !== "directory") {
    throw toolError("UNSAFE_STATE_PATH", "Private directory path is not a directory", { path: directoryPath, type: existing });
  }
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const stats = await lstat(directoryPath);
    if ((stats.mode & 0o077) !== 0) {
      throw toolError("STATE_PERMISSION_DRIFT", "Private directory is accessible by another user or group", {
        path: directoryPath,
        mode: (stats.mode & 0o777).toString(8).padStart(3, "0"),
      });
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw toolError("STATE_OWNERSHIP_DRIFT", "Private directory is not owned by the current user", { path: directoryPath, ownerUid: stats.uid });
    }
  }
}

export async function readJson(filePath, { allowMissing = false } = {}) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (allowMissing && error && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw toolError("INVALID_JSON", "Stored JSON is invalid", { path: filePath }, error);
    }
    throw error;
  }
}

export async function atomicWriteJson(filePath, value, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  await assertNoSymlinkPath(filePath, directory);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicWritePublicJson(filePath, value, { mode = 0o644 } = {}) {
  const directory = path.dirname(filePath);
  const directoryType = await pathType(directory);
  if (directoryType !== "directory") {
    throw toolError("UNSAFE_OUTPUT_PATH", "Output parent is not an existing directory", { path: directory, type: directoryType });
  }
  await assertNoSymlinkPath(filePath, directory);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicWritePrivateText(filePath, value, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  await assertNoSymlinkPath(filePath, directory);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function jsonPointerChanges(before, after, pointer = "") {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (!isPlainObject(before) || !isPlainObject(after)) return [pointer || "/"];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].sort().flatMap((key) => jsonPointerChanges(before[key], after[key], `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`));
}

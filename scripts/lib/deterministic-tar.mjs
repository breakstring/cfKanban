import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync, inflateRawSync } from "node:zlib";

const BLOCK = 512;
export const TAR_GZIP_LIMITS = Object.freeze({
  maxCompressedBytes: 64 * 1024 * 1024,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxEntries: 4096,
});
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
const fail = (message) => { throw new Error(`Invalid tar.gz archive: ${message}`); };
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}

function safePath(value, type) {
  if (type === "directory" && value.endsWith("/")) value = value.slice(0, -1);
  if (!value || value.startsWith("/") || /[\\\u0000-\u001f\u007f]/u.test(value)) fail("unsafe path");
  for (const segment of value.split("/")) {
    // 同时拒绝 Windows ADS 和设备名，确保跨平台解压路径安全。
    if (!segment || segment === "." || segment === ".." || /[<>:"|?*]|[ .]$/u.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) fail("unsafe path");
  }
  return value;
}

function splitUstarPath(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: "" };
  for (let index = value.lastIndexOf("/"); index > 0; index = value.lastIndexOf("/", index - 1)) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (name && Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  fail("path does not fit USTAR name/prefix fields");
}

function writeOctal(header, offset, width, value) {
  const digits = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || digits.length >= width) fail("numeric field overflow");
  header.write(digits.padStart(width - 1, "0"), offset, width - 1, "ascii");
}

function headerFor(entry) {
  const header = Buffer.alloc(BLOCK);
  const { name, prefix } = splitUstarPath(entry.path);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory" ? 0x35 : 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function regularSource(stats) {
  if (!stats.isFile() || stats.nlink !== 1) fail("source must be a regular file without hard links");
  if (stats.size > TAR_GZIP_LIMITS.maxEntryBytes) fail("source entry exceeds size limit");
}

async function readSourceFile(absolute, expected) {
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    regularSource(before);
    if (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size || before.mode !== expected.mode
      || before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs) fail("source changed during packaging");
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) fail("source changed during packaging");
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, data.length);
    const after = await handle.stat();
    regularSource(after);
    if (extra.bytesRead || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail("source changed during packaging");
    return data;
  } finally { await handle.close(); }
}

async function collectSource(root) {
  const entries = [];
  let size = 2 * BLOCK;
  async function visit(relative) {
    const directory = path.join(root, relative);
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) fail("source directory is not a regular directory");
    for (const name of (await readdir(directory)).sort(byteOrder)) {
      const child = relative ? `${relative}/${name}` : name;
      const absolute = path.join(root, child);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) fail("source symbolic links are forbidden");
      const type = stats.isDirectory() ? "directory" : "file";
      safePath(child, type);
      splitUstarPath(child);
      if (entries.length >= TAR_GZIP_LIMITS.maxEntries) fail("too many source entries");
      let data = Buffer.alloc(0);
      if (type === "file") {
        regularSource(stats);
        size += Math.ceil(stats.size / BLOCK) * BLOCK;
        if (size + BLOCK > TAR_GZIP_LIMITS.maxUncompressedBytes) fail("source exceeds archive size limit");
        data = await readSourceFile(absolute, stats);
      }
      size += BLOCK;
      if (size > TAR_GZIP_LIMITS.maxUncompressedBytes) fail("source exceeds archive size limit");
      entries.push({ path: child, type, mode: type === "directory" || stats.mode & 0o111 ? 0o755 : 0o644, data });
      if (type === "directory") await visit(child);
    }
    const after = await lstat(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("source directory changed during packaging");
  }
  await visit("");
  return entries.sort((a, b) => byteOrder(a.path, b.path));
}

export async function writeDeterministicTarGzip({ root, outputPath }) {
  const source = path.resolve(root);
  const rootStats = await lstat(source);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) fail("source root is not a regular directory");
  const canonicalRoot = await realpath(source);
  const destination = path.resolve(outputPath);
  const canonicalDestination = path.join(await realpath(path.dirname(destination)), path.basename(destination));
  const inside = path.relative(canonicalRoot, canonicalDestination);
  if (!inside || !inside.startsWith(`..${path.sep}`) && inside !== ".." && !path.isAbsolute(inside)) fail("output must be outside the source directory");
  const entries = await collectSource(canonicalRoot);
  const parts = [];
  for (const entry of entries) {
    parts.push(headerFor(entry), entry.data);
    const padding = (BLOCK - entry.data.length % BLOCK) % BLOCK;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  const tar = Buffer.concat(parts);
  const bytes = gzipSync(tar, { level: 9, mtime: 0 });
  bytes.fill(0, 4, 8);
  bytes[9] = 255;
  if (bytes.length > TAR_GZIP_LIMITS.maxCompressedBytes) fail("compressed archive exceeds size limit");
  await writeFile(canonicalDestination, bytes, { flag: "wx", mode: 0o644 });
  return {
    outputPath: canonicalDestination,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.length,
    file_count: entries.filter((entry) => entry.type === "file").length,
    directory_count: entries.filter((entry) => entry.type === "directory").length,
    uncompressed_size_bytes: tar.length,
  };
}

function readString(header, offset, width) {
  const bytes = header.subarray(offset, offset + width);
  const end = bytes.indexOf(0);
  if (end !== -1 && bytes.subarray(end).some((byte) => byte !== 0)) fail("invalid string padding");
  try { return utf8.decode(end === -1 ? bytes : bytes.subarray(0, end)); }
  catch { fail("invalid UTF-8 string"); }
}

function readOctal(header, offset, width) {
  const field = header.subarray(offset, offset + width);
  if (field.some((byte) => byte !== 0 && byte !== 0x20 && (byte < 0x30 || byte > 0x37))) fail("invalid octal field");
  const digits = field.toString("ascii").replace(/[\0 ]+$/u, "").trimStart();
  if (!/^[0-7]+$/u.test(digits)) fail("invalid octal field");
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) fail("numeric field overflow");
  return value;
}

function limitsFor(options) {
  const limits = { ...TAR_GZIP_LIMITS };
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(value) || value <= 0 || value > limits[key]) fail("invalid size limit");
    limits[key] = value;
  }
  return limits;
}

export function readTarGzipEntries(input, options = {}) {
  if (!(input instanceof Uint8Array)) fail("bytes must be a Uint8Array");
  const limits = limitsFor(options);
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > limits.maxCompressedBytes) fail("compressed archive exceeds size limit");
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || bytes[3] !== 0) fail("unsupported gzip header");
  let tar;
  try {
    const inflated = inflateRawSync(bytes.subarray(10, -8), { maxOutputLength: limits.maxUncompressedBytes, info: true });
    if (inflated.engine.bytesWritten !== bytes.length - 18) fail("trailing or concatenated gzip data");
    tar = inflated.buffer;
  } catch { fail("invalid or oversized gzip body"); }
  if (bytes.readUInt32LE(bytes.length - 8) !== crc32(tar) || bytes.readUInt32LE(bytes.length - 4) !== tar.length) fail("gzip checksum or size mismatch");
  if (tar.length < 2 * BLOCK || tar.length % BLOCK !== 0) fail("incomplete tar block");
  const entries = [];
  const types = new Map();
  const requiredDirectories = new Set();
  let offset = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (offset + 2 * BLOCK > tar.length || tar.subarray(offset).some((byte) => byte !== 0)) fail("invalid tar terminator");
      return entries;
    }
    if (entries.length >= limits.maxEntries) fail("too many archive entries");
    if (header.subarray(257, 263).toString("ascii") !== "ustar\0" || header.subarray(263, 265).toString("ascii") !== "00") fail("unsupported tar header");
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 0x20 : byte), 0);
    if (readOctal(header, 148, 8) !== checksum) fail("tar checksum mismatch");
    const typeFlag = header[156];
    if (![0, 0x30, 0x35].includes(typeFlag)) fail("links and special archive entries are forbidden");
    const type = typeFlag === 0x35 ? "directory" : "file";
    if (readString(header, 157, 100)) fail("link targets are forbidden");
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    if (!name) fail("empty entry name");
    const entryPath = safePath(prefix ? `${prefix}/${name}` : name, type);
    if (types.has(entryPath)) fail("duplicate archive path");
    if (type === "file" && requiredDirectories.has(entryPath)) fail("file/directory path conflict");
    const segments = entryPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (types.get(parent) === "file") fail("file/directory path conflict");
      requiredDirectories.add(parent);
    }
    types.set(entryPath, type);
    const mode = readOctal(header, 100, 8);
    if (mode > 0o777) fail("special permission bits are forbidden");
    const size = readOctal(header, 124, 12);
    for (const [start, width] of [[108, 8], [116, 8], [136, 12], [329, 8], [337, 8]]) readOctal(header, start, width);
    readString(header, 265, 32);
    readString(header, 297, 32);
    if (header.subarray(500).some((byte) => byte !== 0)) fail("invalid USTAR padding");
    if (size > limits.maxEntryBytes || type === "directory" && size !== 0) fail("invalid or oversized entry");
    const start = offset + BLOCK;
    const end = start + size;
    const paddedEnd = start + Math.ceil(size / BLOCK) * BLOCK;
    if (paddedEnd > tar.length) fail("incomplete entry body");
    if (tar.subarray(end, paddedEnd).some((byte) => byte !== 0)) fail("invalid entry padding");
    entries.push({ path: entryPath, type, mode: type === "directory" || mode & 0o111 ? 0o755 : 0o644, data: tar.subarray(start, end) });
    offset = paddedEnd;
  }
  fail("missing tar terminator");
}

export async function extractTarGzip({ bytes, directory }) {
  const entries = readTarGzipEntries(bytes);
  const requested = path.resolve(directory);
  if (requested === path.parse(requested).root) fail("extraction target must be a new child directory");
  const target = path.join(await realpath(path.dirname(requested)), path.basename(requested));
  await mkdir(target, { mode: 0o755 });
  try {
    async function ensureDirectory(relative) {
      let current = target;
      for (const segment of relative.split("/").filter(Boolean)) {
        current = path.join(current, segment);
        try { await mkdir(current, { mode: 0o755 }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        const stats = await lstat(current);
        if (!stats.isDirectory() || stats.isSymbolicLink()) fail("extraction parent is not a regular directory");
        await chmod(current, 0o755);
      }
    }
    for (const entry of entries) {
      if (entry.type === "directory") await ensureDirectory(entry.path);
      else {
        await ensureDirectory(path.posix.dirname(entry.path) === "." ? "" : path.posix.dirname(entry.path));
        const filename = path.join(target, ...entry.path.split("/"));
        await writeFile(filename, entry.data, { flag: "wx", mode: entry.mode });
        await chmod(filename, entry.mode);
      }
    }
    await chmod(target, 0o755);
    return { directory: target, file_count: entries.filter((entry) => entry.type === "file").length, directory_count: entries.filter((entry) => entry.type === "directory").length };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

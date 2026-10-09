import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { extractTarGzip, readTarGzipEntries, TAR_GZIP_LIMITS, writeDeterministicTarGzip } from "../lib/deterministic-tar.mjs";

const run = promisify(execFile);
const BLOCK = 512;

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cfkanban-tar-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function setOctal(header, offset, width, value) {
  header.fill(0, offset, offset + width);
  header.write(value.toString(8).padStart(width - 1, "0"), offset, width - 1, "ascii");
}

function checksum(header) {
  header.fill(0x20, 148, 156);
  const value = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${value.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

function record({ name = "SKILL.md", prefix = "", data = Buffer.from("# Skill\n"), type = "0", mode = 0o644, size = data.length, target = "" } = {}) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  for (const [offset, width, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, size], [136, 12, 0], [329, 8, 0], [337, 8, 0]]) setOctal(header, offset, width, value);
  header.write(type, 156, 1, "ascii");
  header.write(target, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  checksum(header);
  return Buffer.concat([header, data, Buffer.alloc((BLOCK - data.length % BLOCK) % BLOCK)]);
}

const rawTar = (...records) => Buffer.concat([...records, Buffer.alloc(2 * BLOCK)]);
const archive = (...records) => gzipSync(rawTar(...records), { level: 9 });

test("writer emits reproducible rootless USTAR with normalized ownership, times and modes", async (t) => {
  const directory = await fixture(t);
  const roots = [path.join(directory, "first"), path.join(directory, "second")];
  for (const [index, root] of roots.entries()) {
    await mkdir(root);
    for (const name of index ? ["scripts", "empty", "docs"] : ["docs", "empty", "scripts"]) await mkdir(path.join(root, name), { mode: 0o700 });
    await writeFile(path.join(root, "SKILL.md"), "---\nname: example\n---\n");
    await writeFile(path.join(root, "scripts/tool.mjs"), "#!/usr/bin/env node\n");
    await writeFile(path.join(root, "docs/说明.md"), "资源\n");
    await writeFile(path.join(root, "docs/zero.txt"), "");
    await chmod(path.join(root, "scripts/tool.mjs"), index ? 0o751 : 0o711);
    await chmod(path.join(root, "SKILL.md"), index ? 0o660 : 0o600);
    await utimes(path.join(root, "SKILL.md"), index + 10, index + 20);
  }
  const results = [];
  for (const [index, root] of roots.entries()) results.push(await writeDeterministicTarGzip({ root, outputPath: path.join(directory, `${index}.tar.gz`) }));
  const bytes = await readFile(results[0].outputPath);
  assert.deepEqual(bytes, await readFile(results[1].outputPath));
  assert.equal(bytes.readUInt32LE(4), 0);
  assert.equal(bytes[3], 0);
  assert.equal(bytes[9], 255);
  assert.equal(results[0].sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(results[0].size_bytes, bytes.length);
  assert.equal(results[0].file_count, 4);
  assert.equal(results[0].directory_count, 3);
  const entries = readTarGzipEntries(bytes);
  assert.deepEqual(entries.map((entry) => entry.path), ["SKILL.md", "docs", "docs/zero.txt", "docs/说明.md", "empty", "scripts", "scripts/tool.mjs"]);
  assert.equal(entries.find((entry) => entry.path === "scripts/tool.mjs").mode, 0o755);
  assert.equal(entries.find((entry) => entry.path === "SKILL.md").mode, 0o644);
  assert.equal(entries.find((entry) => entry.path === "empty").type, "directory");
  const tar = gunzipSync(bytes);
  assert.equal(results[0].uncompressed_size_bytes, tar.length);
  let offset = 0;
  for (const entry of entries) {
    const header = tar.subarray(offset, offset + BLOCK);
    assert.equal(header.subarray(257, 265).toString("ascii"), "ustar\0" + "00");
    for (const [start, end] of [[108, 116], [116, 124], [136, 148]]) assert.equal(Number.parseInt(header.subarray(start, end).toString("ascii"), 8), 0);
    offset += BLOCK + Math.ceil(entry.data.length / BLOCK) * BLOCK;
  }
  assert.ok(tar.subarray(offset).every((byte) => byte === 0));
  try {
    const { stdout } = await run("tar", ["-tzf", results[0].outputPath]);
    assert.ok(stdout.split("\n").includes("SKILL.md"));
    assert.ok(stdout.includes("scripts/tool.mjs"));
  } catch (error) { if (error.code !== "ENOENT") throw error; t.diagnostic("System tar unavailable; raw USTAR fields verified directly"); }
});

test("USTAR uses exact 100-byte name and 155-byte prefix fields, including UTF-8 paths", async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, "source");
  const prefix = `${"a".repeat(77)}/${"a".repeat(77)}`;
  const name = "b".repeat(100);
  await mkdir(path.join(root, prefix), { recursive: true });
  await writeFile(path.join(root, prefix, name), "long path");
  await mkdir(path.join(root, "目标"));
  await writeFile(path.join(root, "目标", "文".repeat(33)), "unicode");
  const result = await writeDeterministicTarGzip({ root, outputPath: path.join(directory, "long.tar.gz") });
  const entries = readTarGzipEntries(await readFile(result.outputPath));
  assert.ok(entries.some((entry) => entry.path === `${prefix}/${name}`));
  assert.ok(entries.some((entry) => entry.path === `目标/${"文".repeat(33)}`));
  const tar = gunzipSync(await readFile(result.outputPath));
  assert.equal(tar.subarray(2 * BLOCK, 2 * BLOCK + 100).toString(), name);
  assert.equal(tar.subarray(2 * BLOCK + 345, 2 * BLOCK + 500).toString(), prefix);
});

test("writer rejects unrepresentable USTAR paths and outputs inside the source", async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, "source");
  await mkdir(path.join(root, "a".repeat(156)), { recursive: true });
  await writeFile(path.join(root, "a".repeat(156), "b".repeat(101)), "value");
  await assert.rejects(writeDeterministicTarGzip({ root, outputPath: path.join(directory, "bad.tar.gz") }), /does not fit USTAR/u);
  await assert.rejects(writeDeterministicTarGzip({ root, outputPath: path.join(root, "inside.tar.gz") }), /outside the source/u);
});

test("writer rejects source symlinks, hard links and special nodes", async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, "source");
  await mkdir(root);
  await writeFile(path.join(root, "original"), "value");
  await symlink(path.join(root, "original"), path.join(root, "linked"));
  await assert.rejects(writeDeterministicTarGzip({ root, outputPath: path.join(directory, "symlink.tar.gz") }), /symbolic links/u);
  await rm(path.join(root, "linked"));
  await symlink(root, path.join(directory, "linked-root"), "dir");
  await assert.rejects(writeDeterministicTarGzip({ root: path.join(directory, "linked-root"), outputPath: path.join(directory, "root.tar.gz") }), /source root/u);
  await link(path.join(root, "original"), path.join(root, "hard"));
  await assert.rejects(writeDeterministicTarGzip({ root, outputPath: path.join(directory, "hard.tar.gz") }), /hard links/u);
  await rm(path.join(root, "hard"));
  if (process.platform !== "win32") {
    await run("mkfifo", [path.join(root, "fifo")]);
    await assert.rejects(writeDeterministicTarGzip({ root, outputPath: path.join(directory, "fifo.tar.gz") }), /regular file/u);
  }
});

test("writer never follows or overwrites an existing output", async (t) => {
  const directory = await fixture(t);
  const root = path.join(directory, "source");
  await mkdir(root);
  await writeFile(path.join(root, "SKILL.md"), "skill");
  const target = path.join(directory, "existing");
  await writeFile(target, "preserve");
  await assert.rejects(writeDeterministicTarGzip({ root, outputPath: target }), { code: "EEXIST" });
  await symlink(target, path.join(directory, "alias.tar.gz"));
  await assert.rejects(writeDeterministicTarGzip({ root, outputPath: path.join(directory, "alias.tar.gz") }), { code: "EEXIST" });
  assert.equal(await readFile(target, "utf8"), "preserve");
});

test("reader rejects traversal, absolute, ambiguous and Windows-dangerous paths", () => {
  for (const name of ["../escape", "/absolute", "a/../../escape", "a\\b", "C:/escape", "./SKILL.md", "a//b", "a/", "NUL.txt", "dir/file:stream", "trailing.", "trailing ", "control\nname"]) {
    assert.throws(() => readTarGzipEntries(archive(record({ name }))), /unsafe path/u, name);
  }
  assert.throws(() => readTarGzipEntries(archive(record({ name: "file", prefix: "../outside" }))), /unsafe path/u);
  assert.throws(() => readTarGzipEntries(archive(record({ name: "file\0hidden" }))), /invalid string padding/u);
  const invalidUtf8 = record();
  invalidUtf8[0] = 0xff;
  checksum(invalidUtf8.subarray(0, BLOCK));
  assert.throws(() => readTarGzipEntries(archive(invalidUtf8)), /UTF-8/u);
});

test("reader refuses every link or extension type and linknames on regular files", () => {
  for (const type of ["1", "2", "3", "4", "6", "7", "x", "g", "L", "K", "S"]) {
    assert.throws(() => readTarGzipEntries(archive(record({ type }))), /links and special/u, type);
  }
  assert.throws(() => readTarGzipEntries(archive(record({ target: "../elsewhere" }))), /link targets/u);
  assert.equal(readTarGzipEntries(archive(record({ type: "\0" })))[0].type, "file");
});

test("reader rejects duplicate paths and file/directory topology conflicts regardless of order", () => {
  const directory = record({ name: "a/", type: "5", data: Buffer.alloc(0) });
  for (const records of [
    [record(), record()],
    [directory, record({ name: "a", type: "5", data: Buffer.alloc(0) })],
    [record({ name: "a" }), record({ name: "a/b" })],
    [record({ name: "a/b" }), record({ name: "a" })],
  ]) assert.throws(() => readTarGzipEntries(archive(...records)), /duplicate|conflict/u);
  assert.deepEqual(readTarGzipEntries(archive(record({ name: "a/b" }), directory)).map((entry) => entry.path), ["a/b", "a"]);
});

test("reader validates USTAR magic, version, checksum and octal metadata", () => {
  for (const offset of [257, 263, 0]) {
    const bytes = record();
    bytes[offset] ^= 1;
    assert.throws(() => readTarGzipEntries(archive(bytes)), /header|checksum/u);
  }
  for (const offset of [100, 108, 116, 124, 136, 148, 329, 337]) {
    const bytes = record();
    bytes[offset] = 0x80;
    if (offset !== 148) checksum(bytes.subarray(0, BLOCK));
    assert.throws(() => readTarGzipEntries(archive(bytes)), /octal/u);
  }
  assert.throws(() => readTarGzipEntries(archive(record({ mode: 0o4755 }))), /special permission/u);
  assert.throws(() => readTarGzipEntries(archive(record({ type: "5" }))), /invalid or oversized entry/u);
});

test("reader requires complete bodies, zero padding and two tar terminator blocks", () => {
  const valid = rawTar(record());
  for (const bytes of [Buffer.alloc(511), valid.subarray(0, 511), valid.subarray(0, -BLOCK), valid.subarray(0, -1), record(), record({ size: 2048 })]) {
    assert.throws(() => readTarGzipEntries(gzipSync(bytes)), /incomplete|terminator/u);
  }
  const padding = record();
  padding[BLOCK + 10] = 1;
  assert.throws(() => readTarGzipEntries(archive(padding)), /entry padding/u);
  const headerPadding = record();
  headerPadding[500] = 1;
  checksum(headerPadding.subarray(0, BLOCK));
  assert.throws(() => readTarGzipEntries(archive(headerPadding)), /USTAR padding/u);
  const trailer = Buffer.from(valid);
  trailer[trailer.length - 1] = 1;
  assert.throws(() => readTarGzipEntries(gzipSync(trailer)), /terminator/u);
  assert.equal(readTarGzipEntries(gzipSync(Buffer.concat([valid, Buffer.alloc(4 * BLOCK)]))).length, 1);
});

test("reader verifies gzip framing, CRC and size and rejects concatenation", () => {
  const valid = archive(record());
  for (const offset of [0, 2, 3, valid.length - 8, valid.length - 4]) {
    const bytes = Buffer.from(valid);
    bytes[offset] ^= 1;
    assert.throws(() => readTarGzipEntries(bytes), /gzip/u);
  }
  for (const bytes of [valid.subarray(0, 9), valid.subarray(0, -1), Buffer.concat([valid, valid]), Buffer.concat([valid, Buffer.from("trailing")])]) {
    assert.throws(() => readTarGzipEntries(bytes), /gzip/u);
  }
  assert.throws(() => readTarGzipEntries("not bytes"), /Uint8Array/u);
});

test("reader bounds compressed bytes, inflation, entries and per-file sizes", () => {
  const valid = archive(record(), record({ name: "other" }));
  assert.throws(() => readTarGzipEntries(valid, { maxCompressedBytes: valid.length - 1 }), /size limit/u);
  assert.throws(() => readTarGzipEntries(valid, { maxUncompressedBytes: BLOCK }), /oversized gzip/u);
  assert.throws(() => readTarGzipEntries(valid, { maxEntries: 1 }), /too many/u);
  assert.throws(() => readTarGzipEntries(valid, { maxEntryBytes: 1 }), /oversized entry/u);
  assert.throws(() => readTarGzipEntries(archive(record({ size: TAR_GZIP_LIMITS.maxEntryBytes + 1 }))), /oversized entry/u);
  assert.throws(() => readTarGzipEntries(valid, { maxEntries: TAR_GZIP_LIMITS.maxEntries + 1 }), /invalid size limit/u);
  assert.throws(() => readTarGzipEntries(valid, { unknown: 1 }), /invalid size limit/u);
});

test("extractor validates the whole archive before creating a new destination", async (t) => {
  const directory = await fixture(t);
  const target = path.join(directory, "result");
  await assert.rejects(extractTarGzip({ bytes: archive(record(), record({ name: "../escape" })), directory: target }), /unsafe path/u);
  await assert.rejects(lstat(target), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), []);
});

test("extractor creates a rootless tree with empty directories, binary data and normalized modes", async (t) => {
  const directory = await fixture(t);
  const bytes = archive(
    record({ name: "scripts/tool.mjs", mode: 0o701, data: Buffer.from([0, 1, 255]) }),
    record({ name: "empty/", type: "5", mode: 0o700, data: Buffer.alloc(0) }),
    record(),
  );
  const result = await extractTarGzip({ bytes, directory: path.join(directory, "result") });
  assert.equal(result.file_count, 2);
  assert.equal(result.directory_count, 1);
  assert.deepEqual(await readFile(path.join(result.directory, "scripts/tool.mjs")), Buffer.from([0, 1, 255]));
  assert.deepEqual(await readdir(path.join(result.directory, "empty")), []);
  assert.equal(await readFile(path.join(result.directory, "SKILL.md"), "utf8"), "# Skill\n");
  if (process.platform !== "win32") {
    assert.equal((await lstat(path.join(result.directory, "scripts/tool.mjs"))).mode & 0o777, 0o755);
    assert.equal((await lstat(path.join(result.directory, "SKILL.md"))).mode & 0o777, 0o644);
    assert.equal((await lstat(path.join(result.directory, "empty"))).mode & 0o777, 0o755);
  }
});

test("extractor refuses existing directories, files and symlinks without changing their contents", async (t) => {
  const directory = await fixture(t);
  const target = path.join(directory, "existing");
  await mkdir(target);
  await writeFile(path.join(target, "SKILL.md"), "preserve");
  const bytes = archive(record());
  await assert.rejects(extractTarGzip({ bytes, directory: target }), { code: "EEXIST" });
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "preserve");
  const file = path.join(directory, "file");
  await writeFile(file, "file content");
  await assert.rejects(extractTarGzip({ bytes, directory: file }), { code: "EEXIST" });
  await symlink(target, path.join(directory, "alias"), "dir");
  await assert.rejects(extractTarGzip({ bytes, directory: path.join(directory, "alias") }), { code: "EEXIST" });
  assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), "preserve");
  assert.equal(await readFile(file, "utf8"), "file content");
});

test("empty archives remain valid and missing destination parents are not created", async (t) => {
  const directory = await fixture(t);
  assert.deepEqual(readTarGzipEntries(archive()), []);
  await assert.rejects(extractTarGzip({ bytes: archive(), directory: path.join(directory, "missing/target") }), { code: "ENOENT" });
  assert.deepEqual(await readdir(directory), []);
  const root = path.join(directory, "source");
  await mkdir(root);
  const result = await writeDeterministicTarGzip({ root, outputPath: path.join(directory, "empty.tar.gz") });
  assert.deepEqual(readTarGzipEntries(await readFile(result.outputPath)), []);
});

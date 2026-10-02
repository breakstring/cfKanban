import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyEmbeddedBuild } from "../lib/embedded-build.mjs";

test("嵌入页面发行校验拒绝版本漂移、内容篡改和错误协议", async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "cfkanban-embedded-manifest-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const html = Buffer.from("<!doctype html><title>cfKanban</title>");
  const version = "1.8.0-rc.1";
  const metadata = { schema_version: 1, protocol: 1, entry: "embedded.html", release_version: version,
    size_bytes: html.length, sha256: createHash("sha256").update(html).digest("hex") };
  const writeMetadata = async (value) => writeFile(path.join(outputDirectory, "embedded-build.json"), JSON.stringify(value));
  await writeFile(path.join(outputDirectory, "embedded.html"), html);
  await writeMetadata(metadata);
  assert.deepEqual(await verifyEmbeddedBuild({ outputDirectory, version }), metadata);
  await assert.rejects(verifyEmbeddedBuild({ outputDirectory, version: "1.8.0" }), /metadata does not match/);
  await writeMetadata({ ...metadata, protocol: 2 });
  await assert.rejects(verifyEmbeddedBuild({ outputDirectory, version }), /metadata does not match/);
  await writeMetadata(metadata);
  await writeFile(path.join(outputDirectory, "embedded.html"), Buffer.concat([html, Buffer.from("tampered")]));
  await assert.rejects(verifyEmbeddedBuild({ outputDirectory, version }), /digest changed/);
});

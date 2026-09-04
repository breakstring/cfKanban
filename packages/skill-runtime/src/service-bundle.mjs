import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { toolError } from "./errors.mjs";
import { resolveServiceReleaseRoot } from "./paths.mjs";
import { extractStoredZip, treeDigest } from "./skill-update.mjs";
import {
  assertNoSymlinkPath,
  atomicWriteJson,
  ensurePrivateDirectory,
  pathType,
  readJson,
  requireHttpsOrigin,
  requireString,
  sha256Bytes,
} from "./utils.mjs";


const REQUIRED_SERVICE_ENTRIES = Object.freeze([
  ["dist/index.js", "file"],
  ["apps/web/dist", "directory"],
  ["contracts/openapi.json", "file"],
  ["migrations/manifest.json", "file"],
  ["release/deployment/migration-readback.sql", "file"],
  ["wrangler-config-schema.json", "file"],
  ["wrangler.template.json", "file"],
]);

function normalizeSource(value) {
  let source;
  try {
    source = new URL(requireString(value, "source", { max: 4096 }));
  } catch (error) {
    throw toolError("INVALID_INPUT", "source must be an HTTPS URL", { field: "source" }, error);
  }
  if (source.protocol !== "https:" || source.username || source.password) {
    throw toolError("INVALID_INPUT", "source must be an HTTPS URL without credentials", { field: "source" });
  }
  return source;
}

function digest(value, name) {
  const text = requireString(value, name, { max: 64 });
  if (!/^[a-f0-9]{64}$/u.test(text)) {
    throw toolError("INVALID_DIGEST", name + " must be a lowercase SHA-256 digest", { field: name });
  }
  return text;
}

async function validateEntries(bundleRoot) {
  for (const [relativePath, expectedType] of REQUIRED_SERVICE_ENTRIES) {
    const entry = path.join(bundleRoot, relativePath);
    await assertNoSymlinkPath(entry, bundleRoot);
    const actualType = await pathType(entry);
    if (actualType !== expectedType) {
      throw toolError("SERVICE_BUNDLE_INCOMPLETE", "Service bundle is missing a required deployment entry", {
        entry: relativePath,
        expected_type: expectedType,
        actual_type: actualType,
      });
    }
  }
}

export async function verifyInstalledServiceBundle({
  bundleRoot,
  expectedVersion,
  expectedSha256,
  expectedPublisher,
  expectedSource,
}) {
  const normalizedRoot = path.resolve(requireString(bundleRoot, "bundle_root", { max: 4096 }));
  if (await pathType(normalizedRoot) !== "directory") {
    throw toolError("SERVICE_BUNDLE_INCOMPLETE", "Installed Service bundle root is not a directory");
  }
  const releasePath = path.dirname(normalizedRoot);
  const receiptPath = path.join(releasePath, ".cfkanban-release.json");
  await assertNoSymlinkPath(receiptPath, releasePath);
  const receipt = await readJson(receiptPath);
  const version = requireString(expectedVersion, "expected_version", { max: 128 });
  const artifactSha256 = digest(expectedSha256, "expected_sha256");
  const publisher = requireHttpsOrigin(expectedPublisher, "expected_publisher");
  const source = normalizeSource(expectedSource);
  if (receipt?.schema_version !== 1
    || receipt.kind !== "service_deployment_bundle"
    || receipt.version !== version
    || receipt.artifact_sha256 !== artifactSha256
    || receipt.publisher !== publisher
    || receipt.source !== source.href
    || path.resolve(receipt.bundle_path) !== normalizedRoot
    || path.basename(releasePath) !== version
    || path.basename(path.dirname(releasePath)) !== "versions") {
    throw toolError("SERVICE_BUNDLE_RECEIPT_DRIFT", "Installed Service bundle receipt does not match the authorized release");
  }
  await assertNoSymlinkPath(normalizedRoot, releasePath);
  await validateEntries(normalizedRoot);
  const actualTreeDigest = await treeDigest(normalizedRoot);
  if (actualTreeDigest !== receipt.bundle_tree_digest) {
    throw toolError("LOCAL_SERVICE_BUNDLE_MODIFIED", "Installed Service bundle tree differs from its immutable receipt");
  }
  return {
    verified: true,
    version,
    artifact_sha256: artifactSha256,
    bundle_tree_digest: actualTreeDigest,
    path: normalizedRoot,
    release_path: releasePath,
    receipt_path: receiptPath,
  };
}

export async function installVerifiedServiceBundle({
  bundlePath,
  version,
  expectedSha256,
  publisher,
  source,
  releaseRoot = resolveServiceReleaseRoot(),
}) {
  const actualSha256 = sha256Bytes(await readFile(bundlePath));
  if (actualSha256 !== expectedSha256) {
    throw toolError("ARTIFACT_DIGEST_MISMATCH", "Service bundle digest does not match the immutable manifest", {
      expected: expectedSha256,
      actual: actualSha256,
    });
  }
  const safeVersion = requireString(version, "version", { max: 128 });
  if (!/^[0-9A-Za-z.+-]+$/u.test(safeVersion)) {
    throw toolError("INVALID_RELEASE_VERSION", "Service release version contains unsafe path characters");
  }
  const publisherOrigin = requireHttpsOrigin(publisher, "publisher");
  const sourceUrl = normalizeSource(source);
  await ensurePrivateDirectory(releaseRoot);
  const versionsRoot = path.join(releaseRoot, "versions");
  await ensurePrivateDirectory(versionsRoot);
  const targetPath = path.join(versionsRoot, safeVersion);
  const existingReceipt = await readJson(path.join(targetPath, ".cfkanban-release.json"), { allowMissing: true }).catch(() => null);
  if (existingReceipt !== null) {
    const verified = await verifyInstalledServiceBundle({
      bundleRoot: existingReceipt.bundle_path,
      expectedVersion: safeVersion,
      expectedSha256: actualSha256,
      expectedPublisher: publisherOrigin,
      expectedSource: sourceUrl.href,
    });
    return { installed: false, reused: true, ...verified };
  }

  const temporaryPath = path.join(versionsRoot, "." + safeVersion + "." + process.pid + ".staging");
  await rm(temporaryPath, { recursive: true, force: true });
  await mkdir(temporaryPath, { mode: 0o700 });
  try {
    const fileCount = await extractStoredZip(bundlePath, temporaryPath);
    const entries = await readdir(temporaryPath, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) {
      throw toolError("UNSUPPORTED_SERVICE_BUNDLE", "Service bundle must contain exactly one top-level directory");
    }
    const bundleRoot = path.join(temporaryPath, entries[0].name);
    await validateEntries(bundleRoot);
    const bundleTreeDigest = await treeDigest(bundleRoot);
    const finalBundleRoot = path.join(targetPath, entries[0].name);
    await atomicWriteJson(path.join(temporaryPath, ".cfkanban-release.json"), {
      schema_version: 1,
      kind: "service_deployment_bundle",
      version: safeVersion,
      source: sourceUrl.href,
      publisher: publisherOrigin,
      artifact_origins: [sourceUrl.origin],
      artifact_sha256: actualSha256,
      bundle_path: finalBundleRoot,
      bundle_tree_digest: bundleTreeDigest,
      installed_at: new Date().toISOString(),
    });
    if (await pathType(targetPath) !== "missing") {
      throw toolError("RELEASE_ALREADY_EXISTS", "Target Service release directory already exists", { targetPath });
    }
    await rename(temporaryPath, targetPath);
    return {
      installed: true,
      reused: false,
      verified: true,
      version: safeVersion,
      artifact_sha256: actualSha256,
      bundle_tree_digest: bundleTreeDigest,
      path: finalBundleRoot,
      release_path: targetPath,
      receipt_path: path.join(targetPath, ".cfkanban-release.json"),
      file_count: fileCount,
    };
  } finally {
    await rm(temporaryPath, { recursive: true, force: true });
  }
}

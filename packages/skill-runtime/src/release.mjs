import { readFile } from "node:fs/promises";
import { toolError } from "./errors.mjs";
import { canonicalDigest, readJson, requireHttpsOrigin, requireString, sha256Bytes } from "./utils.mjs";

export function validateReleaseManifest(manifest) {
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) {
    throw toolError("INVALID_RELEASE_MANIFEST", "Release manifest must contain exactly the Skill and Service deployment artifacts");
  }
  const kinds = new Set();
  const artifacts = manifest.artifacts.map((artifact) => {
    const kind = artifact.kind;
    if (kind !== "skill_bundle" && kind !== "service_deployment_bundle" || kinds.has(kind)) {
      throw toolError("INVALID_RELEASE_MANIFEST", "Release manifest artifact kinds must be unique Skill and Service deployment bundles");
    }
    kinds.add(kind);
    const url = new URL(requireString(artifact.url, "artifact.url"));
    if (url.protocol !== "https:") throw toolError("INVALID_RELEASE_MANIFEST", "Artifact URL must use HTTPS", { kind });
    const allowedOrigins = (artifact.allowed_origins || []).map((origin) => requireHttpsOrigin(origin, "allowed_origin"));
    if (!allowedOrigins.includes(url.origin)) {
      throw toolError("ARTIFACT_ORIGIN_REJECTED", "Artifact URL origin is not allowlisted by the immutable manifest", { kind, origin: url.origin });
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 || "")) {
      throw toolError("INVALID_RELEASE_MANIFEST", "Artifact SHA-256 must be a lowercase hexadecimal digest", { kind });
    }
    return { ...artifact, allowed_origins: allowedOrigins };
  });
  return {
    ...manifest,
    publisher: {
      ...manifest.publisher,
      canonical_origin: requireHttpsOrigin(manifest.publisher?.canonical_origin, "publisher.canonical_origin"),
    },
    artifacts,
  };
}

export function verifyStablePointer({ stable, manifestBytes }) {
  if (stable?.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(stable.manifest_sha256 || "")) {
    throw toolError("INVALID_STABLE_POINTER", "Stable pointer is missing an immutable manifest digest");
  }
  const actual = sha256Bytes(manifestBytes);
  if (actual !== stable.manifest_sha256) {
    throw toolError("MANIFEST_DIGEST_MISMATCH", "Immutable release manifest digest does not match the stable pointer", { expected: stable.manifest_sha256, actual });
  }
  return actual;
}

export async function verifyReleaseArtifacts({ manifest, artifactFiles }) {
  const checked = validateReleaseManifest(manifest);
  const results = [];
  for (const artifact of checked.artifacts) {
    const filePath = artifactFiles[artifact.kind];
    if (!filePath) throw toolError("ARTIFACT_MISSING", "A release artifact file was not supplied", { kind: artifact.kind });
    const actual = sha256Bytes(await readFile(filePath));
    if (actual !== artifact.sha256) {
      throw toolError("ARTIFACT_DIGEST_MISMATCH", "Release artifact digest does not match the immutable manifest", { kind: artifact.kind, expected: artifact.sha256, actual });
    }
    results.push({ kind: artifact.kind, version: artifact.version, sha256: actual, source: artifact.url });
  }
  return { verified: true, artifacts: results };
}

export function verifyPublisherContinuity({ currentReceipt, targetManifest }) {
  if (currentReceipt === null || currentReceipt === undefined) return { continuous: true, first_install: true };
  const target = validateReleaseManifest(targetManifest);
  const targetOrigins = new Set(target.artifacts.flatMap((artifact) => artifact.allowed_origins));
  const changed = currentReceipt.publisher?.canonical_origin !== target.publisher.canonical_origin
    || !(currentReceipt.artifact_origins || []).every((origin) => targetOrigins.has(origin));
  return {
    continuous: !changed,
    first_install: false,
    requires_explicit_rebind: changed,
    before: { publisher: currentReceipt.publisher?.canonical_origin || null, artifact_origins: currentReceipt.artifact_origins || [] },
    after: { publisher: target.publisher.canonical_origin, artifact_origins: [...targetOrigins].sort() },
  };
}

export async function loadAndVerifyRelease({ stablePath, manifestPath, artifactFiles }) {
  const stable = await readJson(stablePath);
  const manifestBytes = await readFile(manifestPath);
  verifyStablePointer({ stable, manifestBytes });
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const artifacts = await verifyReleaseArtifacts({ manifest, artifactFiles });
  return { stable, manifest, manifest_content_digest: canonicalDigest(manifest), ...artifacts };
}

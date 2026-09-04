import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { loadAndVerifyRelease } from "../../packages/skill-runtime/src/release.mjs";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

// Maintenance-only: exact six-file inventory, never scan a checkout for upload candidates.
export async function publicationPlan({ repository, version, commit, directory, notes }) {
  requireValue(repository === "breakstring/cfKanban", "Only the declared canonical GitHub repository is supported");
  requireValue(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), "An exact release version is required");
  requireValue(/^[0-9a-f]{40}$/.test(commit), "A full expected Git commit is required");
  requireValue(typeof notes === "string" && notes.trim().length > 0, "Explicit release notes are required");
  const prerelease = version.includes("-");
  const names = [prerelease ? "prerelease.json" : "stable.json", `cfkanban-release-${version}.json`, `cfkanban-skills-${version}.zip`, `cfkanban-service-${version}.zip`, "install.md", "install.zh-CN.md"];
  const root = path.resolve(directory);
  requireValue(!(await lstat(root)).isSymbolicLink(), "Artifact directory cannot be a symbolic link");
  assert.deepEqual((await readdir(root)).sort(), [...names].sort(), "Upload directory must contain exactly the six approved assets");
  const assets = [];
  for (const name of names) {
    const file = path.join(root, name);
    const stat = await lstat(file);
    requireValue(stat.isFile() && !stat.isSymbolicLink(), `Asset must be a regular file: ${name}`);
    requireValue(stat.size > 0 && stat.size <= 100 * 1024 * 1024, `Invalid asset size: ${name}`);
    const bytes = await readFile(file);
    requireValue(bytes.length === stat.size, `Asset changed during inspection: ${name}`);
    assets.push({ name, file, size: bytes.length, sha256: digest(bytes) });
  }
  const verified = await loadAndVerifyRelease({
    releasePointerPath: assets[0].file,
    manifestPath: assets[1].file,
    artifactFiles: { skill_bundle: assets[2].file, service_deployment_bundle: assets[3].file },
  });
  const base = `https://github.com/${repository}/releases/download/${version}/`;
  const { pointer, manifest } = verified;
  requireValue(pointer.release_version === version && manifest.release.version === version && manifest.release.immutable === true, "Release version or immutability mismatch");
  requireValue(pointer.channel === (prerelease ? "prerelease" : "stable"), "Release channel mismatch");
  requireValue(pointer.product === "cfkanban" && manifest.product === "cfkanban", "Release product mismatch");
  for (const document of [pointer, manifest]) {
    requireValue(document.publisher?.id === "cfkanban" && document.publisher.canonical_origin === "https://github.com", "Publisher mismatch");
    assert.deepEqual(document.documents, { en: `${base}install.md`, "zh-CN": `${base}install.zh-CN.md` }, "Bootstrap document URLs must match the exact release");
  }
  requireValue(pointer.manifest_url === `${base}${assets[1].name}`, "Manifest URL must match the exact release");
  for (const artifact of manifest.artifacts) {
    const expected = assets[artifact.kind === "skill_bundle" ? 2 : 3];
    requireValue(artifact.version === version && artifact.url === `${base}${expected.name}`, "Artifact version/URL mismatch");
    assert.deepEqual(artifact.allowed_origins, ["https://github.com"]);
  }
  const plan = { repository, version, commit, prerelease, notes, assets };
  plan.digest = digest(JSON.stringify({ ...plan, assets: assets.map(({ file, ...asset }) => asset) }));
  return plan;
}

export async function checkLocalAssets(plan) {
  for (const asset of plan.assets) {
    const stat = await lstat(asset.file);
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size === asset.size, `Local asset drift: ${asset.name}`);
    requireValue(digest(await readFile(asset.file)) === asset.sha256, `Local asset drift: ${asset.name}`);
  }
}

export function missingAssets(plan, assets) {
  const remaining = new Map(plan.assets.map((asset) => [asset.name, asset]));
  const ids = new Set();
  for (const asset of assets) {
    requireValue(Number.isSafeInteger(asset.id) && asset.id > 0, "Invalid remote asset ID");
    const expected = remaining.get(asset.name);
    requireValue(expected && !ids.has(asset.id), "Unexpected or duplicate remote asset; no mutation allowed");
    requireValue(asset.state === "uploaded", `Remote asset is not uploaded: ${asset.name}`);
    requireValue(asset.size === expected.size && asset.digest === `sha256:${expected.sha256}`, `Remote asset size/digest mismatch: ${asset.name}`);
    ids.add(asset.id);
    remaining.delete(asset.name);
  }
  return [...remaining.values()];
}

// No automatic write retry: uncertain outcomes survive as remote state, and the same plan resumes.
// GitHub is the recovery journal. Never delete assets/releases or use --clobber.
export async function publishRelease({ plan, github, mode = "inspect", verifyPublic, onEvent = () => {} }) {
  requireValue(["inspect", "stage", "publish"].includes(mode), "mode must be inspect, stage or publish");
  await checkLocalAssets(plan);
  requireValue(await github.tagCommit(plan) === plan.commit, "Remote tag does not match the pinned commit");
  let release = await github.findRelease(plan);
  const validate = (value) => {
    requireValue(Number.isSafeInteger(value?.id) && value.id > 0 && value.tag_name === plan.version, "Release ID/tag mismatch");
    requireValue(value.prerelease === plan.prerelease, "Remote release channel mismatch");
    if (value.draft) requireValue(value.name === plan.version && value.body === plan.notes, "Existing draft metadata differs; explicit reconciliation required");
    return value;
  };
  const snapshot = async () => {
    const current = validate(await github.readRelease(plan, release.id));
    requireValue(current.id === release.id, "Release ID changed during readback");
    release = current;
    const assets = await github.listAssets(plan, release.id);
    return missingAssets(plan, assets);
  };
  const event = (phase, extra = {}) => onEvent({ phase, release_id: release?.id ?? null, version: plan.version, plan_digest: plan.digest, ...extra });
  event("preflight");
  if (!release) {
    if (mode === "inspect") return { state: "absent", missing: plan.assets.map((asset) => asset.name) };
    requireValue(mode === "stage", "Create and verify a draft with stage before publishing");
    release = validate(await github.createDraft(plan));
    requireValue(release.draft === true, "Creation must return a draft");
    event("draft_created");
  }
  validate(release);
  let missing = await snapshot();
  if (!release.draft) {
    requireValue(missing.length === 0, "Published release has missing assets; never modify it");
    requireValue(typeof verifyPublic === "function", "Public verification is required");
    await verifyPublic(plan);
    event("published_verified");
    return { state: "published_verified", release_id: release.id, changed: false };
  }
  if (mode === "inspect") return { state: "draft", release_id: release.id, missing: missing.map((asset) => asset.name) };
  if (mode === "stage") {
    const uploaded = new Set();
    while (missing.length > 0) {
      const asset = missing[0];
      await checkLocalAssets(plan);
      // Fresh draft and full inventory check before every side effect, including resume.
      missing = await snapshot();
      requireValue(release.draft, "Release was published concurrently; stop uploading");
      if (!missing.some((candidate) => candidate.name === asset.name)) continue;
      requireValue(!uploaded.has(asset.name), "A verified upload disappeared; stop instead of looping over concurrent changes");
      event("uploading", { asset: asset.name });
      await github.upload(plan, release.id, asset);
      uploaded.add(asset.name);
      missing = await snapshot();
      requireValue(!missing.some((candidate) => candidate.name === asset.name), `Upload readback missing: ${asset.name}`);
      event("uploaded", { asset: asset.name });
    }
    requireValue(release.draft, "Release was published concurrently; stop staging");
    event("draft_verified");
    return { state: "draft_verified", release_id: release.id, assets: plan.assets.length };
  }
  requireValue(missing.length === 0, "Draft is incomplete; stage missing assets before publishing");
  requireValue(typeof verifyPublic === "function", "Public verification is required before publish can begin");
  await checkLocalAssets(plan);
  requireValue(await github.tagCommit(plan) === plan.commit, "Remote tag drift before publish");
  missing = await snapshot();
  requireValue(release.draft && missing.length === 0, "Release changed before publish");
  event("publishing");
  await github.publish(plan, release.id);
  missing = await snapshot();
  requireValue(!release.draft && missing.length === 0, "Published release readback failed");
  await verifyPublic(plan);
  event("published_verified");
  return { state: "published_verified", release_id: release.id, changed: true };
}

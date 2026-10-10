import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createStrictZeroPlan } from "../../../packages/skill-runtime/src/plan.mjs";
import { authorizeJournal, createJournal } from "../../../packages/skill-runtime/src/journal.mjs";
import { writeFrozenWranglerConfig } from "../../../packages/skill-runtime/src/deployment-config.mjs";
import { treeDigest } from "../../../packages/skill-runtime/src/skill-update.mjs";
import { canonicalDigest, sha256Bytes } from "../../../packages/skill-runtime/src/utils.mjs";
import { generateReleaseMetadata } from "../../generate-release-metadata.mjs";

// 仅用于隔离初装验收；所有资源名、digest 和身份均为本地合成数据。
export async function createInitialDeploymentFixture(stateRoot, { schemaVersion = 31 } = {}) {
  const version = "1.12.0-isolated";
  const serviceBundleRoot = path.join(stateRoot, "service-releases", "versions", version, "service");
  const canonicalManifest = JSON.parse(await readFile(new URL("../../../migrations/manifest.json", import.meta.url), "utf8"));
  const manifest = { ...canonicalManifest, schema_version: schemaVersion, migrations: canonicalManifest.migrations.slice(0, schemaVersion) };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const entries = { "dist/index.js": "export default { fetch() { return new Response('isolated'); } };\n",
    "apps/web/dist/index.html": "<!doctype html><title>Isolated</title>\n",
    "contracts/openapi.json": JSON.stringify({ info: { version }, "x-cfkanban-service-version": "0.1.0" }),
    "contracts/service-api.json": JSON.stringify({ service_version: "0.1.0" }), "release/version.json": JSON.stringify({ version }),
    "migrations/manifest.json": manifestBytes,
    "wrangler.template.json": JSON.stringify({ compatibility_date: "2026-10-01", compatibility_flags: ["global_fetch_strictly_public"], assets: { binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: true } }),
    "wrangler-config-schema.json": "{}" };
  for (const name of ["migration-readback.sql", "migration-ledger.sql"]) entries[`release/deployment/${name}`] = await readFile(new URL(`../../../release/deployment/${name}`, import.meta.url));
  for (const migration of manifest.migrations) entries[`migrations/${migration.name}`] = await readFile(new URL(`../../../migrations/${migration.name}`, import.meta.url));
  for (const [relative, contents] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(serviceBundleRoot, relative)), { recursive: true, mode: 0o700 });
    await writeFile(path.join(serviceBundleRoot, relative), contents, { mode: 0o600 });
  }
  const artifactRoot = path.join(stateRoot, "isolated-artifacts");
  await mkdir(artifactRoot, { mode: 0o700 });
  const serviceArtifactPath = path.join(artifactRoot, "isolated-service.zip");
  const skillArtifactPath = path.join(artifactRoot, "isolated-skills.zip");
  await writeFile(serviceArtifactPath, "Isolated synthetic Service artifact: never install or publish\n", { mode: 0o600 });
  await writeFile(skillArtifactPath, "Isolated synthetic Skill artifact: never install or publish\n", { mode: 0o600 });
  const artifactSha256 = sha256Bytes(await readFile(serviceArtifactPath));
  const release = await generateReleaseMetadata({ outputDirectory: path.join(artifactRoot, "release"), canonicalBaseUrl: "https://publisher.invalid/",
    version, channel: "prerelease", skillBundlePath: skillArtifactPath, serviceBundlePath: serviceArtifactPath,
    nodeRange: ">=22.12.0 <27", wranglerRange: ">=4.127.1 <5", serviceApiRange: ">=0.1.0 <0.2.0", schemaVersion });
  await writeFile(path.join(path.dirname(serviceBundleRoot), ".cfkanban-release.json"), JSON.stringify({ schema_version: 1,
    kind: "service_deployment_bundle", version, artifact_sha256: artifactSha256, publisher: "https://publisher.invalid",
    source: release.manifest.artifacts.find(entry => entry.kind === "service_deployment_bundle").url, bundle_path: serviceBundleRoot, bundle_tree_digest: await treeDigest(serviceBundleRoot) }), { mode: 0o600 });
  const planInput = { taskId: "isolated-first-deployment", accountId: "isolated-account", ownerDisplayName: "IsolatedOwner",
    release: { manifest_version: version, manifest_sha256: release.pointer.manifest_sha256, service_bundle_version: version,
      service_bundle_sha256: artifactSha256, schema_version: schemaVersion },
    initialMigrations: { manifest_sha256: sha256Bytes(manifestBytes), ordered: manifest.migrations.map(({ sequence, name, sha256 }) => ({ sequence, name, sha256 })) } };
  const { plan } = createStrictZeroPlan(planInput);
  const operation = { stateRoot, instanceId: plan.target.instance_id, operationId: plan.operation_id, taskId: plan.task_id, plan };
  await createJournal(operation);
  await authorizeJournal({ ...operation, planDigest: canonicalDigest(plan) });
  const databaseId = randomUUID();
  const generated = await writeFrozenWranglerConfig({ ...operation, serviceBundleRoot, d1DatabaseId: databaseId });
  return { ...operation, serviceBundleRoot, databaseId, manifest, planInput, configPath: generated.wrangler_config_path,
    projectionPath: generated.migrations_path, releasePointerPath: release.pointerPath, manifestPath: release.manifestPath,
    releaseManifest: release.manifest, artifactFiles: { skill_bundle: skillArtifactPath, service_deployment_bundle: serviceArtifactPath } };
}

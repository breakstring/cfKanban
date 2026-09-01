import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Bytes } from "../packages/skill-runtime/src/utils.mjs";
import { validateReleaseManifest } from "../packages/skill-runtime/src/release.mjs";

function httpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return url;
}

export async function generateReleaseMetadata({
  outputDirectory,
  canonicalBaseUrl,
  version,
  skillBundlePath,
  serviceBundlePath,
  nodeRange,
  wranglerRange,
  serviceApiRange,
  schemaVersion,
}) {
  const base = httpsUrl(canonicalBaseUrl, "canonicalBaseUrl");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const output = path.resolve(outputDirectory);
  const artifactsDirectory = path.join(output, "artifacts");
  const manifestsDirectory = path.join(output, "manifests");
  await mkdir(artifactsDirectory, { recursive: true });
  await mkdir(manifestsDirectory, { recursive: true });
  const skillName = path.basename(skillBundlePath);
  const serviceName = path.basename(serviceBundlePath);
  const manifestName = `cfkanban-release-${version}.json`;
  const artifactOrigin = base.origin;
  const manifest = validateReleaseManifest({
    schema_version: 1,
    product: "cfkanban",
    publisher: { id: "cfkanban", canonical_origin: base.origin },
    release: { version, immutable: true },
    compatibility: {
      bootstrap_schema: 1,
      node: nodeRange,
      wrangler: wranglerRange,
      service_api: serviceApiRange,
      schema_version: schemaVersion,
    },
    artifacts: [
      {
        kind: "skill_bundle",
        version,
        url: new URL(`artifacts/${skillName}`, base).href,
        allowed_origins: [artifactOrigin],
        sha256: sha256Bytes(await readFile(skillBundlePath)),
      },
      {
        kind: "service_deployment_bundle",
        version,
        url: new URL(`artifacts/${serviceName}`, base).href,
        allowed_origins: [artifactOrigin],
        sha256: sha256Bytes(await readFile(serviceBundlePath)),
      },
    ],
    documents: {
      en: new URL("install.md", base).href,
      "zh-CN": new URL("install.zh-CN.md", base).href,
    },
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(manifestsDirectory, manifestName);
  await writeFile(manifestPath, manifestText, "utf8");
  const stable = {
    schema_version: 1,
    product: "cfkanban",
    publisher: { id: "cfkanban", canonical_origin: base.origin },
    channel: "stable",
    release_version: version,
    manifest_url: new URL(`manifests/${manifestName}`, base).href,
    manifest_sha256: sha256Bytes(Buffer.from(manifestText, "utf8")),
    documents: manifest.documents,
  };
  const stablePath = path.join(output, "stable.json");
  await writeFile(stablePath, `${JSON.stringify(stable, null, 2)}\n`, "utf8");
  await copyFile(skillBundlePath, path.join(artifactsDirectory, skillName));
  await copyFile(serviceBundlePath, path.join(artifactsDirectory, serviceName));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await copyFile(path.join(repoRoot, "release", "bootstrap", "install.md"), path.join(output, "install.md"));
  await copyFile(path.join(repoRoot, "release", "bootstrap", "install.zh-CN.md"), path.join(output, "install.zh-CN.md"));
  return { manifestPath, stablePath, manifest, stable };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [configPath] = process.argv.slice(2);
  if (!configPath) {
    process.stderr.write("Usage: node scripts/generate-release-metadata.mjs <config.json>\n");
    process.exitCode = 2;
  } else {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const result = await generateReleaseMetadata(config);
    process.stdout.write(`${JSON.stringify({ manifestPath: result.manifestPath, stablePath: result.stablePath }, null, 2)}\n`);
  }
}

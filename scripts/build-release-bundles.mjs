import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeDeterministicZip } from "./lib/deterministic-zip.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function copyEntries(entries, targetRoot) {
  for (const entry of entries) {
    const source = path.join(repoRoot, entry);
    const target = path.join(targetRoot, entry);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: false, force: true });
  }
}

export async function buildReleaseBundles({ outputDirectory, version }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("version must be strict semver without build metadata");
  const output = path.resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "cfkanban-release-"));
  try {
    const skillRoot = path.join(temporaryRoot, "skill-bundle");
    const serviceRoot = path.join(temporaryRoot, "service-bundle");
    await mkdir(skillRoot, { recursive: true });
    await mkdir(serviceRoot, { recursive: true });
    await copyEntries([
      ".codex-plugin/plugin.json",
      ".agents/plugins/marketplace.json",
      "skills",
      "packages/skill-runtime",
      "docs/skills/README.md",
      "docs/skills/README.zh-CN.md",
    ], skillRoot);
    const pluginManifestPath = path.join(skillRoot, ".codex-plugin", "plugin.json");
    const pluginManifest = JSON.parse(await readFile(pluginManifestPath, "utf8"));
    pluginManifest.version = version;
    await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, "utf8");
    await copyEntries([
      "apps/web/dist",
      "contracts/openapi.json",
      "migrations",
      "release/deployment",
      "wrangler.jsonc",
    ], serviceRoot);
    await mkdir(path.join(serviceRoot, "dist"), { recursive: true });
    await cp(path.join(repoRoot, "apps", "worker", "dist", "index.js"), path.join(serviceRoot, "dist", "index.js"));
    await cp(path.join(repoRoot, "apps", "worker", "dist", "index.js.map"), path.join(serviceRoot, "dist", "index.js.map"));
    const wranglerTemplateSource = path.join(serviceRoot, "wrangler.jsonc");
    const wranglerTemplate = JSON.parse(await readFile(wranglerTemplateSource, "utf8"));
    wranglerTemplate.$schema = "./wrangler-config-schema.json";
    wranglerTemplate.name = "cfkanban-template";
    wranglerTemplate.main = "./dist/index.js";
    wranglerTemplate.workers_dev = true;
    wranglerTemplate.assets.directory = "./apps/web/dist";
    wranglerTemplate.d1_databases[0].database_name = "cfkanban-template-d1";
    wranglerTemplate.d1_databases[0].database_id = "00000000-0000-4000-8000-000000000000";
    wranglerTemplate.d1_databases[0].migrations_dir = "./migrations";
    await writeFile(wranglerTemplateSource, `${JSON.stringify(wranglerTemplate, null, 2)}\n`, "utf8");
    await rename(wranglerTemplateSource, path.join(serviceRoot, "wrangler.template.json"));
    await cp(path.join(repoRoot, "node_modules", "wrangler", "config-schema.json"), path.join(serviceRoot, "wrangler-config-schema.json"));
    const skillPath = path.join(output, `cfkanban-skills-${version}.zip`);
    const servicePath = path.join(output, `cfkanban-service-${version}.zip`);
    const skill = await writeDeterministicZip({ root: skillRoot, outputPath: skillPath, prefix: `cfkanban-skills-${version}/` });
    const service = await writeDeterministicZip({ root: serviceRoot, outputPath: servicePath, prefix: `cfkanban-service-${version}/` });
    return { skill, service };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [outputDirectory, version] = process.argv.slice(2);
  if (!outputDirectory || !version) {
    process.stderr.write("Usage: node scripts/build-release-bundles.mjs <output-directory> <version>\n");
    process.exitCode = 2;
  } else {
    const result = await buildReleaseBundles({ outputDirectory, version });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

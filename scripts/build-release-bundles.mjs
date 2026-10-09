import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseBuild } from "./lib/release-version.mjs";
import { writeDeterministicZip } from "./lib/deterministic-zip.mjs";
import { verifyWebAssetManifest } from "./lib/web-asset-manifest.mjs";
import { verifyEmbeddedBuild } from "./lib/embedded-build.mjs";
import { buildDshPlugin } from "../packages/dsh-plugin/scripts/build.mjs";
import { verifyLocalRuntimeBuild } from "../packages/local-runtime/scripts/build.mjs";
import { verifyCliBuild } from "./lib/cli-build.mjs";
import { verifyMcpBuild } from "./lib/mcp-build.mjs";
import { generateBrandAssets } from "./generate-brand-assets.mjs";
import { buildAgentSkillsDiscovery, verifyAgentSkillsDiscovery } from "./lib/agent-skills-discovery.mjs";

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
  await generateBrandAssets({ check: true });
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("version must be strict semver without build metadata");
  await verifyReleaseBuild({ repositoryRoot: repoRoot, version });
  await verifyCliBuild({ outputDirectory: path.join(repoRoot, "packages/cli/dist"), version });
  await verifyMcpBuild({ outputDirectory: path.join(repoRoot, "packages/mcp/dist"), version });
  await verifyEmbeddedBuild({ outputDirectory: path.join(repoRoot, "apps/web/dist-embedded"), version });
  await verifyLocalRuntimeBuild({ outputDirectory: path.join(repoRoot, "packages/local-runtime/dist"), version });
  const webBudget = JSON.parse(await readFile(path.join(repoRoot, "scripts/web-performance-budget.json"), "utf8"));
  await verifyWebAssetManifest({ outputDirectory: path.join(repoRoot, "apps/web/dist"), budget: webBudget });
  const output = path.resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "cfkanban-release-"));
  try {
    const skillRoot = path.join(temporaryRoot, "skill-bundle");
    const serviceRoot = path.join(temporaryRoot, "service-bundle");
    await mkdir(skillRoot, { recursive: true });
    await mkdir(serviceRoot, { recursive: true });
    await copyEntries([
      "LICENSE",
      ".codex-plugin/plugin.json",
      ".agents/plugins/marketplace.json",
      "apps/web/src/assets/cfkanban-mark.png",
      "apps/web/src/assets/cfkanban-mark.svg",
      "apps/web/src/assets/cfkanban-mark-orange.svg",
      "skills",
      "packages/skill-runtime",
      "release/version.json",
      "docs/skills/README.md",
      "docs/skills/README.zh-CN.md",
    ], skillRoot);
    await cp(path.join(repoRoot, "packages/mcp/dist"), path.join(skillRoot, "mcp"), { recursive: true });
    await verifyMcpBuild({ outputDirectory: path.join(skillRoot, "mcp"), version });
    await cp(path.join(repoRoot, "packages/cli/dist"), path.join(skillRoot, "cli"), { recursive: true });
    await verifyCliBuild({ outputDirectory: path.join(skillRoot, "cli"), version });
    await cp(path.join(repoRoot, "packages/local-runtime/dist"), path.join(skillRoot, "local-runtime"), { recursive: true });
    await verifyLocalRuntimeBuild({ outputDirectory: path.join(skillRoot, "local-runtime"), version });
    await mkdir(path.join(skillRoot, "web-embedded"), { recursive: true });
    await cp(path.join(repoRoot, "apps/web/dist-embedded/embedded.html"), path.join(skillRoot, "web-embedded/embedded.html"));
    await cp(path.join(repoRoot, "apps/web/dist-embedded/embedded-build.json"), path.join(skillRoot, "web-embedded/embedded-build.json"));
    await verifyEmbeddedBuild({ outputDirectory: path.join(skillRoot, "web-embedded"), version });
    await buildDshPlugin({ outputDirectory: path.join(skillRoot, "dsh"), version });
    await copyEntries([
      "LICENSE",
      "apps/web/dist",
      "contracts/openapi.json",
      "contracts/service-api.json",
      "migrations",
      "release/deployment",
      "release/version.json",
      "wrangler.jsonc",
    ], serviceRoot);
    const skillDiscovery = await buildAgentSkillsDiscovery({
      skillBundleRoot: skillRoot,
      outputDirectory: path.join(serviceRoot, "apps/web/dist"),
      version,
    });
    await verifyWebAssetManifest({ outputDirectory: path.join(serviceRoot, "apps/web/dist"), budget: webBudget });
    await verifyAgentSkillsDiscovery({ outputDirectory: path.join(serviceRoot, "apps/web/dist"), version, skillBundleRoot: skillRoot });
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
    return { skill, service, skill_discovery: skillDiscovery };
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

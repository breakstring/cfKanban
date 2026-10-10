import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readReleaseVersion, writeBuildVersion } from "./lib/release-version.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = new URL("../apps/worker/dist/", import.meta.url);
const wranglerCli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

const version = await readReleaseVersion(repositoryRoot);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const result = spawnSync(process.execPath, [
  wranglerCli,
  "deploy",
  "--dry-run",
  "--config",
  "wrangler.jsonc",
  "--outdir",
  fileURLToPath(outputRoot),
  "--metafile",
  fileURLToPath(new URL("metafile.json", outputRoot)),
], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: fileURLToPath(new URL("../.wrangler/logs/", import.meta.url)),
    WRANGLER_SEND_METRICS: "false",
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const maintenanceEntry = "issue-trend-backfill.mjs";
await build({ absWorkingDir: repositoryRoot,
  entryPoints: [fileURLToPath(new URL("../apps/worker/src/maintenance/issue-trend-backfill.ts", import.meta.url))],
  outfile: fileURLToPath(new URL(maintenanceEntry, outputRoot)), bundle: true, platform: "node",
  target: "node22.12", format: "esm", minify: true, legalComments: "inline", logLevel: "silent" });
await writeFile(new URL("issue-trend-backfill-build.json", outputRoot), `${JSON.stringify({
  release_version: version, algorithm_version: 1, entry: maintenanceEntry,
  sha256: createHash("sha256").update(await readFile(new URL(maintenanceEntry, outputRoot))).digest("hex"),
}, null, 2)}\n`);
await writeBuildVersion({ repositoryRoot, outputDirectory: fileURLToPath(outputRoot), entry: "index.js", version });

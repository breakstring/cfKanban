import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = new URL("../apps/worker/dist/", import.meta.url);
const wranglerCli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

await mkdir(outputRoot, { recursive: true });

const result = spawnSync(process.execPath, [
  wranglerCli,
  "deploy",
  "--dry-run",
  "--config",
  "wrangler.jsonc",
  "--outfile",
  fileURLToPath(new URL("worker.js", outputRoot)),
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

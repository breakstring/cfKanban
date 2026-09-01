import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const validationRoot = await mkdtemp(join(tmpdir(), "cfkanban-d1-validation-"));
const wranglerCli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const environment = {
  ...process.env,
  WRANGLER_LOG_PATH: join(validationRoot, "wrangler-logs"),
};

function wrangler(args) {
  const result = spawnSync(process.execPath, [wranglerCli, ...args], {
    cwd: new URL("..", import.meta.url),
    env: environment,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`Wrangler command failed with status ${result.status}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function validateBatchWorker() {
  const port = await availablePort();
  const output = [];
  const child = spawn(process.execPath, [
    wranglerCli,
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--config",
    "wrangler.validation.jsonc",
    "--persist-to",
    validationRoot,
  ], {
    cwd: new URL("..", import.meta.url),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    let response;
    let lastError;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`wrangler dev exited early (${child.exitCode}): ${output.join("")}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/validate`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      response?.ok,
      `Wrangler validation Worker did not start: ${lastError ?? "no fetch error"}\n${output.join("")}`,
    );
    const result = await response.json();
    assert.deepEqual(result, {
      rejected: true,
      first_status: "done",
      second_status: "todo",
      comment_count: 1,
      failed_comment_count: 0,
      success_commit_count: 1,
      failed_commit_count: 0,
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    });
  }
}

try {
  wrangler([
    "d1",
    "migrations",
    "apply",
    "cfkanban-contract-validation",
    "--local",
    "--config",
    "wrangler.validation.jsonc",
    "--persist-to",
    validationRoot,
  ]);

  const output = wrangler([
    "d1",
    "execute",
    "cfkanban-contract-validation",
    "--local",
    "--config",
    "wrangler.validation.jsonc",
    "--persist-to",
    validationRoot,
    "--command",
    "SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', '_cf_METADATA');",
    "--json",
  ]);
  const json = output.match(/\[\s*\{[\s\S]*$/)?.[0];
  assert.ok(json, `Wrangler did not return JSON: ${output}`);
  const parsed = JSON.parse(json);
  const tableCount = parsed[0]?.results?.[0]?.table_count;
  assert.equal(tableCount, 25, "Wrangler D1 should contain 25 application tables");
  await validateBatchWorker();
  console.log("Wrangler local D1 applied 0001_initial.sql and returned the expected schema.");
  console.log("Wrangler env.DB.batch() committed the valid operation and rolled back the quota failure.");
} finally {
  await rm(validationRoot, { recursive: true, force: true });
}

import { readFile } from "node:fs/promises";

import {
  parseGeneratedMode,
  renderGeneratedJson,
  sha256NormalizedText,
  syncGeneratedFile,
} from "./lib/generated-artifacts.mjs";

const migrationUrl = new URL("../migrations/0001_initial.sql", import.meta.url);
const migration = await readFile(migrationUrl, "utf8");
const tables = [...migration.matchAll(/^CREATE TABLE ([a-z0-9_]+) \(/gm)].map((match) => match[1]);
const indexes = [...migration.matchAll(/^CREATE (?:UNIQUE )?INDEX ([a-z0-9_]+) ON/gm)].map((match) => match[1]);
const sha256 = sha256NormalizedText(migration);

const manifest = {
  manifest_version: 1,
  schema_version: 1,
  service_compatibility: {
    minimum: "0.1.0",
    maximum_exclusive: "0.2.0",
  },
  migrations: [
    {
      sequence: 1,
      name: "0001_initial.sql",
      sha256,
      classification: "bootstrap",
      destructive: false,
      reentry: "wrangler_migration_ledger_only",
      expected_artifacts: {
        tables,
        indexes,
      },
    },
  ],
};

const mode = parseGeneratedMode(process.argv.slice(2));
await syncGeneratedFile(
  new URL("../migrations/manifest.json", import.meta.url),
  renderGeneratedJson(manifest),
  { mode, regenerateCommand: "npm run migrations:generate" },
);
console.log(`${mode === "check" ? "Verified" : "Generated"} migrations/manifest.json for ${tables.length} tables and ${indexes.length} indexes.`);

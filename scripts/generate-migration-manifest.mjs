import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const migrationUrl = new URL("../migrations/0001_initial.sql", import.meta.url);
const migration = await readFile(migrationUrl, "utf8");
const tables = [...migration.matchAll(/^CREATE TABLE ([a-z0-9_]+) \(/gm)].map((match) => match[1]);
const indexes = [...migration.matchAll(/^CREATE (?:UNIQUE )?INDEX ([a-z0-9_]+) ON/gm)].map((match) => match[1]);
const sha256 = createHash("sha256").update(migration).digest("hex");

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

await writeFile(new URL("../migrations/manifest.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated migrations/manifest.json for ${tables.length} tables and ${indexes.length} indexes.`);

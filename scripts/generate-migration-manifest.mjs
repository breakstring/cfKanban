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
  schema_version: 5,
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
        // 读回核对当前 schema；0003 已移除这两个旧 key 索引，初始 SQL 指纹保持不变。
        indexes: indexes.filter((name) => !["idx_workspaces_key", "idx_projects_workspace_key"].includes(name)),
      },
    },
    {
      sequence: 2,
      name: "0002_container_purge.sql",
      sha256: sha256NormalizedText(await readFile(new URL("../migrations/0002_container_purge.sql", import.meta.url), "utf8")),
      classification: "backward_compatible",
      destructive: false,
      reentry: "wrangler_migration_ledger_only",
      expected_artifacts: {
        indexes: ["idx_workspaces_purge_state", "idx_projects_workspace_purge_state"],
      },
    },
    {
      sequence: 3,
      name: "0003_container_uuid.sql",
      sha256: sha256NormalizedText(await readFile(new URL("../migrations/0003_container_uuid.sql", import.meta.url), "utf8")),
      classification: "breaking_non_destructive",
      destructive: false,
      reentry: "wrangler_migration_ledger_only",
      expected_artifacts: {
        tables: ["workspaces", "projects", "public_join_policies", "browser_launches", "web_sessions", "cfkanban_migration_ledger"],
        absent_columns: ["workspaces.key", "projects.key", "public_join_policies.project_key"],
        indexes: ["idx_workspaces_purge_state", "idx_projects_workspace_purge_state", "idx_public_join_resume_enabled_workspace_project"],
      },
    },
    {
      sequence: 4,
      name: "0004_issue_attachments.sql",
      sha256: sha256NormalizedText(await readFile(new URL("../migrations/0004_issue_attachments.sql", import.meta.url), "utf8")),
      classification: "backward_compatible",
      destructive: false,
      reentry: "wrangler_migration_ledger_only",
      expected_artifacts: {
        tables: ["attachment_storage", "attachment_objects", "issue_attachments"],
        indexes: ["idx_attachment_objects_cleanup", "idx_attachment_objects_expiry", "idx_issue_attachments_issue_created"],
      },
    },
    {
      sequence: 5,
      name: "0005_attachment_schema_version.sql",
      sha256: sha256NormalizedText(await readFile(new URL("../migrations/0005_attachment_schema_version.sql", import.meta.url), "utf8")),
      classification: "backward_compatible",
      destructive: false,
      reentry: "wrangler_migration_ledger_only",
      expected_artifacts: {},
      expected_data: {
        instance_meta_schema_version_at_least: 5,
        allow_uninitialized: true,
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
console.log(`${mode === "check" ? "Verified" : "Generated"} migrations/manifest.json for ${manifest.migrations.length} ordered migrations.`);

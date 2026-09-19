import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const migration = async (name) => readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
test("usage migration preserves existing identity and attachment reservation", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const entry of manifest.migrations.filter((entry) => entry.sequence < 6)) db.exec(await migration(entry.name));
    db.prepare("INSERT INTO principals(id,display_name,created_at,updated_at) VALUES (?,?,?,?)").run("owner", "Owner", 1, 1);
    db.prepare("INSERT INTO instance_meta VALUES (1,?,?,?,?,?)").run("instance", "owner", "0.1.0", 5, 1);
    db.prepare("UPDATE attachment_storage SET reserved_bytes=? WHERE singleton=1").run(12345);
    db.exec(await migration("0006_usage_statistics.sql"));
    assert.deepEqual({ ...db.prepare("SELECT * FROM instance_meta").get() }, { singleton:1,instance_id:"instance",owner_principal_id:"owner",service_version:"0.1.0",schema_version:6,created_at:1 });
    assert.equal(db.prepare("SELECT reserved_bytes FROM attachment_storage").get().reserved_bytes, 12345);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_statistics").get().n, 1);
    assert.equal(db.prepare("SELECT metrics_json FROM usage_statistics").get().metrics_json, null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

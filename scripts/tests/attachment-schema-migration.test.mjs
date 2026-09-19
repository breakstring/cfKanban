import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { bootstrapInstance } from "../../apps/worker/src/services/bootstrap.ts";
import { sha256NormalizedText } from "../lib/generated-artifacts.mjs";

const manifest = JSON.parse(await readFile(new URL("../../migrations/manifest.json", import.meta.url), "utf8"));
const migration = async (name) => readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
const apply = async (db, name) => db.exec(`BEGIN;${await migration(name)}COMMIT;`);
const instance = (db) => ({ ...db.prepare("SELECT * FROM instance_meta").get() });
const identities = (db) => Object.fromEntries(
  ["principals", "credentials", "instance_origin_settings", "events", "operation_commits"]
    .map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
);

// 运行真实 bootstrap SQL 和原子 batch；不启动 Worker 或访问任何远端服务。
function sqliteD1(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      let bindings = {};
      return {
        bind(...values) {
          bindings = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
          return this;
        },
        async first() { return statement.get(bindings) ?? null; },
        run() { return statement.run(bindings); },
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function bootstrapInput(schemaVersion) {
  return {
    instanceId: randomUUID(),
    operationId: randomUUID(),
    ownerPrincipalId: randomUUID(),
    ownerCredentialId: randomUUID(),
    ownerCredentialToken: `cfk_v1_owner_${"A".repeat(43)}`,
    ownerDisplayName: "Migration test owner",
    preferredApiOrigin: "https://migration.example.test",
    serviceVersion: "0.1.0-alpha.55",
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  };
}

async function historicalDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0001_initial.sql", "0002_container_purge.sql", "0003_container_uuid.sql"]) {
    await apply(db, name);
  }
  return db;
}

test("attachment fix preserves all four published migration digests", async () => {
  const published = {
    "0001_initial.sql": "8552f2967b0d2b21889a3c7978f46e66d14e0d5da808dc189fe62ac3ac54e5ac",
    "0002_container_purge.sql": "20efa238e6394b2694164a257190e0c1c9fbf79944bc2b121aeb2c7d868bbac9",
    "0003_container_uuid.sql": "e947635c2dde77995eea4397291f3e7089578d9c5a91ba0499a364cbb8abd242",
    "0004_issue_attachments.sql": "cdb10909cfeb76c43822485e14a1036cb8a619f380f837bc3274f7a1559ca2f8",
  };
  for (const [name, digest] of Object.entries(published)) {
    assert.equal(sha256NormalizedText(await migration(name)), digest, name);
    assert.equal(manifest.migrations.find((entry) => entry.name === name).sha256, digest, name);
  }
  assert.ok(manifest.schema_version >= 5);
  assert.deepEqual(manifest.migrations.find((entry) => entry.sequence === 5).expected_data, {
    instance_meta_schema_version_at_least: 5,
    allow_uninitialized: true,
  });
});

for (const version of [3, 4]) {
  test(`attachment schema migration upgrades initialized schema ${version} without changing identity`, async () => {
    const db = await historicalDatabase();
    try {
      await bootstrapInstance(sqliteD1(db), bootstrapInput(version), 1234);
      const before = instance(db);
      const beforeIdentities = identities(db);
      await apply(db, "0004_issue_attachments.sql");
      assert.equal(instance(db).schema_version, version);
      const beforeSchema = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
      await apply(db, "0005_attachment_schema_version.sql");
      assert.deepEqual(instance(db), { ...before, schema_version: 5 });
      assert.deepEqual(identities(db), beforeIdentities);
      assert.deepEqual(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(), beforeSchema);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      await apply(db, "0005_attachment_schema_version.sql");
      assert.deepEqual(instance(db), { ...before, schema_version: 5 });
    } finally { db.close(); }
  });
}

test("empty database applies all migrations before the real bootstrap initializes the current schema", async () => {
  const db = await historicalDatabase();
  try {
    await apply(db, "0004_issue_attachments.sql");
    await apply(db, "0005_attachment_schema_version.sql");
    for (const entry of manifest.migrations.filter((entry) => entry.sequence > 5)) await apply(db, entry.name);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM instance_meta").get().count, 0);
    const input = bootstrapInput();
    const result = await bootstrapInstance(sqliteD1(db), input, 5678);
    assert.equal(result.schemaVersion, manifest.schema_version);
    assert.equal(result.instanceId, input.instanceId);
    assert.equal(result.ownerPrincipalId, input.ownerPrincipalId);
    assert.equal(instance(db).schema_version, manifest.schema_version);
    assert.deepEqual(await bootstrapInstance(sqliteD1(db), input, 5679), { ...result, recovered: true });
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); }
});

test("attachment schema repair never downgrades a future instance version", async () => {
  const db = await historicalDatabase();
  try {
    await apply(db, "0004_issue_attachments.sql");
    await bootstrapInstance(sqliteD1(db), bootstrapInput(6), 9012);
    const before = instance(db);
    await apply(db, "0005_attachment_schema_version.sql");
    assert.deepEqual(instance(db), before);
  } finally { db.close(); }
});

test("owner capacity migration preserves old reservations without inventing a choice", async () => {
  const db = await historicalDatabase();
  try {
    for (const entry of manifest.migrations.filter((entry) => entry.sequence >= 4 && entry.sequence <= 6)) await apply(db, entry.name);
    await bootstrapInstance(sqliteD1(db), bootstrapInput(6), 1234);
    db.prepare("UPDATE attachment_storage SET reserved_bytes=123").run();
    db.prepare("INSERT INTO attachment_objects(id,object_key,size_bytes,sha256,state,expires_at,created_at,created_operation_id) VALUES ('object','attachments/object',123,?,'pending',9999,1234,'operation')").run("a".repeat(64));
    const before=db.prepare("SELECT * FROM attachment_objects").all();
    await apply(db,"0007_attachment_settings.sql");
    assert.deepEqual({...db.prepare("SELECT * FROM attachment_storage").get()},{singleton:1,reserved_bytes:123,limit_bytes:null,limit_configured:0,version:1,last_operation_id:null});
    assert.deepEqual(db.prepare("SELECT * FROM attachment_objects").all(),before);
    assert.equal(instance(db).schema_version,7);
    for (const invalid of [0,-1,1.5,9007199254740992]) assert.throws(()=>db.prepare("UPDATE attachment_storage SET limit_bytes=?").run(invalid),/CHECK constraint/);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  } finally { db.close(); }
});

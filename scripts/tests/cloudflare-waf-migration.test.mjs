import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationsRoot = new URL("../../migrations/", import.meta.url), source = name => readFile(new URL(name, migrationsRoot), "utf8");
test("schema27保留schema26未知intent、幂等唯一键和plan，增加独立非秘密绑定/自有规则记录", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of (await readdir(migrationsRoot)).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 26).sort()) db.exec(await source(name));
    const principalId = randomUUID(), operationId = randomUUID(), planId = randomUUID();
    db.prepare("INSERT INTO principals(id,display_name,display_name_key,created_at,updated_at) VALUES(?, 'Waf_Owner','waf_owner',1,1)").run(principalId);
    db.prepare("INSERT INTO instance_meta VALUES(1,?,?,?,26,1)").run(randomUUID(), principalId, "1.10.0");
    db.prepare("INSERT INTO cloudflare_control_operations(id,principal_id,route,key_hash,request_hash,kind,status,baseline_json,desired_json,secret_value_hash,dispatched_at,result_version_id,deployment_id,failure_class,created_at,updated_at) VALUES(?,?, '/api/v1/admin/cloudflare/secrets',?,?,'configuration_secret','unknown','{}','{}',?,2,NULL,NULL,'unavailable',1,2)").run(operationId, principalId, "a".repeat(64), "b".repeat(64), "c".repeat(64));
    db.prepare("INSERT INTO cloudflare_control_plans VALUES(?,'configuration',1,'{}','{}','{}',1,?)").run(planId, operationId);
    const intent = { ...db.prepare("SELECT * FROM cloudflare_control_operations").get() }, plan = { ...db.prepare("SELECT * FROM cloudflare_control_plans").get() };
    db.exec(await source("0027_cloudflare-waf.sql"));
    assert.deepEqual({ ...db.prepare("SELECT * FROM cloudflare_control_operations").get() }, intent); assert.deepEqual({ ...db.prepare("SELECT * FROM cloudflare_control_plans").get() }, plan);
    assert.equal(db.prepare("SELECT schema_version FROM instance_meta").get().schema_version, 27); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cloudflare_waf_target_binding").get().n, 0); assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cloudflare_waf_ownership").get().n, 1);
    assert.throws(() => db.prepare("INSERT INTO cloudflare_control_operations SELECT ?,principal_id,route,key_hash,request_hash,kind,status,baseline_json,desired_json,secret_value_hash,dispatched_at,result_version_id,deployment_id,failure_class,created_at,updated_at FROM cloudflare_control_operations").run(randomUUID()), /UNIQUE/);
    db.prepare("UPDATE cloudflare_control_operations SET kind='waf' WHERE id=?").run(operationId); db.prepare("UPDATE cloudflare_control_plans SET kind='waf' WHERE id=?").run(planId); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => db.prepare("UPDATE cloudflare_waf_ownership SET rule_id='foreign' WHERE singleton=1").run(), /CHECK/);
  } finally { db.close(); }
});

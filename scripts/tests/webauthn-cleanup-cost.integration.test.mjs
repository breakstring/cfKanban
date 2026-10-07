import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { createWebAuthenticationOptions } from "../../apps/worker/src/services/passkeys.ts";

// 全零 D1 ID、临时 workerd 存储，不发起任何 Cloudflare 控制面或远端 D1 请求。
const server = createTestHarness({ root: fileURLToPath(new URL("../../", import.meta.url)), workers: [{ configPath: "wrangler.wp02-test.jsonc" }] });
const worker = server.getWorker();
let db;
before(async () => { await server.listen(); await worker.applyD1Migrations("DB"); ({ DB: db } = await worker.getEnv()); });
after(async () => { await server.close(); });

test("persistent challenge cleanup lease survives independent callers and performs zero row writes during cooldown", async () => {
  const now = Date.now(), calls = [];
  const tracked = () => ({
    prepare(sql) { const prepared = db.prepare(sql); return { bind(...values) { const bound = prepared.bind(...values); return { sql, bound, async run() { const result = await bound.run(); calls.push({ sql, meta: result.meta }); return result; } }; } }; },
    async batch(statements) { const result = await db.batch(statements.map(item => item.bound)); result.forEach((item, index) => calls.push({ sql: statements[index].sql, meta: item.meta })); return result; },
  });
  const request = new Request("https://cleanup.example.test/api/v1/web-authentication/options", { method: "POST" });
  await createWebAuthenticationOptions(tracked(), request, now);
  assert.equal(calls.filter(item => item.sql.startsWith("DELETE")).length, 2);
  calls.length = 0;
  await Promise.all(Array.from({ length: 4 }, () => createWebAuthenticationOptions(tracked(), request, now + 1000)));
  assert.equal(calls.filter(item => item.sql.startsWith("DELETE")).length, 0);
  const claims = calls.filter(item => item.sql.startsWith("UPDATE webauthn_cleanup_state"));
  assert.equal(claims.length, 4);
  assert.ok(claims.every(item => item.meta.rows_written === 0));
  assert.ok(claims.every(item => item.meta.rows_read <= 1));
  calls.length = 0;
  await createWebAuthenticationOptions(tracked(), request, now + 60_000);
  assert.equal(calls.filter(item => item.sql.startsWith("DELETE")).length, 2);
  console.log(JSON.stringify({ measurement: "local_workerd_only", cooldown_claim_rows_read: claims.map(item => item.meta.rows_read), cooldown_claim_rows_written: claims.map(item => item.meta.rows_written) }));
});

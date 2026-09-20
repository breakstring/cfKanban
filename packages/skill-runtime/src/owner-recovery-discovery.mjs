import { requireObservedPrincipalDisplayName } from "./principal-name.mjs";
import { validatePrivatePath } from "./state.mjs";
import path from "node:path";
import { createCloudflareControlClient } from "./cloudflare-control.mjs";
import { inspectOwnerRecovery } from "./owner-recovery.mjs";
import { toolError } from "./errors.mjs";
import { assertNoSymlinkPath, requireHttpsOrigin, requireString, requireUuid } from "./utils.mjs";

const MAX_WORKERS = 100;
const TABLES = ["instance_meta", "principals", "instance_origin_settings", "credentials"];
const TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?1, ?2, ?3, ?4) ORDER BY name";
const MARKER_SQL = `SELECT m.instance_id, m.owner_principal_id, m.service_version, m.schema_version,
 p.display_name, p.version AS principal_version, s.preferred_api_origin, s.version AS origin_version
 FROM instance_meta m JOIN principals p ON p.id = m.owner_principal_id
 JOIN instance_origin_settings s ON s.singleton = m.singleton WHERE m.singleton = 1 LIMIT 2`;
const options = { errorPrefix: "OWNER_RECOVERY_DISCOVERY", resourceLabel: "Owner recovery discovery" };
const invalid = () => { throw toolError("OWNER_RECOVERY_DISCOVERY_READBACK_INVALID", "Discovery returned invalid or ambiguous bounded metadata"); };

function workerName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,63}$/u.test(value)) invalid();
  return value;
}

async function query(client, databaseId, sql, params) {
  const result = await client(`/${databaseId}/query`, { method: "POST", body: { batch: [{ sql, params }] } });
  if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true || !Array.isArray(result[0].results)) invalid();
  return result[0].results;
}

export async function discoverOwnerRecoveryCandidates(input) {
  const accountId = requireString(input.accountId, "account_id", { max: 128 });
  if (!/^[A-Za-z0-9_-]+$/u.test(accountId)) invalid();
  if (!path.isAbsolute(input.wranglerExecutable ?? "")) throw toolError("ABSOLUTE_PATH_REQUIRED", "Wrangler must be an absolute executable path");
  if ((input.cloudflareProfile == null) === (input.contextDirectory == null)) throw toolError("OWNER_RECOVERY_AUTH_CONTEXT_REQUIRED", "Choose one exact profile or private context directory");
  if (input.contextDirectory != null && !path.isAbsolute(input.contextDirectory)) throw toolError("ABSOLUTE_PATH_REQUIRED", "Authentication context must be an absolute private directory");
  if (input.contextDirectory != null) {
    await assertNoSymlinkPath(input.contextDirectory, path.parse(input.contextDirectory).root);
    await validatePrivatePath(input.contextDirectory, "directory");
  }
  let names;
  if (input.workerNames !== undefined) {
    if (!Array.isArray(input.workerNames) || input.workerNames.length === 0 || input.workerNames.length > MAX_WORKERS) throw toolError("OWNER_RECOVERY_DISCOVERY_LIMIT", "Provide between one and 100 exact Worker names");
    names = input.workerNames.map(workerName);
    if (new Set(names).size !== names.length) invalid();
  }
  const workers = await createCloudflareControlClient(input, "/workers/scripts", options);
  if (names === undefined) {
    const listed = await workers("");
    if (!Array.isArray(listed)) invalid();
    if (listed.length > MAX_WORKERS) throw toolError("OWNER_RECOVERY_DISCOVERY_LIMIT", "Worker discovery exceeds 100 resources; explicitly narrow the Worker names");
    names = listed.map((entry) => workerName(entry?.id));
    if (new Set(names).size !== names.length) invalid();
  }
  const databases = await createCloudflareControlClient(input, "/d1/database", options);
  const candidates = [], unresolved = [];
  let excludedCount = 0;
  for (const name of names) {
    try {
      const settings = await workers(`/${name}/settings`);
      if (!Array.isArray(settings?.bindings) || settings.bindings.length > 256
        || settings.bindings.some((binding) => !binding || typeof binding.type !== "string" || typeof binding.name !== "string")) invalid();
      const bindings = settings.bindings.filter((binding) => binding.type === "d1");
      if (bindings.length > 1) throw toolError("OWNER_RECOVERY_DISCOVERY_AMBIGUOUS_DB", "Worker has multiple D1 bindings");
      if (bindings.length === 0 || bindings[0].name !== "DB") { excludedCount++; continue; }
      const databaseId = requireUuid(bindings[0].id ?? bindings[0].database_id, "database_id");
      const database = await databases(`/${databaseId}`);
      if (database?.uuid !== databaseId) invalid();
      const d1Name = requireString(database.name, "d1_name", { max: 64 });
      const tables = await query(databases, databaseId, TABLE_SQL, TABLES);
      if (tables.length > TABLES.length || tables.some((row) => !TABLES.includes(row?.name)) || new Set(tables.map(row => row.name)).size !== tables.length) invalid();
      if (!tables.some((row) => row.name === "instance_meta")) { excludedCount++; continue; }
      if (tables.length !== TABLES.length) throw toolError("OWNER_RECOVERY_DISCOVERY_INCOMPLETE_SCHEMA", "An instance marker table exists but the recovery schema is incomplete");
      const rows = await query(databases, databaseId, MARKER_SQL, []);
      if (rows.length !== 1) invalid();
      const row = rows[0];
      const instanceId = requireUuid(row.instance_id, "instance_id");
      const owner = requireUuid(row.owner_principal_id, "owner_principal_id");
      const displayName = requireObservedPrincipalDisplayName(row.display_name);
      requireString(row.service_version, "service_version", { max: 128 });
      if (![row.schema_version, row.principal_version, row.origin_version].every(value => Number.isSafeInteger(value) && value > 0) || row.schema_version > 10) invalid();
      const apiOrigin = requireHttpsOrigin(row.preferred_api_origin);
      const target = { accountId, workerName: name, d1Name, databaseId, apiOrigin, instanceId };
      const verified = await inspectOwnerRecovery({ ...input, ...target });
      if (verified.observed.owner_principal_id !== owner || verified.observed.display_name !== displayName
        || verified.observed.origin_version !== row.origin_version || verified.observed.principal_version !== row.principal_version
        || verified.observed.service_version !== row.service_version || verified.observed.schema_version !== row.schema_version) invalid();
      candidates.push({ target, owner_principal_id: owner, display_name: displayName });
    } catch (error) {
      const reason = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.code)
        ? error.code : "OWNER_RECOVERY_DISCOVERY_UNRESOLVED";
      unresolved.push({ worker_name: name, reason });
    }
  }
  return {
    status: candidates.length > 1 ? "selection_required" : unresolved.length > 0 ? "incomplete" : candidates.length === 1 ? "single_candidate" : "no_candidates",
    candidates, excluded_count: excludedCount, unresolved, secret_values_exposed: false,
  };
}

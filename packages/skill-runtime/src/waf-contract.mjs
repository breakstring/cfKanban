const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nullableText = value => value === null || typeof value === "string";
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));

export function isWafOperationResource(value) {
  return record(value) && value.kind === "waf" && typeof value.operation_id === "string" && uuid.test(value.operation_id)
    && ["pending", "unknown", "verified", "failed"].includes(value.status) && Number.isSafeInteger(value.version) && value.version >= 1
    && value.baseline_version_id === null && value.result_version_id === null && value.deployment_id === null
    && nullableText(value.result_rule_id) && nullableText(value.failure_class)
    && (value.failure_class === null || value.failure_class.length <= 128)
    && timestamp(value.created_at) && timestamp(value.updated_at);
}

export function isWafOperationWrite(value) {
  return record(value) && isWafOperationResource(value.resource) && typeof value.event_cursor === "string" && typeof value.idempotent_replay === "boolean";
}

export function isLegacyWafDisablePlan(value) {
  const owned = value?.before?.owned_rule, after = value?.after;
  return value?.kind === "waf" && record(owned) && typeof owned.id === "string" && owned.id.length > 0
    && typeof owned.ruleset_id === "string" && owned.ruleset_id.length > 0
    && after?.action === "disable" && after.entrypoint_strategy === "delete_owned_rule" && after.apply_ready === true
    && after.purchase_or_upgrade_plan === false && after.modifies_foreign_rules === false;
}

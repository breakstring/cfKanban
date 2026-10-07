export type WafCapability = "missing" | "unverified" | "verified" | "permission_denied" | "unavailable" | "target_mismatch" | "unsupported_contract";
export type WafConflictChoice = "preserve_exemptions" | "before_conflicts";
export interface WafConflict {
  rule_id: string | null; ruleset_id: string | null;
  kind: "skip" | "unowned_duplicate" | "expression_unverified" | "ip_access_allow" | "ip_access_unverified";
  repositionable: boolean;
  scope?: "zone" | "account";
}
export interface WafRule { id: string; enabled: boolean; action: string; expression: string; ref?: string; description?: string }
export interface WafView {
  status: WafCapability; zone_id: string | null; hostname: string; owned_rule: WafRule | null;
  other_rule_count: number | null; protected: boolean; version?: number; reason?: string;
  target_binding?: { status: WafCapability; source: string | null; domain_id: string | null; verified_at: string | null; live_verified?: boolean; service_proof?: boolean };
  ownership?: { status: string; ruleset_id: string | null; rule_id: string | null };
  entrypoint?: { strategy: string; id: string | null };
  inventory?: { complete: boolean; ruleset_count: number; total_rule_count: number; free_rule_limit: number; capacity_available: boolean };
  conflicts?: WafConflict[];
  coverage?: { status: string; workers_dev: boolean | null; previews_enabled: boolean | null };
}
export interface WafPlan {
  plan_id: string; kind: "waf"; version: number;
  baseline_version_id: string | null; baseline_deployment_id: string | null;
  target: { account_id: string; worker_name: string; database_id: string; hostname: string; zone_id: string; domain_id: string; instance_id: string };
  before: Record<string, unknown>;
  after: {
    action: "enable" | "disable"; profile: string;
    entrypoint_strategy: "none" | "append_rule" | "create_entrypoint" | "delete_owned_rule" | "reposition_owned_rule";
    entrypoint_id: string | null; position_before: string | null; conflict_choice: WafConflictChoice | null;
    conflicts: WafConflict[]; apply_ready: boolean; coverage: Record<string, unknown>;
    rule: Record<string, unknown>; purchase_or_upgrade_plan: false; modifies_foreign_rules: false;
  };
  created_at: string;
}
export interface WafOperation {
  operation_id: string; kind: "waf"; status: "pending" | "verified" | "failed" | "unknown"; version: number;
  baseline_version_id: string | null; result_version_id: string | null; deployment_id: string | null;
  result_rule_id?: string | null; failure_class: string | null; created_at: string; updated_at: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const capabilities = new Set(["missing", "unverified", "verified", "permission_denied", "unavailable", "target_mismatch", "unsupported_contract"]);
const strategies = new Set(["none", "append_rule", "create_entrypoint", "delete_owned_rule", "reposition_owned_rule"]);
const conflicts = new Set(["skip", "unowned_duplicate", "expression_unverified", "ip_access_allow", "ip_access_unverified"]);
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nullableText(value: unknown): boolean { return value === null || typeof value === "string"; }
function version(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 1; }
function date(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
export function isWafConflicts(value: unknown): value is WafConflict[] {
  return Array.isArray(value) && value.length <= 6000 && value.every(item => record(item)
    && nullableText(item.rule_id) && nullableText(item.ruleset_id) && conflicts.has(String(item.kind)) && typeof item.repositionable === "boolean"
    && (item.scope === undefined || ["zone", "account"].includes(String(item.scope))));
}
export function isWafView(value: unknown): value is WafView {
  if (!record(value) || !capabilities.has(String(value.status)) || !nullableText(value.zone_id) || typeof value.hostname !== "string"
    || typeof value.protected !== "boolean" || (value.other_rule_count !== null && (!Number.isSafeInteger(value.other_rule_count) || (value.other_rule_count as number) < 0))) return false;
  const rule = value.owned_rule;
  if (rule !== null && (!record(rule) || !["id", "action", "expression"].every(key => typeof rule[key] === "string") || typeof rule.enabled !== "boolean")) return false;
  if (value.version === undefined) return ["target_binding", "ownership", "entrypoint", "inventory", "conflicts", "coverage"].every(key => value[key] === undefined);
  if (value.protected && (!record(rule) || value.status !== "verified" || !record(value.target_binding) || value.target_binding.status !== "verified"
    || !record(value.ownership) || value.ownership.status !== "verified" || value.ownership.rule_id !== rule.id || !record(value.coverage)
    || value.coverage.status !== "hostname_only" || value.coverage.workers_dev !== false || value.coverage.previews_enabled !== false
    || !Array.isArray(value.conflicts) || value.conflicts.length !== 0)) return false;
  return version(value.version) && record(value.target_binding) && capabilities.has(String(value.target_binding.status))
    && [value.target_binding.source, value.target_binding.domain_id, value.target_binding.verified_at].every(nullableText)
    && [value.target_binding.live_verified, value.target_binding.service_proof].every(item => item === undefined || typeof item === "boolean")
    && record(value.ownership) && typeof value.ownership.status === "string" && nullableText(value.ownership.rule_id) && nullableText(value.ownership.ruleset_id)
    && record(value.entrypoint) && typeof value.entrypoint.strategy === "string" && nullableText(value.entrypoint.id)
    && record(value.inventory) && typeof value.inventory.complete === "boolean" && typeof value.inventory.capacity_available === "boolean"
    && [value.inventory.ruleset_count, value.inventory.total_rule_count, value.inventory.free_rule_limit].every(item => Number.isSafeInteger(item) && (item as number) >= 0)
    && isWafConflicts(value.conflicts) && record(value.coverage) && typeof value.coverage.status === "string"
    && [value.coverage.workers_dev, value.coverage.previews_enabled].every(item => item === null || typeof item === "boolean");
}
export function isWafPlan(value: unknown): value is WafPlan {
  if (!record(value)) return false;
  const target = value.target;
  return record(value) && value.kind === "waf" && typeof value.plan_id === "string" && uuid.test(value.plan_id) && version(value.version)
    && nullableText(value.baseline_version_id) && nullableText(value.baseline_deployment_id)
    && record(target) && ["account_id", "worker_name", "database_id", "hostname", "zone_id", "domain_id", "instance_id"].every(key => typeof target[key] === "string")
    && record(value.before) && record(value.after) && ["enable", "disable"].includes(String(value.after.action))
    && strategies.has(String(value.after.entrypoint_strategy)) && nullableText(value.after.entrypoint_id) && nullableText(value.after.position_before)
    && [null, "preserve_exemptions", "before_conflicts"].includes(value.after.conflict_choice as string | null)
    && isWafConflicts(value.after.conflicts) && typeof value.after.apply_ready === "boolean" && record(value.after.coverage) && record(value.after.rule)
    && value.after.purchase_or_upgrade_plan === false && value.after.modifies_foreign_rules === false && date(value.created_at);
}
export function isWafOperation(value: unknown): value is WafOperation {
  return record(value) && value.kind === "waf" && typeof value.operation_id === "string" && uuid.test(value.operation_id)
    && ["pending", "verified", "failed", "unknown"].includes(String(value.status)) && version(value.version)
    && value.baseline_version_id === null && value.result_version_id === null && value.deployment_id === null && nullableText(value.failure_class)
    && nullableText(value.result_rule_id) && date(value.created_at) && date(value.updated_at);
}
export function isWafWrite(value: unknown, validate: (value: unknown) => boolean): boolean {
  return record(value) && validate(value.resource) && typeof value.event_cursor === "string" && typeof value.idempotent_replay === "boolean";
}

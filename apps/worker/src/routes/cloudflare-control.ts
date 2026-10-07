import { answerWafTargetProof, applyWaf, getWafOperationByKey, planWaf, registerWafTargetBinding } from "../services/cloudflare-waf.ts";
import { requireVersion } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { requireOwnerControl } from "../kernel/authorization.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { validationError } from "../kernel/errors.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforceInstanceRateLimit, enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import type { WorkerEnv } from "../kernel/types.ts";
import { applyCloudflarePlan, getCloudflareControl, getCloudflareNotifications, getCloudflareOperation, getCloudflarePlan, getCloudflareSecretOperation, getCloudflareWaf, planCloudflareConfiguration, planCloudflareRateLimits, saveCloudflareSecret, updateCloudflareSettings, verifyCloudflareControl, verifyCloudflareOperation, type CloudflareControlDependencies } from "../services/cloudflare-control.ts";

export function registerCloudflareControlRoutes(router: Router, dependencies: CloudflareControlDependencies = {}): void {
  router.post("/.well-known/cfkanban-waf-proof", async (request, env, context) => {
    await enforceInstanceRateLimit(env);
    const challenge = validateJsonObject(await readJsonBody(request), { allowedKeys: ["nonce", "expires_at", "target"], requiredKeys: ["nonce", "expires_at", "target"] });
    return jsonResponse(await answerWafTargetProof(env, request, challenge), context.requestId);
  });
  const base = "/api/v1/admin/cloudflare";
  const authenticate = async (request: Request, env: WorkerEnv, now: number, write = false) => {
    const auth = await authenticateRequest(env.DB, request, now); requireOwnerControl(auth);
    await enforcePrincipalRateLimit(env, auth); if (write) enforceCookieWriteProtection(request, auth); return auth;
  };
  router.get(base, async (request, env, context) => jsonResponse(await getCloudflareControl(env, await authenticate(request, env, context.startedAt)), context.requestId));
  router.get(`${base}/notifications`, async (request, env, context) => jsonResponse(await getCloudflareNotifications(env, await authenticate(request, env, context.startedAt), dependencies), context.requestId));
  router.get(`${base}/waf`, async (request, env, context) => jsonResponse(await getCloudflareWaf(env, await authenticate(request, env, context.startedAt), dependencies), context.requestId));
  router.get(`${base}/waf/operations/{request_key}`, async (request, env, context) => jsonResponse(await getWafOperationByKey(env, await authenticate(request, env, context.startedAt), context.params.request_key ?? ""), context.requestId));
  router.post(`${base}/waf/target-binding`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true), body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["expected_version"], requiredKeys: ["expected_version"] });
    return jsonResponse(await registerWafTargetBinding(env, request, auth, requireVersion(body.expected_version ?? null), context.startedAt, dependencies), context.requestId);
  });
  router.post(`${base}/waf/plan`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true), body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["action", "conflict_choice", "expected_version"], requiredKeys: ["action", "expected_version"] });
    return jsonResponse(await planWaf(env, request, auth, body.action ?? null, body.conflict_choice, requireVersion(body.expected_version ?? null), context.startedAt, dependencies), context.requestId);
  });
  router.post(`${base}/waf/apply`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true), body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["plan_id", "expected_version"], requiredKeys: ["plan_id", "expected_version"] });
    return jsonResponse(await applyWaf(env, request, auth, body.plan_id ?? null, requireVersion(body.expected_version ?? null), context.startedAt, dependencies), context.requestId);
  });
  router.get(`${base}/operations/{operation_id}`, async (request, env, context) => jsonResponse(await getCloudflareOperation(env, await authenticate(request, env, context.startedAt), context.params.operation_id ?? ""), context.requestId));
  router.get(`${base}/secret-operations/{request_key}`, async (request, env, context) => jsonResponse(await getCloudflareSecretOperation(env, await authenticate(request, env, context.startedAt), context.params.request_key ?? ""), context.requestId));
  router.get(`${base}/plans/{plan_id}`, async (request, env, context) => jsonResponse(await getCloudflarePlan(env, await authenticate(request, env, context.startedAt), context.params.plan_id ?? ""), context.requestId));
  router.post(`${base}/verify`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true), body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["include_optional"] });
    if (body.include_optional !== undefined && typeof body.include_optional !== "boolean") throw validationError("invalid_cloudflare_verification_options");
    return jsonResponse(await verifyCloudflareControl(env, request, auth, context.startedAt, dependencies, body.include_optional === true), context.requestId);
  });
  router.patch(`${base}/settings`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true), body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["zone_id", "expected_version"], requiredKeys: ["zone_id", "expected_version"] });
    return jsonResponse(await updateCloudflareSettings(env, request, auth, body.zone_id ?? null, requireVersion(body.expected_version ?? null), context.startedAt), context.requestId);
  });
  router.post(`${base}/secrets`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true), body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["kind", "token", "expected_version"], requiredKeys: ["kind", "token", "expected_version"] });
    return jsonResponse(await saveCloudflareSecret(env, request, auth, body.kind ?? null, body.token ?? null, requireVersion(body.expected_version ?? null), context.startedAt, dependencies), context.requestId);
  });
  router.post(`${base}/operations/{operation_id}/verify`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true); validateJsonObject(await readJsonBody(request), { allowedKeys: [] });
    return jsonResponse(await verifyCloudflareOperation(env, request, auth, context.params.operation_id ?? "", context.startedAt, dependencies), context.requestId);
  });
  router.post(`${base}/rate-limits/plan`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true), body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["scope", "limit", "period_seconds", "expected_version"], requiredKeys: ["scope", "limit", "period_seconds", "expected_version"] });
    return jsonResponse(await planCloudflareRateLimits(env, request, auth, body.scope ?? null, body.limit ?? null, body.period_seconds ?? null, requireVersion(body.expected_version ?? null), context.startedAt, dependencies), context.requestId);
  });
  router.post(`${base}/configuration/plan`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true), body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["settings", "expected_version"], requiredKeys: ["settings", "expected_version"] });
    return jsonResponse(await planCloudflareConfiguration(env, request, auth, body.settings ?? null, requireVersion(body.expected_version ?? null), context.startedAt, dependencies), context.requestId);
  });
  for (const [path, kind] of [["rate-limits", "rate_limit"], ["configuration", "configuration"]] as const) router.post(`${base}/${path}/apply`, async (request, env, context) => {
    const auth = await authenticate(request, env, context.startedAt, true), body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["plan_id", "expected_version"], requiredKeys: ["plan_id", "expected_version"] });
    return jsonResponse(await applyCloudflarePlan(env, request, auth, kind, body.plan_id ?? null, requireVersion(body.expected_version ?? null), context.startedAt, dependencies), context.requestId);
  });
}

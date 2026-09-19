import { requireVersion } from "../domain/model.ts";
import { getAttachmentSettings, updateAttachmentSettings } from "../services/attachment-settings.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { validationError } from "../kernel/errors.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import { readUsage, refreshUsage } from "../services/usage.ts";

export function registerUsageRoutes(router: Router): Router {
  return router.get("/api/v1/admin/usage", async (request, env, context) => {
    const auth = await authenticateRequest(env.DB, request, context.startedAt);
    await enforcePrincipalRateLimit(env, auth);
    return jsonResponse(await readUsage(env, auth, context.startedAt), context.requestId);
  }).post("/api/v1/admin/usage/refresh", async (request, env, context) => {
    const auth = await authenticateRequest(env.DB, request, context.startedAt);
    await enforcePrincipalRateLimit(env, auth);
    enforceCookieWriteProtection(request, auth);
    const body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["mode"], requiredKeys: ["mode"] });
    if (body.mode !== "stale" && body.mode !== "manual") throw validationError("invalid_usage_refresh_mode");
    return jsonResponse(await refreshUsage(env, auth, body.mode, context.startedAt), context.requestId);
  }).get("/api/v1/admin/attachment-settings", async (request, env, context) => {
    const auth = await authenticateRequest(env.DB, request, context.startedAt);
    await enforcePrincipalRateLimit(env, auth);
    return jsonResponse(await getAttachmentSettings(env, auth), context.requestId);
  }).patch("/api/v1/admin/attachment-settings", async (request, env, context) => {
    const auth = await authenticateRequest(env.DB, request, context.startedAt);
    await enforcePrincipalRateLimit(env, auth);
    enforceCookieWriteProtection(request, auth);
    const body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["expected_version", "limit_bytes"], requiredKeys: ["expected_version", "limit_bytes"] });
    return jsonResponse(await updateAttachmentSettings(env, request, auth, body.limit_bytes ?? null, requireVersion(body.expected_version ?? null), context.startedAt), context.requestId);
  });
}

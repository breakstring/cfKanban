import { requireVersion } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import { getHomepageSettings, updateHomepageSettings } from "../services/homepage-settings.ts";

export function registerHomepageSettingsRoutes(router: Router): void {
  router.get("/api/v1/admin/homepage-settings", async (request, env, context) => {
    const auth = await authenticateRequest(env.DB, request, context.startedAt);
    await enforcePrincipalRateLimit(env, auth);
    return jsonResponse(await getHomepageSettings(env, auth), context.requestId);
  }).patch("/api/v1/admin/homepage-settings", async (request, env, context) => {
    const auth = await authenticateRequest(env.DB, request, context.startedAt);
    await enforcePrincipalRateLimit(env, auth);
    enforceCookieWriteProtection(request, auth);
    const body = validateJsonObject(await readJsonBody(request), {
      allowedKeys: ["expected_version", "notice_en", "notice_zh_cn"],
      requiredKeys: ["expected_version", "notice_en", "notice_zh_cn"],
    });
    return jsonResponse(await updateHomepageSettings(env, request, auth, body.notice_en ?? null, body.notice_zh_cn ?? null, requireVersion(body.expected_version ?? null), context.startedAt), context.requestId);
  });
}

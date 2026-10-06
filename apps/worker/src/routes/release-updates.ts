import { authenticateRequest } from "../kernel/auth.ts";
import { jsonResponse } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import { getReleaseUpdates } from "../services/release-updates.ts";

export function registerReleaseUpdatesRoutes(router: Router): void {
  router.get("/api/v1/admin/release-updates", async (request, env, context) => {
    const auth = await authenticateRequest(env.DB, request, context.startedAt);
    await enforcePrincipalRateLimit(env, auth);
    return jsonResponse(await getReleaseUpdates(env, request, auth), context.requestId);
  });
}

import { authenticateRequest } from "../kernel/auth.ts";
import { jsonResponse } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import { getSearchIndexChanges, getSearchIndexSnapshot, getSearchIndexStatus, searchIndexRead } from "../services/search-index.ts";

export function registerSearchIndexRoutes(router: Router): Router {
  for (const [path, read] of [
    ["status", getSearchIndexStatus], ["snapshot", getSearchIndexSnapshot], ["changes", getSearchIndexChanges],
  ] as const) {
    router.get(`/api/v1/search-index/${path}`, async (request, env, context) => {
      const auth = await authenticateRequest(env.DB, request, context.startedAt);
      await enforcePrincipalRateLimit(env, auth);
      return jsonResponse(await searchIndexRead(() => read(env.DB, auth, context.url, context.startedAt)),
        context.requestId, { headers: { "cache-control": "no-store" } });
    });
  }
  return router;
}

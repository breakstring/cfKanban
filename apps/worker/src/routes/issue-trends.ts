import { authenticateRequest } from "../kernel/auth.ts";
import { jsonResponse } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import { getProjectIssueTrends, getWorkspaceIssueTrends } from "../services/issue-trends.ts";

export function registerIssueTrendRoutes(router: Router): void {
  router.get("/api/v1/workspaces/{workspace_id}/projects/{project_id}/issues/trends", async (request, env, context) => {
    const auth = await authenticateRequest(env.DB, request, context.startedAt);
    await enforcePrincipalRateLimit(env, auth);
    return jsonResponse(await getProjectIssueTrends(env.DB, auth, context.params.workspace_id ?? "", context.params.project_id ?? "",
      context.url, context.startedAt), context.requestId);
  }).get("/api/v1/workspaces/{workspace_id}/issues/trends", async (request, env, context) => {
    const auth = await authenticateRequest(env.DB, request, context.startedAt);
    await enforcePrincipalRateLimit(env, auth);
    return jsonResponse(await getWorkspaceIssueTrends(env.DB, auth, context.params.workspace_id ?? "", context.url, context.startedAt), context.requestId);
  });
}

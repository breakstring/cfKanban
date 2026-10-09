import { requireVersion } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import type { RequestContext, WorkerEnv } from "../kernel/types.ts";
import { createMilestone, getMilestone, listMilestones, updateMilestone } from "../services/milestones.ts";

async function authenticated(request: Request, env: WorkerEnv, context: RequestContext, write = false) {
  const auth = await authenticateRequest(env.DB, request, context.startedAt);
  await enforcePrincipalRateLimit(env, auth);
  if (write) enforceCookieWriteProtection(request, auth);
  return auth;
}

export function registerMilestoneRoutes(router: Router): void {
  router
    .get("/api/v1/workspaces/{workspace_id}/projects/{project_id}/milestones", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listMilestones(env.DB, auth, context.params.workspace_id ?? "",
        context.params.project_id ?? "", context.url, context.startedAt), context.requestId);
    })
    .post("/api/v1/workspaces/{workspace_id}/projects/{project_id}/milestones", async (request, env, context) => {
      const auth = await authenticated(request, env, context, true);
      const value = validateJsonObject(await readJsonBody(request), {
        allowedKeys: ["title", "description", "due_date", "status_key"], requiredKeys: ["title"],
      });
      return jsonResponse(await createMilestone(env.DB, request, auth, context.params.workspace_id ?? "",
        context.params.project_id ?? "", value, context.startedAt), context.requestId);
    })
    .get("/api/v1/milestones/{milestone_id}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getMilestone(env.DB, auth, context.params.milestone_id ?? "", context.startedAt), context.requestId);
    })
    .patch("/api/v1/milestones/{milestone_id}", async (request, env, context) => {
      const auth = await authenticated(request, env, context, true);
      const value = validateJsonObject(await readJsonBody(request), {
        allowedKeys: ["title", "description", "due_date", "status_key", "expected_version"], requiredKeys: ["expected_version"],
      });
      return jsonResponse(await updateMilestone(env.DB, auth, context.params.milestone_id ?? "", value,
        requireVersion(value.expected_version ?? null), context.startedAt), context.requestId);
    });
}

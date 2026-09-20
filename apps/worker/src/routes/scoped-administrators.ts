import { requireUuid } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { validationError } from "../kernel/errors.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import type { RequestContext, WorkerEnv } from "../kernel/types.ts";
import { changeAdministrator, listAdministratorCandidates, listAdministrators, listProjectMemberCandidates, listProjectMembers } from "../services/scoped-administrators.ts";

function scope(context: RequestContext) {
  const workspaceId = requireUuid(context.params.workspace_id ?? "", "workspace_id");
  return { workspaceId, ...(context.params.project_id === undefined ? {} : {
    projectId: requireUuid(context.params.project_id, "project_id"),
  }) };
}

async function authenticated(request: Request, env: WorkerEnv, context: RequestContext) {
  const auth = await authenticateRequest(env.DB, request, context.startedAt);
  await enforcePrincipalRateLimit(env, auth);
  return auth;
}

export function registerScopedAdministratorRoutes(router: Router): Router {
  for (const base of ["/api/v1/workspaces/{workspace_id}", "/api/v1/workspaces/{workspace_id}/projects/{project_id}"]) {
    router.get(`${base}/administrator-candidates`, async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listAdministratorCandidates(env.DB, auth, scope(context), context.url, context.startedAt), context.requestId);
    });
    router.get(`${base}/administrators`, async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listAdministrators(env.DB, auth, scope(context), context.url, context.startedAt), context.requestId);
    });
    router.post(`${base}/administrators`, async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const body = validateJsonObject(await readJsonBody(request), {
        allowedKeys: ["principal_id", "expected_version"], requiredKeys: ["principal_id", "expected_version"],
      });
      if (typeof body.expected_version !== "number") throw validationError("invalid_expected_version");
      return jsonResponse(await changeAdministrator(env.DB, request, auth, scope(context), {
        principalId: requireUuid(body.principal_id ?? null, "principal_id"), expectedVersion: body.expected_version,
      }, context.startedAt), context.requestId);
    });
    router.delete(`${base}/administrators/{administrator_id}`, async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const version = context.url.searchParams.get("expected_version");
      if (version === null || !/^[1-9][0-9]*$/.test(version)) throw validationError("invalid_expected_version");
      return jsonResponse(await changeAdministrator(env.DB, request, auth, scope(context), {
        administratorId: requireUuid(context.params.administrator_id ?? "", "administrator_id"), expectedVersion: Number(version),
      }, context.startedAt), context.requestId);
    });
  }
  router.get("/api/v1/workspaces/{workspace_id}/projects/{project_id}/member-candidates", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    return jsonResponse(await listProjectMemberCandidates(env.DB, auth, scope(context), context.url, context.startedAt), context.requestId);
  });
  router.get("/api/v1/workspaces/{workspace_id}/projects/{project_id}/members", async (request, env, context) => {
    const auth = await authenticated(request, env, context);
    return jsonResponse(await listProjectMembers(env.DB, auth, scope(context), context.url, context.startedAt), context.requestId);
  });
  return router;
}

import { requireVersion } from "../domain/model.ts";
import { authenticateRequest, SESSION_COOKIE_NAME } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import type { JsonValue, RequestContext, WorkerEnv } from "../kernel/types.ts";
import {
  disablePublicJoin,
  enablePublicJoin,
  getProjectResourceLimits,
  getPublicJoinPolicy,
  getRateLimitSettings,
  listPublicProjects,
  redeemPublicJoin,
  updateProjectResourceLimits,
} from "../services/public-join.ts";

async function body(request: Request, allowedKeys: readonly string[], requiredKeys: readonly string[]) {
  return validateJsonObject(await readJsonBody(request), { allowedKeys, requiredKeys });
}

function path(context: RequestContext, name: string): JsonValue {
  return context.params[name] ?? "";
}

function expectedVersionFromQuery(url: URL): number {
  const value = url.searchParams.get("expected_version");
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return requireVersion(null);
  return requireVersion(Number(value));
}

async function authenticated(request: Request, env: WorkerEnv, context: RequestContext) {
  const auth = await authenticateRequest(env.DB, request, context.startedAt);
  await enforcePrincipalRateLimit(env, auth);
  return auth;
}

async function writeAuth(request: Request, env: WorkerEnv, context: RequestContext) {
  const auth = await authenticated(request, env, context);
  enforceCookieWriteProtection(request, auth);
  return auth;
}

async function optionalAuth(request: Request, env: WorkerEnv, context: RequestContext) {
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");
  const hasSessionCookie = cookie?.split(";").some((entry) => (
    entry.trim().startsWith(`${SESSION_COOKIE_NAME}=`)
  )) ?? false;
  if (authorization === null && !hasSessionCookie) return null;
  return authenticated(request, env, context);
}

export function registerWp08Routes(router: Router): Router {
  router
    .get("/api/v1/public-projects", async (_request, env, context) => jsonResponse(
      await listPublicProjects(env.DB, context.url),
      context.requestId,
      { headers: { "cache-control": "no-store" } },
    ))
    .get("/api/v1/admin/projects/{project_id}/public-join", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getPublicJoinPolicy(
        env.DB,
        auth,
        path(context, "project_id"),
        context.startedAt,
      ), context.requestId);
    })
    .put("/api/v1/admin/projects/{project_id}/public-join", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(
        request,
        ["comment_limit", "expected_version", "issue_limit", "principal_limit", "public_summary"],
        ["comment_limit", "expected_version", "issue_limit", "principal_limit", "public_summary"],
      );
      return jsonResponse(await enablePublicJoin(
        env.DB,
        request,
        auth,
        path(context, "project_id"),
        value.public_summary as JsonValue,
        requireVersion(value.expected_version as JsonValue),
        {
          comment_limit: value.comment_limit as JsonValue,
          issue_limit: value.issue_limit as JsonValue,
          principal_limit: value.principal_limit as JsonValue,
        },
        context.startedAt,
      ), context.requestId);
    })
    .delete("/api/v1/admin/projects/{project_id}/public-join", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      return jsonResponse(await disablePublicJoin(
        env.DB,
        auth,
        path(context, "project_id"),
        expectedVersionFromQuery(context.url),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/admin/projects/{project_id}/resource-limits", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getProjectResourceLimits(
        env.DB,
        auth,
        path(context, "project_id"),
        context.startedAt,
      ), context.requestId);
    })
    .patch("/api/v1/admin/projects/{project_id}/resource-limits", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(
        request,
        ["comment_limit", "expected_version", "issue_limit", "principal_limit"],
        ["comment_limit", "expected_version", "issue_limit", "principal_limit"],
      );
      return jsonResponse(await updateProjectResourceLimits(
        env.DB,
        auth,
        path(context, "project_id"),
        requireVersion(value.expected_version as JsonValue),
        {
          comment_limit: value.comment_limit as JsonValue,
          issue_limit: value.issue_limit as JsonValue,
          principal_limit: value.principal_limit as JsonValue,
        },
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/admin/rate-limit-settings", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getRateLimitSettings(
        env.DB,
        auth,
        context.startedAt,
      ), context.requestId, { headers: { "cache-control": "no-store" } });
    })
    .post("/api/v1/public-joins/{public_id}/redeem", async (request, env, context) => {
      const value = await body(
        request,
        ["display_name", "new_credential_token", "redeem_as", "role"],
        ["redeem_as", "role"],
      );
      const auth = await optionalAuth(request, env, context);
      if (auth !== null) enforceCookieWriteProtection(request, auth);
      return jsonResponse(await redeemPublicJoin(
        env.DB,
        request,
        auth,
        path(context, "public_id"),
        value.redeem_as as JsonValue,
        value.role as JsonValue,
        value.display_name as JsonValue | undefined,
        value.new_credential_token as JsonValue | undefined,
        context.startedAt,
      ), context.requestId, { headers: { "cache-control": "no-store" } });
    });
  return router;
}

import { requireVersion } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import type { JsonValue, RequestContext, WorkerEnv } from "../kernel/types.ts";
import {
  assignIssueToMe,
  clearIssueBlocked,
  createIssue,
  deleteIssue,
  getIssue,
  getIssueContext,
  listIssueCandidates,
  listIssues,
  listProjectIssues,
  reportIssueBlocked,
  restoreIssue,
  updateIssue,
} from "../services/issues.ts";

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

export function registerWp05Routes(router: Router): Router {
  router
    .get("/api/v1/issues", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listIssues(env.DB, auth, context.url, context.startedAt), context.requestId);
    })
    .get("/api/v1/issues/candidates", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listIssueCandidates(
        env.DB,
        auth,
        context.url,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/workspaces/{workspace_key}/projects/{project_key}/issues", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listProjectIssues(
        env.DB,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
        context.url,
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/workspaces/{workspace_key}/projects/{project_key}/issues", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(
        request,
        ["assignee_principal_id", "body", "label_ids", "priority_key", "status_key", "title"],
        ["title"],
      );
      return jsonResponse(await createIssue(
        env.DB,
        request,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
        value,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/issues/{identifier}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getIssue(
        env.DB,
        auth,
        path(context, "identifier"),
        context.url,
      ), context.requestId);
    })
    .patch("/api/v1/issues/{identifier}", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(
        request,
        ["assignee_principal_id", "body", "expected_version", "priority_key", "status_key", "title"],
        ["expected_version"],
      );
      return jsonResponse(await updateIssue(
        env.DB,
        auth,
        path(context, "identifier"),
        value,
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .delete("/api/v1/issues/{identifier}", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      return jsonResponse(await deleteIssue(
        env.DB,
        auth,
        path(context, "identifier"),
        expectedVersionFromQuery(context.url),
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/issues/{identifier}/commands/restore", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["expected_version"], ["expected_version"]);
      return jsonResponse(await restoreIssue(
        env.DB,
        request,
        auth,
        path(context, "identifier"),
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/issues/{identifier}/context", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getIssueContext(env.DB, auth, path(context, "identifier")), context.requestId);
    })
    .post("/api/v1/issues/{identifier}/commands/assign-to-me", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["expected_version"], ["expected_version"]);
      return jsonResponse(await assignIssueToMe(
        env.DB,
        request,
        auth,
        path(context, "identifier"),
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/issues/{identifier}/commands/report-blocked", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["expected_version", "reason"], ["expected_version", "reason"]);
      return jsonResponse(await reportIssueBlocked(
        env.DB,
        request,
        auth,
        path(context, "identifier"),
        requireVersion(value.expected_version as JsonValue),
        value.reason as JsonValue,
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/issues/{identifier}/commands/clear-blocked", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["expected_version"], ["expected_version"]);
      return jsonResponse(await clearIssueBlocked(
        env.DB,
        request,
        auth,
        path(context, "identifier"),
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    });
  return router;
}

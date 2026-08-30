import { requireVersion } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import type { JsonValue, RequestContext, WorkerEnv } from "../kernel/types.ts";
import {
  createProject,
  createWorkspace,
  deleteProject,
  deleteWorkspace,
  getProject,
  getWorkspace,
  listProjects,
  listStatuses,
  listWorkspaces,
  restoreProject,
  restoreWorkspace,
  updateProject,
  updateStatusName,
  updateWorkspace,
} from "../services/containers.ts";
import {
  getInstanceDiscovery,
  getInstanceOrigin,
  getMe,
  getMeta,
  updateInstanceOrigin,
  updateMe,
} from "../services/identity.ts";

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

export function registerWp03Routes(router: Router): Router {
  router
    .get("/.well-known/cfkanban-instance.json", async (_request, env, context) => jsonResponse(
      await getInstanceDiscovery(env.DB, context.url.origin),
      context.requestId,
    ))
    .get("/api/v1/meta", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getMeta(env.DB, auth, context.url.origin), context.requestId);
    })
    .get("/api/v1/me", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getMe(env.DB, auth), context.requestId);
    })
    .patch("/api/v1/me", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const value = await body(request, ["display_name", "expected_version"], ["display_name", "expected_version"]);
      return jsonResponse(await updateMe(
        env.DB,
        auth,
        value.display_name as JsonValue,
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/workspaces", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listWorkspaces(env.DB, auth, context.url), context.requestId);
    })
    .post("/api/v1/workspaces", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const value = await body(request, ["display_name", "key"], ["display_name", "key"]);
      return jsonResponse(await createWorkspace(
        env.DB,
        request,
        auth,
        value.key as JsonValue,
        value.display_name as JsonValue,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/workspaces/{workspace_key}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getWorkspace(
        env.DB,
        auth,
        path(context, "workspace_key"),
        context.url,
      ), context.requestId);
    })
    .patch("/api/v1/workspaces/{workspace_key}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const value = await body(request, ["display_name", "expected_version"], ["display_name", "expected_version"]);
      return jsonResponse(await updateWorkspace(
        env.DB,
        auth,
        path(context, "workspace_key"),
        value.display_name as JsonValue,
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .delete("/api/v1/workspaces/{workspace_key}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      return jsonResponse(await deleteWorkspace(
        env.DB,
        auth,
        path(context, "workspace_key"),
        expectedVersionFromQuery(context.url),
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/workspaces/{workspace_key}/commands/restore", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const value = await body(request, ["expected_version"], ["expected_version"]);
      return jsonResponse(await restoreWorkspace(
        env.DB,
        request,
        auth,
        path(context, "workspace_key"),
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/workspaces/{workspace_key}/projects", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listProjects(env.DB, auth, path(context, "workspace_key"), context.url), context.requestId);
    })
    .post("/api/v1/workspaces/{workspace_key}/projects", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const value = await body(request, ["context", "display_name", "key"], ["display_name", "key"]);
      return jsonResponse(await createProject(
        env.DB,
        request,
        auth,
        path(context, "workspace_key"),
        value.key as JsonValue,
        value.display_name as JsonValue,
        value.context as JsonValue | undefined,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/workspaces/{workspace_key}/projects/{project_key}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getProject(
        env.DB,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
        context.url,
      ), context.requestId);
    })
    .patch("/api/v1/workspaces/{workspace_key}/projects/{project_key}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const value = await body(request, ["context", "display_name", "expected_version"], ["expected_version"]);
      return jsonResponse(await updateProject(
        env.DB,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
        value.display_name as JsonValue | undefined,
        value.context as JsonValue | undefined,
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .delete("/api/v1/workspaces/{workspace_key}/projects/{project_key}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      return jsonResponse(await deleteProject(
        env.DB,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
        expectedVersionFromQuery(context.url),
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/workspaces/{workspace_key}/projects/{project_key}/commands/restore", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const value = await body(request, ["expected_version"], ["expected_version"]);
      return jsonResponse(await restoreProject(
        env.DB,
        request,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/workspaces/{workspace_key}/projects/{project_key}/statuses", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listStatuses(
        env.DB,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
      ), context.requestId);
    })
    .patch("/api/v1/workspaces/{workspace_key}/projects/{project_key}/statuses/{status_key}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      enforceCookieWriteProtection(request, auth);
      const value = await body(request, ["display_name", "expected_version"], ["display_name", "expected_version"]);
      return jsonResponse(await updateStatusName(
        env.DB,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
        path(context, "status_key"),
        value.display_name as JsonValue,
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/admin/instance-origin", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getInstanceOrigin(env.DB, auth, context.url.origin), context.requestId);
    })
    .put("/api/v1/admin/instance-origin", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      const value = await body(
        request,
        ["expected_version", "preferred_api_origin"],
        ["expected_version", "preferred_api_origin"],
      );
      return jsonResponse(await updateInstanceOrigin(
        env.DB,
        request,
        auth,
        value.preferred_api_origin as JsonValue,
        requireVersion(value.expected_version as JsonValue),
        context.url.origin,
        context.startedAt,
      ), context.requestId);
    });
  return router;
}

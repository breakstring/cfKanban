import { requireVersion } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import type { Router } from "../kernel/router.ts";
import type { JsonValue, RequestContext, WorkerEnv } from "../kernel/types.ts";
import {
  completeIssue,
  createComment,
  deleteComment,
  getComment,
  listComments,
  restoreComment,
} from "../services/comments.ts";
import { listAuditEvents, listEvents } from "../services/events.ts";
import {
  addIssueLabel,
  createLabel,
  deleteLabel,
  getLabel,
  listLabels,
  removeIssueLabel,
  restoreLabel,
  updateLabel,
} from "../services/labels.ts";
import {
  createIssueRelation,
  deleteRelation,
  getRelation,
  listIssueRelations,
  restoreRelation,
} from "../services/relations.ts";

async function body(request: Request, allowedKeys: readonly string[], requiredKeys: readonly string[]) {
  return validateJsonObject(await readJsonBody(request), { allowedKeys, requiredKeys });
}

function path(context: RequestContext, name: string): JsonValue {
  return context.params[name] ?? "";
}

function versionQuery(url: URL, name = "expected_version"): number {
  const value = url.searchParams.get(name);
  if (value === null || !/^[1-9][0-9]*$/.test(value)) return requireVersion(null, name);
  return requireVersion(Number(value), name);
}

async function authenticated(request: Request, env: WorkerEnv, context: RequestContext) {
  return authenticateRequest(env.DB, request, context.startedAt);
}

async function writeAuth(request: Request, env: WorkerEnv, context: RequestContext) {
  const auth = await authenticated(request, env, context);
  enforceCookieWriteProtection(request, auth);
  return auth;
}

export function registerWp06Routes(router: Router): Router {
  router
    .get("/api/v1/events", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listEvents(env.DB, auth, context.url, context.startedAt), context.requestId);
    })
    .get("/api/v1/admin/audit-events", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listAuditEvents(
        env.DB,
        auth,
        context.url,
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/issues/{identifier}/commands/complete", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(
        request,
        ["artifacts", "expected_version", "follow_ups", "summary", "verification"],
        ["expected_version", "summary"],
      );
      return jsonResponse(await completeIssue(
        env.DB,
        request,
        auth,
        path(context, "identifier"),
        requireVersion(value.expected_version as JsonValue),
        value,
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/issues/{identifier}/commands/add-label", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["expected_version", "label_id"], ["expected_version", "label_id"]);
      return jsonResponse(await addIssueLabel(
        env.DB,
        request,
        auth,
        path(context, "identifier"),
        value.label_id as JsonValue,
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/issues/{identifier}/commands/remove-label", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["expected_version", "label_id"], ["expected_version", "label_id"]);
      return jsonResponse(await removeIssueLabel(
        env.DB,
        request,
        auth,
        path(context, "identifier"),
        value.label_id as JsonValue,
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/issues/{identifier}/comments", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listComments(
        env.DB,
        auth,
        path(context, "identifier"),
        context.url,
      ), context.requestId);
    })
    .post("/api/v1/issues/{identifier}/comments", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["body", "reply_to_comment_id"], ["body"]);
      return jsonResponse(await createComment(
        env.DB,
        request,
        auth,
        path(context, "identifier"),
        value.body as JsonValue,
        value.reply_to_comment_id as JsonValue | undefined,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/comments/{comment_id}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getComment(
        env.DB,
        auth,
        path(context, "comment_id"),
        context.url,
      ), context.requestId);
    })
    .delete("/api/v1/comments/{comment_id}", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      return jsonResponse(await deleteComment(
        env.DB,
        auth,
        path(context, "comment_id"),
        versionQuery(context.url),
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/comments/{comment_id}/commands/restore", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["expected_version"], ["expected_version"]);
      return jsonResponse(await restoreComment(
        env.DB,
        request,
        auth,
        path(context, "comment_id"),
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/workspaces/{workspace_key}/projects/{project_key}/labels", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listLabels(
        env.DB,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
        context.url,
      ), context.requestId);
    })
    .post("/api/v1/workspaces/{workspace_key}/projects/{project_key}/labels", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["color", "name"], ["name"]);
      return jsonResponse(await createLabel(
        env.DB,
        request,
        auth,
        path(context, "workspace_key"),
        path(context, "project_key"),
        value.name as JsonValue,
        value.color as JsonValue | undefined,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/labels/{label_id}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getLabel(
        env.DB,
        auth,
        path(context, "label_id"),
        context.url,
      ), context.requestId);
    })
    .patch("/api/v1/labels/{label_id}", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["color", "expected_version", "name"], ["expected_version"]);
      return jsonResponse(await updateLabel(
        env.DB,
        auth,
        path(context, "label_id"),
        value.name as JsonValue | undefined,
        value.color as JsonValue | undefined,
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .delete("/api/v1/labels/{label_id}", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      return jsonResponse(await deleteLabel(
        env.DB,
        auth,
        path(context, "label_id"),
        versionQuery(context.url),
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/labels/{label_id}/commands/restore", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(request, ["expected_version"], ["expected_version"]);
      return jsonResponse(await restoreLabel(
        env.DB,
        request,
        auth,
        path(context, "label_id"),
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/issues/{identifier}/relations", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listIssueRelations(
        env.DB,
        auth,
        path(context, "identifier"),
        context.url,
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/issues/{identifier}/relations", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(
        request,
        ["kind", "source_expected_version", "target_expected_version", "target_identifier"],
        ["kind", "source_expected_version", "target_expected_version", "target_identifier"],
      );
      return jsonResponse(await createIssueRelation(
        env.DB,
        request,
        auth,
        path(context, "identifier"),
        value.target_identifier as JsonValue,
        value.kind as JsonValue,
        requireVersion(value.source_expected_version as JsonValue, "source_expected_version"),
        requireVersion(value.target_expected_version as JsonValue, "target_expected_version"),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/relations/{relation_id}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getRelation(
        env.DB,
        auth,
        path(context, "relation_id"),
        context.url,
        context.startedAt,
      ), context.requestId);
    })
    .delete("/api/v1/relations/{relation_id}", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      return jsonResponse(await deleteRelation(
        env.DB,
        auth,
        path(context, "relation_id"),
        versionQuery(context.url),
        versionQuery(context.url, "source_expected_version"),
        versionQuery(context.url, "target_expected_version"),
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/relations/{relation_id}/commands/restore", async (request, env, context) => {
      const auth = await writeAuth(request, env, context);
      const value = await body(
        request,
        ["expected_version", "source_expected_version", "target_expected_version"],
        ["expected_version", "source_expected_version", "target_expected_version"],
      );
      return jsonResponse(await restoreRelation(
        env.DB,
        request,
        auth,
        path(context, "relation_id"),
        requireVersion(value.expected_version as JsonValue),
        requireVersion(value.source_expected_version as JsonValue, "source_expected_version"),
        requireVersion(value.target_expected_version as JsonValue, "target_expected_version"),
        context.startedAt,
      ), context.requestId);
    });
  return router;
}

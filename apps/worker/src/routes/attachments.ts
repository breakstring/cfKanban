import { requireVersion } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { validationError } from "../kernel/errors.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import { enforcePrincipalRateLimit } from "../kernel/rate-limit.ts";
import type { Router } from "../kernel/router.ts";
import type { RequestContext, WorkerEnv } from "../kernel/types.ts";
import { downloadAttachment, getAttachment, listAttachments, reserveAttachment, setAttachmentDeleted, uploadAttachment } from "../services/attachments.ts";

async function authenticate(request: Request, env: WorkerEnv, context: RequestContext) {
  const auth = await authenticateRequest(env.DB, request, context.startedAt);
  await enforcePrincipalRateLimit(env, auth);
  if (request.method !== "GET") enforceCookieWriteProtection(request, auth);
  return auth;
}
export function registerAttachmentRoutes(router: Router): Router {
  router.get("/api/v1/issues/{identifier}/attachments", async (request, env, context) => {
    const auth = await authenticate(request, env, context);
    return jsonResponse(await listAttachments(env, auth, context.params.identifier ?? "", context.url, context.startedAt), context.requestId);
  }).post("/api/v1/issues/{identifier}/attachments", async (request, env, context) => {
    const auth = await authenticate(request, env, context);
    const keys = ["filename", "content_type", "size_bytes", "sha256"];
    const body = validateJsonObject(await readJsonBody(request), { allowedKeys: keys, requiredKeys: keys });
    return jsonResponse(await reserveAttachment(env, request, auth, context.params.identifier ?? "", body, context.startedAt), context.requestId);
  }).get("/api/v1/attachments/{id}", async (request, env, context) => {
    const auth = await authenticate(request, env, context);
    return jsonResponse(await getAttachment(env, auth, context.params.id ?? "", context.startedAt), context.requestId);
  }).put("/api/v1/attachments/{id}/content", async (request, env, context) => {
    const auth = await authenticate(request, env, context);
    return jsonResponse(await uploadAttachment(env, request, auth, context.params.id ?? ""), context.requestId);
  }).get("/api/v1/attachments/{id}/content", async (request, env, context) => {
    const auth = await authenticate(request, env, context);
    const preview = context.url.searchParams.get("preview");
    if (preview !== null && preview !== "1") throw validationError("invalid_attachment_preview");
    return downloadAttachment(env, auth, context.params.id ?? "", preview === "1");
  }).delete("/api/v1/attachments/{id}", async (request, env, context) => {
    const auth = await authenticate(request, env, context);
    const value = context.url.searchParams.get("expected_version");
    const version = requireVersion(value !== null && /^[1-9][0-9]*$/.test(value) ? Number(value) : null);
    return jsonResponse(await setAttachmentDeleted(env, request, auth, context.params.id ?? "", version, false), context.requestId);
  }).post("/api/v1/attachments/{id}/commands/restore", async (request, env, context) => {
    const auth = await authenticate(request, env, context);
    const body = validateJsonObject(await readJsonBody(request), { allowedKeys: ["expected_version"], requiredKeys: ["expected_version"] });
    return jsonResponse(await setAttachmentDeleted(env, request, auth, context.params.id ?? "", requireVersion(body.expected_version ?? null), true), context.requestId);
  });
  return router;
}

import { requireVersion } from "../domain/model.ts";
import { authenticateRequest } from "../kernel/auth.ts";
import { enforceCookieWriteProtection } from "../kernel/csrf.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import type { Router } from "../kernel/router.ts";
import type { JsonValue, RequestContext, WorkerEnv } from "../kernel/types.ts";
import {
  createProjectGrant,
  getPrincipal,
  getProjectGrant,
  listPrincipalCredentials,
  listPrincipals,
  listProjectGrants,
  revokeCredential,
  revokeProjectGrant,
  rotateOwnerCredential,
  updateProjectGrant,
} from "../services/access.ts";
import {
  createInvitation,
  getInvitation,
  getInvitationBootstrapHtml,
  listInvitations,
  redeemInvitation,
  revokeInvitation,
} from "../services/invitations.ts";

const INVITATION_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'sha256-nz/HcXi8i3neAsDIt7kAGLz+gVTfd+Je7RtFPckEkRc='",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'none'",
  "style-src 'none'",
].join("; ");

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

async function ownerWriteAuth(request: Request, env: WorkerEnv, context: RequestContext) {
  const auth = await authenticateRequest(env.DB, request, context.startedAt);
  enforceCookieWriteProtection(request, auth);
  return auth;
}

async function authenticated(request: Request, env: WorkerEnv, context: RequestContext) {
  return authenticateRequest(env.DB, request, context.startedAt);
}

export function registerWp04Routes(router: Router): Router {
  router
    .get("/invite", async (_request, env, context) => new Response(
      await getInvitationBootstrapHtml(env.DB, context.url.searchParams.get("code"), context.startedAt),
      {
        headers: {
          "cache-control": "no-store",
          "content-security-policy": INVITATION_PAGE_CSP,
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
      },
    ))
    .post("/api/v1/invitations/redeem", async (request, env, context) => {
      const value = await body(
        request,
        ["display_name", "invite_code", "new_credential_token", "redeem_as"],
        ["invite_code", "redeem_as"],
      );
      return jsonResponse(await redeemInvitation(
        env.DB,
        request,
        value.invite_code as JsonValue,
        value.redeem_as as JsonValue,
        value.display_name as JsonValue | undefined,
        value.new_credential_token as JsonValue | undefined,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/admin/invitations", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listInvitations(env.DB, auth, context.url, context.startedAt), context.requestId);
    })
    .post("/api/v1/admin/invitations", async (request, env, context) => {
      const auth = await ownerWriteAuth(request, env, context);
      const value = await body(
        request,
        ["grants", "kind", "principal_id", "recovery_mode"],
        ["kind"],
      );
      return jsonResponse(await createInvitation(
        env.DB,
        request,
        auth,
        value.kind as JsonValue,
        value.grants as JsonValue | undefined,
        value.principal_id as JsonValue | undefined,
        value.recovery_mode as JsonValue | undefined,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/admin/invitations/{invitation_id}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getInvitation(
        env.DB,
        auth,
        path(context, "invitation_id"),
        context.startedAt,
      ), context.requestId);
    })
    .delete("/api/v1/admin/invitations/{invitation_id}", async (request, env, context) => {
      const auth = await ownerWriteAuth(request, env, context);
      return jsonResponse(await revokeInvitation(
        env.DB,
        auth,
        path(context, "invitation_id"),
        expectedVersionFromQuery(context.url),
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/admin/principals", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listPrincipals(env.DB, auth, context.url), context.requestId);
    })
    .get("/api/v1/admin/principals/{principal_id}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getPrincipal(
        env.DB,
        auth,
        path(context, "principal_id"),
      ), context.requestId);
    })
    .get("/api/v1/admin/principals/{principal_id}/credentials", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listPrincipalCredentials(
        env.DB,
        auth,
        path(context, "principal_id"),
        context.url,
      ), context.requestId);
    })
    .delete("/api/v1/admin/credentials/{credential_id}", async (request, env, context) => {
      const auth = await ownerWriteAuth(request, env, context);
      return jsonResponse(await revokeCredential(
        env.DB,
        auth,
        path(context, "credential_id"),
        expectedVersionFromQuery(context.url),
        context.startedAt,
      ), context.requestId);
    })
    .post("/api/v1/admin/owner-credentials/rotate", async (request, env, context) => {
      const value = await body(request, ["new_credential_token"], ["new_credential_token"]);
      return jsonResponse(await rotateOwnerCredential(
        env.DB,
        request,
        value.new_credential_token as JsonValue,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/admin/projects/{project_id}/grants", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await listProjectGrants(
        env.DB,
        auth,
        path(context, "project_id"),
        context.url,
      ), context.requestId);
    })
    .post("/api/v1/admin/projects/{project_id}/grants", async (request, env, context) => {
      const auth = await ownerWriteAuth(request, env, context);
      const value = await body(request, ["principal_id", "role"], ["principal_id", "role"]);
      return jsonResponse(await createProjectGrant(
        env.DB,
        request,
        auth,
        path(context, "project_id"),
        value.principal_id as JsonValue,
        value.role as JsonValue,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/admin/grants/{grant_id}", async (request, env, context) => {
      const auth = await authenticated(request, env, context);
      return jsonResponse(await getProjectGrant(env.DB, auth, path(context, "grant_id")), context.requestId);
    })
    .patch("/api/v1/admin/grants/{grant_id}", async (request, env, context) => {
      const auth = await ownerWriteAuth(request, env, context);
      const value = await body(request, ["expected_version", "role"], ["expected_version", "role"]);
      return jsonResponse(await updateProjectGrant(
        env.DB,
        auth,
        path(context, "grant_id"),
        value.role as JsonValue,
        requireVersion(value.expected_version as JsonValue),
        context.startedAt,
      ), context.requestId);
    })
    .delete("/api/v1/admin/grants/{grant_id}", async (request, env, context) => {
      const auth = await ownerWriteAuth(request, env, context);
      return jsonResponse(await revokeProjectGrant(
        env.DB,
        auth,
        path(context, "grant_id"),
        expectedVersionFromQuery(context.url),
        context.startedAt,
      ), context.requestId);
    });
  return router;
}

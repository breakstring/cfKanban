import { requireVersion } from "../domain/model.ts";
import { authenticateBearer, authenticateCookieSession, authenticateRequest } from "../kernel/auth.ts";
import {
  clearCsrfCookie,
  clearSessionCookie,
  enforceCookieWriteProtection,
  serializeCsrfCookie,
  serializeSessionCookie,
} from "../kernel/csrf.ts";
import { jsonResponse, readJsonBody, validateJsonObject } from "../kernel/http.ts";
import type { Router } from "../kernel/router.ts";
import type { JsonValue, RequestContext, WorkerEnv } from "../kernel/types.ts";
import {
  createPasskeyRegistrationOptions,
  createWebAuthenticationOptions,
  listMyPasskeys,
  registerPasskey,
  revokeMyPasskey,
  revokePrincipalPasskey,
  verifyWebAuthentication,
  type SessionExchangeResult,
} from "../services/passkeys.ts";
import {
  assertWebLaunchPageAvailable,
  createWebLaunch,
  getWebSession,
  redeemWebLaunch,
  revokeWebSession,
  webLaunchBootstrapHtml,
  webLaunchPageContentSecurityPolicy,
} from "../services/web-auth.ts";

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

function exchangeResponse(exchange: SessionExchangeResult, requestId: string): Response {
  const headers = new Headers();
  headers.set("cache-control", "no-store");
  if (exchange.sessionToken !== null && exchange.csrfToken !== null) {
    headers.append("set-cookie", serializeSessionCookie(exchange.sessionToken));
    headers.append("set-cookie", serializeCsrfCookie(exchange.csrfToken));
  }
  return jsonResponse(exchange.body, requestId, { headers });
}

function clearedCookieHeaders(): Headers {
  const headers = new Headers();
  headers.set("cache-control", "no-store");
  headers.append("set-cookie", clearSessionCookie());
  headers.append("set-cookie", clearCsrfCookie());
  return headers;
}

export function registerWp07Routes(router: Router): Router {
  router
    .get("/app/launch", async (_request, env, context) => {
      await assertWebLaunchPageAvailable(
        env.DB,
        context.url.searchParams.get("code"),
        context.startedAt,
      );
      return new Response(webLaunchBootstrapHtml(), {
        headers: {
          "cache-control": "no-store",
          "content-security-policy": await webLaunchPageContentSecurityPolicy(),
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
      });
    })
    .post("/api/v1/web-launches", async (request, env, context) => {
      const auth = await authenticateBearer(env.DB, request.headers.get("authorization"));
      const value = await body(request, ["target"], ["target"]);
      return jsonResponse(await createWebLaunch(
        env.DB,
        request,
        auth,
        value.target as JsonValue,
        context.startedAt,
      ), context.requestId, { headers: { "cache-control": "no-store" } });
    })
    .post("/api/v1/web-sessions/redeem", async (request, env, context) => {
      const value = await body(request, ["launch_code"], ["launch_code"]);
      return exchangeResponse(await redeemWebLaunch(
        env.DB,
        request,
        value.launch_code as JsonValue,
        context.startedAt,
      ), context.requestId);
    })
    .get("/api/v1/web-session", async (request, env, context) => {
      const auth = await authenticateCookieSession(env.DB, request, context.startedAt);
      return jsonResponse(await getWebSession(env.DB, auth, context.startedAt), context.requestId, {
        headers: { "cache-control": "no-store" },
      });
    })
    .delete("/api/v1/web-session", async (request, env, context) => {
      const auth = await authenticateCookieSession(env.DB, request, context.startedAt);
      enforceCookieWriteProtection(request, auth);
      return jsonResponse(
        await revokeWebSession(env.DB, auth, context.startedAt),
        context.requestId,
        { headers: clearedCookieHeaders() },
      );
    })
    .post("/api/v1/me/passkeys/registration-options", async (request, env, context) => {
      const auth = await authenticateCookieSession(env.DB, request, context.startedAt);
      enforceCookieWriteProtection(request, auth);
      await body(request, [], []);
      return jsonResponse(await createPasskeyRegistrationOptions(
        env.DB,
        request,
        auth,
        context.startedAt,
      ), context.requestId, { headers: { "cache-control": "no-store" } });
    })
    .get("/api/v1/me/passkeys", async (request, env, context) => {
      const auth = await authenticateCookieSession(env.DB, request, context.startedAt);
      return jsonResponse(await listMyPasskeys(env.DB, auth, context.startedAt), context.requestId, {
        headers: { "cache-control": "no-store" },
      });
    })
    .post("/api/v1/me/passkeys", async (request, env, context) => {
      const auth = await authenticateCookieSession(env.DB, request, context.startedAt);
      enforceCookieWriteProtection(request, auth);
      const value = await body(request, ["challenge_id", "credential"], ["challenge_id", "credential"]);
      return jsonResponse(await registerPasskey(
        env.DB,
        request,
        auth,
        value.challenge_id as JsonValue,
        value.credential as JsonValue,
        context.startedAt,
      ), context.requestId, { headers: { "cache-control": "no-store" } });
    })
    .delete("/api/v1/me/passkeys/{passkey_id}", async (request, env, context) => {
      const auth = await authenticateCookieSession(env.DB, request, context.startedAt);
      enforceCookieWriteProtection(request, auth);
      const result = await revokeMyPasskey(
        env.DB,
        auth,
        path(context, "passkey_id"),
        expectedVersionFromQuery(context.url),
        context.startedAt,
      );
      const clearsCurrentSource = auth.sourceKind === "web_authenticator"
        && auth.sourceId === context.params.passkey_id;
      return jsonResponse(
        result,
        context.requestId,
        clearsCurrentSource
          ? { headers: clearedCookieHeaders() }
          : { headers: { "cache-control": "no-store" } },
      );
    })
    .delete("/api/v1/admin/passkeys/{passkey_id}", async (request, env, context) => {
      const auth = await authenticateRequest(env.DB, request, context.startedAt);
      enforceCookieWriteProtection(request, auth);
      return jsonResponse(await revokePrincipalPasskey(
        env.DB,
        auth,
        path(context, "passkey_id"),
        expectedVersionFromQuery(context.url),
        context.startedAt,
      ), context.requestId, { headers: { "cache-control": "no-store" } });
    })
    .post("/api/v1/web-authentication/options", async (request, env, context) => {
      await body(request, [], []);
      return jsonResponse(await createWebAuthenticationOptions(
        env.DB,
        request,
        context.startedAt,
      ), context.requestId, { headers: { "cache-control": "no-store" } });
    })
    .post("/api/v1/web-authentication/verify", async (request, env, context) => {
      const value = await body(request, ["challenge_id", "credential"], ["challenge_id", "credential"]);
      return exchangeResponse(await verifyWebAuthentication(
        env.DB,
        request,
        value.challenge_id as JsonValue,
        value.credential as JsonValue,
        context.startedAt,
      ), context.requestId);
    });
  return router;
}

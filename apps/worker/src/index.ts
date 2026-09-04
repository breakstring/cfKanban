import openApiDocument from "../../../contracts/openapi.json";

import { clearCsrfCookie, clearSessionCookie } from "./kernel/csrf.ts";
import { ApiError, errorResponse, notFound, platformUnavailable } from "./kernel/errors.ts";
import { createRequestContext, jsonResponse, readJsonBody, withRequestId } from "./kernel/http.ts";
import {
  enforceInstanceRateLimit,
  enforceUnauthenticatedSensitiveRateLimit,
  isRateLimitedDynamicPath,
  isUnauthenticatedSensitivePath,
} from "./kernel/rate-limit.ts";
import { Router } from "./kernel/router.ts";
import type { WorkerEnv } from "./kernel/types.ts";
import { registerWp03Routes } from "./routes/wp03.ts";
import { registerWp04Routes } from "./routes/wp04.ts";
import { registerWp05Routes } from "./routes/wp05.ts";
import { registerWp06Routes } from "./routes/wp06.ts";
import { registerWp07Routes } from "./routes/wp07.ts";
import { registerWp08Routes } from "./routes/wp08.ts";

const SERVICE_VERSION = "0.1.0";
const SCHEMA_VERSION = 1;
const openApiBody = JSON.stringify(openApiDocument);

const router = registerWp08Routes(registerWp07Routes(registerWp06Routes(registerWp05Routes(registerWp04Routes(registerWp03Routes(new Router()
  .get("/healthz", async (_request, env, context) => {
    try {
      await env.DB.prepare("SELECT 1 AS reachable").first();
    } catch (error) {
      throw platformUnavailable("d1", error);
    }
    return jsonResponse({
      d1: "reachable",
      schema_version: SCHEMA_VERSION,
      service_version: SERVICE_VERSION,
    }, context.requestId);
  })
  .get("/openapi.json", (_request, _env, context) => new Response(openApiBody, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-request-id": context.requestId,
    },
  }))))))));

function mayHaveJsonBody(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
}

function withSpaDocumentHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export async function fetchWorker(request: Request, env: WorkerEnv): Promise<Response> {
  const context = createRequestContext(request);
  try {
    if (isRateLimitedDynamicPath(context.url.pathname)) {
      await enforceInstanceRateLimit(env);
      if (isUnauthenticatedSensitivePath(context.method, context.url.pathname)) {
        await enforceUnauthenticatedSensitiveRateLimit(env);
      }
    }
    const routed = router.dispatch(request, env, context);
    if (routed !== null) return withRequestId(await routed, context.requestId);

    if (isRateLimitedDynamicPath(context.url.pathname)) {
      if (mayHaveJsonBody(request)) await readJsonBody(request);
      throw notFound();
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (context.url.pathname === "/" || context.url.pathname === "/app" || context.url.pathname.startsWith("/app/")) {
      return withSpaDocumentHeaders(assetResponse, context.requestId);
    }
    return withRequestId(assetResponse, context.requestId);
  } catch (error) {
    const response = errorResponse(error, context.requestId);
    if (!(error instanceof ApiError) || !error.clearSessionCookies) return response;
    const headers = new Headers(response.headers);
    headers.append("set-cookie", clearSessionCookie());
    headers.append("set-cookie", clearCsrfCookie());
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

export default {
  fetch(request, env): Promise<Response> {
    return fetchWorker(request, env);
  },
} satisfies ExportedHandler<WorkerEnv>;

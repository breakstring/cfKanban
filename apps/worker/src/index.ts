import openApiDocument from "../../../contracts/openapi.json" with { type: "json" };
import serviceApi from "../../../contracts/service-api.json" with { type: "json" };
import migrationManifest from "../../../migrations/manifest.json" with { type: "json" };

import { RELEASE_VERSION } from "./release-version.ts";

import { clearCsrfCookie, clearSessionCookie } from "./kernel/csrf.ts";
import { documentationResponse, isDocumentationPath } from "./kernel/docs.ts";
import { ApiError, errorResponse, notFound, platformUnavailable } from "./kernel/errors.ts";
import {
  createRequestContext,
  HTML_DOCUMENT_CACHE_CONTROL,
  jsonResponse,
  readJsonBody,
  withRequestId,
} from "./kernel/http.ts";
import {
  enforceInstanceRateLimit,
  enforceUnauthenticatedSensitiveRateLimit,
  isRateLimitedDynamicPath,
  isUnauthenticatedSensitivePath,
} from "./kernel/rate-limit.ts";
import { Router } from "./kernel/router.ts";
import type { WorkerEnv } from "./kernel/types.ts";
import { registerAttachmentRoutes } from "./routes/attachments.ts";
import { registerHomepageSettingsRoutes } from "./routes/homepage-settings.ts";
import { registerNotificationRoutes } from "./routes/notifications.ts";
import { registerReleaseUpdatesRoutes } from "./routes/release-updates.ts";
import { registerUsageRoutes } from "./routes/usage.ts";
import { registerCloudflareControlRoutes } from "./routes/cloudflare-control.ts";
import { registerScopedAdministratorRoutes } from "./routes/scoped-administrators.ts";
import { registerSearchIndexRoutes } from "./routes/search-index.ts";
import { collectAttachmentGarbage } from "./services/attachments.ts";
import { collectUsageHistoryDaily } from "./services/usage-history.ts";
import { registerWp03Routes } from "./routes/wp03.ts";
import { registerWp04Routes } from "./routes/wp04.ts";
import { registerWp05Routes } from "./routes/wp05.ts";
import { registerWp06Routes } from "./routes/wp06.ts";
import { registerWp07Routes } from "./routes/wp07.ts";
import { registerWp08Routes } from "./routes/wp08.ts";

const SERVICE_VERSION = serviceApi.service_version;
const SCHEMA_VERSION = migrationManifest.schema_version;
const openApiBody = JSON.stringify(openApiDocument);

const router = registerUsageRoutes(registerAttachmentRoutes(registerWp08Routes(registerWp07Routes(registerWp06Routes(registerWp05Routes(registerWp04Routes(registerWp03Routes(new Router()
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
      release_version: RELEASE_VERSION,
    }, context.requestId);
  })
  .get("/openapi.json", (_request, _env, context) => new Response(openApiBody, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-request-id": context.requestId,
    },
  }))))))))));

registerScopedAdministratorRoutes(router);
registerHomepageSettingsRoutes(router);
registerNotificationRoutes(router);
registerReleaseUpdatesRoutes(router);
registerSearchIndexRoutes(router);
registerCloudflareControlRoutes(router);

function mayHaveJsonBody(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
}

function withSpaDocumentHeaders(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", HTML_DOCUMENT_CACHE_CONTROL);
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
    if (isDocumentationPath(context.url.pathname)) {
      return withRequestId(await documentationResponse(request, env), context.requestId);
    }
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

    let assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status === 404 && (request.method === "GET" || request.method === "HEAD")) {
      // Static Assets 对被排除的文档资源直接返回真实 404；应用导航在 Worker 内回退。
      const shellUrl = new URL(request.url);
      shellUrl.pathname = "/index.html";
      shellUrl.search = "";
      assetResponse = await env.ASSETS.fetch(new Request(shellUrl, { method: request.method }));
    }
    if (context.url.pathname === "/" || context.url.pathname === "/app" || context.url.pathname.startsWith("/app/")) {
      return withSpaDocumentHeaders(assetResponse, context.requestId);
    }
    return withRequestId(assetResponse, context.requestId);
  } catch (error) {
    const response = errorResponse(error, context.requestId);
    // 迟到的续期响应不能清除另一页签已经建立的新身份；登录与显式退出保留既有处理。
    if (!(error instanceof ApiError) || !error.clearSessionCookies || context.url.pathname === "/api/v1/web-session/renew") return response;
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
  async scheduled(_controller, env): Promise<void> {
    try {
      const summary = await collectAttachmentGarbage(env);
      if (summary.failures.delete || summary.failures.verify || summary.failures.release || summary.backlog.garbage || summary.backlog.expired_pending_may_remain) {
        console.warn({ operation: "attachment_garbage_collection", ...summary });
      }
    } catch {
      console.warn({ operation: "attachment_garbage_collection", error: "collection_failed" });
    }
    if (env.USAGE_HISTORY_ENABLED === "true") {
      try {
        await collectUsageHistoryDaily(env);
      } catch {
        console.warn({ operation: "usage_history_collection", error: "collection_failed" });
      }
    }
  },
  fetch(request, env): Promise<Response> {
    return fetchWorker(request, env);
  },
} satisfies ExportedHandler<WorkerEnv>;

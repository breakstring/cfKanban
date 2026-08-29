import openApiDocument from "../../../contracts/openapi.json";

import { errorResponse, notFound, platformUnavailable } from "./kernel/errors.ts";
import { createRequestContext, jsonResponse, readJsonBody, withRequestId } from "./kernel/http.ts";
import { Router } from "./kernel/router.ts";
import type { WorkerEnv } from "./kernel/types.ts";
import { registerWp03Routes } from "./routes/wp03.ts";
import { registerWp04Routes } from "./routes/wp04.ts";
import { registerWp05Routes } from "./routes/wp05.ts";
import { registerWp06Routes } from "./routes/wp06.ts";
import { registerWp07Routes } from "./routes/wp07.ts";

const SERVICE_VERSION = "0.1.0";
const SCHEMA_VERSION = 1;
const openApiBody = JSON.stringify(openApiDocument);

const router = registerWp07Routes(registerWp06Routes(registerWp05Routes(registerWp04Routes(registerWp03Routes(new Router()
  .get("/healthz", async (_request, env, context) => {
    try {
      await env.DB.prepare("SELECT 1 AS reachable").first();
    } catch {
      throw platformUnavailable("d1");
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
  })))))));

function isWorkerOwnedPath(pathname: string): boolean {
  return pathname.startsWith("/api/")
    || pathname === "/healthz"
    || pathname === "/openapi.json"
    || pathname === "/invite"
    || pathname === "/app/launch"
    || pathname.startsWith("/.well-known/");
}

function mayHaveJsonBody(request: Request): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.body !== null;
}

export async function fetchWorker(request: Request, env: WorkerEnv): Promise<Response> {
  const context = createRequestContext(request);
  try {
    const routed = router.dispatch(request, env, context);
    if (routed !== null) return withRequestId(await routed, context.requestId);

    if (isWorkerOwnedPath(context.url.pathname)) {
      if (mayHaveJsonBody(request)) await readJsonBody(request);
      throw notFound();
    }

    return withRequestId(await env.ASSETS.fetch(request), context.requestId);
  } catch (error) {
    return errorResponse(error, context.requestId);
  }
}

export default {
  fetch(request, env): Promise<Response> {
    return fetchWorker(request, env);
  },
} satisfies ExportedHandler<WorkerEnv>;

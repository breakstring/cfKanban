import type { RequestContext, WorkerEnv } from "./types.ts";

export type RouteHandler = (
  request: Request,
  env: WorkerEnv,
  context: RequestContext,
) => Promise<Response> | Response;

interface Route {
  handler: RouteHandler;
  method: string;
  path: string;
}

export class Router {
  readonly #routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): this {
    this.#routes.push({ handler, method: method.toUpperCase(), path });
    return this;
  }

  get(path: string, handler: RouteHandler): this {
    return this.add("GET", path, handler);
  }

  dispatch(
    request: Request,
    env: WorkerEnv,
    context: RequestContext,
  ): Promise<Response> | Response | null {
    const route = this.#routes.find(
      (candidate) => candidate.method === context.method && candidate.path === context.url.pathname,
    );
    return route?.handler(request, env, context) ?? null;
  }
}

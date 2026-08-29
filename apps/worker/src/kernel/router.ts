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
  segments: readonly RouteSegment[];
}

type RouteSegment =
  | { kind: "literal"; value: string }
  | { kind: "parameter"; name: string };

function compilePath(path: string): readonly RouteSegment[] {
  if (!path.startsWith("/")) throw new Error("Route paths must start with '/'.");
  return path.split("/").slice(1).map((segment) => {
    const parameter = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(segment);
    return parameter?.[1]
      ? { kind: "parameter", name: parameter[1] }
      : { kind: "literal", value: segment };
  });
}

function matchRoute(route: Route, pathname: string): Record<string, string> | null {
  const pathnameSegments = pathname.split("/").slice(1);
  if (pathnameSegments.length !== route.segments.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const routeSegment = route.segments[index];
    const pathnameSegment = pathnameSegments[index];
    if (routeSegment === undefined || pathnameSegment === undefined) return null;
    if (routeSegment.kind === "literal") {
      if (routeSegment.value !== pathnameSegment) return null;
      continue;
    }
    try {
      params[routeSegment.name] = decodeURIComponent(pathnameSegment);
    } catch {
      return null;
    }
  }
  return params;
}

export class Router {
  readonly #routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): this {
    this.#routes.push({ handler, method: method.toUpperCase(), path, segments: compilePath(path) });
    return this;
  }

  get(path: string, handler: RouteHandler): this {
    return this.add("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.add("POST", path, handler);
  }

  patch(path: string, handler: RouteHandler): this {
    return this.add("PATCH", path, handler);
  }

  put(path: string, handler: RouteHandler): this {
    return this.add("PUT", path, handler);
  }

  delete(path: string, handler: RouteHandler): this {
    return this.add("DELETE", path, handler);
  }

  dispatch(
    request: Request,
    env: WorkerEnv,
    context: RequestContext,
  ): Promise<Response> | Response | null {
    for (const route of this.#routes) {
      if (route.method !== context.method) continue;
      const params = matchRoute(route, context.url.pathname);
      if (params === null) continue;
      context.params = params;
      return route.handler(request, env, context);
    }
    return null;
  }
}

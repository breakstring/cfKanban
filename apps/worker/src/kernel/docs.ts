import catalog from "../../../docs/catalog.json" with { type: "json" };

import { HTML_DOCUMENT_CACHE_CONTROL } from "./http.ts";
import type { WorkerEnv } from "./types.ts";

const documentPaths = new Set(["/docs/"]);
const markdownPaths = new Set<string>();
const redirects = new Map([
  ["/docs", "/docs/"],
  ["/docs/index.html", "/docs/"],
]);

for (const locale of ["en", "zh-CN"]) {
  redirects.set(`/docs/${locale}`, `/docs/${locale}/overview/`);
  redirects.set(`/docs/${locale}/`, `/docs/${locale}/overview/`);
  for (const group of catalog) {
    for (const page of group.pages) {
      const sourcePath = `/docs/${locale}/${page.path}`;
      const isIndex = page.path.endsWith("/index");
      const path = isIndex ? sourcePath.slice(0, -"index".length) : sourcePath;
      documentPaths.add(path);
      markdownPaths.add(`${sourcePath}.md`);
      if (isIndex) {
        redirects.set(path.slice(0, -1), path);
        redirects.set(sourcePath, path);
        redirects.set(`${sourcePath}.html`, path);
      } else {
        redirects.set(`${path}/`, path);
        redirects.set(`${path}.html`, path);
      }
    }
  }
}

function documentHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("cache-control", HTML_DOCUMENT_CACHE_CONTROL);
  result.set("referrer-policy", "no-referrer");
  result.set("x-content-type-options", "nosniff");
  return result;
}

function plainResponse(request: Request, status = 404): Response {
  const headers = documentHeaders({ "content-type": "text/plain; charset=utf-8" });
  if (status === 405) headers.set("allow", "GET, HEAD");
  return new Response(request.method === "HEAD" ? null : status === 405 ? "Method Not Allowed" : "Not Found", {
    headers,
    status,
  });
}

function assetRequest(request: Request, pathname: string, method = request.method): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  // Public documentation never forwards Session cookies or Bearer credentials to the assets binding.
  return new Request(url, { method });
}

function isHtml(response: Response): boolean {
  return /^text\/html(?:;|$)/i.test(response.headers.get("content-type") ?? "");
}

async function fetchDocument(request: Request, env: WorkerEnv, path: string, status: number): Promise<Response | null> {
  // Clean URLs avoid ASSETS' .html-to-canonical redirects. GET also verifies the document for HEAD requests.
  const response = await env.ASSETS.fetch(assetRequest(request, path, "GET"));
  if (response.status !== 200 || !isHtml(response)) return null;
  const body = await response.text();
  if (!/<meta\s+[^>]*name=["']cfkanban-docs["'][^>]*>/i.test(body)) return null;
  const headers = documentHeaders(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(request.method === "HEAD" ? null : body, { headers, status });
}

async function notFoundDocument(request: Request, env: WorkerEnv): Promise<Response> {
  return await fetchDocument(request, env, "/docs/404", 404) ?? plainResponse(request);
}

export function isDocumentationPath(path: string): boolean {
  return path === "/llms.txt" || path === "/docs" || path.startsWith("/docs/");
}

export async function documentationResponse(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plainResponse(request, 405);
  const path = new URL(request.url).pathname;
  const redirect = redirects.get(path);
  if (redirect) {
    return new Response(null, {
      headers: documentHeaders({ location: redirect }),
      status: 308,
    });
  }
  if (documentPaths.has(path)) {
    return await fetchDocument(request, env, path, 200) ?? notFoundDocument(request, env);
  }

  const isMarkdown = markdownPaths.has(path);
  const isText = path === "/llms.txt" || path === "/docs/llms.txt";
  const isHashmap = path === "/docs/hashmap.json";
  const isIconStylesheet = path === "/docs/vp-icons.css";
  const isAsset = path.startsWith("/docs/assets/") && !path.endsWith("/");
  if (!isMarkdown && !isText && !isHashmap && !isIconStylesheet && !isAsset) {
    const isResource = path.startsWith("/docs/assets/") || (/\.[^/]+$/.test(path) && !path.endsWith(".html"));
    return isResource ? plainResponse(request) : notFoundDocument(request, env);
  }

  const response = await env.ASSETS.fetch(assetRequest(request, path));
  // A missing file in the shared SPA asset directory otherwise returns the main app as 200 HTML.
  if (response.status !== 200 || isHtml(response)) return plainResponse(request);
  const headers = documentHeaders(response.headers);
  if (isMarkdown || isText) headers.set("content-type", "text/plain; charset=utf-8");
  if (isHashmap) headers.set("content-type", "application/json; charset=utf-8");
  if (isIconStylesheet) headers.set("content-type", "text/css; charset=utf-8");
  if (isAsset && /[.-][A-Za-z0-9_-]{8,}\.[^/]+$/.test(path)) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  return new Response(request.method === "HEAD" ? null : response.body, { headers });
}

import { RELEASE_VERSION } from "../release-version.ts";
import { HTML_DOCUMENT_CACHE_CONTROL } from "./http.ts";
import type { WorkerEnv } from "./types.ts";

const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const SKILLS = ["cfkanban", "cfkanban-admin", "cfkanban-deploy", "cfkanban-howto"];
const INDEX_PATH = `/agent-skills/${RELEASE_VERSION}/index.json`;

interface SkillEntry { name: string; type: "archive"; description: string; url: string; digest: string }
interface SkillsIndex { $schema: string; skills: SkillEntry[] }

function publicHeaders(contentType = "text/plain; charset=utf-8", immutable = false): Headers {
  return new Headers({
    "content-type": contentType,
    "cache-control": immutable ? "public, max-age=31536000, immutable, no-transform" : HTML_DOCUMENT_CACHE_CONTROL,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  });
}

function plainResponse(request: Request, status = 404): Response {
  const headers = publicHeaders();
  if (status === 405) headers.set("allow", "GET, HEAD");
  return new Response(request.method === "HEAD" ? null : status === 405 ? "Method Not Allowed" : status === 503 ? "Service Unavailable" : "Not Found", { headers, status });
}

function assetRequest(request: Request, pathname: string, method = "GET"): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  // 公开发现的静态请求不转发业务凭据。
  return new Request(url, { method });
}

function isIndex(value: unknown): value is SkillsIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as Partial<SkillsIndex>;
  if (index.$schema !== SCHEMA || !Array.isArray(index.skills) || index.skills.length !== SKILLS.length) return false;
  const names = new Set<string>();
  for (const entry of index.skills) {
    if (!entry || !SKILLS.includes(entry.name) || names.has(entry.name) || entry.type !== "archive"
      || typeof entry.description !== "string" || !entry.description || [...entry.description].length > 1024
      || entry.url !== `/agent-skills/${RELEASE_VERSION}/${entry.name}.tar.gz`
      || typeof entry.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.digest)) return false;
    names.add(entry.name);
  }
  return true;
}

export function isAgentSkillsDiscoveryPath(pathname: string): boolean {
  return pathname === "/.well-known/agent-skills" || pathname.startsWith("/.well-known/agent-skills/")
    || pathname === "/agent-skills" || pathname.startsWith("/agent-skills/");
}

export async function agentSkillsDiscoveryResponse(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plainResponse(request, 405);
  const url = new URL(request.url);
  const isPublicIndex = url.pathname === "/.well-known/agent-skills/index.json" || url.pathname === INDEX_PATH;
  const archiveName = SKILLS.find(name => url.pathname === `/agent-skills/${RELEASE_VERSION}/${name}.tar.gz`);
  if (!isPublicIndex && !archiveName) return plainResponse(request);
  const indexResponse = await env.ASSETS.fetch(assetRequest(request, INDEX_PATH));
  if (indexResponse.status !== 200 || /^text\/html(?:;|$)/iu.test(indexResponse.headers.get("content-type") ?? "")) return plainResponse(request);
  let index: unknown;
  try { index = await indexResponse.json(); } catch { return plainResponse(request, 503); }
  if (!isIndex(index)) return plainResponse(request, 503);
  if (isPublicIndex) {
    const body = JSON.stringify({ $schema: index.$schema, skills: index.skills.map(entry => ({ ...entry, url: new URL(entry.url, url.origin).href })) });
    return new Response(request.method === "HEAD" ? null : body, { headers: publicHeaders("application/json; charset=utf-8") });
  }
  const response = await env.ASSETS.fetch(assetRequest(request, url.pathname, request.method));
  if (response.status !== 200 || /^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) return plainResponse(request);
  const headers = publicHeaders("application/gzip", true);
  // .tar.gz 是工件原始表示，不是 HTTP content encoding。
  return new Response(request.method === "HEAD" ? null : response.body, { headers });
}

import catalog from "../../../docs/catalog.json" with { type: "json" };

import { authenticationGuideBody } from "./auth-documentation.ts";
import { HTML_DOCUMENT_CACHE_CONTROL } from "./http.ts";
import { PUBLIC_CONTENT_SIGNAL } from "./public-content.ts";

const API_CATALOG_PATH = "/.well-known/api-catalog";
const API_CATALOG_PROFILE = "https://www.rfc-editor.org/info/rfc9727";
const resourcePaths = [API_CATALOG_PATH, "/robots.txt", "/sitemap.xml", "/auth.md"];
const publicDocumentPaths = [...new Set(catalog.flatMap(group => group.pages.flatMap(page => (
  ["en", "zh-CN"].map(locale => `/docs/${locale}/${page.path.replace(/\/index$/u, "/")}`)
))))];
const publicHtmlPaths = ["/", ...publicDocumentPaths];
const crawlablePaths = [...publicHtmlPaths, "/auth.md"];

function discoveryHeaders(contentType: string): Headers {
  return new Headers({
    "cache-control": HTML_DOCUMENT_CACHE_CONTROL,
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function publicApiLinks(origin: string): string[] {
  const anchor = `${origin}/api/v1`;
  return [
    `<${origin}/openapi.json>; rel="service-desc"; type="application/json"; anchor="${anchor}"`,
    ...["en", "zh-CN"].map(locale => (
      `<${origin}/docs/${locale}/overview/>; rel="service-doc"; type="text/html"; hreflang="${locale}"; anchor="${anchor}"`
    )),
    `<${origin}/auth.md>; rel="service-doc"; type="text/markdown"; anchor="${anchor}"`,
  ];
}

export function homepageDiscoveryLink(request: Request): string {
  const origin = new URL(request.url).origin;
  return [
    `<${origin}${API_CATALOG_PATH}>; rel="api-catalog"; type="application/linkset+json"`,
    ...publicApiLinks(origin),
  ].join(", ");
}

function catalogBody(origin: string): string {
  const api = `${origin}/api/v1`;
  return JSON.stringify({
    linkset: [
      {
        anchor: api,
        "service-desc": [{ href: `${origin}/openapi.json`, type: "application/json" }],
        "service-doc": [
          ...["en", "zh-CN"].map(locale => ({
            href: `${origin}/docs/${locale}/overview/`, type: "text/html", hreflang: [locale],
          })),
          { href: `${origin}/auth.md`, type: "text/markdown", hreflang: ["en", "zh-CN"] },
        ],
      },
    ],
  });
}

function robotsBody(origin: string): string {
  // 精确匹配公开页面，使私有、兑换及未知路径继续默认禁止爬取。
  return [
    "User-agent: *",
    `Content-Signal: ${PUBLIC_CONTENT_SIGNAL}`,
    "Disallow: /",
    ...crawlablePaths.map(path => `Allow: ${path}$`),
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

function xmlText(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]!);
}

function sitemapBody(origin: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...publicHtmlPaths.map(path => `  <url><loc>${xmlText(new URL(path, origin).href)}</loc></url>`),
    "</urlset>",
    "",
  ].join("\n");
}

export function publicDiscoveryResponse(request: Request): Response | null {
  const url = new URL(request.url);
  const knownResource = resourcePaths.includes(url.pathname);
  if (!knownResource) {
    if (!resourcePaths.some(path => url.pathname.startsWith(`${path}/`))) return null;
    return new Response(request.method === "HEAD" ? null : "Not Found", {
      status: 404,
      headers: discoveryHeaders("text/plain; charset=utf-8"),
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    const headers = discoveryHeaders("text/plain; charset=utf-8");
    headers.set("allow", "GET, HEAD");
    return new Response("Method Not Allowed", { status: 405, headers });
  }

  let headers: Headers;
  let body: string;
  if (url.pathname === API_CATALOG_PATH) {
    headers = discoveryHeaders(`application/linkset+json; profile="${API_CATALOG_PROFILE}"`);
    headers.set("link", homepageDiscoveryLink(request));
    body = catalogBody(url.origin);
  } else if (url.pathname === "/robots.txt") {
    headers = discoveryHeaders("text/plain; charset=utf-8");
    headers.set("content-signal", PUBLIC_CONTENT_SIGNAL);
    body = robotsBody(url.origin);
  } else if (url.pathname === "/auth.md") {
    headers = discoveryHeaders("text/markdown; charset=utf-8");
    headers.set("content-signal", PUBLIC_CONTENT_SIGNAL);
    body = authenticationGuideBody(url.origin);
  } else {
    headers = discoveryHeaders("application/xml; charset=utf-8");
    body = sitemapBody(url.origin);
  }
  return new Response(request.method === "HEAD" ? null : body, { headers });
}

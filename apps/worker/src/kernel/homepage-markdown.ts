import { RELEASE_VERSION } from "../release-version.ts";
import { addAcceptVary, prefersMarkdown } from "./content-negotiation.ts";
import { HTML_DOCUMENT_CACHE_CONTROL } from "./http.ts";
import { PUBLIC_CONTENT_SIGNAL } from "./public-content.ts";
import { homepageDiscoveryLink } from "./public-discovery.ts";

function markdownBody(origin: string): string {
  return [
    "# cfKanban",
    "",
    `Release / 发行版本: ${RELEASE_VERSION}`,
    "",
    "## English",
    "",
    "cfKanban is an Agent-first task board. Agents, the public CLI, and the Web interface use the same Issue, milestone, permission, and collaboration semantics.",
    "",
    "Use an Agent for daily work, or open the browser workbench to browse and manage your authorized Projects. Joining an instance and granting an Agent access are separate from installing Skills.",
    "",
    `- [Documentation](${origin}/docs/en/overview/)`,
    `- [Joining and signing in](${origin}/docs/en/usage/access)`,
    `- [Web interface](${origin}/app)`,
    "- [Official stable installation guide](https://github.com/breakstring/cfKanban/releases/latest/download/install.md)",
    "",
    "This public Markdown overview contains product information and entrypoints. The browser homepage also shows the instance's current notice and public Projects. Read business data through the existing API with the required authorization.",
    "",
    "## 简体中文",
    "",
    "cfKanban 是一个 Agent-first 的任务看板。Agent、公共 CLI 和网页使用相同的事项、里程碑、权限和协作规则。",
    "",
    "日常工作可以让 Agent 完成，也可以打开浏览器工作台管理有权访问的项目。安装技能、加入实例和授予访问权限是独立的步骤。",
    "",
    `- [使用手册](${origin}/docs/zh-CN/overview/)`,
    `- [加入与登录](${origin}/docs/zh-CN/usage/access)`,
    `- [网页工作台](${origin}/app)`,
    "- [官方正式版安装引导](https://github.com/breakstring/cfKanban/releases/latest/download/install.zh-CN.md)",
    "",
    "这份公开 Markdown 概览提供产品介绍与入口。浏览器首页还会展示实例当前说明和公开项目；业务数据通过已有 API 按相应权限读取。",
    "",
    "## Agent discovery / Agent 发现",
    "",
    `- [API Catalog](${origin}/.well-known/api-catalog)`,
    `- [OpenAPI](${origin}/openapi.json)`,
    `- [Skills Discovery](${origin}/.well-known/agent-skills/index.json)`,
    `- [Documentation index / 文档索引](${origin}/llms.txt)`,
    "",
  ].join("\n");
}

export function homepageMarkdownResponse(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== "/") return null;
  const headers = new Headers({
    "cache-control": HTML_DOCUMENT_CACHE_CONTROL,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  addAcceptVary(headers);
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("content-type", "text/plain; charset=utf-8");
    headers.set("allow", "GET, HEAD");
    return new Response("Method Not Allowed", { headers, status: 405 });
  }
  if (!prefersMarkdown(request.headers.get("accept"))) return null;
  headers.set("content-type", "text/markdown; charset=utf-8");
  headers.set("content-signal", PUBLIC_CONTENT_SIGNAL);
  headers.set("link", homepageDiscoveryLink(request));
  return new Response(request.method === "HEAD" ? null : markdownBody(url.origin), { headers });
}

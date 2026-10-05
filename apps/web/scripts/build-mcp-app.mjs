import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { assertEmbeddedHtml } from "./build-embedded.mjs";
import { readReleaseVersion } from "../../../scripts/lib/release-version.mjs";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scriptHash = value => `sha256-${createHash("sha256").update(value).digest("base64")}`;

export async function buildMcpAppDocument({ outputDirectory = path.join(webRoot, "dist-mcp-app"), version } = {}) {
  const releaseVersion = version ?? await readReleaseVersion(repositoryRoot);
  if (typeof releaseVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(releaseVersion)) throw new Error("Invalid MCP App release version");
  const staging = await mkdtemp(path.join(tmpdir(), "cfkanban-mcp-app-build-"));
  try {
    const result = await build({
      configFile: path.join(webRoot, "vite.mcp-app.config.ts"),
      define: { __CFKANBAN_MCP_APP_VERSION__: JSON.stringify(releaseVersion) },
      build: { outDir: staging }, logLevel: "warn",
    });
    const bundles = (Array.isArray(result) ? result : [result]).flatMap(output => output.output ?? []);
    const modules = bundles.filter(output => output.type === "chunk");
    if (modules.length !== 1 || modules[0].imports.length || modules[0].dynamicImports.length) throw new Error("MCP App build must produce one module without runtime imports");
    const forbidden = /[\\/]src[\\/](?:App\.vue|lib[\\/](?:api|router|i18n)\.ts|views[\\/])/;
    if (Object.keys(modules[0].modules).some(id => forbidden.test(id))) throw new Error("MCP App build imported standalone session or route behavior");
    const entries = await readdir(staging, { recursive: true });
    const htmlEntry = entries.find(entry => entry.endsWith("workbench.html"));
    if (!htmlEntry) throw new Error("MCP App HTML entry is missing");
    let html = await readFile(path.join(staging, htmlEntry), "utf8");
    const css = bundles.filter(output => output.type === "asset" && output.fileName.endsWith(".css"));
    if (css.length !== 1) throw new Error("MCP App build must contain one stylesheet");
    const cssText = typeof css[0].source === "string" ? css[0].source : Buffer.from(css[0].source).toString("utf8");
    const code = modules[0].code.replace(/<\/script/gi, "<\\/script");
    html = html.replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script\s*>/i, () => `<script type="module">${code}</script>`)
      .replace(/<link\b[^>]*>/gi, "")
      .replace("</head>", () => `<style>${cssText.replace(/<\/style/gi, "<\\/style")}</style></head>`);
    const policy = `default-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src '${scriptHash(code)}'; style-src 'unsafe-inline'; img-src data:`;
    html = html.replace(/<meta\b[^>]*charset=["']?UTF-8["']?[^>]*>/i, match => `${match}<meta http-equiv="Content-Security-Policy" content="${policy}">`);
    const checked = assertEmbeddedHtml(html);
    const metadata = { schema_version: 1, entry: "workbench.html", protocol: 1, release_version: releaseVersion, sha256: checked.sha256, size_bytes: checked.size_bytes };
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "workbench.html"), html);
    await writeFile(path.join(outputDirectory, "mcp-app-build.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    // 依赖清单供上层生成许可证，不进入可发行 metadata 或 CLI 输出。
    return Object.defineProperty(metadata, "inputs", { value: Object.keys(modules[0].modules), enumerable: false });
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = await buildMcpAppDocument();
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const webRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
const scriptHash = value => `sha256-${createHash("sha256").update(value).digest("base64")}`;

export function assertEmbeddedHtml(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > 5_242_880) throw new Error("Invalid embedded document size");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (scripts.length !== 1 || /\bsrc\s*=/i.test(scripts[0][1])) throw new Error("Embedded document must contain one inline script");
  if (/<(?:link|iframe|object|embed|base)\b/i.test(html) || /<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b/i.test(html)) throw new Error("Embedded document contains an external resource element");
  const outsideScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  if (/\bon[a-z]+\s*=/i.test(outsideScripts) || [...outsideScripts.matchAll(/\b(src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].some(match => match[1].toLowerCase() === "srcset" || !(match[2] ?? match[3] ?? match[4]).startsWith("data:"))) throw new Error("Embedded document contains a runtime resource or inline event handler");
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)];
  if (styles.length !== 1 || /@import\b/i.test(styles[0][1]) || [...styles[0][1].matchAll(/url\(([^)]*)\)/gi)].some(match => {
    const value = match[1].trim().replace(/^["']|["']$/g, "");
    return value !== "" && !value.startsWith("data:");
  })) throw new Error("Embedded styles contain an external dependency");
  const script = scripts[0][2];
  if (/\bimport\s*(?:\(|["'{*])|\bexport\s+(?:\{|default|const|function|class)|\b(?:eval|Function)\s*\(/.test(script)) throw new Error("Embedded script contains a runtime module or dynamic code dependency");
  if (/\b(?:localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket|EventSource)\b|document\.cookie/.test(script)) throw new Error("Embedded script contains browser authentication or network state");
  const hash = scriptHash(script);
  const policies = [...html.matchAll(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/gi)];
  const policy = policies.length === 1 ? policies[0][1] : undefined;
  const directives = policy?.split(";").map(value => value.trim());
  const required = ["default-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'", "img-src data:", "style-src 'unsafe-inline'", `script-src '${hash}'`];
  if (!directives || directives.length !== required.length || !required.every(directive => directives.includes(directive))) throw new Error("Embedded Content Security Policy is missing or does not match its script");
  return { sha256: digest(html), size_bytes: Buffer.byteLength(html), script_hashes: [hash] };
}

export async function buildEmbeddedDocument({ outputDirectory = path.join(webRoot, "dist-embedded") } = {}) {
  const staging = await mkdtemp(path.join(tmpdir(), "cfkanban-embedded-build-"));
  try {
    const result = await build({ configFile: path.join(webRoot, "vite.embedded.config.ts"), build: { outDir: staging }, logLevel: "warn" });
    const bundles = (Array.isArray(result) ? result : [result]).flatMap(output => output.output ?? []);
    const modules = bundles.filter(output => output.type === "chunk");
    if (modules.length !== 1 || modules[0].imports.length || modules[0].dynamicImports.length) throw new Error("Embedded build must produce one module without runtime imports");
    const forbidden = /[\\/]src[\\/](?:App\.vue|lib[\\/](?:api|router|i18n)\.ts|views[\\/])/;
    if (Object.keys(modules[0].modules).some(id => forbidden.test(id))) throw new Error("Embedded build imported standalone session or route behavior");
    const entries = await readdir(staging, { recursive: true });
    const htmlEntry = entries.find(entry => entry.endsWith("embedded.html"));
    if (!htmlEntry) throw new Error("Embedded HTML entry is missing");
    let html = await readFile(path.join(staging, htmlEntry), "utf8");
    const css = bundles.filter(output => output.type === "asset" && output.fileName.endsWith(".css"));
    if (css.length !== 1) throw new Error("Embedded build must contain one stylesheet");
    const cssText = typeof css[0].source === "string" ? css[0].source : Buffer.from(css[0].source).toString("utf8");
    const code = modules[0].code.replace(/<\/script/gi, "<\\/script");
    html = html.replace(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script\s*>/i, () => `<script type="module">${code}</script>`)
      .replace(/<link\b[^>]*>/gi, "")
      .replace("</head>", () => `<style>${cssText.replace(/<\/style/gi, "<\\/style")}</style></head>`);
    const policy = `default-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; script-src '${scriptHash(code)}'; style-src 'unsafe-inline'; img-src data:`;
    html = html.replace(/<meta\b[^>]*charset=["']?UTF-8["']?[^>]*>/i, match => `${match}<meta http-equiv="Content-Security-Policy" content="${policy}">`);
    const checked = assertEmbeddedHtml(html);
    const release = JSON.parse(await readFile(path.join(repositoryRoot, "release/version.json"), "utf8"));
    const metadata = { schema_version: 1, entry: "embedded.html", protocol: 1, release_version: release.version, sha256: checked.sha256, size_bytes: checked.size_bytes };
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "embedded.html"), html);
    await writeFile(path.join(outputDirectory, "embedded-build.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return metadata;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = await buildEmbeddedDocument();
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

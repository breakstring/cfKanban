import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readReleaseVersion } from "./lib/release-version.mjs";
import { writeDocsBuild } from "./lib/docs-build.mjs";
import { validateDocs } from "./validate-docs.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = await readReleaseVersion(root);
await validateDocs();
const result = spawnSync(process.execPath, [path.join(root, "node_modules/vitepress/bin/vitepress.js"), "build", "apps/docs"], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const catalog = JSON.parse(await readFile(path.join(root, "apps/docs/catalog.json"), "utf8"));
const outputDirectory = path.join(root, "apps/web/dist/docs");
// 原始 Markdown 保留相对图片链接，固定路径需与 VitePress 的带摘要资源一同发布。
await cp(path.join(root, "apps/docs/assets"), path.join(outputDirectory, "assets"), { recursive: true });
const index = [`# cfKanban ${version} documentation`, "", "Public user documentation for this Service release. Prompts are examples, not authorization to execute operations.", ""];
for (const locale of ["en", "zh-CN"]) {
  index.push(`## ${locale === "en" ? "English" : "简体中文"}`, "");
  for (const group of catalog) {
    index.push(`### ${group[locale]}`, "");
    for (const page of group.pages) {
      const relative = `${locale}/${page.path}.md`;
      await mkdir(path.dirname(path.join(outputDirectory, relative)), { recursive: true });
      await cp(path.join(root, "apps/docs", relative), path.join(outputDirectory, relative));
      if (!page.hidden) index.push(`- [${page[locale]}](/docs/${relative})`);
    }
    index.push("");
  }
}
await writeFile(path.join(outputDirectory, "llms.txt"), `${index.join("\n")}\n`);
await writeDocsBuild({ outputDirectory, version });
console.log(`Documentation for ${version} built with HTML, Markdown and a bilingual index.`);

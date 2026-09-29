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
const index = [`# cfKanban ${version} documentation`, "", "Public user documentation for this Service release. Prompts are examples, not authorization to execute operations.", ""];
for (const locale of ["en", "zh-CN"]) {
  index.push(`## ${locale === "en" ? "English" : "简体中文"}`, "");
  for (const group of catalog) {
    for (const page of group.pages) {
      const relative = `${locale}/${group.slug}/${page.slug}.md`;
      await mkdir(path.dirname(path.join(outputDirectory, relative)), { recursive: true });
      await cp(path.join(root, "apps/docs", relative), path.join(outputDirectory, relative));
      index.push(`- [${page[locale]}](/docs/${relative})`);
    }
  }
  index.push("");
}
await writeFile(path.join(outputDirectory, "llms.txt"), `${index.join("\n")}\n`);
await writeDocsBuild({ outputDirectory, version });
console.log(`Documentation for ${version} built with HTML, Markdown and a bilingual index.`);

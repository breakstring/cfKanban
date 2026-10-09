import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../apps/docs/", import.meta.url));
// Worker 生成的公开文档没有静态源文件；其路由与正文由 Worker 测试校验。
const generatedRootDocuments = new Set(["/auth.md"]);

export async function validateDocs() {
  const catalog = JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8"));
  assert.deepEqual(catalog.map(group => group.slug), ["overview", "integrations", "usage", "deployment", "cli"]);
  const paths = new Set();
  for (const group of catalog) {
    for (const page of group.pages) {
      assert.equal(page.slug, undefined, `${group.slug}: pages must use an explicit content path`);
      assert.equal(typeof page.path, "string", `${group.slug}: missing content path`);
      assert.match(page.path, /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)+$/u, `${group.slug}: invalid content path ${page.path}`);
      assert.ok(!paths.has(page.path), `Duplicate documentation path: ${page.path}`);
      paths.add(page.path);
      assert.ok(page.hidden === undefined || typeof page.hidden === "boolean", `${page.path}: hidden must be a boolean`);
    }
  }
  let count = 0;
  for (const locale of ["en", "zh-CN"]) {
    const expected = [...paths].map(pagePath => `${pagePath}.md`).sort();
    const actual = (await readdir(path.join(root, locale), { recursive: true })).filter(file => file.endsWith(".md")).map(file => file.replaceAll(path.sep, "/")).sort();
    assert.deepEqual(actual, expected, `${locale}: content and public navigation must match`);
    for (const relative of expected) {
      const file = path.join(root, locale, relative);
      const source = await readFile(file, "utf8");
      assert.match(source, /^# .+/mu, `${file}: missing title`);
      assert.ok(source.trim().length > 150, `${file}: content must not be a placeholder`);
      if (!relative.startsWith("overview/") && !relative.endsWith("/index.md")) {
        assert.match(source, /```text\n[^`]+\n```/u, `${file}: missing Agent prompt`);
        assert.match(source, locale === "en" ? /\bWeb\b|\bbrowser\b/iu : /网页|浏览器/u, `${file}: missing Web guidance`);
      }
      for (const match of source.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/gu)) {
        const href = match[1];
        if (/^(?:https?:|mailto:|#)/u.test(href)) continue;
        if (generatedRootDocuments.has(href)) continue;
        assert.ok(!href.startsWith("/"), `${file}: use relative documentation links so published Markdown also resolves beneath /docs/`);
        const pathname = href.split(/[?#]/u)[0];
        if (!pathname) continue;
        let target = path.resolve(href.startsWith("/") ? root : path.dirname(file), pathname.replace(/^\//u, ""));
        if (pathname.endsWith("/")) target = path.join(target, "index.md");
        else if (!path.extname(target)) target += ".md";
        assert.ok(!path.relative(root, target).startsWith(".."), `${file}: link leaves public documentation`);
        assert.ok((await stat(target)).isFile(), `${file}: broken link ${href}`);
      }
      count++;
    }
  }
  const agentGuide = await readFile(new URL("../apps/web/public/llms.txt", import.meta.url), "utf8");
  for (const match of agentGuide.matchAll(/\]\(([^\s)]+)\)/gu)) {
    const href = match[1];
    if (/^https?:/u.test(href)) continue;
    if (generatedRootDocuments.has(href)) continue;
    if (href === "/docs/llms.txt") continue; // 文档索引由构建脚本生成。
    assert.ok(href.startsWith("/"), `Root Agent guide must use same-instance paths: ${href}`);
    const target = href.startsWith("/docs/")
      ? path.join(root, href.slice("/docs/".length))
      : fileURLToPath(new URL(`../apps/web/public${href}`, import.meta.url));
    assert.ok((await stat(target)).isFile(), `Root Agent guide: broken link ${href}`);
  }
  console.log(`Documentation checks passed for ${count} bilingual pages and their navigation/links.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await validateDocs();

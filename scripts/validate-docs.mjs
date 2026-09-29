import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../apps/docs/", import.meta.url));

export async function validateDocs() {
  const catalog = JSON.parse(await readFile(path.join(root, "catalog.json"), "utf8"));
  assert.deepEqual(catalog.map(group => group.slug), ["overview", "usage", "administration", "deployment"]);
  let count = 0;
  for (const locale of ["en", "zh-CN"]) {
    const expected = catalog.flatMap(group => group.pages.map(page => `${group.slug}/${page.slug}.md`)).sort();
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
  console.log(`Documentation checks passed for ${count} bilingual pages and their navigation/links.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await validateDocs();

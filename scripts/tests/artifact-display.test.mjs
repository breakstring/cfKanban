import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, nextTick } from "vue";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const built = await build({
  stdin: {
    contents: 'export { default as CompletionRecord } from "./apps/web/src/components/CompletionRecord.vue"; export { setLocale } from "./apps/web/src/lib/i18n-core"; export { artifactKindLabel } from "./apps/web/src/lib/artifact-display";',
    resolveDir: root,
  },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
  plugins: [{ name: "completion-artifact-fixture", setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: pathToFileURL(require.resolve("vue")).href, external: true }));
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
      return { contents: compileScript(descriptor, { id: "completion-artifact-fixture", inlineTemplate: true }).content, loader: "ts", resolveDir: path.dirname(filename) };
    });
  } }],
});
const { CompletionRecord, setLocale, artifactKindLabel } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("artifact labels cover both UI languages and preserve unknown wire keys", () => {
  assert.deepEqual(["path", "url", "commit", "other"].map(kind => artifactKindLabel(kind, "zh-CN")), ["路径", "链接", "提交", "其他"]);
  assert.deepEqual(["path", "url", "commit", "other"].map(kind => artifactKindLabel(kind, "en")), ["Path", "URL", "Commit", "Other"]);
  for (const locale of ["en", "zh-CN"]) {
    for (const kind of ["future-kind", "Path", "__proto__", "constructor", ""]) assert.equal(artifactKindLabel(kind, locale), kind);
  }
});

function fixture(value) {
  const node = (tag, text = "") => ({ tag, text, props: {}, children: [], parent: null });
  const remove = child => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; };
  const renderer = createRenderer({
    createElement: tag => node(tag), createText: text => node("#text", text), createComment: text => node("#comment", text),
    setText: (element, text) => { element.text = text; }, setElementText: (element, text) => { element.text = text; element.children = []; },
    parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
    insert(child, parent, anchor = null) { remove(child); child.parent = parent; parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child); },
    remove, patchProp: (element, key, _previous, current) => { element.props[key] = current; },
  });
  const container = node("root");
  const app = renderer.createApp({ render: () => h(CompletionRecord, { value }) });
  app.mount(container);
  const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
  const elements = tag => descendants(container).filter(element => element.tag === tag);
  return { app, elements };
}

test("shared completion artifacts react to language changes while retaining their values and links", async () => {
  const value = {
    summary: "完成检查 / actual evidence",
    verification: ["Checked actual output"],
    artifacts: [{ kind: "path", value: "src/文件.ts" }, { kind: "url", value: "https://example.test/result" }, { kind: "commit", value: "a1b2c3d" }, { kind: "other", value: "用户原文" }],
    follow_ups: ["后续 original text"],
  };
  const original = structuredClone(value);
  setLocale("en");
  const f = fixture(value);
  try {
    assert.deepEqual(f.elements("code").map(element => element.text), ["Path", "URL", "Commit", "Other"]);
    setLocale("zh-CN"); await nextTick();
    assert.deepEqual(f.elements("code").map(element => element.text), ["路径", "链接", "提交", "其他"]);
    assert.equal(f.elements("p")[0].text, value.summary);
    assert.deepEqual(f.elements("span").map(element => element.text), ["src/文件.ts", "a1b2c3d", "用户原文"]);
    assert.deepEqual(f.elements("a").map(element => [element.text, element.props.href]), [["https://example.test/result", "https://example.test/result"]]);
    assert.deepEqual(value, original);
    setLocale("en"); await nextTick();
    assert.deepEqual(f.elements("code").map(element => element.text), ["Path", "URL", "Commit", "Other"]);
  } finally { f.app.unmount(); setLocale("en"); }
});

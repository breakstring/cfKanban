import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { build } from "esbuild";
import { compileScript, parse } from "@vue/compiler-sfc";
import { createRenderer, h, markRaw, nextTick, reactive } from "vue";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "cfkanban-project-menu-"));
const moduleFile = path.join(temporary, "menu.mjs");
const require = createRequire(import.meta.url);
await build({
  entryPoints: [path.join(root, "apps/web/src/components/ProjectSwitcherMenu.vue")],
  outfile: moduleFile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  plugins: [{ name: "component-fixture", setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: pathToFileURL(require.resolve("vue")).href, external: true }));
    builder.onResolve({ filter: /^@nuxt\/ui\/components\/Button.vue$/ }, () => ({ path: "button", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'import {defineComponent,h} from "vue"; export default defineComponent({inheritAttrs:false,setup(_props,{attrs,slots}) { return () => h("button",attrs,slots.default?.()); }});', loader: "js" }));
    builder.onLoad({ filter: /\.vue$/ }, async ({ path: filename }) => {
      const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
      return { contents: `${compileScript(descriptor, { id: "menu-fixture", inlineTemplate: true }).content}\nexport {setLocale} from "../lib/i18n-core";`, loader: "ts", resolveDir: path.dirname(filename) };
    });
  } }],
});
const { default: Menu, setLocale } = await import(pathToFileURL(moduleFile));
after(() => rm(temporary, { recursive: true, force: true }));

function fixture(overrides = {}, slots = {}) {
  const events = [];
  const listeners = new Map();
  const windowListeners = new Map();
  const document = {
    activeElement: null,
    addEventListener: (event, listener) => listeners.set(event, listener),
    removeEventListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); },
    defaultView: { innerWidth: 320, innerHeight: 800, addEventListener: (event, listener) => windowListeners.set(event, listener), removeEventListener: (event, listener) => { if (windowListeners.get(event) === listener) windowListeners.delete(event); } },
  };
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const node = (tag, text = "") => markRaw({ tag, text, props: {}, children: [], parent: null, ownerDocument: document,
    focus() { document.activeElement = this; },
    getBoundingClientRect: () => ({ left: 48, width: 160, bottom: 56 }),
    querySelector(selector) { return descendants(this).find(child => String(child.props.class ?? "").split(" ").includes(selector.slice(1))); },
    querySelectorAll() { const panel = this.querySelector(".project-switch-panel"); return panel ? descendants(panel).filter(child => child.tag === "button" && !child.props.disabled) : []; },
  });
  const remove = child => { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; };
  const renderer = createRenderer({
    createElement: tag => node(tag), createText: text => node("#text", text), createComment: text => node("#comment", text),
    setText: (element, text) => { element.text = text; }, setElementText: (element, text) => { element.text = text; element.children = []; },
    parentNode: element => element.parent, nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] ?? null,
    insert(child, parent, anchor = null) { remove(child); child.parent = parent; parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, child); },
    remove, patchProp: (element, key, _previous, value) => { element.props[key] = value; },
  });
  const state = reactive({ title: "Workspace / Project", opened: false, search: "", busy: false, error: "", disabled: false, groups: [{ id: "workspace", label: "Workspace", projects: [{ id: "a", label: "Project A", current: true }, { id: "b", label: "Project B", disabled: true, description: "Unavailable" }] }], ...overrides });
  const container = node("root");
  const app = renderer.createApp({ render: () => h(Menu, { ...state,
    onOpen: () => { events.push(["open"]); state.opened = true; }, onClose: () => { events.push(["close"]); state.opened = false; },
    onSearch: value => { events.push(["search", value]); state.search = value; }, onRetry: () => events.push(["retry"]), onSelect: value => events.push(["select", value]),
  }, slots) });
  app.mount(container);
  const find = className => descendants(container).find(element => String(element.props.class ?? "").split(" ").includes(className));
  const tick = async () => { await nextTick(); await nextTick(); };
  return { app, state, events, document, listeners, windowListeners, container, descendants, find, tick };
}

test("shared project menu emits only display events, excludes disabled rows from keyboard movement and restores focus", async () => {
  setLocale("en");
  const f = fixture();
  try {
    const trigger = f.find("project-switch-trigger");
    trigger.props.onClick(); await f.tick();
    assert.deepEqual(f.events, [["open"]]);
    assert.equal(f.document.activeElement.tag, "input");
    const input = f.document.activeElement;
    input.props.onInput({ target: { value: "Project B" } }); await f.tick();
    assert.deepEqual(f.events.at(-1), ["search", "Project B"]);
    const rootNode = f.find("project-switcher");
    let prevented = 0;
    rootNode.props.onKeydown({ key: "ArrowDown", target: input, preventDefault: () => prevented++ });
    assert.equal(prevented, 1);
    const rows = f.descendants(f.find("project-switch-panel")).filter(element => String(element.props.class ?? "").includes("project-switch-row"));
    assert.equal(f.document.activeElement, rows[0]);
    assert.equal(rows[0].props["aria-current"], "page");
    assert.equal(rows[1].props.disabled, true);
    rows[1].props.onClick();
    assert.equal(f.events.some(event => event[0] === "select"), false);
    rows[0].props.onClick(); assert.deepEqual(f.events.at(-1), ["select", "a"]);
    f.listeners.get("pointerdown")({ composedPath: () => [rows[0], rootNode] });
    assert.equal(f.state.opened, true);
    rootNode.props.onKeydown({ key: "Escape", target: rows[0], preventDefault() {} }); await f.tick();
    assert.equal(f.state.opened, false);
    assert.equal(f.document.activeElement, trigger);
    trigger.props.onClick(); await f.tick();
    f.listeners.get("pointerdown")({ composedPath: () => [] }); await f.tick();
    assert.equal(f.state.opened, false);
  } finally { f.app.unmount(); }
  assert.equal(f.listeners.size, 0);
  assert.equal(f.windowListeners.size, 0);
});

test("the shared menu renders localized loading, errors, retry and caller-owned group/footer actions", async () => {
  setLocale("zh-CN");
  const f = fixture({ opened: true, busy: true, error: "验证失败", groups: [] }, { "group-action": () => h("button", "管理"), footer: () => h("button", { onClick: () => f.events.push(["more"]) }, "加载更多") });
  try {
    await f.tick();
    let all = f.descendants(f.container);
    assert.ok(all.some(element => element.props.role === "status" && element.text === "加载中…"));
    assert.ok(all.some(element => element.props.role === "alert"));
    const retry = all.find(element => String(element.props.class ?? "").includes("text-button"));
    assert.equal(retry.props.disabled, true);
    f.state.busy = false; await f.tick();
    retry.props.onClick(); assert.deepEqual(f.events.at(-1), ["retry"]);
    const footer = f.find("project-switch-footer");
    footer.children.find(element => element.tag === "button").props.onClick();
    assert.deepEqual(f.events.at(-1), ["more"]);
    f.state.groups = [{ id: "empty", label: "Empty workspace", projects: [] }]; await f.tick();
    all = f.descendants(f.container);
    assert.ok(all.some(element => element.tag === "button" && element.text === "管理"));
    assert.ok(all.some(element => element.text === "暂无项目"));
  } finally { f.app.unmount(); setLocale("en"); }
});

test("menu collision positioning stays inside narrow viewports and updates without a new open request", async () => {
  const f = fixture({ opened: true });
  try {
    await f.tick();
    const panel = f.find("project-switch-panel");
    assert.equal(panel.props.style.left, "16px");
    assert.equal(panel.props.style.width, "288px");
    assert.ok(parseFloat(panel.props.style.top) + parseFloat(panel.props.style.maxHeight) <= f.document.defaultView.innerHeight - 16);
    f.document.defaultView.innerWidth = 240;
    f.windowListeners.get("resize")(); await f.tick();
    assert.equal(panel.props.style.left, "16px");
    assert.equal(panel.props.style.width, "208px");
    assert.equal(f.events.length, 0);
  } finally { f.app.unmount(); }
});

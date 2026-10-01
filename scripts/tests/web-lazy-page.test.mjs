import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { build } from "esbuild";
import { createRenderer, defineComponent, h, nextTick, ref } from "vue";

const output = await build({
  stdin: {
    contents: `export { lazyPage } from './apps/web/src/lib/lazy-page.ts'; export { locale } from './apps/web/src/lib/i18n.ts';`,
    resolveDir: new URL("../../", import.meta.url).pathname,
  },
  bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent",
  plugins: [{ name: "shared-vue-runtime", setup(builder) {
    builder.onResolve({ filter: /^vue$/ }, () => ({ path: new URL("../../node_modules/vue/index.mjs", import.meta.url).href, external: true }));
  } }],
});
const { lazyPage, locale } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
afterEach(() => { locale.value = "en"; });

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
function node(tag, text = "") { return { tag, text, children: [], props: {}, parent: null }; }
const renderer = createRenderer({
  createElement: tag => node(tag), createText: text => node("#text", text), createComment: text => node("#comment", text),
  setText: (target, text) => { target.text = text; },
  setElementText: (target, text) => { target.text = text; target.children = []; },
  patchProp: (target, key, _old, value) => { target.props[key] = value; },
  insert(target, parent, anchor = null) {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
    target.parent = parent;
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, target);
  },
  remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); },
  parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
});
const all = target => [target, ...target.children.flatMap(all)];
const text = target => target.text + target.children.map(text).join("");
const button = (host, label) => all(host).find(item => item.tag === "button" && text(item) === label);
async function settle() {
  for (let step = 0; step < 10; step++) await Promise.resolve();
  await nextTick();
}
function mount(Component, props, slots) {
  const host = node("root");
  const app = renderer.createApp({ setup: () => () => h(Component, props, slots) });
  app.mount(host);
  return { app, host };
}
const content = label => defineComponent({ setup: () => () => h("p", label) });

test("page imports start only on mount, share pending imports and reuse successful modules", async () => {
  let calls = 0, unusedCalls = 0;
  const pending = deferred();
  const Page = lazyPage(() => { calls++; return pending.promise; });
  lazyPage(async () => { unusedCalls++; return { default: content("unused") }; });
  assert.equal(calls, 0);
  const first = mount(Page), second = mount(Page);
  await settle();
  assert.equal(calls, 1);
  assert.equal(unusedCalls, 0);
  assert.match(text(first.host), /Loading page/);
  assert.equal(all(first.host).find(item => item.props.role === "status").props["aria-busy"], "true");
  pending.resolve({ default: content("loaded") });
  await settle();
  assert.equal(text(first.host), "loaded");
  assert.equal(text(second.host), "loaded");
  first.app.unmount(); second.app.unmount();
  const returning = mount(Page);
  assert.equal(text(returning.host), "loaded");
  assert.equal(calls, 1);
  returning.app.unmount();
});

test("pending and failed states follow the current locale; retry reimports only after a click", async () => {
  const first = deferred(), retry = deferred();
  let calls = 0;
  const Page = lazyPage(() => (++calls === 1 ? first.promise : retry.promise));
  const current = mount(Page);
  await settle();
  locale.value = "zh-CN";
  await nextTick();
  assert.match(text(current.host), /正在加载页面/);
  first.reject(new Error("internal module path must not become product text"));
  await settle();
  assert.equal(calls, 1);
  assert.match(text(current.host), /页面未能加载/);
  assert.doesNotMatch(text(current.host), /internal module/);
  assert.ok(button(current.host, "重试页面"));
  locale.value = "en";
  await nextTick();
  assert.match(text(current.host), /The page could not be loaded/);
  button(current.host, "Retry page").props.onClick();
  await settle();
  assert.equal(calls, 2);
  assert.match(text(current.host), /Loading page/);
  retry.resolve({ default: content("ready after retry") });
  await settle();
  assert.equal(text(current.host), "ready after retry");
  current.app.unmount();
});

test("loaded pages receive current props, events, attributes and named slots without a DOM wrapper", async () => {
  const pending = deferred();
  const Page = lazyPage(() => pending.promise);
  const title = ref("first"), events = [];
  const Loaded = defineComponent({
    inheritAttrs: false,
    props: { title: String }, emits: ["context"],
    setup(props, { attrs, slots, emit }) {
      return () => h("article", attrs, [
        h("button", { onClick: () => emit("context", props.title) }, props.title),
        slots.default?.(), slots.footer?.(),
      ]);
    },
  });
  const host = node("root");
  const app = renderer.createApp({ setup: () => () => h(Page, {
    title: title.value, id: "route-page", onContext: value => events.push(value),
  }, { default: () => h("span", "body"), footer: () => h("span", "footer") }) });
  app.mount(host);
  title.value = "changed while pending";
  pending.resolve({ default: Loaded });
  await settle();
  assert.equal(host.children[0].tag, "article");
  assert.equal(host.children[0].props.id, "route-page");
  assert.equal(text(host), "changed while pendingbodyfooter");
  button(host, "changed while pending").props.onClick();
  assert.deepEqual(events, ["changed while pending"]);
  title.value = "changed after loading";
  await nextTick();
  assert.match(text(host), /changed after loading/);
  app.unmount();
});

test("late import success or failure does not render a page after leaving", async () => {
  for (const failure of [false, true]) {
    const pending = deferred();
    let setups = 0;
    const Loaded = defineComponent({ setup() { setups++; return () => h("p", "late"); } });
    const Page = lazyPage(() => pending.promise);
    const current = mount(Page);
    await settle();
    current.app.unmount();
    if (failure) pending.reject(new Error("late failure"));
    else pending.resolve({ default: Loaded });
    await settle();
    assert.equal(current.host.children.length, 0);
    assert.equal(setups, 0);
  }
});

test("retry preserves mounted sibling drafts and refresh is exclusively an explicit user action", async () => {
  const originalWindow = globalThis.window;
  let reloads = 0, loads = 0, siblingSetups = 0;
  globalThis.window = { location: { reload() { reloads++; } } };
  const siblingDraft = ref("unsaved draft");
  const Sibling = defineComponent({ setup() { siblingSetups++; return () => h("input", { value: siblingDraft.value }); } });
  const retry = deferred();
  const Page = lazyPage(() => { loads++; return loads === 1 ? Promise.reject(new Error("missing old chunk")) : retry.promise; });
  const current = mount(defineComponent({ setup: () => () => h("div", [h(Sibling), h(Page)]) }));
  try {
    await settle();
    assert.equal(reloads, 0);
    assert.equal(loads, 1);
    button(current.host, "Retry page").props.onClick();
    await settle();
    assert.equal(reloads, 0);
    assert.equal(loads, 2);
    assert.equal(siblingSetups, 1);
    assert.equal(all(current.host).find(item => item.tag === "input").props.value, "unsaved draft");
    retry.reject(new Error("still missing"));
    await settle();
    assert.equal(reloads, 0);
    button(current.host, "Refresh page").props.onClick();
    assert.equal(reloads, 1);
    assert.equal(siblingSetups, 1);
  } finally {
    current.app.unmount();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("preloading only imports the selected module; mount joins the pending import and reuses its result", async () => {
  let imports = 0, setups = 0, apiCalls = 0;
  const pending = deferred();
  const Loaded = defineComponent({ setup() { setups++; apiCalls++; return () => h("p", "preloaded page"); } });
  const Page = lazyPage(() => { imports++; return pending.promise; });
  const preloading = Page.preload();
  await settle();
  assert.equal(imports, 1);
  assert.equal(setups, 0);
  assert.equal(apiCalls, 0);
  const current = mount(Page);
  await settle();
  assert.match(text(current.host), /Loading page/);
  assert.equal(imports, 1);
  pending.resolve({ default: Loaded });
  await preloading;
  await settle();
  assert.equal(text(current.host), "preloaded page");
  assert.equal(setups, 1);
  assert.equal(apiCalls, 1);
  current.app.unmount();
  const ready = mount(Page);
  assert.equal(text(ready.host), "preloaded page");
  assert.equal(imports, 1);
  ready.app.unmount();
});

test("a failed preload is retained through further preloads and mount until an explicit retry", async () => {
  let imports = 0, setups = 0;
  const Loaded = defineComponent({ setup() { setups++; return () => h("p", "retried preload"); } });
  const retry = deferred();
  const Page = lazyPage(() => { imports++; return imports === 1 ? Promise.reject(new Error("preload failed")) : retry.promise; });
  await assert.rejects(Page.preload(), /preload failed/);
  await assert.rejects(Page.preload(), /preload failed/);
  assert.equal(imports, 1);
  assert.equal(setups, 0);
  const current = mount(Page);
  await settle();
  assert.match(text(current.host), /The page could not be loaded/);
  assert.equal(imports, 1, "mount must not implicitly retry a failed preload");
  button(current.host, "Retry page").props.onClick();
  await settle();
  assert.equal(imports, 2);
  retry.resolve({ default: Loaded });
  await settle();
  assert.equal(text(current.host), "retried preload");
  assert.equal(setups, 1);
  current.app.unmount();
});

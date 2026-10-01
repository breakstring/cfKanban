import { defineComponent, h, onMounted, onUnmounted, ref, shallowRef } from "vue";
import type { Component } from "vue";
import { locale } from "./i18n";

export type LazyPage<T extends Component> = T & { preload: () => Promise<void> };

export function lazyPage<T extends Component>(loader: () => Promise<{ default: T }>): LazyPage<T> {
  let cached: T | null = null;
  let pending: Promise<T> | null = null;

  function importPage(retry = false): Promise<T> {
    if (cached !== null) return Promise.resolve(cached);
    if (retry) pending = null;
    if (pending === null) {
      pending = Promise.resolve().then(loader).then(module => {
        cached = module.default;
        return cached;
      });
    }
    return pending;
  }

  const wrapper = defineComponent({
    name: "LazyPage",
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      const component = shallowRef<T | null>(cached);
      const loading = ref(cached === null);
      const failed = ref(false);
      let generation = 0;

      async function load(retry = false): Promise<void> {
        if (retry && loading.value) return;
        const current = ++generation;
        loading.value = true;
        failed.value = false;
        try {
          const result = await importPage(retry);
          if (current === generation) component.value = result;
        } catch {
          if (current === generation) failed.value = true;
        } finally {
          if (current === generation) loading.value = false;
        }
      }

      onMounted(() => { if (component.value === null) void load(); });
      onUnmounted(() => { generation += 1; });

      return () => {
        if (component.value !== null) return h(component.value, attrs, slots);
        const chinese = locale.value === "zh-CN";
        if (loading.value) return h("div", { class: "page-state", role: "status", "aria-busy": "true" }, [
          h("span", { class: "spinner", "aria-hidden": "true" }),
          h("span", chinese ? "正在加载页面…" : "Loading page…"),
        ]);
        if (failed.value) return h("div", { class: "page-state error-state", role: "alert" }, [
          h("p", chinese
            ? "页面未能加载。请重试；如果仍失败，请刷新获取最新版本。"
            : "The page could not be loaded. Retry, or refresh to get the latest version."),
          h("button", { class: "secondary-button", type: "button", onClick: () => { void load(true); } }, chinese ? "重试页面" : "Retry page"),
          h("button", { class: "secondary-button", type: "button", onClick: () => window.location.reload() }, chinese ? "刷新页面" : "Refresh page"),
        ]);
        return null;
      };
    },
  });
  return Object.assign(wrapper, { preload: () => importPage().then(() => undefined) }) as unknown as LazyPage<T>;
}

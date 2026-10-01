// 领域组件测试只替换 UI 库边界；真实弹层、焦点和样式由浏览器验收。
export function nuxtUiTestPlugin() {
  return {
    name: "nuxt-ui-component-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^@nuxt\/ui\/components\/[^/]+\.vue$/ }, ({ path }) => ({
        path: path.split("/").at(-1).replace(".vue", ""), namespace: "nuxt-ui-test",
      }));
      builder.onLoad({ filter: /.*/, namespace: "nuxt-ui-test" }, ({ path }) => ({
        contents: componentSource(path), loader: "js", resolveDir: process.cwd(),
      }));
    },
  };
}

function componentSource(name) {
  if (!["App", "Avatar", "Badge", "Button", "Card", "Checkbox", "DropdownMenu", "Input", "Modal", "Select", "Textarea"].includes(name)) {
    throw new Error(`Add a native-semantic test adapter for Nuxt UI ${name}`);
  }
  return `
import { defineComponent, h } from "vue";
export default defineComponent({
  name: "U${name}TestAdapter",
  inheritAttrs: false,
  props: ["modelValue", "modelModifiers", "items", "open", "title", "close", "dismissible", "color", "variant", "size", "ui", "icon", "leadingIcon", "trailingIcon", "loading", "alt", "label", "to", "href"],
  emits: ["update:modelValue", "update:open"],
  setup(props, { attrs, slots, emit }) {
    const value = event => event?.target?.value ?? event;
    const update = next => emit("update:modelValue", next);
    return () => {
      const name = ${JSON.stringify(name)};
      if (name === "DropdownMenu") return h("div", attrs, [
        slots.default?.(), slots["content-top"]?.(),
        ...(props.items ?? []).flat().map(item => h("button", { type: "button", disabled: item.disabled, onClick: item.onSelect }, item.label)),
      ]);
      if (name === "Modal") {
        if (props.open === false) return null;
        return h("section", { ...attrs, role: "dialog", "aria-label": props.title }, [
          h("h2", props.title),
          props.close === false ? null : h("button", {
            type: "button", disabled: props.close?.disabled, "aria-label": props.close?.["aria-label"] ?? "Close",
            onClick: () => { if (!props.close?.disabled) emit("update:open", false); },
          }, "×"),
          slots.body?.(), slots.footer?.(),
        ]);
      }
      if (["Input", "Textarea", "Select", "Checkbox"].includes(name)) {
        const tag = name === "Textarea" ? "textarea" : name === "Select" ? "select" : "input";
        const inputProps = {
          ...attrs,
          ...(props.modelValue === undefined ? {} : { value: props.modelValue }),
          "onUpdate:modelValue": update,
          onInput: event => { attrs.onInput?.(event); update(value(event)); },
        };
        if (name === "Select") inputProps.onChange = event => { attrs.onChange?.(event); update(value(event)); };
        if (name === "Checkbox") {
          inputProps.type = "checkbox";
          inputProps.checked = props.modelValue;
          inputProps.onChange = event => update(event.target.checked);
        }
        const options = name === "Select" ? (props.items ?? []).flat().map(item => {
          const option = typeof item === "object" ? item : { value: item, label: item };
          return h("option", { value: option.value, disabled: option.disabled }, option.label);
        }) : undefined;
        return h(tag, inputProps, options);
      }
      if (name === "Avatar") return h("span", { ...attrs, "aria-hidden": "true" }, (props.alt ?? "").slice(0, 1));
      const tag = name === "Button" ? (props.to || props.href ? "a" : "button") : name === "Badge" ? "span" : name === "Card" ? "article" : "div";
      return h(tag, {
        ...attrs,
        ...(name === "Button" ? { type: attrs.type ?? "button", disabled: attrs.disabled === "" || Boolean(attrs.disabled || props.loading), ...(props.to || props.href ? { href: props.to || props.href } : {}) } : {}),
      }, [slots.leading?.(), slots.header?.(), slots.default?.() ?? props.label, slots.footer?.(), slots.trailing?.()]);
    };
  },
});`;
}

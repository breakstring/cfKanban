import DefaultTheme from "vitepress/theme-without-fonts";
import type { Theme } from "vitepress";
import Layout from "./Layout.vue";
import LanguageEntry from "./LanguageEntry.vue";
import "./style.css";

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("LanguageEntry", LanguageEntry);
  },
} satisfies Theme;

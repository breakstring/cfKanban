import { defineConfig, type DefaultTheme } from "vitepress";
import { fileURLToPath } from "node:url";
import { readReleaseVersion } from "../../../scripts/lib/release-version.mjs";
import catalog from "../catalog.json";

const version = await readReleaseVersion(fileURLToPath(new URL("../../../", import.meta.url)));
type Locale = "en" | "zh-CN";
function sidebar(locale: Locale): DefaultTheme.SidebarItem[] {
  return catalog.map(group => ({
    text: group[locale],
    collapsed: true,
    items: group.pages.filter(page => !("hidden" in page && page.hidden)).map(page => ({
      text: page[locale],
      link: `/${locale}/${page.path.replace(/\/index$/u, "/")}`,
    })),
  }));
}
function theme(locale: Locale): DefaultTheme.Config {
  const zh = locale === "zh-CN";
  return {
    sidebar: sidebar(locale),
    socialLinks: [{ icon: "github", link: "https://github.com/breakstring/cfKanban", ariaLabel: zh ? "cfKanban GitHub 仓库" : "cfKanban on GitHub" }],
    outline: { level: [2, 3], label: zh ? "本页内容" : "On this page" },
    docFooter: { prev: zh ? "上一页" : "Previous page", next: zh ? "下一页" : "Next page" },
    sidebarMenuLabel: zh ? "目录" : "Menu",
    returnToTopLabel: zh ? "返回顶部" : "Return to top",
    langMenuLabel: zh ? "切换语言" : "Change language",
    skipToContentLabel: zh ? "跳到正文" : "Skip to content",
    externalLinkIcon: true,
  };
}

export default defineConfig({
  title: "cfKanban",
  description: "Agent-first collaboration. Guides for using, integrating, administering and deploying cfKanban.",
  base: "/docs/",
  outDir: "../web/dist/docs",
  cleanUrls: true,
  appearance: false,
  vite: {
    build: {
      assetsInlineLimit: file => /[\\/]cfkanban-mark-orange\.svg$/u.test(file) ? false : undefined,
    },
  },
  lastUpdated: false,
  head: [
    ["meta", { name: "cfkanban-docs", content: version }],
    ["meta", { name: "referrer", content: "no-referrer" }],
  ],
  transformHead({ assets }) {
    const logo = assets.find(asset => /cfkanban-mark-orange[^/]*\.svg$/u.test(asset));
    return logo ? [["link", { rel: "icon", href: logo }]] : [];
  },
  locales: {
    en: { label: "English", lang: "en", themeConfig: theme("en") },
    "zh-CN": { label: "简体中文", lang: "zh-CN", description: "以 Agent 为先的协作看板。了解如何使用、集成代理、管理和部署 cfKanban。", themeConfig: theme("zh-CN") },
  },
  themeConfig: {
    siteTitle: false,
    logoLink: { link: "/", target: "_self" },
    search: {
      provider: "local",
      options: {
        disableQueryPersistence: true,
        miniSearch: {
          options: {
            tokenize: (text: string) => text.match(/[\p{Script=Han}]|[\p{Script=Latin}\p{N}_-]+/gu) ?? [],
          },
          searchOptions: { combineWith: "AND" },
        },
        locales: {
          "zh-CN": {
            translations: {
              button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
              modal: {
                displayDetails: "显示详细内容", resetButtonTitle: "清除搜索", backButtonTitle: "关闭搜索",
                noResultsText: "没有找到相关文档", footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
              },
            },
          },
        },
      },
    },
  },
});

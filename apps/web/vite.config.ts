import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";
import { fileURLToPath } from "node:url";
import { readReleaseVersion, writeBuildVersion } from "../../scripts/lib/release-version.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
let releaseVersion: string;

export default defineConfig({
  plugins: [vue(), ui({
    router: false,
    colorMode: false,
    autoImport: false,
    components: false,
    dts: false,
    ui: {
      colors: { primary: "orange", neutral: "slate" },
      modal: { slots: { overlay: "z-40", content: "z-50" } },
      select: { slots: { content: "z-[60]" } },
      dropdownMenu: { slots: { content: "z-[60] data-[state=open]:animate-none data-[state=closed]:animate-none" } },
    },
    icon: { clientBundle: { scan: true } },
  }), {
    name: "cfkanban-release-version",
    apply: "build",
    async buildStart() {
      releaseVersion = await readReleaseVersion(repositoryRoot);
    },
    async closeBundle() {
      await writeBuildVersion({
        repositoryRoot,
        outputDirectory: fileURLToPath(new URL("./dist/", import.meta.url)),
        entry: "index.html",
        version: releaseVersion,
      });
    },
  }],
  build: {
    assetsInlineLimit: file => /[\\/]cfkanban-mark(?:-orange)?\.(?:svg|png)$/u.test(file) ? false : undefined,
    emptyOutDir: true,
    manifest: true,
    outDir: "dist",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "bootstrap", tags: ["$initial"], priority: 100 },
            // 首页共用的轻量工具独立保留，避免合并小组时带入认证弹窗等 UI 依赖。
            { name: "public-shared", test: /[\\/]src[\\/]lib[\\/](pagination|webauthn|homepage-notice|write-fence)\.ts$/, priority: 50 },
            { name: "shared", minShareCount: 2, entriesAware: true, entriesAwareMergeThreshold: 20_000 },
          ],
        },
      },
    },
  },
});

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
    emptyOutDir: true,
    outDir: "dist",
  },
});

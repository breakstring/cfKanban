import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
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
  })],
  build: {
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
    outDir: "dist-embedded/.staging",
    rolldownOptions: {
      input: fileURLToPath(new URL("./src/embedded/embedded.html", import.meta.url)),
      output: { codeSplitting: false },
    },
  },
});

import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import embedded from "./vite.embedded.config.ts";

export default mergeConfig(embedded, {
  build: {
    outDir: "dist-mcp-app/.staging",
    rolldownOptions: {
      input: fileURLToPath(new URL("./src/mcp-app/workbench.html", import.meta.url)),
    },
  },
});

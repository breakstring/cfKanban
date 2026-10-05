import { rm } from "node:fs/promises";

const targets = [
  new URL("../apps/web/dist/", import.meta.url),
  new URL("../apps/web/dist-embedded/", import.meta.url),
  new URL("../apps/web/dist-mcp-app/", import.meta.url),
  new URL("../apps/worker/dist/", import.meta.url),
  new URL("../packages/mcp/dist/", import.meta.url),
  new URL("../packages/cli/dist/", import.meta.url),
  new URL("../packages/local-runtime/dist/", import.meta.url),
  new URL("../build/dsh/", import.meta.url),
];

for (const target of targets) await rm(target, { recursive: true, force: true });
console.log("Removed scoped Worker, Web, MCP, local runtime and DSH build output.");

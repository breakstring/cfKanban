import { createMcpFacade as createFacade, MCP_TOOLS } from "../../skill-runtime/src/mcp-facade.mjs";
const VERSION = typeof __CFKANBAN_MCP_VERSION__ === "undefined" ? "source" : __CFKANBAN_MCP_VERSION__;
export { MCP_TOOLS };
export function createMcpFacade(options = {}) {
  return createFacade({ ...options, runtime: { name: "cfkanban-mcp", version: VERSION } });
}

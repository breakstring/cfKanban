import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import Workbench from "../embedded/Workbench.vue";
import { workbenchClientFactory } from "./provider";
import { createMcpAppClient } from "./client";
import { applyTheme } from "../lib/theme";
import "../style.css";
import "../ui.css";
import "../embedded/embedded.css";
import "./host.css";

declare const __CFKANBAN_MCP_APP_VERSION__: string;

createApp(Workbench).use(ui).provide(workbenchClientFactory, options => createMcpAppClient({
  ...options,
  version: __CFKANBAN_MCP_APP_VERSION__,
  document,
})).mount("#app");
applyTheme("orange");

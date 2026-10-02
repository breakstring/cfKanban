import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import Workbench from "./Workbench.vue";
import { applyTheme } from "../lib/theme";
import "../style.css";
import "../ui.css";
import "./embedded.css";

createApp(Workbench).use(ui).mount("#app");
applyTheme("orange");

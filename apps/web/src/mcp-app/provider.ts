import type { InjectionKey } from "vue";
import type { createEmbedClient, EmbedClientOptions } from "../embedded/client";

export type WorkbenchDisplayMode = "inline" | "fullscreen" | "pip";
export interface WorkbenchDisplayState {
  mode: WorkbenchDisplayMode | null;
  canExpand: boolean;
  requesting: boolean;
}
export interface WorkbenchClientOptions extends EmbedClientOptions {
  onDisplayMode?: (state: WorkbenchDisplayState) => void;
}
export type WorkbenchClient = ReturnType<typeof createEmbedClient> & { requestFullscreen?: () => Promise<boolean> };
export const workbenchClientFactory: InjectionKey<(options: WorkbenchClientOptions) => WorkbenchClient> = Symbol("cfkanban.workbench.client");

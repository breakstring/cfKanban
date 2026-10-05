import type { InjectionKey } from "vue";
import type { createEmbedClient } from "../embedded/client";

export const workbenchClientFactory: InjectionKey<typeof createEmbedClient> = Symbol("cfkanban.workbench.client");

import { resolveConfig } from "vite";

// Nuxt UI's Vite config hook writes its theme types before vue-tsc on a clean checkout.
await resolveConfig({}, "serve");

import { rm } from "node:fs/promises";

const targets = [
  new URL("../apps/web/dist/", import.meta.url),
  new URL("../apps/worker/dist/", import.meta.url),
];

for (const target of targets) await rm(target, { recursive: true, force: true });
console.log("Removed scoped Worker and Web build output.");

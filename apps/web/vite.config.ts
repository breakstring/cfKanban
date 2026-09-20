import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { readReleaseVersion, writeBuildVersion } from "../../scripts/lib/release-version.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
let releaseVersion: string;

export default defineConfig({
  plugins: [vue(), {
    name: "cfkanban-release-version",
    apply: "build",
    async buildStart() {
      releaseVersion = await readReleaseVersion(repositoryRoot);
    },
    async closeBundle() {
      await writeBuildVersion({
        repositoryRoot,
        outputDirectory: fileURLToPath(new URL("./dist/", import.meta.url)),
        entry: "index.html",
        version: releaseVersion,
      });
    },
  }],
  build: {
    emptyOutDir: true,
    outDir: "dist",
  },
});

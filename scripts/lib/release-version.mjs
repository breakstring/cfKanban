import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function readReleaseVersion(repositoryRoot) {
  const release = await json(path.join(repositoryRoot, "release/version.json"));
  if (!versionPattern.test(release.version)) throw new Error("Release declaration must contain strict semver without build metadata");
  const plugin = await json(path.join(repositoryRoot, ".codex-plugin/plugin.json"));
  if (plugin.version !== release.version) throw new Error("Plugin version does not match release/version.json");
  return release.version;
}

export async function writeBuildVersion({ repositoryRoot, outputDirectory, entry, version }) {
  if (await readReleaseVersion(repositoryRoot) !== version) throw new Error("Release version changed during build");
  const metadata = { release_version: version, entry, sha256: sha256(await readFile(path.join(outputDirectory, entry))) };
  await writeFile(path.join(outputDirectory, "build-version.json"), `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function verifyBuildVersion({ outputDirectory, entry, version }) {
  const metadata = await json(path.join(outputDirectory, "build-version.json"));
  if (metadata.release_version !== version || metadata.entry !== entry) throw new Error("Built artifact version does not match release version; rebuild before packaging");
  if (metadata.sha256 !== sha256(await readFile(path.join(outputDirectory, entry)))) throw new Error("Built artifact digest changed; rebuild before packaging");
}

export async function verifyReleaseBuild({ repositoryRoot, version }) {
  const declared = await readReleaseVersion(repositoryRoot);
  if (version !== declared) throw new Error("Requested bundle version does not match release/version.json");
  await verifyBuildVersion({ outputDirectory: path.join(repositoryRoot, "apps/worker/dist"), entry: "index.js", version });
  await verifyBuildVersion({ outputDirectory: path.join(repositoryRoot, "apps/web/dist"), entry: "index.html", version });
}

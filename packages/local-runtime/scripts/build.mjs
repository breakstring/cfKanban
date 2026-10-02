import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { verifyEmbeddedBuild } from "../../../scripts/lib/embedded-build.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
export const LOCAL_RUNTIME_FILES = Object.freeze([
  "browser.mjs", "embedded/embedded-build.json", "embedded/embedded.html",
  "launcher.mjs", "server.mjs", "THIRD_PARTY_NOTICES.txt", "workbench.mjs",
]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function collectFiles(root, relative = "") {
  const files = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const entry = relative ? `${relative}/${name}` : name;
    const info = await lstat(path.join(root, entry));
    if (info.isSymbolicLink()) throw new Error("Local runtime artifact rejects symbolic links");
    if (info.isDirectory()) files.push(...await collectFiles(root, entry));
    else if (info.isFile()) files.push(entry);
    else throw new Error("Local runtime artifact rejects non-regular files");
  }
  return files;
}

export async function verifyLocalRuntimeBuild({ outputDirectory, version }) {
  const metadata = JSON.parse(await readFile(path.join(outputDirectory, "build-metadata.json"), "utf8"));
  if (metadata.schema_version !== 1 || metadata.release_version !== version || metadata.protocol !== 1 || metadata.node_range !== ">=22.12.0" ||
      !metadata.files || typeof metadata.files !== "object" || Array.isArray(metadata.files)) {
    throw new Error("Local runtime metadata does not match the current release; rebuild before packaging");
  }
  const expected = [...LOCAL_RUNTIME_FILES].sort();
  const actual = (await collectFiles(outputDirectory)).filter((entry) => entry !== "build-metadata.json").sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) || JSON.stringify(Object.keys(metadata.files).sort()) !== JSON.stringify(expected)) {
    throw new Error("Local runtime metadata must cover the exact prebuilt payload");
  }
  for (const entry of expected) {
    const bytes = await readFile(path.join(outputDirectory, entry));
    if (metadata.files[entry]?.size_bytes !== bytes.length || metadata.files[entry]?.sha256 !== digest(bytes)) {
      throw new Error("Local runtime entry digest changed; rebuild before packaging");
    }
  }
  await verifyEmbeddedBuild({ outputDirectory: path.join(outputDirectory, "embedded"), version });
  return metadata;
}

async function dependencyNotices(inputs, root) {
  const dependencyRoots = new Set();
  for (const input of inputs) {
    const matched = input.match(/^(.*?node_modules\/(?:@[^/]+\/)?[^/]+)/);
    if (matched) dependencyRoots.add(matched[1]);
  }
  const notices = ["cfKanban local runtime bundled dependencies. The containing release supplies the cfKanban source license.\n"];
  for (const relative of [...dependencyRoots].sort()) {
    const directory = path.resolve(root, relative);
    const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    let license = "License text is supplied by the upstream package.";
    for (const entry of ["LICENSE", "LICENSE.txt", "LICENSE.md", "license", "LICENSE-MIT"]) {
      try { license = await readFile(path.join(directory, entry), "utf8"); break; } catch {}
    }
    notices.push(`\n--- ${metadata.name}@${metadata.version} (${metadata.license ?? "SEE LICENSE"}) ---\n${license}`);
  }
  return `${notices.join("\n")}\n`;
}

export async function buildLocalRuntime({ outputDirectory = path.join(packageRoot, "dist"), version, sourceRoot = repositoryRoot } = {}) {
  if (version === undefined) version = JSON.parse(await readFile(path.join(sourceRoot, "release/version.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("Local runtime build requires a fixed release version");
  const embeddedRoot = path.join(sourceRoot, "apps/web/dist-embedded");
  await verifyEmbeddedBuild({ outputDirectory: embeddedRoot, version });
  const { assertEmbeddedHtml } = await import(pathToFileURL(path.join(sourceRoot, "apps/web/scripts/build-embedded.mjs")).href);
  const html = await readFile(path.join(embeddedRoot, "embedded.html"), "utf8");
  assertEmbeddedHtml(html);
  const stage = await mkdtemp(path.join(os.tmpdir(), "cfkanban-local-build-"));
  try {
    const inputs = new Set();
    for (const [name, entry, platform] of [
      ["server", "src/server.mjs", "node"], ["launcher", "src/launcher.mjs", "node"],
      ["workbench", "src/workbench/index.mjs", "node"], ["browser", "src/browser.mjs", "browser"],
    ]) {
      const result = await build({
        absWorkingDir: sourceRoot, entryPoints: [path.join(sourceRoot, "packages/local-runtime", entry)],
        outfile: path.join(stage, `${name}.mjs`), bundle: true, platform, format: "esm",
        target: platform === "node" ? "node22.12" : "es2022", minify: true, legalComments: "inline", metafile: true, logLevel: "silent",
        loader: { ".html": "text", ".png": "dataurl" },
        define: { __CFKANBAN_LOCAL_VERSION__: JSON.stringify(version) },
        ...(platform === "node" ? { banner: { js: 'import { createRequire as __cfkanbanCreateRequire } from "node:module"; const require = __cfkanbanCreateRequire(import.meta.url);' } } : {}),
      });
      for (const input of Object.keys(result.metafile.inputs)) {
        if (input.replaceAll("\\", "/").includes("packages/dsh-plugin/")) throw new Error("Common local runtime must not depend on DSH source");
        inputs.add(input);
      }
      for (const output of Object.values(result.metafile.outputs)) {
        for (const imported of output.imports) {
          if (imported.external && (platform === "browser" || !isBuiltin(imported.path))) throw new Error("Local runtime must contain its complete dependency closure");
        }
      }
    }
    await mkdir(path.join(stage, "embedded"));
    await writeFile(path.join(stage, "embedded/embedded.html"), html);
    await cp(path.join(embeddedRoot, "embedded-build.json"), path.join(stage, "embedded/embedded-build.json"));
    await writeFile(path.join(stage, "THIRD_PARTY_NOTICES.txt"), await dependencyNotices(inputs, sourceRoot));
    const files = {};
    for (const entry of LOCAL_RUNTIME_FILES) {
      const bytes = await readFile(path.join(stage, entry));
      files[entry] = { sha256: digest(bytes), size_bytes: bytes.length };
    }
    const metadata = { schema_version: 1, release_version: version, protocol: 1, node_range: ">=22.12.0", files };
    await writeFile(path.join(stage, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    await verifyLocalRuntimeBuild({ outputDirectory: stage, version });
    await mkdir(outputDirectory, { recursive: true });
    await cp(stage, outputDirectory, { recursive: true });
    await verifyLocalRuntimeBuild({ outputDirectory, version });
    return { outputDirectory: path.resolve(outputDirectory), metadata };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

let isMain = false;
try { isMain = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (isMain) {
  const index = process.argv.indexOf("--version");
  const result = await buildLocalRuntime({ ...(index < 0 ? {} : { version: process.argv[index + 1] }) });
  console.log(`Built cfKanban local runtime ${result.metadata.release_version}: server, launcher, browser and shared workbench.`);
}

import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { verifyLocalRuntimeBuild } from "../../local-runtime/scripts/build.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKILLS = ["cfkanban-howto", "cfkanban", "cfkanban-admin", "cfkanban-deploy"];
const EMBEDDED_ENTRY = "embedded/embedded.html";

export async function collectArtifactFiles(root, relative = "") {
  const files = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const file = relative ? `${relative}/${name}` : name;
    const absolute = path.join(root, file);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error("DSH artifact rejects symbolic links");
    if (stat.isDirectory()) files.push(...await collectArtifactFiles(root, file));
    else if (stat.isFile()) files.push({ path: file, absolute, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
    else throw new Error("DSH artifact rejects non-regular files");
  }
  return files;
}

function putOctal(header, offset, width, value) {
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length >= width) throw new Error("DSH artifact tar field exceeds limit");
  header.write(`${text}\0`, offset, width, "ascii");
}

export async function writeDeterministicTarball({ root, outputPath }) {
  const parts = [];
  const files = await collectArtifactFiles(root);
  for (const file of files) {
    const content = await readFile(file.absolute);
    const name = `package/${file.path}`;
    const header = Buffer.alloc(512);
    if (Buffer.byteLength(name) <= 100) header.write(name, 0, 100);
    else {
      const separator = name.lastIndexOf("/");
      const prefix = name.slice(0, separator);
      const leaf = name.slice(separator + 1);
      if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(leaf) > 100) throw new Error("DSH artifact path exceeds ustar limit");
      header.write(leaf, 0, 100);
      header.write(prefix, 345, 155);
    }
    putOctal(header, 100, 8, file.mode);
    putOctal(header, 108, 8, 0);
    putOctal(header, 116, 8, 0);
    putOctal(header, 124, 12, content.length);
    putOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    parts.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(parts), { level: 9 });
  archive[9] = 255;
  await writeFile(outputPath, archive);
  return { outputPath, fileCount: files.length, sha256: createHash("sha256").update(archive).digest("hex"), size: archive.length };
}

function sourceIdentity(root) {
  try {
    const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    return {
      kind: "source-build",
      commit: execFileSync("git", ["rev-parse", "HEAD"], options).trim(),
      dirty: execFileSync("git", ["status", "--porcelain"], options).trim() !== "",
    };
  } catch { return { kind: "source-build", commit: null, dirty: null }; }
}

async function copyRegular(source, target) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("DSH artifact rejects symbolic source links");
  if (info.isDirectory()) await collectArtifactFiles(source);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: false });
}

async function buildClient(root, target, embeddedSource, embeddedHtml) {
  const requireBuild = createRequire(path.join(root, "packages", "mcp", "package.json"));
  const esbuild = requireBuild("esbuild");
  const canonicalEmbedded = realpathSync(embeddedSource);
  const result = await esbuild.build({
    entryPoints: [path.join(root, "packages", "dsh-plugin", "src", "client", "index.jsx")],
    absWorkingDir: root,
    bundle: true, write: false, platform: "browser", format: "cjs", target: "es2022", external: ["react"],
    loader: { ".png": "dataurl", ".html": "text" }, metafile: true,
    plugins: [{
      name: "fixed-embedded-document",
      setup(build) {
        build.onLoad({ filter: /\.html$/ }, ({ path: input }) => realpathSync(input) === canonicalEmbedded ? { contents: embeddedHtml, loader: "text" } : undefined);
      },
    }],
  });
  const embedsDocument = Object.values(result.metafile.outputs).some((output) => Object.entries(output.inputs).some(([input, contribution]) =>
    contribution.bytesInOutput > 0 && realpathSync(path.resolve(root, input)) === canonicalEmbedded));
  if (!embedsDocument) throw new Error("DSH client must embed the fixed offline HTML artifact");
  const body = result.outputFiles[0].text;
  const wrapped = `window.__ModuleLoader__.load({ id: "@cfkanban/dsh-plugin", factory(require) {\nconst module = { exports: {} }; const exports = module.exports;\n${body}\nreturn module.exports;\n} });\n`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, wrapped);
  return esbuild.version;
}

export async function buildDshPlugin({ outputDirectory, version, mcpDirectory = path.join(repositoryRoot, "packages", "mcp", "dist"), localRuntimeDirectory = path.join(repositoryRoot, "packages", "local-runtime", "dist"), sourceRoot = repositoryRoot }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("DSH artifact requires strict semver without build metadata");
  const output = path.resolve(outputDirectory);
  const stage = await mkdtemp(path.join(os.tmpdir(), "cfkanban-dsh-build-"));
  const packageDirectory = path.join(stage, "package");
  const pluginRoot = path.join(sourceRoot, "packages", "dsh-plugin");
  try {
    await mkdir(packageDirectory, { recursive: true });
    for (const entry of ["src", "cordis.patch.yml", "README.md", "README.zh-CN.md"]) {
      await copyRegular(path.join(pluginRoot, entry), path.join(packageDirectory, entry));
    }
    await copyRegular(path.join(sourceRoot, "LICENSE"), path.join(packageDirectory, "LICENSE"));
    for (const skill of SKILLS) await copyRegular(path.join(sourceRoot, "skills", skill), path.join(packageDirectory, "skills", skill));
    await copyRegular(path.join(sourceRoot, "packages", "skill-runtime"), path.join(packageDirectory, "packages", "skill-runtime"));
    for (const entry of ["server.mjs", "facade.mjs", "build-metadata.json", "THIRD_PARTY_NOTICES.txt"]) await copyRegular(path.join(mcpDirectory, entry), path.join(packageDirectory, "mcp", entry));
    const mcpMetadata = JSON.parse(await readFile(path.join(mcpDirectory, "build-metadata.json"), "utf8"));
    if (mcpMetadata.release_version !== version) throw new Error("DSH and MCP artifact release versions must match");
    if (mcpMetadata.schema_version !== 1 || mcpMetadata.transport !== "stdio" || mcpMetadata.node_range !== ">=22.12.0" || !Array.isArray(mcpMetadata.entries)) {
      throw new Error("DSH artifact requires verified prebuilt MCP metadata");
    }
    for (const name of ["server.mjs", "facade.mjs"]) {
      const matches = mcpMetadata.entries.filter((entry) => entry.path === name);
      const content = await readFile(path.join(packageDirectory, "mcp", name));
      if (matches.length !== 1 || matches[0].size_bytes !== content.length || matches[0].sha256 !== createHash("sha256").update(content).digest("hex")) {
        throw new Error("DSH artifact MCP entry integrity check failed");
      }
    }
    await verifyLocalRuntimeBuild({ outputDirectory: localRuntimeDirectory, version });
    await copyRegular(localRuntimeDirectory, path.join(packageDirectory, "local-runtime"));
    const localMetadata = await verifyLocalRuntimeBuild({ outputDirectory: path.join(packageDirectory, "local-runtime"), version });
    for (const entry of ["src/host/bridge.mjs", "src/host/scope.mjs", "src/shared/panel.mjs"]) {
      const wrapper = path.join(packageDirectory, entry);
      const source = await readFile(wrapper, "utf8");
      const relocated = source.replace(/(["'])\.\.\/\.\.\/\.\.\/local-runtime\/src\/workbench\/(?:index|bridge|scope|shared)\.mjs\1/g, '"../../local-runtime/workbench.mjs"');
      await writeFile(wrapper, relocated);
    }
    const metadata = JSON.parse(await readFile(path.join(pluginRoot, "package.json"), "utf8"));
    metadata.version = version;
    await writeFile(path.join(packageDirectory, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    const embeddedDirectory = path.join(sourceRoot, "apps", "web", "dist-embedded");
    const embeddedSource = path.join(embeddedDirectory, "embedded.html");
    await copyRegular(embeddedSource, path.join(packageDirectory, EMBEDDED_ENTRY));
    await copyRegular(path.join(embeddedDirectory, "embedded-build.json"), path.join(packageDirectory, "embedded", "embedded-build.json"));
    const embeddedBytes = await readFile(path.join(packageDirectory, EMBEDDED_ENTRY));
    const embeddedMetadata = JSON.parse(await readFile(path.join(packageDirectory, "embedded", "embedded-build.json"), "utf8"));
    const { assertEmbeddedHtml } = await import(pathToFileURL(path.join(sourceRoot, "apps", "web", "scripts", "build-embedded.mjs")).href);
    const embeddedInspection = await assertEmbeddedHtml(embeddedBytes.toString("utf8"));
    if (embeddedMetadata.schema_version !== 1 || embeddedMetadata.entry !== "embedded.html" || embeddedMetadata.protocol !== 1 || embeddedMetadata.release_version !== version ||
      embeddedMetadata.sha256 !== embeddedInspection.sha256 || embeddedMetadata.size_bytes !== embeddedBytes.length ||
      embeddedInspection.size_bytes !== embeddedBytes.length) {
      throw new Error("DSH artifact requires verified prebuilt embedded HTML metadata");
    }
    if (!embeddedBytes.equals(await readFile(path.join(packageDirectory, "local-runtime/embedded/embedded.html"))) ||
        !(await readFile(path.join(packageDirectory, "embedded/embedded-build.json"))).equals(await readFile(path.join(packageDirectory, "local-runtime/embedded/embedded-build.json")))) {
      throw new Error("DSH and local runtime must carry the same fixed Vue document");
    }
    const clientCompiler = await buildClient(sourceRoot, path.join(packageDirectory, "lib", "client.js"), embeddedSource, embeddedBytes.toString("utf8"));
    const panel = await import(pathToFileURL(path.join(pluginRoot, "src", "shared", "panel.mjs")).href);
    const files = [];
    for (const entry of await collectArtifactFiles(packageDirectory)) {
      if (entry.path.split("/").includes("node_modules")) throw new Error("DSH runtime payload must not depend on node_modules");
      const bytes = await readFile(entry.absolute);
      files.push({ path: entry.path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
    }
    const manifest = {
      schema_version: 1, release_version: version,
      source: sourceIdentity(sourceRoot),
      compatibility: { node: ">=22.12.0", dsh: "0.2.0-rc.2" },
      build: { client_compiler: { name: "esbuild", version: clientCompiler } },
      components: {
        skills: SKILLS, mcp: mcpMetadata, local_runtime: localMetadata,
        embedded: {
          framework: "vue", entry: EMBEDDED_ENTRY, format: "self-contained-html",
          release_version: embeddedMetadata.release_version, protocol_version: embeddedMetadata.protocol, sha256: embeddedMetadata.sha256,
          size_bytes: embeddedMetadata.size_bytes,
        },
        panel: {
          id: panel.PANEL_ID, protocol_version: panel.PANEL_PROTOCOL, kind: panel.PANEL_KIND,
          host_entry: "src/host/index.mjs", client_entry: "lib/client.js",
          client_role: "slot_message_port_bridge", host_role: "local_workbench_bridge",
          display: {
            framework: "vue", entry: EMBEDDED_ENTRY, format: "self-contained-html",
            isolation: "opaque-srcdoc", transport: "message-port",
          },
          optional: true, execution_scope: "local_single_user",
        },
      }, files,
    };
    await writeFile(path.join(packageDirectory, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(output, { recursive: true });
    const result = await writeDeterministicTarball({ root: packageDirectory, outputPath: path.join(output, `cfkanban-dsh-${version}.tgz`) });
    return { ...result, manifest };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

let isMain = false;
try { isMain = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (isMain) {
  const [outputDirectory, version] = process.argv.slice(2);
  if (!outputDirectory || !version) {
    process.stderr.write("Usage: node packages/dsh-plugin/scripts/build.mjs <output-directory> <version>\n");
    process.exitCode = 2;
  } else {
    const { manifest, ...result } = await buildDshPlugin({ outputDirectory, version });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

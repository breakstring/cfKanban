import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDshPlugin, collectArtifactFiles, writeDeterministicTarball } from "../scripts/build.mjs";
import { acceptsNode, resolveRuntime, verifyArtifact } from "../src/bundle.mjs";
import { LOCAL_RUNTIME_FILES, verifyLocalRuntimeBuild } from "../../local-runtime/scripts/build.mjs";
import { MCP_BUILD_FILES, verifyMcpBuild } from "../../../scripts/lib/mcp-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const version = JSON.parse(await readFile(path.join(root, "release/version.json"), "utf8")).version;

async function temporary(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cfkanban dsh test "));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("DSH Node selection uses the Host's absolute executable and preserves spaced argv", async () => {
  const result = resolveRuntime({ root: "/a package with spaces", execPath: process.execPath, versions: { node: "24.18.1", electron: "39.0.0" } });
  assert.equal(path.isAbsolute(result.nodeCommand), true);
  assert.deepEqual(result.mcpArgs, ["--expose-internals", "/a package with spaces/mcp/server.mjs"]);
  assert.deepEqual(result.mcpEnvironment, { ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(resolveRuntime({ execPath: process.execPath, versions: { node: "22.12.0" } }).mcpEnvironment.ELECTRON_RUN_AS_NODE, undefined);
  for (const candidate of ["22.11.9", "20.20.0", "unknown", "22.12"]) assert.equal(acceptsNode(candidate), false);
  for (const candidate of ["v22.12.0", "22.13.0", "24.18.1"]) assert.equal(acceptsNode(candidate), true);
  assert.throws(() => resolveRuntime({ execPath: process.execPath, versions: { node: "20.20.0" } }), /Node >=22.12.0/);
  assert.throws(() => resolveRuntime({ nodeExecutable: "node" }), /absolute path/);
  assert.throws(() => resolveRuntime({ nodeExecutable: "/missing/cfkanban-node" }));
  assert.equal(acceptsNode(resolveRuntime({ nodeExecutable: process.execPath }).nodeVersion), true);
});

test("prebuilt DSH archive keeps complete Skills resources and works outside the checkout", async () => {
  await temporary(async (directory) => {
    const artifact = await buildDshPlugin({ outputDirectory: directory, version });
    const archive = await readFile(artifact.outputPath);
    assert.equal(createHash("sha256").update(archive).digest("hex"), artifact.sha256);
    const extracted = path.join(directory, "isolated installation with spaces");
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", artifact.outputPath, "-C", extracted]);
    const packageRoot = path.join(extracted, "package");
    const manifest = verifyArtifact(packageRoot);
    const mcpMetadata = await verifyMcpBuild({ outputDirectory: path.join(packageRoot, "mcp"), version });
    assert.deepEqual(manifest.components.mcp, mcpMetadata);
    for (const entry of MCP_BUILD_FILES) {
      assert.deepEqual(await readFile(path.join(packageRoot, "mcp", entry)), await readFile(path.join(root, "packages/mcp/dist", entry)));
      assert.equal(manifest.files.some(file => file.path === `mcp/${entry}`), true);
    }
    const embedded = await readFile(path.join(root, "apps", "web", "dist-embedded", "embedded.html"));
    assert.deepEqual(await readFile(path.join(packageRoot, "embedded", "embedded.html")), embedded);
    assert.equal(manifest.release_version, version);
    assert.deepEqual(manifest.components.embedded, {
      framework: "vue", entry: "embedded/embedded.html", format: "self-contained-html",
      release_version: version, protocol_version: 1, sha256: createHash("sha256").update(embedded).digest("hex"),
      size_bytes: embedded.length,
    });
    assert.deepEqual(manifest.components.panel, {
      id: "@cfkanban/dsh-plugin", protocol_version: 1, kind: "cfkanban",
      host_entry: "src/host/index.mjs", client_entry: "lib/client.js", optional: true,
      client_role: "slot_message_port_bridge", host_role: "local_workbench_bridge",
      display: {
        framework: "vue", entry: "embedded/embedded.html", format: "self-contained-html",
        isolation: "opaque-srcdoc", transport: "message-port",
      },
      execution_scope: "local_single_user",
    });
    assert.equal(manifest.source.kind, "source-build");
    const localMetadata = await verifyLocalRuntimeBuild({ outputDirectory: path.join(packageRoot, "local-runtime"), version });
    assert.deepEqual(manifest.components.local_runtime, localMetadata);
    for (const entry of [...LOCAL_RUNTIME_FILES, "build-metadata.json"]) {
      assert.deepEqual(await readFile(path.join(packageRoot, "local-runtime", entry)), await readFile(path.join(root, "packages/local-runtime/dist", entry)));
    }
    assert.deepEqual(await readFile(path.join(packageRoot, "local-runtime/embedded/embedded.html")), embedded);
    assert.equal(typeof manifest.source.dirty, "boolean");
    assert.equal(manifest.files.some((entry) => entry.path.includes("node_modules")), false);
    assert.equal(manifest.files.some((entry) => entry.path.startsWith("scripts/") || entry.path.startsWith("tests/")), false);
    for (const entry of ["embedded/embedded.html", "embedded/embedded-build.json", "src/host/scope.mjs", "local-runtime/workbench.mjs", "local-runtime/browser.mjs", "local-runtime/server.mjs", "local-runtime/launcher.mjs", "packages/skill-runtime/src/scope.mjs", "packages/skill-runtime/src/utils.mjs", "packages/skill-runtime/src/errors.mjs"]) {
      assert.equal(manifest.files.some((file) => file.path === entry), true);
    }
    for (const entry of ["src/host/bridge.mjs", "src/host/scope.mjs", "src/shared/panel.mjs"]) {
      const wrapper = await readFile(path.join(packageRoot, entry), "utf8");
      assert.equal(wrapper.includes("local-runtime/src/"), false);
      assert.match(wrapper, /\.\.\/\.\.\/local-runtime\/workbench\.mjs/);
      await import(pathToFileURL(path.join(packageRoot, entry)).href);
    }
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(metadata.version, version);
    assert.deepEqual(metadata.dsh.bundle, { patch: "./cordis.patch.yml" });
    assert.equal(metadata.dsh.client.platform, "web");
    assert.equal(metadata.main, "./src/host/index.mjs");
    assert.equal(metadata.exports["."], "./src/host/index.mjs");
    assert.equal(metadata.exports["./bundle"], "./src/bundle.mjs");
    assert.equal(metadata.scripts, undefined);
    assert.equal(metadata.dependencies, undefined);
    assert.equal(metadata.peerDependencies["@deepseek-ai/dsh-client-connection"], "0.2.0-rc.2");
    assert.equal(metadata.peerDependenciesMeta["@deepseek-ai/dsh-client-connection"].optional, true);
    const patch = await readFile(path.join(packageRoot, "cordis.patch.yml"), "utf8");
    assert.match(patch, /providerName: cfkanban/);
    assert.match(patch, /includeDefaultRoots: false/);
    assert.match(patch, /serverName: cfkanban/);
    assert.match(patch, /id: cfkanban-bundle\s+name: '@cfkanban\/dsh-plugin\/bundle'/);
    assert.match(patch, /id: cfkanban-panel\s+name: '@cfkanban\/dsh-plugin'/);
    assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.equal(patch.includes("npx"), false);
    const service = resolveRuntime({ root: packageRoot });
    const argsExpression = /args: !!js '([^']+)'/.exec(patch)[1];
    const envExpression = /env: !!js '([^']+)'/.exec(patch)[1];
    const args = new Function("ctx", `return ${argsExpression}`)({ cfkanbanBundle: service });
    const environment = new Function("ctx", `return ${envExpression}`)({ cfkanbanBundle: service });
    assert.deepEqual(args, service.mcpArgs);
    assert.deepEqual(environment, service.mcpEnvironment);
    args.push("schema-default-probe");
    environment.probe = "schema-default-probe";
    assert.equal(service.mcpArgs.includes("schema-default-probe"), false);
    assert.equal(service.mcpEnvironment.probe, undefined);
    for (const [skill, surface] of [["cfkanban", "daily"], ["cfkanban-admin", "admin"], ["cfkanban-deploy", "deploy"]]) {
      const output = execFileSync(process.execPath, ["scripts/cfkanban-tool.mjs", "help"], { cwd: path.join(packageRoot, "skills", skill), encoding: "utf8" });
      const help = JSON.parse(output);
      assert.equal(help.ok, true);
      assert.equal(help.result.surface, surface);
    }
    for (const skill of ["cfkanban-howto", "cfkanban", "cfkanban-admin", "cfkanban-deploy"]) {
      for (const entry of await collectArtifactFiles(path.join(root, "skills", skill))) {
        assert.deepEqual(await readFile(path.join(packageRoot, "skills", skill, entry.path)), await readFile(entry.absolute));
      }
    }
    const registrations = [];
    const client = await readFile(path.join(packageRoot, "lib", "client.js"), "utf8");
    const logo = await readFile(path.join(root, "apps", "web", "src", "assets", "cfkanban-mark-orange.svg"));
    vm.runInNewContext(client, { window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } } });
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].id, "@cfkanban/dsh-plugin");
    const exports = registrations[0].factory((name) => {
      assert.equal(name, "react");
      return { useEffect() {}, createElement: (type, props, ...children) => ({ type, props, children }) };
    });
    assert.equal(typeof exports.apply, "function");
    assert.equal(exports.inject.includes("sidebarRightTabs"), true);
    const button = exports.PanelButton({ open() {}, t: key => key });
    const logoUrl = button.children[0].props.src;
    assert.match(logoUrl, /^data:image\/svg\+xml(?:;base64)?,/);
    assert.deepEqual(Buffer.from(await (await fetch(logoUrl)).arrayBuffer()), logo);
    const manifestFile = path.join(packageRoot, "artifact-manifest.json");
    const originalManifest = await readFile(manifestFile, "utf8");
    const originalHost = await readFile(path.join(packageRoot, "src", "host", "bridge.mjs"));
    const incomplete = JSON.parse(originalManifest);
    incomplete.files = incomplete.files.filter((entry) => entry.path !== "src/host/bridge.mjs");
    await writeFile(manifestFile, JSON.stringify(incomplete));
    await writeFile(path.join(packageRoot, "src", "host", "bridge.mjs"), "tampered");
    assert.throws(() => verifyArtifact(packageRoot), /complete payload/);
    await writeFile(manifestFile, originalManifest);
    await writeFile(path.join(packageRoot, "src", "host", "bridge.mjs"), originalHost);
    await writeFile(path.join(packageRoot, "unexpected.mjs"), "unexpected");
    assert.throws(() => verifyArtifact(packageRoot), /complete payload/);
    await rm(path.join(packageRoot, "unexpected.mjs"));
    await symlink(path.join(directory, "outside"), path.join(packageRoot, "escape"));
    assert.throws(() => verifyArtifact(packageRoot), /symbolic link/);
    await rm(path.join(packageRoot, "escape"));
    await mkdir(path.join(packageRoot, "node_modules"));
    await writeFile(path.join(packageRoot, "node_modules", "host-managed-peer.txt"), "host package-manager metadata");
    assert.equal(verifyArtifact(packageRoot).release_version, version);
    const workbenchPath = path.join(packageRoot, "mcp", "workbench.html");
    const originalWorkbench = await readFile(workbenchPath);
    await writeFile(workbenchPath, "tampered");
    assert.throws(() => verifyArtifact(packageRoot), /integrity check failed/);
    await writeFile(workbenchPath, originalWorkbench);
    await writeFile(path.join(packageRoot, "mcp", "server.mjs"), "tampered");
    assert.throws(() => verifyArtifact(packageRoot), /integrity check failed/);
  });
});

test("DSH packaging rejects stale or altered local runtime prebuilds", async () => {
  await temporary(async (directory) => {
    const localRuntimeDirectory = path.join(directory, "local runtime");
    await cp(path.join(root, "packages/local-runtime/dist"), localRuntimeDirectory, { recursive: true });
    const metadataPath = path.join(localRuntimeDirectory, "build-metadata.json");
    const original = await readFile(metadataPath, "utf8");
    const metadata = JSON.parse(original);
    metadata.release_version = "0.0.1";
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(buildDshPlugin({ outputDirectory: directory, version, localRuntimeDirectory }), /Local runtime metadata/);
    await writeFile(metadataPath, original);
    await writeFile(path.join(localRuntimeDirectory, "server.mjs"), "tampered");
    await assert.rejects(buildDshPlugin({ outputDirectory: directory, version, localRuntimeDirectory }), /Local runtime entry digest/);
    await cp(path.join(root, "packages/local-runtime/dist/server.mjs"), path.join(localRuntimeDirectory, "server.mjs"));
    metadata.release_version = version;
    delete metadata.files["workbench.mjs"];
    await writeFile(metadataPath, JSON.stringify(metadata));
    await assert.rejects(buildDshPlugin({ outputDirectory: directory, version, localRuntimeDirectory }), /exact prebuilt payload/);
  });
});

test("DSH build rejects mismatched versions and modified MCP build entries", async () => {
  await temporary(async (directory) => {
    const mcpDirectory = path.join(directory, "mcp");
    await cp(path.join(root, "packages", "mcp", "dist"), mcpDirectory, { recursive: true });
    await assert.rejects(buildDshPlugin({ outputDirectory: directory, version: "1.0.0", mcpDirectory }), /versions must match/);
    for (const entry of ["server.mjs", "workbench.html", "mcp-app-build.json"]) {
      const target = path.join(mcpDirectory, entry);
      const original = await readFile(target);
      await writeFile(target, "tampered");
      await assert.rejects(buildDshPlugin({ outputDirectory: directory, version, mcpDirectory }), /integrity check failed/);
      await writeFile(target, original);
    }
  });
});

test("DSH tarball is deterministic and refuses symlink escape", async () => {
  await temporary(async (directory) => {
    const payload = path.join(directory, "payload");
    await mkdir(payload);
    await writeFile(path.join(payload, "package.json"), "{}\n");
    await writeFile(path.join(payload, "unicode-中文.txt"), "portable\n");
    const first = await writeDeterministicTarball({ root: payload, outputPath: path.join(directory, "first.tgz") });
    const second = await writeDeterministicTarball({ root: payload, outputPath: path.join(directory, "second.tgz") });
    assert.equal(first.sha256, second.sha256);
    assert.deepEqual(await readFile(first.outputPath), await readFile(second.outputPath));
    await symlink(path.join(directory, "outside"), path.join(payload, "escape"));
    await assert.rejects(writeDeterministicTarball({ root: payload, outputPath: path.join(directory, "escape.tgz") }), /symbolic links/);
  });
});

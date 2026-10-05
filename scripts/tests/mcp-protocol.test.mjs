import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpStateFixture } from "./mcp-fixture.mjs";
import { MCP_BUILD_FILES } from "../lib/mcp-build.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceOutput = path.join(repositoryRoot, "packages/mcp/dist");
async function isolatedBundle(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfkanban MCP path with spaces "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "installed artifact");
  await mkdir(root);
  for (const name of MCP_BUILD_FILES) await copyFile(path.join(sourceOutput, name), path.join(root, name));
  return { home, root, entry: path.join(root, "server.mjs") };
}
function startPeer(t, entry, home) {
  const child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env: { HOME: home, USERPROFILE: home, PATH: "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let buffer = "", stderr = "", id = 0;
  const pending = new Map(), frames = [];
  child.stderr.on("data", chunk => { stderr += chunk; });
  // stdout 的 chunk 可能截断多字节字符；流解码器保留未完成的 UTF-8 字节。
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0"); frames.push(message);
      const target = pending.get(message.id);
      if (target) { pending.delete(message.id); clearTimeout(target.timer); target.resolve(message); }
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 5000);
    pending.set(requestId, { resolve, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  const notify = (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  return { child, request, notify, frames, stderr: () => stderr, close: async () => { const closed = once(child, "close"); child.stdin.end(); return closed; } };
}

test("stdio peer preserves UTF-8 resource bytes split across stdout chunks", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cfkanban-mcp-utf8-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = path.join(directory, "fixture.mjs");
  await writeFile(entry, `process.stdin.once("data", () => {
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "工作台中文资源" } }) + "\\n");
    const split = bytes.indexOf(Buffer.from("工")) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 30);
  });`);
  const peer = startPeer(t, entry, directory);
  const response = await peer.request("resources/read");
  assert.equal(response.result.text, "工作台中文资源");
  assert.equal(response.result.text.includes("\uFFFD"), false);
});
async function initialize(peer) {
  const response = await peer.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "isolated-test-client", version: "1.0.0" } });
  assert.equal(response.error, undefined);
  assert.equal(response.result.serverInfo.name, "cfkanban-mcp");
  assert.deepEqual(response.result.capabilities.experimental?.["openai/mentions"], { searchTool: "cfkanban_mentions_search" });
  peer.notify("notifications/initialized");
  return response;
}

test("prebuilt artifact starts offline at a spaced absolute path with empty PATH, supports lifecycle and restarts", async t => {
  const bundle = await isolatedBundle(t);
  const metadata = JSON.parse(await readFile(path.join(bundle.root, "build-metadata.json"), "utf8"));
  for (const entry of metadata.entries) {
    const bytes = await readFile(path.join(bundle.root, entry.path));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    assert.equal(bytes.length, entry.size_bytes);
  }
  let previousViewId;
  for (let iteration = 0; iteration < 2; iteration++) {
    const peer = startPeer(t, bundle.entry, bundle.home);
    const before = await peer.request("tools/list");
    assert.equal(before.error.code, -32600);
    const initialized = await initialize(peer);
    assert.equal(initialized.result.serverInfo.version, metadata.release_version);
    const list = await peer.request("tools/list");
    assert.equal(list.result.tools.length, 26);
    const mentions = list.result.tools.find(tool => tool.name === "cfkanban_mentions_search");
    assert.deepEqual(mentions._meta["openai/extensions"], { "mentions/search": {} });
    assert.deepEqual(mentions._meta.ui.visibility, ["app"]);
    assert.equal(mentions._meta.connector_name, "cfkanban-search");
    const emptyMention = await peer.request("tools/call", { name: mentions.name, arguments: { query: "CFK-" } });
    assert.deepEqual(emptyMention.result.structuredContent, { items: [] });
    const legacyMention = await peer.request("tools/call", { name: mentions.name, arguments: { query: "CFK-1", path: [] } });
    assert.equal(legacyMention.result.isError, true);
    assert.equal(legacyMention.result.structuredContent.error.code, "MCP_INVALID_ARGUMENTS");
    const unknownReference = await peer.request("resources/read", { uri: "cfkanban://issue/unknown" });
    assert.equal(unknownReference.error.data.code, "MCP_MENTION_REFERENCE_UNKNOWN");
    for (const name of ["cfkanban_profile_locale_set", "cfkanban_labels_list", "cfkanban_issues_labels_add", "cfkanban_issues_labels_remove"]) {
      assert.ok(list.result.tools.some(tool => tool.name === name));
    }
    assert.ok(list.result.tools.every(tool => tool.inputSchema.additionalProperties === false));
    const opener = list.result.tools.find(tool => tool.name === "cfkanban_workbench_open");
    assert.deepEqual(opener._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
    const globalOpener = list.result.tools.find(tool => tool.name === "cfkanban_workbench_global_open");
    assert.deepEqual(globalOpener._meta["openai/ui"].entrypoints, [{ type: "global" }]);
    assert.equal(globalOpener._meta.ui.resourceUri, opener._meta.ui.resourceUri);
    const uiMetadata = JSON.parse(await readFile(path.join(bundle.root, "mcp-app-build.json"), "utf8"));
    assert.equal(opener._meta.ui.resourceUri, `ui://cfkanban/workbench/${metadata.release_version}/${uiMetadata.sha256}/index.html`);
    assert.equal(opener.icons.length, 1);
    assert.equal(opener.icons[0].mimeType, "image/svg+xml");
    assert.deepEqual(opener.icons[0].sizes, ["20x20"]);
    assert.match(opener.icons[0].src, /^data:image\/svg\+xml;base64,/);
    assert.deepEqual(Buffer.from(opener.icons[0].src.slice("data:image/svg+xml;base64,".length), "base64"), await readFile(path.join(repositoryRoot, "apps/web/src/assets/cfkanban-mark.svg")));
    const resources = await peer.request("resources/list");
    assert.equal(resources.result.resources.length, 1);
    const resource = await peer.request("resources/read", { uri: opener._meta.ui.resourceUri });
    assert.equal(resource.result.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.deepEqual(resource.result.contents[0]._meta["openai/ui"], { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen" });
    assert.equal(resource.result.contents[0].text, await readFile(path.join(bundle.root, "workbench.html"), "utf8"));
    await writeFile(path.join(bundle.root, "workbench.html"), `${resource.result.contents[0].text}\n<!-- changed -->`);
    assert.ok((await peer.request("resources/read", { uri: opener._meta.ui.resourceUri })).error);
    await writeFile(path.join(bundle.root, "workbench.html"), resource.result.contents[0].text);
    assert.ok((await peer.request("resources/read", { uri: "file:///arbitrary" })).error);
    assert.ok((await peer.request("resources/read", { uri: `ui://cfkanban/workbench/${metadata.release_version}/index.html` })).error);
    const opened = await peer.request("tools/call", { name: "cfkanban_workbench_open", arguments: {} });
    assert.equal(opened.result.structuredContent.ok, true);
    assert.ok(opened.result._meta["cfkanban/viewId"]);
    if (previousViewId) {
      const stale = await peer.request("tools/call", { name: "cfkanban_workbench_snapshot", arguments: { view_id: previousViewId } });
      assert.equal(stale.result.structuredContent.error.code, "PANEL_BINDING_EXPIRED");
    }
    previousViewId = opened.result._meta["cfkanban/viewId"];
    assert.equal(JSON.stringify(opened.result.content).includes(opened.result._meta["cfkanban/viewId"]), false);
    assert.deepEqual((await peer.request("ping")).result, {});
    const inspect = await peer.request("tools/call", { name: "cfkanban_connection_inspect", arguments: {} });
    assert.equal(inspect.result.isError, false);
    assert.deepEqual(inspect.result.structuredContent.data.candidates, []);
    assert.equal(inspect.result.structuredContent.data.runtime.version, metadata.release_version);
    const bad = await peer.request("tools/call", { name: "cfkanban_issues_get", arguments: { instance_id: randomUUID(), identifier: "CFK-1", stateRoot: bundle.home } });
    assert.equal(bad.result.isError, true);
    assert.equal(bad.result.structuredContent.error.code, "MCP_INVALID_ARGUMENTS");
    const missing = await peer.request("tools/call", { name: "cfkanban_any_api", arguments: {} });
    assert.equal(missing.result.structuredContent.error.code, "MCP_TOOL_NOT_FOUND");
    const [code] = await peer.close();
    assert.equal(code, 0);
    assert.equal(peer.stderr(), "");
    assert.ok(peer.frames.every(frame => frame.jsonrpc === "2.0"));
  }
});

test("stdio state refusal never prints credential or local state paths, including an independent process lock", async t => {
  const bundle = await isolatedBundle(t);
  const fixture = await createMcpStateFixture(t);
  const peer = startPeer(t, bundle.entry, fixture.home);
  await initialize(peer);
  const credentialsRoot = path.join(fixture.stateRoot, "instances", fixture.instanceId, "credentials");
  await writeFile(path.join(credentialsRoot, "owner-devices.lock"), "isolated fixture lock", { mode: 0o600 });
  const refused = await peer.request("tools/call", { name: "cfkanban_issues_get", arguments: { instance_id: fixture.instanceId, identifier: "CFK-1" } });
  assert.equal(refused.result.structuredContent.error.code, "OWNER_DEVICE_LOCKED");
  const token = JSON.parse(await readFile(path.join(credentialsRoot, "current.secret.json"), "utf8")).token;
  const output = JSON.stringify(refused) + peer.stderr();
  assert.equal(output.includes(fixture.home), false);
  assert.equal(output.includes(token), false);
  await rm(path.join(credentialsRoot, "owner-devices.lock"));
  await writeFile(path.join(credentialsRoot, "identity-switch.json"), JSON.stringify({ phase: "credential_promoted" }), { mode: 0o600 });
  const incomplete = await peer.request("tools/call", { name: "cfkanban_issues_get", arguments: { instance_id: fixture.instanceId, identifier: "CFK-1" } });
  assert.equal(incomplete.result.structuredContent.error.code, "IDENTITY_SWITCH_INCOMPLETE");
  assert.equal((await peer.close())[0], 0);
});

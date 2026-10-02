import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpStateFixture } from "./mcp-fixture.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceOutput = path.join(repositoryRoot, "packages/mcp/dist");
async function isolatedBundle(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "cfkanban MCP path with spaces "));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "installed artifact");
  await mkdir(root);
  for (const name of ["server.mjs", "facade.mjs", "build-metadata.json"]) await copyFile(path.join(sourceOutput, name), path.join(root, name));
  return { home, root, entry: path.join(root, "server.mjs") };
}
function startPeer(t, entry, home) {
  const child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env: { HOME: home, USERPROFILE: home, PATH: "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  let buffer = "", stderr = "", id = 0;
  const pending = new Map(), frames = [];
  child.stderr.on("data", chunk => { stderr += chunk; });
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
async function initialize(peer) {
  const response = await peer.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "isolated-test-client", version: "1.0.0" } });
  assert.equal(response.error, undefined);
  assert.equal(response.result.serverInfo.name, "cfkanban-mcp");
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
  for (let iteration = 0; iteration < 2; iteration++) {
    const peer = startPeer(t, bundle.entry, bundle.home);
    const before = await peer.request("tools/list");
    assert.equal(before.error.code, -32600);
    const initialized = await initialize(peer);
    assert.equal(initialized.result.serverInfo.version, metadata.release_version);
    const list = await peer.request("tools/list");
    assert.equal(list.result.tools.length, 16);
    assert.ok(list.result.tools.every(tool => tool.inputSchema.additionalProperties === false));
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

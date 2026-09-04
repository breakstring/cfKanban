import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { toolError } from "./errors.mjs";
import { classifyExecutionEnvironment, resolveStateRoot } from "./paths.mjs";
import { checkTrustedOriginRebind } from "./rebind.mjs";
import { getInstancePaths } from "./state.mjs";
import { apiRequest } from "./transport.mjs";
import { isPlainObject, readJson, requireString, requireUuid } from "./utils.mjs";

const INVITE_CODE_PATTERN = /^cfi_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/u;
const LAUNCH_CODE_PATTERN = /^cfl_v1_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/u;
const STDOUT_ACKNOWLEDGEMENT = "I understand this one-time capability may be retained by the Agent host";
const DELIVERY_ENVIRONMENT_KEYS = new Set([
  "APPDATA", "COMSPEC", "DBUS_SESSION_BUS_ADDRESS", "DESKTOP_STARTUP_ID", "DISPLAY",
  "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOCALAPPDATA", "LOGNAME", "PATH", "PATHEXT",
  "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USER", "USERPROFILE", "WAYLAND_DISPLAY",
  "WSLENV", "WSL_DISTRO_NAME", "WSL_INTEROP", "XAUTHORITY", "XDG_RUNTIME_DIR",
]);

function requireDelivery(value, allowed, fallback) {
  const delivery = value === undefined ? fallback : requireString(value, "delivery", { max: 32 });
  if (!allowed.includes(delivery)) {
    throw toolError("INVALID_DELIVERY", "Unsupported one-time capability delivery channel", {
      allowed,
      delivery,
    });
  }
  return delivery;
}

function requireSensitiveStdoutAcknowledgement(value) {
  if (value !== STDOUT_ACKNOWLEDGEMENT) {
    throw toolError("SENSITIVE_STDOUT_ACKNOWLEDGEMENT_REQUIRED", "One-time capability output requires the exact acknowledgement from the Skill workflow", {
      acknowledgement: STDOUT_ACKNOWLEDGEMENT,
    });
  }
}

function validateCapabilityUrl(value, { expectedOrigin, pathname, pattern, field }) {
  let url;
  try {
    url = new URL(requireString(value, field, { max: 4096 }));
  } catch (error) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Service returned an invalid one-time capability URL", { field }, error);
  }
  const codes = url.searchParams.getAll("code");
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.origin !== expectedOrigin
    || url.pathname !== pathname
    || url.hash
    || [...url.searchParams.keys()].some((key) => key !== "code")
    || codes.length !== 1
    || !pattern.test(codes[0])
  ) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Service returned a one-time capability outside the trusted origin or expected shape", { field });
  }
  return url.href;
}

function safeTimestamp(value, field) {
  const timestamp = requireString(value, field, { max: 32 });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The one-time capability response contained an invalid timestamp", { field });
  }
  return timestamp;
}

function safeWorkspaceKey(value) {
  const key = requireString(value, "workspace_key", { max: 32 });
  if (!/^[a-z][a-z0-9-]{1,31}$/u.test(key)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response contained an invalid Workspace key");
  }
  return key;
}

function safeProjectKey(value) {
  const key = requireString(value, "project_key", { max: 16 });
  if (!/^[A-Z][A-Z0-9-]{1,15}$/u.test(key)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The one-time capability response contained an invalid Project key");
  }
  return key;
}

function safeIssueIdentifier(value) {
  const identifier = requireString(value, "identifier", { max: 64 });
  if (!/^CFK-[1-9][0-9]*$/u.test(identifier)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response contained an invalid Issue identifier");
  }
  return identifier;
}

function safeVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response contained an invalid version");
  }
  return value;
}

function safeEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The one-time capability response contained an invalid enum value", { field });
  }
  return value;
}

function safeBrowserLaunchResource(resource) {
  if (!isPlainObject(resource)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response is missing its resource");
  }
  return {
    id: requireUuid(resource.id, "launch_id"),
    created_at: safeTimestamp(resource.created_at, "created_at"),
    expires_at: safeTimestamp(resource.expires_at, "expires_at"),
    secret_available: resource.secret_available === true,
    target: safeBrowserLaunchTarget(resource.target),
  };
}

function safeBrowserLaunchTarget(target) {
  if (!isPlainObject(target)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response is missing its target");
  }
  if (target.kind === "project") {
    const workspaceKey = safeWorkspaceKey(target.workspace_key);
    const projectKey = safeProjectKey(target.project_key);
    const entryPath = `/app/w/${workspaceKey}/p/${projectKey}`;
    if (target.entry_path !== entryPath) {
      throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response contained an inconsistent Project entry path");
    }
    return {
      kind: "project",
      workspace_key: workspaceKey,
      project_key: projectKey,
      project_id: requireUuid(target.project_id, "project_id"),
      entry_path: entryPath,
    };
  }
  if (target.kind === "issue") {
    const identifier = safeIssueIdentifier(target.identifier);
    const workspaceKey = safeWorkspaceKey(target.workspace_key);
    const projectKey = safeProjectKey(target.project_key);
    const entryPath = `/app/issues/${identifier}`;
    if (target.entry_path !== entryPath) {
      throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response contained an inconsistent Issue entry path");
    }
    return {
      kind: "issue",
      identifier,
      issue_id: requireUuid(target.issue_id, "issue_id"),
      project_id: requireUuid(target.project_id, "project_id"),
      workspace_key: workspaceKey,
      project_key: projectKey,
      entry_path: entryPath,
    };
  }
  if (target.kind === "admin") {
    const entryPaths = {
      overview: "/app/admin",
      "workspaces-projects": "/app/admin?section=workspaces",
      access: "/app/admin?section=access",
      audit: "/app/admin?section=audit",
    };
    const section = requireString(target.section, "section", { max: 32 });
    if (target.entry_path !== entryPaths[section]) {
      throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response contained an inconsistent admin entry path");
    }
    return {
      kind: "admin",
      section,
      entry_path: entryPaths[section],
    };
  }
  throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response contained an unknown target kind");
}

function safeInvitationGrant(grant) {
  if (!isPlainObject(grant)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response contained an invalid grant");
  }
  return {
    project_id: requireUuid(grant.project_id, "project_id"),
    workspace_key: safeWorkspaceKey(grant.workspace_key),
    project_key: safeProjectKey(grant.project_key),
    role: safeEnum(grant.role, ["reader", "writer"], "role"),
  };
}

function safeBoundPrincipal(principal) {
  if (principal === null) return null;
  if (!isPlainObject(principal)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response contained an invalid bound Principal");
  }
  return {
    principal_id: requireUuid(principal.principal_id, "principal_id"),
  };
}

function safeInvitationResource(resource) {
  if (!isPlainObject(resource)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response is missing its resource");
  }
  return {
    id: requireUuid(resource.id, "invitation_id"),
    kind: safeEnum(resource.kind, ["project_grant", "principal_recovery"], "kind"),
    status: safeEnum(resource.status, ["active", "expired", "redeemed", "revoked"], "status"),
    version: safeVersion(resource.version),
    created_at: safeTimestamp(resource.created_at, "created_at"),
    expires_at: safeTimestamp(resource.expires_at, "expires_at"),
    code_fingerprint: /^cfi_v1_[A-Za-z0-9_-]{8}_…$/u.test(resource.code_fingerprint)
      ? resource.code_fingerprint
      : (() => { throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response contained an invalid code fingerprint"); })(),
    recovery_mode: safeEnum(resource.recovery_mode, [null, "rotation", "full_recovery"], "recovery_mode"),
    bound_principal: safeBoundPrincipal(resource.bound_principal ?? null),
    grants: Array.isArray(resource.grants) ? resource.grants.map(safeInvitationGrant) : [],
    secret_available: resource.secret_available === true,
  };
}

function safeOperation(operation, resource) {
  const eventCursor = operation.data?.event_cursor;
  if (
    operation.ok !== true
    || operation.status !== 200
    || typeof eventCursor !== "string"
    || eventCursor.trim().length === 0
    || eventCursor.length > 4096
    || operation.data?.idempotent_replay !== !resource.secret_available
  ) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The one-time capability response contained an inconsistent operation envelope");
  }
  return {
    ok: true,
    status: 200,
    event_cursor: eventCursor,
    idempotent_replay: operation.data.idempotent_replay,
    resource,
  };
}

function assertBrowserLaunchTargetMatchesRequest(target, requestedTarget) {
  if (!isPlainObject(requestedTarget) || target.kind !== requestedTarget.kind) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response did not match the requested target");
  }
  const matches = target.kind === "project"
    ? target.workspace_key === requestedTarget.workspace_key && target.project_key === requestedTarget.project_key
    : target.kind === "issue"
      ? target.identifier === requestedTarget.identifier
      : target.section === requestedTarget.section;
  if (!matches) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Browser Launch response did not match the requested target");
  }
}

function assertInvitationMatchesRequest(resource, body) {
  if (!isPlainObject(body) || resource.kind !== body.kind) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response did not match the requested kind");
  }
  if (resource.kind === "project_grant") {
    if (resource.bound_principal !== null || resource.recovery_mode !== null || !Array.isArray(body.grants)) {
      throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response mixed Project and recovery fields");
    }
    const expected = body.grants.map((grant) => {
      if (!isPlainObject(grant)) {
        throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response could not be matched to the requested Grants");
      }
      return `${requireUuid(grant.project_id, "project_id")}:${safeEnum(grant.role, ["reader", "writer"], "role")}`;
    }).sort();
    const actual = resource.grants.map((grant) => `${grant.project_id}:${grant.role}`).sort();
    if (expected.length !== actual.length || expected.some((entry, index) => entry !== actual[index])) {
      throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response did not match the requested Grants");
    }
    return;
  }
  const principalId = requireUuid(body.principal_id, "principal_id");
  const recoveryMode = safeEnum(body.recovery_mode, ["rotation", "full_recovery"], "recovery_mode");
  if (
    resource.bound_principal?.principal_id !== principalId
    || resource.recovery_mode !== recoveryMode
    || resource.grants.length !== 0
  ) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation response did not match the requested recovery target");
  }
}

function deliveryEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => (
    typeof value === "string" && (DELIVERY_ENVIRONMENT_KEYS.has(key) || key.startsWith("LC_"))
  )));
}

async function executableOnPath(name, { env, platform, accessImpl }) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const separator = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const directory of (env.PATH || "").split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, platform === "win32" ? `${name}${extension.toLowerCase()}` : name);
      try {
        await accessImpl(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep looking without exposing PATH contents.
      }
    }
  }
  return null;
}

function runDeliveryProcess(executable, args, { input = null, spawnImpl = spawn, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (code) => {
      if (settled) return;
      settled = true;
      reject(toolError(code, "The local one-time capability delivery helper failed", {
        executable: path.basename(executable),
      }));
    };
    const child = spawnImpl(executable, args, {
      env: deliveryEnvironment(env),
      shell: false,
      windowsHide: true,
      stdio: [input === null ? "ignore" : "pipe", "ignore", "ignore"],
    });
    child.once("error", () => fail("DELIVERY_HELPER_UNAVAILABLE"));
    child.once("exit", (code) => {
      if (settled) return;
      if (code !== 0) return fail("DELIVERY_HELPER_FAILED");
      settled = true;
      resolve();
    });
    if (input !== null) {
      child.stdin.once("error", () => fail("DELIVERY_HELPER_FAILED"));
      child.stdin.end(input);
    }
  });
}

export async function resolveSystemBrowserOpener({
  platform = process.platform,
  release = os.release(),
  env = process.env,
  accessImpl = access,
  spawnImpl = spawn,
} = {}) {
  const executionEnvironment = classifyExecutionEnvironment({ platform, release, env });
  if (executionEnvironment === "macos") {
    await accessImpl("/usr/bin/open", fsConstants.X_OK).catch(() => {
      throw toolError("BROWSER_DELIVERY_UNAVAILABLE", "The macOS browser opener is unavailable before creating a Browser Launch");
    });
    return {
      kind: "system_browser",
      open: (localUrl) => runDeliveryProcess("/usr/bin/open", [localUrl], { spawnImpl, env }),
    };
  }
  if (executionEnvironment === "windows-native") {
    const executable = await executableOnPath("cmd", { env, platform, accessImpl });
    if (executable === null) {
      throw toolError("BROWSER_DELIVERY_UNAVAILABLE", "The Windows browser opener is unavailable before creating a Browser Launch");
    }
    return {
      kind: "system_browser",
      open: (localUrl) => runDeliveryProcess(executable, ["/d", "/s", "/c", "start", "", localUrl], { spawnImpl, env }),
    };
  }
  if (executionEnvironment === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw toolError("BROWSER_DELIVERY_UNAVAILABLE", "No graphical Linux browser session was detected before creating a Browser Launch", {
      execution_environment: executionEnvironment,
    });
  }
  const candidates = executionEnvironment === "wsl2"
    ? [["wslview", []], ["xdg-open", []]]
    : [["xdg-open", []], ["gio", ["open"]]];
  for (const [name, prefix] of candidates) {
    const executable = await executableOnPath(name, { env, platform, accessImpl });
    if (executable !== null) {
      return {
        kind: "system_browser",
        open: (localUrl) => runDeliveryProcess(executable, [...prefix, localUrl], { spawnImpl, env }),
      };
    }
  }
  throw toolError("BROWSER_DELIVERY_UNAVAILABLE", "No supported browser opener was found before creating a Browser Launch", {
    execution_environment: executionEnvironment,
  });
}

export async function resolveClipboardWriter({
  platform = process.platform,
  release = os.release(),
  env = process.env,
  accessImpl = access,
  spawnImpl = spawn,
} = {}) {
  const executionEnvironment = classifyExecutionEnvironment({ platform, release, env });
  if (executionEnvironment === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    throw toolError("CLIPBOARD_DELIVERY_UNAVAILABLE", "No graphical Linux clipboard session was detected before creating an Invitation", {
      execution_environment: executionEnvironment,
    });
  }
  const candidates = executionEnvironment === "macos"
    ? [["/usr/bin/pbcopy", []]]
    : executionEnvironment === "windows-native" || executionEnvironment === "wsl2"
      ? [["clip", []], ["clip.exe", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [name, args] of candidates) {
    let executable = null;
    if (path.isAbsolute(name)) {
      try {
        await accessImpl(name, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        executable = name;
      } catch {
        executable = null;
      }
    } else {
      executable = await executableOnPath(name, { env, platform, accessImpl });
    }
    if (executable !== null) {
      return {
        kind: "clipboard",
        write: (value) => runDeliveryProcess(executable, args, { input: value, spawnImpl, env }),
      };
    }
  }
  throw toolError("CLIPBOARD_DELIVERY_UNAVAILABLE", "No supported clipboard helper was found before creating an Invitation", {
    execution_environment: executionEnvironment,
  });
}

export async function relayToBrowser(targetUrl, openLocalUrl, { timeoutMs = 15_000 } = {}) {
  const nonce = randomBytes(24).toString("base64url");
  const expectedPath = `/${nonce}`;
  let delivered;
  let rejectDelivery;
  const deliveredPromise = new Promise((resolve, reject) => {
    delivered = resolve;
    rejectDelivery = reject;
  });
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== expectedPath) {
      response.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    try {
      response.writeHead(302, {
        "cache-control": "no-store",
        location: targetUrl,
        "referrer-policy": "no-referrer",
      });
      response.end(() => delivered());
    } catch {
      rejectDelivery(toolError("BROWSER_RELAY_FAILED", "The local Browser Launch relay could not deliver its redirect"));
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(toolError("BROWSER_RELAY_FAILED", "The local Browser Launch relay could not bind to loopback")));
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw toolError("BROWSER_RELAY_FAILED", "The local Browser Launch relay did not expose a loopback port");
  }
  let timer;
  try {
    const localUrl = `http://127.0.0.1:${address.port}${expectedPath}`;
    await openLocalUrl(localUrl);
    await Promise.race([
      deliveredPromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(toolError("BROWSER_OPEN_TIMEOUT", "The browser did not reach the local one-time relay before it expired")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
  }
}

export function assertGenericApiPathIsNonSensitive({ method = "GET", apiPath }) {
  const normalizedMethod = requireString(method, "method", { max: 16 }).trim().toUpperCase();
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requireString(apiPath, "api_path"), "https://local.invalid").pathname);
    if (pathname.length > 1) pathname = pathname.replace(/\/+$/u, "");
  } catch (error) {
    throw toolError("INVALID_API_PATH", "API path must be a same-origin absolute path", {}, error);
  }
  const dedicatedCommand = normalizedMethod === "POST" && pathname === "/api/v1/web-launches"
    ? "web launch"
    : normalizedMethod === "POST" && pathname === "/api/v1/admin/invitations"
      ? "invite create"
      : null;
  if (dedicatedCommand !== null) {
    throw toolError("SENSITIVE_DELIVERY_REQUIRED", "This operation can return a one-time secret and must use its dedicated command", {
      command: dedicatedCommand,
    });
  }
}

export async function guardedApiRequest(input) {
  assertGenericApiPathIsNonSensitive(input);
  return apiRequest(input);
}

export async function createBrowserLaunchAndDeliver({
  stateRoot = resolveStateRoot(),
  instanceId,
  target,
  idempotencyKey,
  delivery: requestedDelivery,
  sensitiveOutputAcknowledgement,
  fetchImpl = globalThis.fetch,
  browserOpener = null,
} = {}) {
  const delivery = requireDelivery(requestedDelivery, ["system_browser", "stdout_once"], "system_browser");
  let resolvedBrowserOpener = browserOpener;
  if (delivery === "system_browser") {
    resolvedBrowserOpener ??= await resolveSystemBrowserOpener();
    if (typeof resolvedBrowserOpener?.open !== "function") {
      throw toolError("BROWSER_DELIVERY_UNAVAILABLE", "The browser opener is invalid before creating a Browser Launch");
    }
  } else {
    requireSensitiveStdoutAcknowledgement(sensitiveOutputAcknowledgement);
  }
  await checkTrustedOriginRebind({ stateRoot, instanceId, fetchImpl });
  const metadata = await readJson(getInstancePaths({ stateRoot, instanceId }).instanceMetadata);
  const operation = await apiRequest({
    stateRoot,
    instanceId,
    method: "POST",
    apiPath: "/api/v1/web-launches",
    body: { target },
    idempotencyKey,
    fetchImpl,
  });
  if (!operation.ok) return operation;
  const resource = safeBrowserLaunchResource(operation.data?.resource);
  assertBrowserLaunchTargetMatchesRequest(resource.target, target);
  const safeResult = safeOperation(operation, resource);
  if (!resource.secret_available) {
    return {
      ...safeResult,
      delivery: { channel: delivery, delivered: false, reason: "one_time_secret_not_available_on_replay" },
    };
  }
  const launchUrl = validateCapabilityUrl(operation.data.resource.launch_url, {
    expectedOrigin: metadata.trusted_api_origin,
    pathname: "/app/launch",
    pattern: LAUNCH_CODE_PATTERN,
    field: "launch_url",
  });
  if (delivery === "stdout_once") {
    return {
      ...safeResult,
      delivery: {
        channel: "stdout_once",
        classification: "one_time_bearer_capability",
        delivered: true,
        expires_at: resource.expires_at,
        handling: "Do not log, quote, journal, receipt, or repeat this value.",
      },
      sensitive_output: launchUrl,
    };
  }
  try {
    await relayToBrowser(launchUrl, resolvedBrowserOpener.open);
  } catch (error) {
    throw toolError("BROWSER_DELIVERY_FAILED_AFTER_COMMIT", "The Browser Launch was created but could not be opened; its secret will expire without being returned", {
      committed: true,
      launch_id: resource.id,
      expires_at: resource.expires_at,
      recovery: "create_new_launch_after_fixing_browser_delivery",
    }, error);
  }
  return {
    ...safeResult,
    delivery: { channel: "system_browser", delivered: true, capability_exposed: false },
  };
}

export async function createInvitationAndDeliver({
  stateRoot = resolveStateRoot(),
  instanceId,
  body,
  idempotencyKey,
  delivery: requestedDelivery,
  sensitiveOutputAcknowledgement,
  fetchImpl = globalThis.fetch,
  clipboardWriter = null,
} = {}) {
  const delivery = requireDelivery(requestedDelivery, ["clipboard", "stdout_once"], "clipboard");
  let resolvedClipboardWriter = clipboardWriter;
  if (delivery === "clipboard") {
    resolvedClipboardWriter ??= await resolveClipboardWriter();
    if (typeof resolvedClipboardWriter?.write !== "function") {
      throw toolError("CLIPBOARD_DELIVERY_UNAVAILABLE", "The clipboard writer is invalid before creating an Invitation");
    }
  } else {
    requireSensitiveStdoutAcknowledgement(sensitiveOutputAcknowledgement);
  }
  await checkTrustedOriginRebind({ stateRoot, instanceId, fetchImpl });
  const metadata = await readJson(getInstancePaths({ stateRoot, instanceId }).instanceMetadata);
  const operation = await apiRequest({
    stateRoot,
    instanceId,
    method: "POST",
    apiPath: "/api/v1/admin/invitations",
    body,
    idempotencyKey,
    fetchImpl,
  });
  if (!operation.ok) return operation;
  const resource = safeInvitationResource(operation.data?.resource);
  assertInvitationMatchesRequest(resource, body);
  const safeResult = safeOperation(operation, resource);
  if (!resource.secret_available) {
    return {
      ...safeResult,
      delivery: { channel: delivery, delivered: false, reason: "one_time_secret_not_available_on_replay" },
    };
  }
  const inviteUrl = validateCapabilityUrl(operation.data.resource.invite_url, {
    expectedOrigin: metadata.trusted_api_origin,
    pathname: "/invite",
    pattern: INVITE_CODE_PATTERN,
    field: "invite_url",
  });
  const copyText = requireString(operation.data.resource.copy_text, "copy_text", { max: 8192 });
  if (!copyText.includes(inviteUrl)) {
    throw toolError("INVALID_CAPABILITY_RESPONSE", "The Invitation copy text did not contain the exact trusted Invite URL");
  }
  if (delivery === "stdout_once") {
    return {
      ...safeResult,
      delivery: {
        channel: "stdout_once",
        classification: "one_time_bearer_capability",
        delivered: true,
        expires_at: resource.expires_at,
        handling: "Show only to the intended recipient; do not log, quote, journal, receipt, or repeat this value.",
      },
      sensitive_output: copyText,
    };
  }
  try {
    await resolvedClipboardWriter.write(copyText);
  } catch (error) {
    throw toolError("CLIPBOARD_DELIVERY_FAILED_AFTER_COMMIT", "The Invitation was created but could not be copied; its secret was not returned", {
      committed: true,
      invitation_id: resource.id,
      expires_at: resource.expires_at,
      recovery: "revoke_or_expire_then_create_a_replacement",
    }, error);
  }
  return {
    ...safeResult,
    delivery: { channel: "clipboard", delivered: true, capability_exposed: false },
  };
}

export const sensitiveStdoutAcknowledgement = STDOUT_ACKNOWLEDGEMENT;

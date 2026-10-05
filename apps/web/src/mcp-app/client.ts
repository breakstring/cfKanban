import type { EmbedClientOptions } from "../embedded/client";
import { emptySnapshot, parseActionMessage, parseSnapshotMessage } from "../embedded/protocol";
import type { ActionMessage, ActionPayloads, EmbedAction, EmbedLocale, EmbedSnapshot, PublicResult } from "../embedded/protocol";
import { detectedBrowserLocale, resolveLocalePreference } from "../lib/locale-preference";
import type { WorkbenchClientOptions, WorkbenchDisplayMode } from "./provider";

export const MCP_APP_PROTOCOL = "2026-01-26";
const VIEW_META = "cfkanban/viewId";
const SNAPSHOT_META = "cfkanban/snapshot";
const RECEIPT_META = "cfkanban/actionReceipt";
const REOPEN = "MCP_APP_REOPEN_REQUIRED";
const LIMIT_BYTES = 2_162_688;
const uncertainActions = new Set(["mutate", "quick_update", "create_issue", "set_locale", "recover"]);
type RecordValue = Record<string, unknown>;
type RpcResponse = { result?: unknown; error?: unknown };
type AppDocument = Pick<Document, "documentElement">;
export interface McpAppClientOptions extends WorkbenchClientOptions {
  version: string;
  document?: AppDocument;
  window: EmbedClientOptions["window"] & Partial<Pick<Window, "navigator">>;
}

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function fields(value: unknown, allowed: string[], required: string[] = allowed): value is RecordValue {
  return record(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
function displayMode(value: unknown): value is WorkbenchDisplayMode {
  return value === "inline" || value === "fullscreen" || value === "pip";
}
function bounded(value: unknown): boolean {
  let count = 0;
  function visit(item: unknown, depth: number): boolean {
    if (++count > 30_000 || depth > 24) return false;
    // MCP Apps 经 postMessage 传递的可选宿主字段可以保留 undefined。
    if (item === undefined || item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 262_144;
    if (Array.isArray(item)) return item.length <= 1000 && item.every(child => visit(child, depth + 1));
    return record(item) && Object.entries(item).every(([key, child]) => !["__proto__", "prototype", "constructor"].includes(key) && visit(child, depth + 1));
  }
  try { return visit(value, 0) && new TextEncoder().encode(JSON.stringify(value, (_key, entry) => entry === undefined ? null : entry)).length <= LIMIT_BYTES; } catch { return false; }
}
function publicResult(value: unknown, version: string): PublicResult | null {
  if (!fields(value, ["ok", "protocol", "version", "error", "outcome_unknown"], ["ok", "protocol", "version"])
    || typeof value.ok !== "boolean" || value.protocol !== 1 || value.version !== version
    || (value.outcome_unknown !== undefined && typeof value.outcome_unknown !== "boolean")
    || (value.error !== undefined && (!fields(value.error, ["code"]) || typeof value.error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value.error.code)))) return null;
  return { ok: value.ok, ...(value.error === undefined ? {} : { error: { code: (value.error as { code: string }).code } }), ...(value.outcome_unknown === undefined ? {} : { outcome_unknown: value.outcome_unknown as boolean }) };
}
function toolResult(value: unknown, version: string): { result: PublicResult; meta: RecordValue } | null {
  if (!fields(value, ["content", "structuredContent", "isError", "_meta"], ["content", "structuredContent"])
    || !Array.isArray(value.content) || (value.isError !== undefined && typeof value.isError !== "boolean")
    || (value._meta !== undefined && !record(value._meta))) return null;
  const result = publicResult(value.structuredContent, version);
  return result ? { result, meta: value._meta as RecordValue ?? {} } : null;
}
function receiptResult(value: unknown): PublicResult | null {
  if (!fields(value, ["ok", "error", "outcome_unknown"], ["ok"]) || typeof value.ok !== "boolean"
    || (value.outcome_unknown !== undefined && typeof value.outcome_unknown !== "boolean")
    || (value.error !== undefined && (!fields(value.error, ["code"]) || typeof value.error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value.error.code)))) return null;
  return value as PublicResult;
}

// 宿主样式只能设置颜色和尺寸；字体、URL 与品牌主色不进入 CSS。
const styleVariables: Record<string, string> = {
  "--color-background-primary": "--ui-bg", "--color-background-secondary": "--ui-bg-muted",
  "--color-background-tertiary": "--ui-bg-elevated", "--color-text-primary": "--ui-text",
  "--color-text-secondary": "--ui-text-muted", "--color-border-primary": "--ui-border",
  "--color-border-secondary": "--ui-border-accented", "--border-radius-md": "--radius-control",
  "--border-radius-lg": "--radius-card",
};
function safeStyle(name: string, value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  return name.startsWith("--border-radius-") ? /^(?:0|\d{1,2}(?:\.\d{1,2})?(?:px|rem))$/.test(value)
    : /^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|(?:rgb|rgba|hsl|hsla)\([\d.%\s,+/-]{1,80}\)|(?:transparent|currentColor|black|white))$/i.test(value);
}
export function applyHostContext(document: AppDocument | undefined, value: unknown): EmbedLocale | undefined {
  if (!record(value)) return;
  const root = document?.documentElement;
  if (root) {
    if (value.theme === "light" || value.theme === "dark") {
      root.dataset.mcpTheme = value.theme;
      root.classList.toggle("dark", value.theme === "dark");
    }
    if (["inline", "fullscreen", "pip"].includes(value.displayMode as string)) root.dataset.mcpDisplayMode = value.displayMode as string;
    if (record(value.styles) && record(value.styles.variables)) {
      for (const [name, target] of Object.entries(styleVariables)) {
        const entry = value.styles.variables[name];
        if (safeStyle(name, entry)) root.style.setProperty(target, entry);
        else root.style.removeProperty(target);
      }
    }
  }
  return typeof value.locale === "string" && value.locale.trim() ? resolveLocalePreference(null, [value.locale]) : undefined;
}

export function createMcpAppClient(options: McpAppClientOptions) {
  let disposed = false;
  let initialized = false;
  let reopened = false;
  let announced = false;
  let viewId: string | null = null;
  let locale: EmbedLocale = detectedBrowserLocale(options.window.navigator);
  let snapshot: EmbedSnapshot = emptySnapshot();
  let initial: unknown = null;
  let outcomeUnknown = false;
  let originalAction: ActionMessage | null = null;
  let snapshotRequest: Promise<PublicResult> | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let syncAttempt = 0;
  let syncing = false;
  let currentDisplayMode: WorkbenchDisplayMode | null = null;
  let availableDisplayModes: WorkbenchDisplayMode[] = [];
  let displayRevision = 0;
  let initialDisplayHandled = false;
  let displayRequest: Promise<boolean> | null = null;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pending = new Map<string, { resolve: (value: RpcResponse | null) => void; timer: ReturnType<typeof setTimeout> }>();
  const failed = (code: string, uncertain = false): PublicResult => ({ ok: false, error: { code }, ...(uncertain ? { outcome_unknown: true } : {}) });
  const post = (message: unknown) => options.window.parent.postMessage(message, "*");
  const announce = () => { if (!announced) { announced = true; options.onConnect(locale); preferFullscreen(); } };
  const connectionTimer = setTimeout(() => failClosed(initialized ? "MCP_APP_INITIAL_RESULT_TIMEOUT" : "MCP_APP_HOST_INIT_TIMEOUT"), timeoutMs);
  function finish(id: string, result: RpcResponse | null) {
    const waiter = pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(id);
    waiter.resolve(result);
  }
  function failClosed(code = REOPEN) {
    if (disposed || reopened) return;
    reopened = true;
    viewId = null;
    clearTimeout(connectionTimer);
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    syncing = false;
    options.onError(code);
    for (const id of pending.keys()) finish(id, null);
  }
  function request(method: string, params: RecordValue): Promise<RpcResponse | null> {
    if (disposed || reopened || pending.size >= 16) return Promise.resolve(null);
    const id = (options.makeId ?? (() => crypto.randomUUID()))();
    if (typeof id !== "string" || !/^[\da-f-]{36}$/i.test(id) || pending.has(id)) return Promise.resolve(null);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        finish(id, null);
        try { post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "View request timed out" } }); } catch { /* 父层仍保留原写操作。 */ }
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try { post({ jsonrpc: "2.0", id, method, params }); } catch { finish(id, null); }
    });
  }
  function publishDisplayMode() {
    options.onDisplayMode?.({ mode: currentDisplayMode, canExpand: availableDisplayModes.includes("fullscreen"), requesting: displayRequest !== null });
  }
  function consumeHostContext(value: unknown): EmbedLocale | undefined {
    if (!record(value)) return;
    if (Object.hasOwn(value, "availableDisplayModes")) availableDisplayModes = Array.isArray(value.availableDisplayModes) && value.availableDisplayModes.every(displayMode) ? [...new Set(value.availableDisplayModes)] : [];
    if (displayMode(value.displayMode)) {
      currentDisplayMode = value.displayMode;
      displayRevision++;
      if (currentDisplayMode === "fullscreen") initialDisplayHandled = true;
    }
    publishDisplayMode();
    return applyHostContext(options.document, value);
  }
  function preferFullscreen() {
    if (initialDisplayHandled) return;
    initialDisplayHandled = true;
    if (currentDisplayMode !== "fullscreen") void requestFullscreen();
  }
  function requestFullscreen(): Promise<boolean> {
    if (!initialized || !announced || !viewId || disposed || reopened || !availableDisplayModes.includes("fullscreen")) return Promise.resolve(false);
    if (currentDisplayMode === "fullscreen") return Promise.resolve(true);
    if (displayRequest) return displayRequest;
    const revision = displayRevision;
    displayRequest = request("ui/request-display-mode", { mode: "fullscreen" }).then(response => {
      if (disposed || reopened) return false;
      const value = response?.result;
      // 后续宿主通知可以表示用户已退出；过时响应不能覆盖它。
      if (!response?.error && record(value) && displayMode(value.mode) && revision === displayRevision) consumeHostContext({ displayMode: value.mode });
      return currentDisplayMode === "fullscreen";
    }).finally(() => {
      displayRequest = null;
      if (!disposed && !reopened) publishDisplayMode();
    });
    publishDisplayMode();
    return displayRequest;
  }
  function consumeSnapshot(meta: RecordValue): boolean {
    const parsed = parseSnapshotMessage(meta[SNAPSHOT_META]);
    if (!parsed) return false;
    snapshot = parsed.state;
    announce();
    options.onSnapshot(snapshot);
    return true;
  }
  function settleOriginal(result: PublicResult) {
    if (!originalAction || result.outcome_unknown || snapshot.pending) return;
    const original = originalAction;
    originalAction = null;
    outcomeUnknown = false;
    options.onActionSettled?.(original, result);
  }
  function consumeReceipt(meta: RecordValue) {
    if (!originalAction || !fields(meta[RECEIPT_META], ["id", "result"])) return;
    const receipt = meta[RECEIPT_META];
    if (receipt.id !== originalAction.id) return;
    const result = receiptResult(receipt.result);
    if (result) settleOriginal(result);
  }
  async function call(name: string, args: RecordValue, uncertain = false, message?: ActionMessage): Promise<PublicResult> {
    if (!initialized || !viewId || disposed || reopened) return failed(REOPEN);
    const response = await request("tools/call", { name, arguments: { ...args, view_id: viewId, ...(name === "cfkanban_workbench_snapshot" && originalAction ? { action_id: originalAction.id } : {}) } });
    if (disposed || reopened) return failed(REOPEN, uncertain);
    const received = response && !response.error ? toolResult(response.result, options.version) : null;
    if (!received) {
      if (uncertain) { outcomeUnknown = true; originalAction ??= message ?? null; }
      if (uncertain) startSnapshotSync();
      const unknown = uncertain || originalAction !== null;
      const result = failed(unknown ? "EMBED_REQUEST_UNCERTAIN" : "EMBED_REQUEST_FAILED", unknown);
      options.onError(result.error!.code);
      return result;
    }
    const code = received.result.error?.code;
    if (code && (code === "PANEL_BINDING_EXPIRED" || /(?:VIEW|HANDLE).*(?:EXPIRED|REQUIRED|INVALID|MISSING|UNAVAILABLE)|WORKBENCH_NOT_OPEN/.test(code))) {
      failClosed(code.startsWith("MCP_APP_VIEW_ID_") ? code : REOPEN);
      return failed(REOPEN, uncertain || Boolean(received.result.outcome_unknown));
    }
    if (!consumeSnapshot(received.meta)) {
      if (uncertain) { outcomeUnknown = true; originalAction ??= message ?? null; }
      if (uncertain) startSnapshotSync();
      return failed(uncertain ? "EMBED_REQUEST_UNCERTAIN" : "EMBED_REQUEST_FAILED", uncertain);
    }
    if (received.result.outcome_unknown) { outcomeUnknown = true; originalAction ??= message ?? null; }
    consumeReceipt(received.meta);
    if (message?.action === "recover" && !received.result.outcome_unknown && !snapshot.pending) settleOriginal(received.result);
    return received.result;
  }
  function refreshSnapshot(): Promise<PublicResult> {
    if (!snapshotRequest) snapshotRequest = call("cfkanban_workbench_snapshot", {}).finally(() => { snapshotRequest = null; });
    return snapshotRequest;
  }
  function startSnapshotSync() {
    if (syncing || disposed || reopened) return;
    syncing = true;
    syncAttempt = 0;
    const synchronize = () => {
      if (disposed || reopened) { syncing = false; return; }
      syncTimer = setTimeout(() => {
        syncTimer = null;
        void refreshSnapshot().then(result => {
          if (disposed || reopened) { syncing = false; return; }
          if (!result.ok) { syncing = false; failClosed(); return; }
          if (snapshot.busy === 0) { syncing = false; return; }
          syncAttempt++;
          if (syncAttempt >= 10) { syncing = false; failClosed(); return; }
          synchronize();
        });
      }, syncAttempt >= 8 ? 1000 : 250);
    };
    synchronize();
  }
  function acceptInitial(value: unknown) {
    const received = toolResult(value, options.version);
    const nextViewId = received?.meta[VIEW_META];
    if (viewId && nextViewId === undefined) {
      if (received && consumeSnapshot(received.meta)) consumeReceipt(received.meta);
      return;
    }
    if (!received || !received.result.ok || typeof nextViewId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nextViewId)) { if (!viewId) failClosed("MCP_APP_INITIAL_RESULT_INVALID"); return; }
    if (viewId && viewId !== nextViewId) { failClosed(); return; }
    const first = viewId === null;
    viewId = nextViewId;
    if (consumeSnapshot(received.meta)) {
      clearTimeout(connectionTimer);
      announce();
      if (!first) void refreshSnapshot();
    } else if (first) {
      void refreshSnapshot().then(result => {
        if (disposed || reopened) return;
        if (!result.ok) { failClosed("MCP_APP_INITIAL_SNAPSHOT_INVALID"); return; }
        clearTimeout(connectionTimer);
        announce();
      });
    } else void refreshSnapshot();
  }
  function receive(event: MessageEvent) {
    if (disposed || reopened || event.source !== options.window.parent || !bounded(event.data) || !record(event.data) || event.data.jsonrpc !== "2.0") return;
    const message = event.data;
    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      if (!fields(message, ["jsonrpc", "id", "result", "error"], ["jsonrpc", "id"]) || typeof message.id !== "string" || !pending.has(message.id)
        || Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) return;
      if (message.error !== undefined && (!fields(message.error, ["code", "message", "data"], ["code", "message"]) || !Number.isInteger(message.error.code) || typeof message.error.message !== "string")) return;
      finish(message.id, { ...(message.error === undefined ? { result: message.result } : { error: message.error }) });
      return;
    }
    if (message.method === "ui/resource-teardown" && fields(message, ["jsonrpc", "id", "method", "params"], ["jsonrpc", "id", "method"]) && (typeof message.id === "string" || Number.isInteger(message.id)) && (message.params === undefined || record(message.params) && (message.params.reason === undefined || typeof message.params.reason === "string" && message.params.reason.length <= 1000))) {
      try { post({ jsonrpc: "2.0", id: message.id, result: {} }); } catch { /* 失联宿主不影响本地清理。 */ }
      dispose();
      return;
    }
    if (!fields(message, ["jsonrpc", "method", "params"]) || typeof message.method !== "string") return;
    if (message.method === "ui/notifications/tool-result") {
      if (initialized) acceptInitial(message.params);
      else if (initial === null) initial = message.params;
      else if (JSON.stringify(initial) !== JSON.stringify(message.params)) failClosed();
    } else if (message.method === "ui/notifications/host-context-changed" && initialized) {
      const changedLocale = consumeHostContext(message.params);
      if (changedLocale && changedLocale !== locale) {
        locale = changedLocale;
        if (announced) options.onConnect(locale);
      }
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    viewId = null;
    initial = null;
    originalAction = null;
    clearTimeout(connectionTimer);
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    syncing = false;
    options.window.removeEventListener("message", receive as EventListener);
    options.window.removeEventListener("pagehide", dispose);
    for (const id of pending.keys()) finish(id, null);
  }
  options.window.addEventListener("message", receive as EventListener);
  options.window.addEventListener("pagehide", dispose);
  void request("ui/initialize", {
    appInfo: { name: "cfKanban", version: options.version },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: MCP_APP_PROTOCOL,
  }).then(response => {
    if (disposed || reopened) return;
    const value = response?.result;
    if (!response) { failClosed("MCP_APP_HOST_INIT_TIMEOUT"); return; }
    if (response.error || !record(value)
      || value.protocolVersion !== MCP_APP_PROTOCOL || !record(value.hostInfo)
      || typeof value.hostInfo.name !== "string" || typeof value.hostInfo.version !== "string" || !record(value.hostCapabilities)
      || (value.hostContext !== undefined && !record(value.hostContext))) { failClosed("MCP_APP_HOST_INIT_INVALID"); return; }
    initialized = true;
    locale = consumeHostContext(value.hostContext) ?? locale;
    try { post({ jsonrpc: "2.0", method: "ui/notifications/initialized" }); } catch { failClosed("MCP_APP_HOST_INIT_INVALID"); return; }
    if (initial !== null) { acceptInitial(initial); initial = null; }
  });
  return {
    get connected() { return announced && initialized && viewId !== null && !disposed && !reopened; },
    requestFullscreen,
    async action<K extends EmbedAction>(action: K, payload: ActionPayloads[K]): Promise<PublicResult> {
      if (!announced || !initialized || !viewId || disposed || reopened) return failed(REOPEN);
      const id = (options.makeId ?? (() => crypto.randomUUID()))();
      const message = parseActionMessage({ type: "action", id, action, payload });
      if (!message) return failed("EMBED_INVALID_ACTION");
      if (outcomeUnknown || originalAction) {
        const refreshed = await refreshSnapshot();
        if (!refreshed.ok) return refreshed;
        // 超时后的首个交互只核对宿主快照，不重新发送原动作。
        if (!originalAction && !outcomeUnknown) return failed("MCP_APP_ACTION_SYNCED");
        if (action !== "recover" || !snapshot.pending) return failed("EMBED_REQUEST_UNCERTAIN", true);
      }
      return call("cfkanban_workbench_action", { message }, uncertainActions.has(action), message);
    },
    dispose,
  };
}

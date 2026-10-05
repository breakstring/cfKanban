import { isConnectMessage, parseActionMessage, parseRenderCancelMessage, parseRenderCheckMessage, parseResultMessage, parseSnapshotMessage, sameRenderTarget, snapshotRenderTarget } from "./protocol";
import type { ActionMessage, ActionPayloads, EmbedAction, EmbedLocale, EmbedSnapshot, PublicResult, RenderCheckMessage } from "./protocol";

export interface EmbedClientOptions {
  window: Pick<Window, "parent" | "addEventListener" | "removeEventListener">;
  onConnect: (locale: EmbedLocale) => void;
  onSnapshot: (state: EmbedSnapshot) => void;
  afterRender?: () => Promise<void>;
  onError: (code: string) => void;
  onActionSettled?: (message: ActionMessage, result: PublicResult) => void;
  makeId?: () => string;
  timeoutMs?: number;
}

export function createEmbedClient(options: EmbedClientOptions) {
  let port: MessagePort | null = null;
  let connected = false;
  let disposed = false;
  let snapshot: EmbedSnapshot | null = null;
  let renderCheck: RenderCheckMessage | null = null;
  const pending = new Map<string, { resolve: (result: PublicResult) => void; timer: ReturnType<typeof setTimeout>; uncertain: boolean }>();
  const failed = (code: string): PublicResult => ({ ok: false, error: { code } });
  const finish = (id: string, result: PublicResult) => {
    const waiter = pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(id);
    waiter.resolve(result);
  };
  const confirmRendered = async (message: RenderCheckMessage) => {
    const expectedSnapshot = snapshot;
    const expectedPort = port;
    renderCheck = message;
    if (!expectedSnapshot || !expectedPort || !options.afterRender || !sameRenderTarget(snapshotRenderTarget(expectedSnapshot), message.target)) return;
    try {
      await options.afterRender();
      if (disposed || renderCheck !== message || port !== expectedPort || snapshot !== expectedSnapshot
        || !sameRenderTarget(snapshotRenderTarget(snapshot), message.target)) return;
      renderCheck = null;
      expectedPort.postMessage({ type: "rendered", id: message.id, target: message.target });
    } catch { if (renderCheck === message) renderCheck = null; }
  };
  const receive = (event: MessageEvent) => {
    if (disposed) return;
    const receivedSnapshot = parseSnapshotMessage(event.data);
    if (receivedSnapshot) {
      renderCheck = null;
      snapshot = receivedSnapshot.state;
      options.onSnapshot(snapshot);
      return;
    }
    const check = parseRenderCheckMessage(event.data);
    if (check) { void confirmRendered(check); return; }
    const cancel = parseRenderCancelMessage(event.data);
    if (cancel) { if (renderCheck?.id === cancel.id) renderCheck = null; return; }
    const result = parseResultMessage(event.data);
    if (result) { if (!pending.has(result.id) && result.result.error) options.onError(result.result.error.code); finish(result.id, result.result); return; }
    options.onError("EMBED_INVALID_MESSAGE");
  };
  const connect = (event: MessageEvent) => {
    if (disposed || connected || event.source !== options.window.parent || !isConnectMessage(event.data) || event.ports.length !== 1) return;
    const transferred = event.ports[0];
    if (!transferred) return;
    connected = true;
    port = transferred;
    port.addEventListener("message", receive);
    port.addEventListener("messageerror", () => options.onError("EMBED_INVALID_MESSAGE"));
    port.start();
    options.onConnect(event.data.locale);
    options.window.removeEventListener("message", connect as EventListener);
  };
  options.window.addEventListener("message", connect as EventListener);
  return {
    get connected() { return connected && !disposed; },
    action<K extends EmbedAction>(action: K, payload: ActionPayloads[K]): Promise<PublicResult> {
      if (!port || disposed) return Promise.resolve(failed("EMBED_NOT_CONNECTED"));
      if (pending.size >= 16) return Promise.resolve(failed("EMBED_BUSY"));
      const id = (options.makeId ?? (() => crypto.randomUUID()))();
      const message = parseActionMessage({ type: "action", id, action, payload });
      if (!message || pending.has(id)) return Promise.resolve(failed("EMBED_INVALID_ACTION"));
      return new Promise(resolve => {
        const uncertain = ["mutate", "quick_update", "create_issue", "set_locale", "recover"].includes(action);
        const timer = setTimeout(() => {
          // 父层仍保留写操作；超时只能请求原操作恢复，不能重新生成业务键。
          const code = uncertain ? "EMBED_REQUEST_UNCERTAIN" : "EMBED_REQUEST_FAILED";
          finish(id, { ...failed(code), ...(uncertain ? { outcome_unknown: true } : {}) });
          options.onError(code);
        }, options.timeoutMs ?? 60_000);
        pending.set(id, { resolve, timer, uncertain });
        try { port?.postMessage(message); } catch { finish(id, { ...failed(uncertain ? "EMBED_REQUEST_UNCERTAIN" : "EMBED_REQUEST_FAILED"), ...(uncertain ? { outcome_unknown: true } : {}) }); }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      renderCheck = null;
      snapshot = null;
      options.window.removeEventListener("message", connect as EventListener);
      port?.removeEventListener("message", receive);
      port?.close();
      port = null;
      for (const [id, waiter] of pending) finish(id, { ...failed("EMBED_DISCONNECTED"), ...(waiter.uncertain ? { outcome_unknown: true } : {}) });
    },
  };
}

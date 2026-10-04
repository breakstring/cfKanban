import { WorkbenchController } from './workbench/controller.mjs';
import { WorkbenchAdapter } from './workbench/embed-adapter.mjs';

export async function mountLocalWorkbench({ document = globalThis.document, window = globalThis.window, fetchImpl = globalThis.fetch } = {}) {
  const configuration = document.getElementById('configuration');
  const config = JSON.parse(configuration.textContent);
  configuration.remove();
  const frame = document.getElementById('workbench');
  const status = document.getElementById('status');
  const online = document.getElementById('online');
  const close = document.getElementById('close');
  const ui = (english, chinese) => config.locale === 'zh-CN' ? chinese : english;
  close.title = ui('Close local service', '关闭本地服务');
  close.setAttribute('aria-label', close.title);
  status.textContent = ui('Local workbench', '本地工作台');
  const lifetime = new AbortController();
  let saving = Promise.resolve();
  let checkpointTimer;
  let controller;
  let onlinePending = config.online_pending;
  let onlineReceiptId = config.online_receipt_id;
  let onlineActive = false;
  let localUnavailable = false;
  async function post(endpoint, payload, signal) {
    try {
      const response = await fetchImpl(`./api/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cfkanban-csrf': config.csrf }, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify(payload), signal });
      const wire = await response.json();
      if (!wire.ok && ['LOCAL_SERVICE_EXPIRED', 'LOCAL_AUTH_REQUIRED'].includes(wire.error?.code)) {
        localUnavailable = true;
        status.textContent = ui('Local session ended. Ask your Agent to reopen it; verify any pending operation first.', '本地会话已结束，请让 Agent 重新打开；未确定操作须先核实。');
      } else if (wire.ok && localUnavailable) {
        localUnavailable = false;
        status.textContent = ui('Local workbench', '本地工作台');
      }
      return wire;
    } catch (error) {
      if (!lifetime.signal.aborted && !signal?.aborted) {
        localUnavailable = true;
        status.textContent = ui('Local service unavailable. Ask your Agent to reopen it; verify any pending operation first.', '本地服务不可用，请让 Agent 重新打开；未确定操作须先核实。');
      }
      throw error;
    }
  }
  function saveCheckpoint() {
    const checkpoint = controller.getCheckpoint();
    if (!checkpoint) return Promise.reject(new Error('LOCAL_CHECKPOINT_UNAVAILABLE'));
    saving = saving.catch(() => {}).then(async () => {
      const result = await post('checkpoint', { protocol: 1, input: checkpoint }, lifetime.signal);
      if (!result.ok) throw new Error('LOCAL_CHECKPOINT_UNAVAILABLE');
      return result;
    });
    return saving;
  }
  const rpc = { call: async (endpoint, payload, signal) => {
    if (['mutate', 'recover'].includes(endpoint)) await saveCheckpoint();
    return post(endpoint, payload, signal);
  } };
  controller = new WorkbenchController(rpc, lifetime.signal);
  const adapter = new WorkbenchAdapter(controller, null, () => {});
  function onlineState() {
    const state = controller.getSnapshot();
    frame.inert = Boolean(onlineActive || onlinePending);
    online.title = onlinePending ? ui('Recover original online opening', '核实恢复在线页面') : ui('Open full online board', '打开完整线上看板');
    online.setAttribute('aria-label', online.title);
    online.dataset.recovering = String(Boolean(onlinePending));
    online.disabled = onlineActive || (!onlinePending && (!state.binding || Boolean(state.pending || state.busy)));
  }
  const unsubscribe = controller.subscribe(() => {
    onlineState();
    clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(() => { void saveCheckpoint().catch(() => { if (!localUnavailable) status.textContent = ui('View recovery checkpoint unavailable', '本地视图恢复记录未保存'); }); }, 100);
  });
  frame.addEventListener('load', () => adapter.frameLoaded(frame, config.locale));
  frame.srcdoc = config.embeddedHtml;
  onlineState();
  if (onlinePending) status.textContent = ui('Online delivery uncertain; recover the original request', '在线交付未确定，请核实恢复原请求');
  online.addEventListener('click', async () => {
    const state = controller.getSnapshot();
    if (onlineActive || (!onlinePending && (!state.binding || state.pending || state.busy))) return;
    const target = onlinePending ?? { binding_id: state.binding.binding_id, ...(state.issue ? { identifier: state.issue.identifier } : {}) };
    const recovering = Boolean(onlinePending);
    const receiptId = onlineReceiptId ?? crypto.randomUUID();
    onlineActive = true;
    onlineState();
    let requested = false;
    try {
      await saveCheckpoint();
      requested = true;
      const wire = await post('open-online', { protocol: 1, input: { ...target, receipt_id: receiptId, recover: recovering } }, lifetime.signal);
      const unknown = wire.outcome_unknown || wire.value?.outcome_unknown;
      onlinePending = unknown ? target : wire.online_pending ?? null;
      onlineReceiptId = unknown ? receiptId : wire.online_receipt_id ?? receiptId;
      status.textContent = wire.outcome_unknown || wire.value?.outcome_unknown ? ui('Delivery uncertain; click to verify the original request', '交付不确定，再次点击核实原请求') : wire.ok && wire.value.ok && wire.value.delivery?.delivered ? ui('Delivered to system browser; verify the online page', '已交付系统浏览器，请核对在线页面') : ui('Online delivery failed', '在线页面未交付');
      if (wire.ok && !unknown && wire.online_pending) {
        // 只确认已收到的结果；确认失败不重试投递，也不推翻已知业务结果。
        try {
          const ack = await post('ack-online', { protocol: 1, input: { ...target, receipt_id: onlineReceiptId } }, lifetime.signal);
          if (ack.ok && ack.value?.ok) { onlinePending = ack.online_pending; onlineReceiptId = ack.online_receipt_id; }
        } catch {}
      }
    } catch { if (requested) { onlinePending = target; onlineReceiptId = receiptId; } if (!localUnavailable) status.textContent = requested ? ui('Online delivery uncertain; recover the original request', '在线交付未确定，请核实恢复原请求') : ui('Online delivery failed', '在线页面未交付'); }
    finally { onlineActive = false; onlineState(); }
  });
  close.addEventListener('click', async () => {
    try {
      const wire = await post('shutdown', { protocol: 1, input: {} }, lifetime.signal);
      if (!wire.ok) { status.textContent = ui('Resolve pending operations before closing', '请先核实并恢复未确定的操作'); return; }
      dispose();
      status.textContent = ui('Local service closed', '本地服务已关闭');
      frame.remove();
      close.disabled = true;
      online.disabled = true;
    } catch { if (!localUnavailable) status.textContent = ui('Service unavailable; verify original operations', '服务未响应，请核实原操作'); }
  });
  function dispose() { clearTimeout(checkpointTimer); unsubscribe(); adapter.dispose(); controller.dispose(); lifetime.abort(); }
  window.addEventListener('pagehide', event => {
    if (lifetime.signal.aborted || event.persisted) return;
    // keepalive 只释放本地载体；刷新可在服务端宽限内继续使用同一 Cookie/恢复记录。
    void fetchImpl('./api/view-release', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cfkanban-csrf': config.csrf }, credentials: 'same-origin', cache: 'no-store', body: JSON.stringify({ protocol: 1, input: { page_id: config.page_id } }), keepalive: true }).catch(() => {});
    dispose();
  });
  if (config.checkpoint) await controller.restoreCheckpoint(config.checkpoint);
  else await controller.bootstrap(null, config.initialContext);
  return { dispose, controller };
}
if (typeof document !== 'undefined' && document.getElementById('configuration')) {
  void mountLocalWorkbench().catch(() => { document.getElementById('status').textContent = '本地工作台不可用 / Local workbench unavailable'; });
}

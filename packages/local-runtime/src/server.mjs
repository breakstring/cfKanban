import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchBridge } from './workbench/bridge.mjs';
import { WORKBENCH_ENDPOINTS, validateCheckpoint, canonical } from './workbench/shared.mjs';
import { createMcpFacade } from '../../skill-runtime/src/mcp-facade.mjs';
import { LocalRuntimeError, failure } from './errors.mjs';
import { OnlineBroker } from './online-broker.mjs';

const BODY_LIMIT = 65_536;
const CHECKPOINT_LIMIT = 2_097_152;
const ROUTE_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const safeJson = value => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const equalSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const object = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function untilAbort(promise, signal, unknown = false) {
  if (signal.aborted) return Promise.reject(new LocalRuntimeError('LOCAL_REQUEST_INTERRUPTED', { outcomeUnknown: unknown }));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new LocalRuntimeError('LOCAL_REQUEST_INTERRUPTED', { outcomeUnknown: unknown }));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function send(response, status, value, headers = {}) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
  response.end(JSON.stringify(value));
}
async function readBody(request, limit = BODY_LIMIT) {
  if (Number(request.headers['content-length'] ?? 0) > limit) throw new LocalRuntimeError('LOCAL_BODY_TOO_LARGE');
  let size = 0;
  const buffers = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new LocalRuntimeError('LOCAL_BODY_TOO_LARGE');
    buffers.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new LocalRuntimeError('LOCAL_INVALID_INPUT'); }
}
function cookie(view, maxAge) {
  return `${view.cookieName}=${view.secret}; HttpOnly; SameSite=Strict; Path=/view/${view.id}/; Max-Age=${Math.ceil(maxAge / 1000)}`;
}
function readCookie(request, name) {
  const found = (request.headers.cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  return found.length === 1 ? found[0].slice(name.length + 1) : null;
}
function shell(view, { html, browserScript, initialContext }) {
  const online = view.onlineBroker?.snapshot();
  const config = safeJson({ csrf: view.csrf, page_id: view.pageId, initialContext, embeddedHtml: html, checkpoint: view.checkpoint, online_pending: online?.pending_target ?? null, online_receipt_id: online?.receipt_id ?? null });
  const script = browserScript.replaceAll('</script', '<\\/script');
  const hash = value => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
  const childScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => hash(match[1]));
  const csp = `default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'; frame-src 'self'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src ${hash(script)} ${childScripts.join(' ')}`;
  return { csp, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>cfKanban local workbench</title><style>html,body{height:100%;margin:0;background:#fff;font:13px system-ui;color:#334155}body{display:flex;flex-direction:column}header{display:flex;gap:6px;align-items:center;padding:4px 12px;border-bottom:1px solid #e2e8f0}button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border:0;background:transparent;border-radius:6px;color:#596b83;cursor:pointer}button:hover:not(:disabled){background:#f1f5f9;color:#c2410c}button:focus-visible{outline:2px solid #c2410c;outline-offset:2px}button:disabled{opacity:.5;cursor:default}#status{flex:1;min-width:0;line-height:1.5}svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}#online .recover-icon{display:none}#online[data-recovering="true"] .open-icon{display:none}#online[data-recovering="true"] .recover-icon{display:block}iframe{width:100%;flex:1;min-height:0;border:0}</style></head><body><header><span id="status" role="status">Local workbench</span><button id="online" type="button" title="Open full online board" aria-label="Open full online board" disabled><svg class="open-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M11 3h6v6M17 3l-9 9M8 3H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" /></svg><svg class="recover-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 7a6 6 0 1 0 0 6M16 3v4h-4" /></svg></button><button id="close" type="button" title="Close local service" aria-label="Close local service"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button></header><iframe id="workbench" title="cfKanban" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"></iframe><script type="application/json" id="configuration">${config}</script><script type="module">${script}</script></body></html>` };
}
export async function validateDirectory(directory) {
  try {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw new Error();
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    return path.normalize(directory);
  } catch { throw new LocalRuntimeError('LOCAL_DIRECTORY_INVALID'); }
}

// 此入口仅供可信 launcher 和隔离 fixture；浏览器不能提供目录、factory 或工件。
export async function startLocalWorkbenchServer({ directory, html, browserScript, initialContext = null, createBridge = options => new WorkbenchBridge(options), createFacade = createMcpFacade, openOnline = null,
  launchTtlMs = 60_000, viewReleaseGraceMs = 60_000, idleTtlMs = 15 * 60_000, maxLifetimeMs = 8 * 60 * 60_000, requestTimeoutMs = 45_000, maxViews = 16, maxLaunches = 8, now = Date.now } = {}) {
  directory = await validateDirectory(directory);
  if (typeof html !== 'string' || typeof browserScript !== 'string' || html.length > 2_097_152 || browserScript.length > 4_194_304) throw new LocalRuntimeError('LOCAL_ARTIFACT_INVALID');
  for (const [value, max] of [[launchTtlMs, 60_000], [viewReleaseGraceMs, 60_000], [idleTtlMs, 60 * 60_000], [maxLifetimeMs, 8 * 60 * 60_000], [requestTimeoutMs, 120_000], [maxViews, 16], [maxLaunches, 8]]) if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new LocalRuntimeError('LOCAL_INVALID_OPTIONS');
  const views = new Map();
  const launches = new Map();
  const requests = new Set();
  let closing = false;
  let origin;
  let lastActivity = now();
  const expiresAt = lastActivity + maxLifetimeMs;
  const cookieLifetime = () => Math.max(0, expiresAt - now());
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const endpoints = new Set(WORKBENCH_ENDPOINTS);
  const extraEndpoints = new Set(['open-online', 'ack-online', 'view-close', 'view-release', 'shutdown', 'checkpoint']);
  const viewPending = view => Boolean(view.checkpoint?.state.pending || view.bridge.hasPending?.() || view.activeWrites.size || view.activeBusiness || view.onlineBroker?.hasPending());
  const hasPending = () => [...views.values()].some(viewPending);
  const server = createServer(async (request, response) => {
    try {
      if (closing || request.headers.host !== new URL(origin).host || request.headers['sec-fetch-site'] === 'cross-site') return send(response, 403, failure('LOCAL_HOST_REJECTED'));
      if (request.headers.origin !== undefined && request.headers.origin !== origin) return send(response, 403, failure('LOCAL_ORIGIN_REJECTED'));
      const launch = launches.get(request.url);
      if (launch) {
        if (request.method !== 'GET' || request.headers.origin !== undefined) return send(response, 403, failure('LOCAL_LAUNCH_REJECTED'));
        launches.delete(request.url);
        clearTimeout(launch.timer);
        if (now() >= launch.expires || views.size >= maxViews) { launch.reject(new LocalRuntimeError('LOCAL_LAUNCH_EXPIRED')); return send(response, 410, failure('LOCAL_LAUNCH_EXPIRED')); }
        const id = randomUUID();
        const operator = Object.freeze({});
        const bridge = createBridge({ directory, createFacade, host: { singleUserLocal: true, hasWebServer: true, webHost: '127.0.0.1', operator } });
        const onlineBroker = openOnline ? new OnlineBroker({ bridge, openOnline, requestTimeoutMs }) : null;
        const view = { id, operator, bridge, onlineBroker, secret: randomBytes(32).toString('base64url'), csrf: randomBytes(32).toString('base64url'), cookieName: `cfkanban_local_${id.replaceAll('-', '')}`, pageId: null, releasedAt: null, running: 0, activeWrites: new Map(), activeBusiness: 0, checkpoint: null, attempts: [] };
        views.set(id, view);
        lastActivity = now();
        response.writeHead(303, { location: `/view/${id}/`, 'set-cookie': cookie(view, cookieLifetime()), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        response.end(() => launch.resolve({ view_id: id, delivered: true }));
        return;
      }
      const route = new RegExp(`^/view/(${ROUTE_UUID})/(?:api/([a-z][a-z_-]{0,50}))?$`).exec(request.url ?? '');
      const view = route && views.get(route[1]);
      if (!view || !equalSecret(readCookie(request, view.cookieName), view.secret)) return send(response, 401, failure('LOCAL_AUTH_REQUIRED'));
      if (now() >= expiresAt) {
        response.once('finish', () => { void close({ force: true }); });
        return send(response, 410, failure('LOCAL_SERVICE_EXPIRED', hasPending()));
      }
      lastActivity = now();
      // 已兑换视图保留同一 Bridge/原操作；闲置不撤销 Cookie，绝对服务期限仍独立核验。
      response.setHeader('set-cookie', cookie(view, cookieLifetime()));
      const endpoint = route[2];
      if (!endpoint) {
        if (request.method !== 'GET') return send(response, 405, failure('LOCAL_METHOD_REJECTED'));
        view.releasedAt = null;
        view.pageId = randomUUID();
        const document = shell(view, { html, browserScript, initialContext });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': document.csp, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' });
        response.end(document.html);
        return;
      }
      if (!endpoints.has(endpoint) && !extraEndpoints.has(endpoint)) return send(response, 404, failure('LOCAL_ROUTE_REJECTED'));
      if (request.method !== 'POST') return send(response, 405, failure('LOCAL_METHOD_REJECTED'));
      if (request.headers.origin !== origin || !equalSecret(request.headers['x-cfkanban-csrf'], view.csrf)) return send(response, 403, failure('LOCAL_CSRF_REJECTED'));
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') return send(response, 415, failure('LOCAL_CONTENT_TYPE_REJECTED'));
      if (endpoint !== 'view-release') view.releasedAt = null;
      view.attempts = view.attempts.filter(at => now() - at < 10_000);
      if (view.attempts.length >= 60 || view.running >= 4) return send(response, 429, failure('LOCAL_CAPACITY'));
      view.attempts.push(now());
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), requestTimeoutMs);
      const onClosed = () => { if (!response.writableEnded) abort.abort(); };
      response.once('close', onClosed);
      requests.add(abort);
      view.running++;
      try {
        const input = await readBody(request, endpoint === 'checkpoint' ? CHECKPOINT_LIMIT : BODY_LIMIT);
        if (endpoint === 'view-close' || endpoint === 'view-release' || endpoint === 'shutdown') {
          if (!exact(input, ['protocol', 'input']) || input.protocol !== 1 || !exact(input.input, endpoint === 'view-release' ? ['page_id'] : [])) return send(response, 400, failure('LOCAL_INVALID_INPUT'));
          if (endpoint === 'view-release') {
            if (typeof input.input.page_id !== 'string' || !new RegExp(`^${ROUTE_UUID}$`).test(input.input.page_id)) return send(response, 400, failure('LOCAL_INVALID_INPUT'));
            if (input.input.page_id !== view.pageId) return send(response, 200, { ok: true, value: { ok: true } });
          }
          if (endpoint === 'shutdown' ? hasPending() : viewPending(view)) return send(response, 409, failure('LOCAL_PENDING_OPERATION', true));
          if (endpoint === 'view-release') {
            // pagehide 也用于刷新；给同 Cookie 页面恢复留出宽限，不转移绑定或原操作。
            view.releasedAt = now();
            return send(response, 200, { ok: true, value: { ok: true } });
          }
          if (endpoint === 'shutdown') void close({}, response);
          send(response, 200, { ok: true, value: { ok: true } });
          if (endpoint === 'shutdown') return;
          view.onlineBroker?.dispose(); view.bridge.dispose(); views.delete(view.id);
          return;
        }
        if (endpoint === 'checkpoint') {
          if (!exact(input, ['protocol', 'input']) || input.protocol !== 1 || !object(input.input)) return send(response, 400, failure('LOCAL_INVALID_INPUT'));
          const checkpoint = validateCheckpoint(input.input);
          if (!checkpoint) return send(response, 400, failure('LOCAL_INVALID_INPUT'));
          if (view.onlineBroker && !view.onlineBroker.acceptsCheckpoint(checkpoint)) return send(response, 409, failure('LOCAL_PENDING_OPERATION', true));
          if (view.activeWrites.size && (view.activeWrites.size !== 1 || !view.activeWrites.has(canonical(checkpoint.state.pending)))) return send(response, 409, failure('LOCAL_PENDING_OPERATION', true));
          if (view.bridge.acceptsCheckpoint ? !view.bridge.acceptsCheckpoint(checkpoint) : view.bridge.hasPending?.() && !checkpoint.state.pending) return send(response, 409, failure('LOCAL_PENDING_OPERATION', true));
          // checkpoint 不影响权限或业务调用，仅保留原视图请求；不会写入磁盘。
          view.checkpoint = checkpoint;
          return send(response, 200, { ok: true, value: { ok: true } });
        }
        if (endpoint === 'open-online' || endpoint === 'ack-online') {
          if (!view.onlineBroker || !exact(input, ['protocol', 'input']) || input.protocol !== 1 || !object(input.input)) return send(response, 400, failure('LOCAL_INVALID_INPUT'));
          let result;
          if (endpoint === 'ack-online') result = view.onlineBroker.acknowledge(input.input);
          else if (Object.keys(input.input).some(key => !['binding_id', 'identifier', 'receipt_id', 'recover'].includes(key))) result = failure('LOCAL_INVALID_INPUT');
          else if (!view.onlineBroker.hasPending() && (view.activeBusiness || view.checkpoint?.state.pending)) result = failure('LOCAL_PENDING_OPERATION');
          else result = await view.onlineBroker.open({ binding_id: input.input.binding_id, ...(input.input.identifier === undefined ? {} : { identifier: input.input.identifier }) }, { signal: abort.signal, receiptId: input.input.receipt_id, recover: input.input.recover ?? false });
          const online = view.onlineBroker.snapshot();
          return send(response, ['LOCAL_INVALID_INPUT'].includes(result.error?.code) ? 400 : ['LOCAL_PENDING_OPERATION', 'LOCAL_OPERATION_PENDING'].includes(result.error?.code) ? 409 : 200, { ok: true, value: result, online_pending: online.pending_target, online_receipt_id: online.receipt_id });
        }
        if (!exact(input, ['protocol', 'input']) || input.protocol !== 1 || !object(input.input)) return send(response, 400, failure('LOCAL_INVALID_INPUT'));
        if (view.onlineBroker && !view.onlineBroker.allows(endpoint, input.input)) return send(response, 409, failure('LOCAL_PENDING_OPERATION', true));
        const write = ['mutate', 'recover'].includes(endpoint);
        const business = write || ['bind', 'bind_scope', 'unbind'].includes(endpoint);
        const fingerprint = write ? canonical(input.input) : null;
        // 绑定预读尚未改变 Bridge；在线交付不能在此时锁住旧目标。
        if (business) view.activeBusiness++;
        // 请求生命周期内的 checkpoint 只能保留本次完整原请求，不能替换预读中的操作。
        if (write) view.activeWrites.set(fingerprint, (view.activeWrites.get(fingerprint) ?? 0) + 1);
        try {
          const result = await untilAbort(view.bridge.call(endpoint, input, abort.signal, view.operator), abort.signal, write);
          send(response, 200, { ok: true, value: result });
        } finally {
          if (business) view.activeBusiness--;
          if (write) {
            const count = view.activeWrites.get(fingerprint) - 1;
            if (count) view.activeWrites.set(fingerprint, count); else view.activeWrites.delete(fingerprint);
          }
        }
      } finally {
        clearTimeout(timeout);
        requests.delete(abort);
        response.removeListener('close', onClosed);
        view.running--;
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response, error?.code === 'LOCAL_BODY_TOO_LARGE' ? 413 : 400, failure(error instanceof LocalRuntimeError ? error.code : 'LOCAL_REQUEST_FAILED', error instanceof LocalRuntimeError && error.outcome_unknown));
      else response.destroy();
    }
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 15_000);
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', () => reject(new LocalRuntimeError('LOCAL_BIND_FAILED'))); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setInterval(() => {
    if (now() >= expiresAt) { void close({ force: true }); return; }
    for (const view of views.values()) if (view.releasedAt !== null && now() - view.releasedAt >= viewReleaseGraceMs && view.running === 0 && !viewPending(view)) {
      view.onlineBroker?.dispose(); view.bridge.dispose(); views.delete(view.id);
    }
    if (views.size === 0 && now() - lastActivity >= idleTtlMs && !hasPending() && requests.size === 0) void close();
  }, Math.min(1000, idleTtlMs));
  timer.unref();
  const lifetime = setTimeout(() => { void close({ force: true }); }, maxLifetimeMs);
  lifetime.unref();
  async function close({ force = false } = {}, flushResponse = null) {
    if (closing) return closed;
    if (!force && hasPending()) throw new LocalRuntimeError('LOCAL_PENDING_OPERATION', { outcomeUnknown: true });
    closing = true;
    const unknown = hasPending();
    clearInterval(timer);
    clearTimeout(lifetime);
    for (const launch of launches.values()) { clearTimeout(launch.timer); launch.reject(new LocalRuntimeError('LOCAL_SERVICE_CLOSED')); }
    launches.clear();
    for (const abort of requests) abort.abort();
    for (const view of views.values()) { view.onlineBroker?.dispose(); view.bridge.dispose(); }
    views.clear();
    await new Promise(resolve => {
      const stop = () => { server.close(resolve); server.closeAllConnections(); };
      if (flushResponse && !flushResponse.writableFinished) flushResponse.once('finish', stop);
      else stop();
    });
    resolveClosed({ closed: true, outcome_unknown: unknown, recovery: unknown ? 'verify_original_operations_before_retry' : 'none' });
    return closed;
  }
  async function deliverView(openLocalUrl) {
    if (closing || typeof openLocalUrl !== 'function' || launches.size >= maxLaunches || views.size >= maxViews) throw new LocalRuntimeError('LOCAL_CAPACITY');
    const route = `/launch/${randomBytes(32).toString('base64url')}`;
    let resolve;
    let reject;
    const delivered = new Promise((yes, no) => { resolve = yes; reject = no; });
    const launch = { resolve, reject, expires: now() + launchTtlMs, timer: setTimeout(() => { launches.delete(route); reject(new LocalRuntimeError('LOCAL_LAUNCH_EXPIRED')); }, launchTtlMs) };
    launches.set(route, launch);
    try { return await Promise.race([Promise.resolve().then(() => openLocalUrl(`${origin}${route}`)).then(() => delivered), delivered]); }
    catch { launches.delete(route); clearTimeout(launch.timer); throw new LocalRuntimeError('LOCAL_DELIVERY_FAILED'); }
  }
  return { address: origin, close, closed, deliverView };
}

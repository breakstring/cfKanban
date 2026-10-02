import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { startLocalWorkbenchServer } from '../src/server.mjs';

function element(value = '') {
  const listeners = new Map();
  return { textContent: value, disabled: false, inert: false, listeners, dataset: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener: (event, handler) => listeners.set(event, handler), remove() {},
  };
}
function parentDocument(config) {
  const elements = new Map(['workbench', 'status', 'online', 'close'].map(id => [id, element()]));
  elements.set('configuration', element(JSON.stringify(config)));
  return { elements, getElementById: id => elements.get(id) };
}

for (const firstOutcome of ['unknown', 'known']) {
test(`parent online recovery preserves the ${firstOutcome} original after a lost reply and same-cookie reload`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cfkanban-parent-recovery-'));
  let runtime;
  let first;
  let reloaded;
  try {
    const script = path.join(directory, 'browser.mjs');
    await build({ entryPoints: [new URL('../src/browser.mjs', import.meta.url).pathname], outfile: script, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent' });
    const { mountLocalWorkbench } = await import(pathToFileURL(script));
    const target = { instance_id: randomUUID(), workspace_id: randomUUID(), project_id: randomUUID() };
    const principal = randomUUID();
    const bindingId = randomUUID();
    const identity = { instance: { instance_id: target.instance_id }, principal: { principal_id: principal } };
    const issue = { identifier: 'CFK-548', version: 2, title: 'Fixture', status: { key: 'todo' }, allowed_actions: ['read', 'update'] };
    const onlineRequests = [];
    const business = [];
    const createBridge = () => ({ hasPending: () => false, dispose() {}, verifiedTarget: async (binding, _signal, identifier) => { assert.equal(binding, bindingId); assert.equal(identifier, issue.identifier); }, call: async (endpoint, payload) => {
      business.push(endpoint);
      if (endpoint === 'identity') return { ok: true, data: identity };
      if (endpoint === 'bind') return { ok: true, data: { binding_id: bindingId, identity, project: { id: target.project_id }, statuses: [{ key: 'todo' }] } };
      if (endpoint === 'board') return { ok: true, data: { columns: [{ key: 'todo', items: [issue], next_cursor: null }] } };
      if (endpoint === 'detail') return { ok: true, data: issue };
      return { ok: true, data: {} };
    } });
    runtime = await startLocalWorkbenchServer({ directory, html: '<html></html>', browserScript: await readFile(script, 'utf8'), initialContext: { target, view: 'board' }, createBridge,
      openOnline: async input => { onlineRequests.push(input); return onlineRequests.length === 1 && firstOutcome === 'unknown' ? { ok: false, outcome_unknown: true } : { ok: true, delivery: { delivered: true } }; },
    });
    let opening;
    await runtime.deliverView(url => { opening = fetch(url, { redirect: 'manual' }); return opening; });
    const response = await opening;
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const base = `${runtime.address}${response.headers.get('location')}`;
    const loadConfig = async () => JSON.parse(/<script type="application\/json" id="configuration">(.*?)<\/script>/.exec(await (await fetch(base, { headers: { cookie } })).text())[1]);
    let loseReply = true;
    const browserFetch = async (url, options) => {
      const result = await fetch(new URL(url, base), { ...options, headers: { ...options.headers, cookie, origin: runtime.address } });
      if (url === './api/open-online' && loseReply) { loseReply = false; await result.json(); throw new Error('Fixture dropped the response'); }
      return result;
    };
    const window = { addEventListener() {} };
    const doc = parentDocument(await loadConfig());
    first = await mountLocalWorkbench({ document: doc, window, fetchImpl: browserFetch });
    await first.controller.openIssue(issue.identifier);
    await doc.elements.get('online').listeners.get('click')();
    assert.equal(doc.elements.get('workbench').inert, true);
    assert.equal(doc.elements.get('online').textContent, '');
    assert.equal(doc.elements.get('online').title, '核实恢复在线页面');
    assert.equal(doc.elements.get('online').attributes['aria-label'], doc.elements.get('online').title);
    assert.equal(doc.elements.get('online').dataset.recovering, 'true');
    assert.equal(doc.elements.get('online').disabled, false);
    assert.equal(await first.controller.unbind(), false);
    assert.equal(business.includes('unbind'), false);
    first.dispose();
    const config = await loadConfig();
    assert.deepEqual(config.online_pending, { binding_id: bindingId, identifier: issue.identifier });
    assert.equal(config.online_pending.idempotency_key, undefined);
    const restoredDoc = parentDocument(config);
    reloaded = await mountLocalWorkbench({ document: restoredDoc, window, fetchImpl: browserFetch });
    assert.equal(restoredDoc.elements.get('workbench').inert, true);
    reloaded.controller.patch({ issue: { ...issue, identifier: 'CFK-544' } });
    await restoredDoc.elements.get('online').listeners.get('click')();
    assert.equal(restoredDoc.elements.get('workbench').inert, false);
    assert.equal(onlineRequests.length, firstOutcome === 'unknown' ? 2 : 1);
    assert.equal(new Set(onlineRequests.map(input => input.idempotencyKey)).size, 1);
    assert.ok(onlineRequests.every(input => input.bindingId === bindingId && input.identifier === issue.identifier));
    assert.equal(restoredDoc.elements.get('online').textContent, '');
    assert.equal(restoredDoc.elements.get('online').title, '打开完整线上看板');
    assert.equal(restoredDoc.elements.get('online').dataset.recovering, 'false');
    await restoredDoc.elements.get('close').listeners.get('click')();
    assert.equal(restoredDoc.elements.get('status').textContent, '本地服务已关闭');
    assert.equal((await runtime.closed).outcome_unknown, false);
  } finally {
    first?.dispose(); reloaded?.dispose();
    await runtime?.close({ force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
}

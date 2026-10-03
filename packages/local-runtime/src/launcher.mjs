import { readFile } from 'node:fs/promises';
import { createMcpFacade } from '../../skill-runtime/src/mcp-facade.mjs';
import { resolveWebInstance } from '../../skill-runtime/src/web-resolve.mjs';
import { resolveSystemBrowserOpener } from '../../skill-runtime/src/capability-delivery.mjs';
import { createOnlineOpener } from './online-broker.mjs';
import { loadLocalArtifacts } from './artifacts.mjs';
import { startLocalWorkbenchServer, validateDirectory } from './server.mjs';
import { LocalRuntimeError } from './errors.mjs';
export { createOnlineOpener, OnlineBroker } from './online-broker.mjs';

const uuid = value => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const requireOk = result => { if (!result?.ok) throw new LocalRuntimeError('LOCAL_CONNECTION_UNAVAILABLE'); return result.data; };
export async function resolveInitialContext({ directory, instanceId, target, createFacade = createMcpFacade, resolveInstance = resolveWebInstance } = {}) {
  if (instanceId !== undefined && !uuid(instanceId)) throw new LocalRuntimeError('LOCAL_INVALID_TARGET');
  if (target !== undefined && (!target || typeof target !== 'object' || Array.isArray(target) || !['project', 'issue'].includes(target.kind))) throw new LocalRuntimeError('LOCAL_TARGET_UNSUPPORTED');
  if (!instanceId && target) {
    let resolved;
    try { resolved = await resolveInstance({ repoRoot: directory }); } catch { throw new LocalRuntimeError('LOCAL_CONNECTION_UNAVAILABLE'); }
    if (resolved.status !== 'resolved') throw new LocalRuntimeError('LOCAL_INSTANCE_SELECTION_REQUIRED');
    instanceId = resolved.instance.instance_id;
  }
  if (!instanceId) return { view: 'board' };
  const identity = requireOk(await createFacade().callTool('cfkanban_connection_inspect', { instance_id: instanceId }));
  const principal = identity.principal?.principal_id ?? identity.principal?.id;
  if (!uuid(principal)) throw new LocalRuntimeError('LOCAL_CONNECTION_UNAVAILABLE');
  if (!target) return { instance_id: instanceId, view: 'board' };
  let workspaceId;
  let projectId;
  let identifier;
  if (target.kind === 'project') {
    if (Object.keys(target).some(key => !['kind', 'workspace_id', 'project_id'].includes(key)) || !uuid(target.workspace_id) || !uuid(target.project_id)) throw new LocalRuntimeError('LOCAL_INVALID_TARGET');
    workspaceId = target.workspace_id;
    projectId = target.project_id;
  } else {
    if (Object.keys(target).some(key => !['kind', 'identifier'].includes(key)) || typeof target.identifier !== 'string' || !/^CFK-[1-9][0-9]*$/.test(target.identifier)) throw new LocalRuntimeError('LOCAL_INVALID_TARGET');
    identifier = target.identifier;
    const issue = requireOk(await createFacade().callTool('cfkanban_issues_get', { instance_id: instanceId, identifier }));
    workspaceId = issue.workspace?.id ?? issue.project?.workspace_id;
    projectId = issue.project?.id;
    if (!uuid(workspaceId) || !uuid(projectId)) throw new LocalRuntimeError('LOCAL_INVALID_TARGET');
  }
  const facade = createFacade({ binding: { instance_id: instanceId, expected_principal_id: principal, project_ids: [projectId] } });
  requireOk(await facade.callTool('cfkanban_projects_get', { instance_id: instanceId, workspace_id: workspaceId, project_id: projectId }));
  if (identifier) requireOk(await facade.callTool('cfkanban_issues_get', { instance_id: instanceId, identifier }));
  return { view: 'board', target: { instance_id: instanceId, workspace_id: workspaceId, project_id: projectId, ...(identifier ? { identifier } : {}) } };
}
export async function openLocalWorkbench({ directory, instanceId, target, delivery = 'system_browser', onRelayReady, signal, browserOpener, artifactRoot, createFacade, createBridge, resolveInstance, serverOptions = {} } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 12) throw new LocalRuntimeError('LOCAL_NODE_UNSUPPORTED');
  directory = await validateDirectory(directory);
  if (!['system_browser', 'host_browser'].includes(delivery) || (delivery === 'host_browser' && typeof onRelayReady !== 'function')) throw new LocalRuntimeError('LOCAL_DELIVERY_UNAVAILABLE');
  const opener = delivery === 'system_browser' ? browserOpener ?? await resolveSystemBrowserOpener() : null;
  const version = typeof __CFKANBAN_LOCAL_VERSION__ !== 'undefined' ? __CFKANBAN_LOCAL_VERSION__ : JSON.parse(await readFile(new URL('../../../release/version.json', import.meta.url), 'utf8')).version;
  const artifacts = await loadLocalArtifacts({ ...(artifactRoot ? { artifactRoot } : {}), version });
  const initialContext = await resolveInitialContext({ directory, instanceId, target, createFacade, resolveInstance });
  const runtime = await startLocalWorkbenchServer({ ...serverOptions, directory, html: artifacts.html, browserScript: artifacts.browserScript, initialContext, ...(createFacade ? { createFacade } : {}), ...(createBridge ? { createBridge } : {}), openOnline: createOnlineOpener() });
  const terminate = () => { void runtime.close({ force: true }); };
  process.once('SIGINT', terminate);
  process.once('SIGTERM', terminate);
  signal?.addEventListener('abort', terminate, { once: true });
  runtime.closed.finally(() => { process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate); signal?.removeEventListener('abort', terminate); });
  try {
    if (signal?.aborted) throw new LocalRuntimeError('LOCAL_SERVICE_CLOSED');
    await runtime.deliverView(localUrl => delivery === 'host_browser' ? onRelayReady({ event: 'browser_relay_ready', channel: 'host_browser', local_url: localUrl, expires_in_seconds: 60, classification: 'local_one_time_browser_handoff', navigation_hint: 'reuse_verified_probe_tab' }) : opener.open(localUrl));
    const metadata = { ok: true, mode: 'local', channel: delivery, delivered: true, release_version: version, secret_values_exposed: false };
    Object.defineProperties(metadata, { closed: { value: runtime.closed }, close: { value: runtime.close } });
    return metadata;
  } catch (error) {
    await runtime.close({ force: true });
    throw error instanceof LocalRuntimeError ? error : new LocalRuntimeError('LOCAL_DELIVERY_FAILED');
  }
}

export function stopOnEof(runtime, stream) {
  const stop = () => { void runtime.close({ force: true }); };
  stream.once('end', stop);
  return () => stream.removeListener('end', stop);
}

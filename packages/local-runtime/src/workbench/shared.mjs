export const PANEL_PROTOCOL = 1;
export const WORKBENCH_PROTOCOL = PANEL_PROTOCOL;
export const WORKBENCH_ENDPOINTS = Object.freeze(['workspace_scope', 'session_scope', 'scope_targets', 'bind_scope', 'connections', 'identity', 'workspaces', 'projects', 'bind', 'unbind', 'list', 'board', 'assignees', 'labels', 'detail', 'comments', 'mutate', 'recover']);
export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
export const STATUSES = ['backlog', 'todo', 'in_progress', 'done', 'canceled'];
export { validateCheckpoint } from './checkpoint.mjs';

export function scopeFailureCode(code) {
  if (['FORBIDDEN', 'CAPABILITY_DENIED', 'PANEL_PERMISSION_DENIED', 'PANEL_SCOPE_DENIED'].includes(code)) return 'PANEL_SCOPE_PERMISSION_DENIED';
  if (['MCP_PRINCIPAL_BINDING_MISMATCH', 'PANEL_IDENTITY_CHANGED', 'STATE_IDENTITY_CONFLICT'].includes(code)) return 'PANEL_SCOPE_IDENTITY_CHANGED';
  if (code === 'MCP_LOCAL_STATE_UNAVAILABLE') return 'PANEL_SCOPE_HOST_UNAVAILABLE';
  if (code === 'UNAUTHORIZED' || /^(?:STATE_|OWNER_DEVICE_|IDENTITY_SWITCH_)/.test(code ?? '')) return 'PANEL_SCOPE_CREDENTIAL_UNAVAILABLE';
  if (['NOT_FOUND', 'PANEL_SCOPE_TARGET_UNAVAILABLE', 'PANEL_SCOPE_UNAVAILABLE', 'PANEL_WORKSPACE_CHANGED', 'INVALID_ORIGIN'].includes(code) || /^DISCOVERY_/.test(code ?? '')) return 'PANEL_SCOPE_STALE';
  return 'PANEL_SCOPE_TARGET_UNAVAILABLE';
}

export class PanelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function record(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new PanelError('PANEL_INVALID_INPUT', 'Expected an ordinary object.');
  }
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new PanelError('PANEL_INVALID_INPUT', 'Unexpected or missing input field.');
  }
  return value;
}

export function boundedText(value, max, name, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) {
    throw new PanelError('PANEL_INVALID_INPUT', `Invalid ${name}.`);
  }
  return value;
}

export function uuid(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new PanelError('PANEL_INVALID_INPUT', `Invalid ${name}.`);
  }
  return value;
}

export function isSessionReference(value) {
  if (typeof value !== 'string') return false;
  const reference = value.startsWith('session-') ? value.slice(8) : value;
  try { uuid(reference, 'Session'); return true; } catch { return false; }
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9]{1,11}-[1-9][0-9]{0,14}$/.test(value)) {
    throw new PanelError('PANEL_INVALID_INPUT', 'Invalid Issue identifier.');
  }
  return value;
}

export function canonical(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(canonical(item))));
  if (value && typeof value === 'object') return JSON.stringify(Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, JSON.parse(canonical(value[key]))])));
  return JSON.stringify(value);
}
export function canCreateIssue(principal, binding) {
  return Boolean(binding && (binding.project_id ?? binding.project?.id) && (binding.workspace_id ?? binding.project?.workspace_id) && (principal?.is_owner === true || principal?.grants?.some(grant => grant.role === 'writer' && grant.workspace_id === (binding.workspace_id ?? binding.project?.workspace_id) && grant.project_id === (binding.project_id ?? binding.project?.id))));
}

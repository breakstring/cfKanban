import { record, uuid, identifier, boundedText, STATUSES, PRIORITIES, isSessionReference } from './shared.mjs';

const STATE_FIELDS = ['binding', 'identity', 'workspace_id', 'pending', 'issue', 'view', 'filters', 'scope_mode', 'workspace_scope', 'scope_instance_id', 'source_session_id', 'session_context_changed'];
const RESOURCE_FIELDS = ['id', 'instance_id', 'principal_id', 'display_name', 'title', 'name', 'trusted_api_origin', 'available'];
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const resource = value => pick(value, RESOURCE_FIELDS);
const identity = value => value ? { instance: resource(value.instance), principal: resource(value.principal) } : null;
const status = value => pick(value, ['key', 'display_name']);
const summary = value => value ? { ...pick(value, ['id', 'identifier', 'title', 'version', 'priority', 'is_blocked']), status: status(value.status), assignee: value.assignee ? resource(value.assignee) : null, allowed_actions: Array.isArray(value.allowed_actions) ? value.allowed_actions : [] } : null;

export function checkpointState(state) {
  return { schema_version: 1, state: {
    ...pick(state, ['workspace_id', 'view', 'scope_mode', 'scope_instance_id', 'source_session_id', 'session_context_changed']), identity: identity(state.identity),
    binding: state.binding ? { binding_id: state.binding.binding_id, identity: identity(state.binding.identity), project: resource(state.binding.project), statuses: (Array.isArray(state.binding.statuses) ? state.binding.statuses : state.binding.statuses?.items ?? state.binding.statuses?.statuses ?? []).map(status) } : null,
    pending: state.pending ? structuredClone(state.pending) : null, issue: summary(state.issue), filters: pick(state.filters, ['assignment', 'status', 'priority']), workspace_scope: state.workspace_scope ? pick(state.workspace_scope, ['status']) : null,
  } };
}

export function validateCheckpoint(value) {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 2_097_152) return null;
    record(value, ['schema_version', 'state'], ['schema_version', 'state']);
    if (value.schema_version !== 1) return null;
    const state = record(value.state, STATE_FIELDS, ['binding', 'pending', 'issue', 'view', 'filters']);
    const checkResource = value => {
      record(value, RESOURCE_FIELDS);
      for (const key of ['id', 'instance_id', 'principal_id']) if (value[key] !== undefined) uuid(value[key], key);
      for (const key of ['display_name', 'title', 'name', 'trusted_api_origin']) if (value[key] !== undefined) boundedText(value[key], 2048, key, true);
      if (value.available !== undefined && typeof value.available !== 'boolean') throw new Error();
    };
    const checkIdentity = value => { if (value === null) return; record(value, ['instance', 'principal'], ['instance', 'principal']); checkResource(value.instance); checkResource(value.principal); };
    const checkStatus = value => { record(value, ['key', 'display_name'], ['key']); if (!STATUSES.includes(value.key)) throw new Error(); if (value.display_name !== undefined) boundedText(value.display_name, 256, 'status name', true); };
    if (state.identity !== undefined) checkIdentity(state.identity);
    if (state.workspace_id !== undefined) uuid(state.workspace_id, 'workspace');
    if (state.scope_instance_id != null) uuid(state.scope_instance_id, 'scope instance');
    if (state.source_session_id != null && !isSessionReference(state.source_session_id)) return null;
    if (state.session_context_changed !== undefined && typeof state.session_context_changed !== 'boolean') return null;
    if (!['list', 'board'].includes(state.view) || (state.scope_mode !== undefined && !['manual', 'suggested'].includes(state.scope_mode))) return null;
    record(state.filters, ['assignment', 'status', 'priority'], ['assignment', 'status', 'priority']);
    if (!['all', 'mine'].includes(state.filters.assignment) || !['', ...STATUSES].includes(state.filters.status) || !['', ...PRIORITIES].includes(state.filters.priority)) return null;
    if (state.workspace_scope != null) { record(state.workspace_scope, ['status'], ['status']); if (!['configured', 'empty', 'missing', 'invalid', 'unavailable'].includes(state.workspace_scope.status)) return null; }
    if (state.binding !== null) {
      record(state.binding, ['binding_id', 'identity', 'project', 'statuses'], ['binding_id', 'identity', 'project', 'statuses']); uuid(state.binding.binding_id, 'binding'); checkIdentity(state.binding.identity); checkResource(state.binding.project);
      if (!Array.isArray(state.binding.statuses) || state.binding.statuses.length > 5) return null;
      state.binding.statuses.forEach(checkStatus);
    }
    if (state.issue !== null) {
      record(state.issue, ['id', 'identifier', 'title', 'version', 'priority', 'is_blocked', 'status', 'assignee', 'allowed_actions'], ['identifier', 'version', 'status', 'allowed_actions']);
      identifier(state.issue.identifier); if (!Number.isSafeInteger(state.issue.version) || state.issue.version < 1) return null; checkStatus(state.issue.status);
      if (state.issue.id !== undefined) uuid(state.issue.id, 'Issue'); if (state.issue.title !== undefined) boundedText(state.issue.title, 1024, 'title', true);
      if (state.issue.priority !== undefined && !PRIORITIES.includes(state.issue.priority)) return null;
      if (state.issue.is_blocked !== undefined && typeof state.issue.is_blocked !== 'boolean') return null;
      if (state.issue.assignee != null) checkResource(state.issue.assignee);
      if (!Array.isArray(state.issue.allowed_actions) || state.issue.allowed_actions.length > 20 || state.issue.allowed_actions.some(action => typeof action !== 'string' || action.length > 64)) return null;
    }
    if (state.pending !== null) {
      const p = record(state.pending, ['binding_id', 'identifier', 'expected_version', 'operation', 'change', 'idempotency_key'], ['binding_id', 'identifier', 'expected_version', 'operation', 'change', 'idempotency_key']);
      uuid(p.binding_id, 'binding'); uuid(p.idempotency_key, 'original key'); identifier(p.identifier); if (!state.binding || p.binding_id !== state.binding.binding_id || !Number.isSafeInteger(p.expected_version) || p.expected_version < 1) return null;
      if (p.operation === 'update') {
        record(p.change, ['status_key', 'priority_key', 'assignee_principal_id']); if (!Object.keys(p.change).length || (p.change.status_key !== undefined && (!STATUSES.includes(p.change.status_key) || p.change.status_key === 'done')) || (p.change.priority_key !== undefined && !PRIORITIES.includes(p.change.priority_key))) return null;
        if (p.change.assignee_principal_id != null) uuid(p.change.assignee_principal_id, 'assignee');
      } else if (p.operation === 'comment') { record(p.change, ['body'], ['body']); boundedText(p.change.body, 32768, 'comment'); }
      else if (p.operation === 'complete') {
        record(p.change, ['summary', 'verification', 'artifacts', 'follow_ups'], ['summary']); boundedText(p.change.summary, 8192, 'summary', true);
        for (const key of ['verification', 'follow_ups']) if (p.change[key] !== undefined && (!Array.isArray(p.change[key]) || p.change[key].length > 50 || p.change[key].some(value => typeof value !== 'string' || value.length > (key === 'follow_ups' ? 2048 : 1024)))) return null;
        if (p.change.artifacts !== undefined && (!Array.isArray(p.change.artifacts) || p.change.artifacts.length > 50)) return null;
        for (const row of p.change.artifacts ?? []) { record(row, ['kind', 'value'], ['kind', 'value']); if (!['url', 'path', 'commit', 'other'].includes(row.kind)) return null; boundedText(row.value, 2048, 'artifact'); }
      } else return null;
    }
    return structuredClone(value);
  } catch { return null; }
}

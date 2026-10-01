import { onUnmounted, ref, shallowReactive } from "vue";
import { apiRequest } from "./api";
import { isWebSessionView } from "./session-boundary";
import type { WebSessionView } from "../types";

export type SessionTextFields = Record<string, string>;
export interface SessionTextDraftRegistration {
  key: string;
  path: string;
  label: { en: string; zh: string };
  target?(): Record<string, string>;
  capture(): SessionTextFields | null;
  canRestore(target: Readonly<Record<string, string>>): boolean;
  restore(fields: Readonly<SessionTextFields>, target: Readonly<Record<string, string>>, isCurrent: () => boolean): void | boolean | Promise<void | boolean>;
  uncertain?(): boolean;
}
export interface RetainedSessionTextDraft {
  id: number;
  principalId: string;
  key: string;
  path: string;
  label: { en: string; zh: string };
  fields: SessionTextFields;
  target: Record<string, string>;
  copyOnly: boolean;
}

// Only explicit business-text getters enter this page-memory store. It never
// serializes component state, request envelopes, DOM forms, or browser storage.
const registrations = shallowReactive(new Map<symbol, { owner: string | null; registration: SessionTextDraftRegistration }>());
export const retainedSessionTextDrafts = ref<RetainedSessionTextDraft[]>([]);
let principalId: string | null = null;
let nextId = 0;
const restoring = new Set<number>();

export function setSessionDraftPrincipal(value: string | null): void {
  if (value !== null && retainedSessionTextDrafts.value.some(draft => draft.principalId !== value)) clearRetainedSessionTextDrafts();
  principalId = value;
}

export function registerSessionTextDraft(registration: SessionTextDraftRegistration): () => void {
  const key = Symbol();
  registrations.set(key, { owner: principalId, registration });
  return () => { registrations.delete(key); };
}

export function useSessionTextDraft(registration: SessionTextDraftRegistration): void {
  onUnmounted(registerSessionTextDraft(registration));
}

export function changedTextFields(pairs: Record<string, readonly [string, string]>): SessionTextFields | null {
  const fields = Object.fromEntries(Object.entries(pairs).filter(([, [value, original]]) => value !== original).map(([key, [value]]) => [key, value]));
  return Object.keys(fields).length ? fields : null;
}

export function captureSessionTextDrafts(owner: string): void {
  if (owner !== principalId) return;
  for (const { owner: registeredOwner, registration: entry } of registrations.values()) {
    if (registeredOwner !== owner) continue;
    let value: SessionTextFields | null;
    let target: Record<string, string>;
    let copyOnly: boolean;
    try { value = entry.capture(); target = { ...entry.target?.() }; copyOnly = entry.uncertain?.() ?? false; }
    catch { continue; }
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) continue;
    // A caller must enumerate plain strings; never retain refs or object graphs.
    if (Object.values(value).some(field => typeof field !== "string") || Object.values(target).some(field => typeof field !== "string")) continue;
    const fields = { ...value };
    const previous = retainedSessionTextDrafts.value.find(draft => draft.principalId === owner && draft.key === entry.key && JSON.stringify(draft.target) === JSON.stringify(target));
    const draft: RetainedSessionTextDraft = { id: previous?.id ?? ++nextId, principalId: owner, key: entry.key, path: entry.path, label: { ...entry.label }, fields, target, copyOnly };
    retainedSessionTextDrafts.value = [...retainedSessionTextDrafts.value.filter(item => item.id !== draft.id), draft];
  }
}

function currentRegistration(draft: RetainedSessionTextDraft): SessionTextDraftRegistration | undefined {
  return [...registrations.values()].find(({ owner, registration: entry }) => owner === draft.principalId && entry.key === draft.key && entry.path === draft.path)?.registration;
}

export function canRestoreSessionTextDraft(draft: RetainedSessionTextDraft, owner: string | null): boolean {
  return owner !== null && owner === principalId && owner === draft.principalId && !draft.copyOnly
    && (currentRegistration(draft)?.canRestore(draft.target) ?? false);
}

export async function restoreSessionTextDraft(id: number, owner: string): Promise<boolean> {
  const draft = retainedSessionTextDrafts.value.find(entry => entry.id === id);
  if (!draft || restoring.has(id) || !canRestoreSessionTextDraft(draft, owner)) return false;
  const registration = currentRegistration(draft)!;
  const isCurrent = () => principalId === owner && currentRegistration(draft) === registration && retainedSessionTextDrafts.value.find(entry => entry.id === id) === draft;
  restoring.add(id);
  try {
    const result = await registration.restore({ ...draft.fields }, { ...draft.target }, isCurrent);
    if (result === false || !isCurrent()) return false;
    discardSessionTextDraft(id);
    return true;
  } finally { restoring.delete(id); }
}

export function sessionTextDraftCopy(draft: RetainedSessionTextDraft): string {
  return Object.values(draft.fields).join("\n\n");
}

export function discardSessionTextDraft(id: number): void {
  retainedSessionTextDrafts.value = retainedSessionTextDrafts.value.filter(entry => entry.id !== id);
}

export function clearRetainedSessionTextDrafts(): void { retainedSessionTextDrafts.value = []; }

export async function verifySessionTextDraftIdentity(isCurrent: () => boolean): Promise<WebSessionView | null> {
  const owner = principalId;
  if (owner === null || !isCurrent()) return null;
  const current = await apiRequest<WebSessionView>("/api/v1/web-session", { validateResponse: isWebSessionView, authorizationCurrent: isCurrent });
  return isCurrent() && principalId === owner && current.principal.id === owner ? current : null;
}

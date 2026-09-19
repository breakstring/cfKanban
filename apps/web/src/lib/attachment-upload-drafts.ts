export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  state: "pending" | "ready" | "expired";
  version: number;
  created_at: string;
  expires_at: string;
  deleted_at: string | null;
  uploaded_by: { principal_id: string; display_name: string };
  preview_content_type: string | null;
  allowed_actions: string[];
}

export interface AttachmentUploadDraft {
  file: File;
  sha256: string | null;
  reserveKey: string;
  uploadKey: string;
  attachment: Attachment | null;
  reserveStarted: boolean;
  firstAttemptAt: number | null;
}

// File bytes and retry keys survive route unmounts only within the current
// session boundary. They are never serialized into browser storage.
const drafts = new Map<string, AttachmentUploadDraft>();
let sessionScopeGeneration = 0;
let unloadTarget: Window | null = null;

function draftKey(sessionId: string, principalId: string, identifier: string): string {
  return JSON.stringify([sessionId, principalId, identifier]);
}

function beforeUnload(event: BeforeUnloadEvent): void {
  if (drafts.size === 0) return;
  event.preventDefault();
  event.returnValue = "";
}

function syncUnloadWarning(): void {
  if (drafts.size > 0 && unloadTarget === null && typeof window !== "undefined") {
    unloadTarget = window;
    unloadTarget.addEventListener("beforeunload", beforeUnload);
  } else if (drafts.size === 0 && unloadTarget !== null) {
    unloadTarget.removeEventListener("beforeunload", beforeUnload);
    unloadTarget = null;
  }
}

export function clearAttachmentUploadDrafts(): void {
  sessionScopeGeneration += 1;
  drafts.clear();
  syncUnloadWarning();
}

export function forgetIssueAttachmentUploadDraft(sessionId: string, principalId: string, identifier: string): void {
  drafts.delete(draftKey(sessionId, principalId, identifier));
  syncUnloadWarning();
}

export function captureAttachmentUploadDraft(sessionId: string, principalId: string, identifier: string) {
  const generation = sessionScopeGeneration;
  const key = draftKey(sessionId, principalId, identifier);
  const isCurrent = () => generation === sessionScopeGeneration;
  return {
    isCurrent,
    get: (): AttachmentUploadDraft | null => isCurrent() ? drafts.get(key) ?? null : null,
    set(value: AttachmentUploadDraft | null): void {
      if (!isCurrent()) return;
      if (value === null) drafts.delete(key);
      else drafts.set(key, value);
      syncUnloadWarning();
    },
  };
}

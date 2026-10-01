import { reactive } from "vue";

import type { WebSessionView } from "../types";
import { apiRequest } from "./api";
import { sessionBoundaryKey } from "./session-boundary";

export interface NotificationResource {
  id: string;
  title: string;
  body: string;
  created_at: string;
  expires_at: string | null;
  withdrawn_at: string | null;
  version: number;
  status: "active" | "expired" | "withdrawn";
  acknowledged_at: string | null;
}

export interface NotificationPage {
  items: NotificationResource[];
  next_cursor: string | null;
}

export interface NotificationPreferences {
  enabled: boolean;
  version: number;
  receive_after: string;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isTime(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
export function isNotificationResource(value: unknown): value is NotificationResource {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
    && typeof value.title === "string" && Array.from(value.title).length >= 1 && Array.from(value.title).length <= 200
    && typeof value.body === "string" && Array.from(value.body).length >= 1 && Array.from(value.body).length <= 4000
    && isTime(value.created_at) && (value.expires_at === null || isTime(value.expires_at))
    && (value.withdrawn_at === null || isTime(value.withdrawn_at)) && (value.acknowledged_at === null || isTime(value.acknowledged_at))
    && typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version > 0
    && (value.status === "active" || value.status === "expired" || value.status === "withdrawn");
}
export function isNotificationPage(value: unknown): value is NotificationPage {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isNotificationResource)
    && (value.next_cursor === null || typeof value.next_cursor === "string");
}
export function isNotificationPreferences(value: unknown): value is NotificationPreferences {
  return isRecord(value) && typeof value.enabled === "boolean" && typeof value.version === "number"
    && Number.isSafeInteger(value.version) && value.version > 0 && isTime(value.receive_after);
}
export function hasNotificationResource(value: unknown): value is { resource: NotificationResource } {
  return isRecord(value) && isNotificationResource(value.resource);
}
export function hasNotificationPreferences(value: unknown): value is { resource: NotificationPreferences } {
  return isRecord(value) && isNotificationPreferences(value.resource);
}

export function notificationSessionKey(session: WebSessionView | null): string | null {
  if (session === null) return null;
  return sessionBoundaryKey(session);
}

export const notificationAttention = reactive({ hasPending: false, unavailable: false, checking: false });
let boundary: string | null = null;
let generation = 0;
let lastCheck = -Infinity;
let controller: AbortController | null = null;

export function setNotificationSession(session: WebSessionView | null): void {
  const nextBoundary = notificationSessionKey(session);
  if (boundary === nextBoundary) return;
  boundary = nextBoundary;
  clearNotificationAttention();
}

export function clearNotificationAttention(): void {
  generation += 1;
  controller?.abort();
  controller = null;
  lastCheck = -Infinity;
  notificationAttention.hasPending = false;
  notificationAttention.unavailable = false;
  notificationAttention.checking = false;
}

export async function checkNotificationAttention(force = false): Promise<void> {
  if (boundary === null) return;
  if (!force && (controller !== null || Date.now() - lastCheck < 45_000)) return;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  const requestGeneration = ++generation;
  lastCheck = Date.now();
  notificationAttention.checking = true;
  const timeout = setTimeout(() => current.abort(), 2_000);
  try {
    const result = await apiRequest<NotificationPage>("/api/v1/me/notifications?pending=true&limit=3", { signal: current.signal, validateResponse: value => isNotificationPage(value) && value.items.length <= 3 });
    if (requestGeneration !== generation || current.signal.aborted) return;
    notificationAttention.hasPending = result.items.length > 0;
    notificationAttention.unavailable = false;
  } catch {
    if (requestGeneration === generation) notificationAttention.unavailable = true;
  } finally {
    clearTimeout(timeout);
    if (requestGeneration === generation) {
      controller = null;
      notificationAttention.checking = false;
    }
  }
}

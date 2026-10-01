import type { WebSessionView } from "../types";
import { sameSessionBoundary } from "./session-boundary";

const ACTIVITY_EVENTS = new Set(["pointerdown", "pointermove", "mousedown", "mousemove", "keydown", "input", "touchstart", "touchmove", "wheel"]);
const REQUEST_TIMEOUT_MS = 5_000;
const FAILURE_BACKOFF_MS = 30_000;
const DEADLINE_CHECK_LEAD_MS = 5_000;

export function hasSessionRenewal(session: WebSessionView): boolean {
  return Number.isSafeInteger(session.version) && (session.version ?? 0) > 0
    && Number.isFinite(Date.parse(session.renewal?.renew_after ?? ""))
    && Number.isFinite(Date.parse(session.renewal?.absolute_expires_at ?? ""));
}

export function isSessionRenewalResult(value: unknown, sessionId: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as { event_cursor?: unknown; idempotent_replay?: unknown; resource?: Record<string, unknown> };
  const resource = envelope.resource;
  return typeof envelope.event_cursor === "string" && typeof envelope.idempotent_replay === "boolean"
    && resource?.session_id === sessionId && Number.isSafeInteger(resource.version) && Number(resource.version) > 0
    && typeof resource.renewed === "boolean"
    && [resource.expires_at, resource.renew_after, resource.absolute_expires_at].every(item => typeof item === "string" && Number.isFinite(Date.parse(item)))
    && Date.parse(String(resource.expires_at)) <= Date.parse(String(resource.absolute_expires_at));
}

export function mergeSessionFacts(previous: WebSessionView | null, next: WebSessionView): WebSessionView {
  if (!previous || !sameSessionBoundary(previous, next)) return next;
  if (hasSessionRenewal(previous) && hasSessionRenewal(next) && next.version! < previous.version!) return previous;
  if (Date.parse(next.expires_at) >= Date.parse(previous.expires_at)) return next;
  return { ...next, expires_at: previous.expires_at, ...(hasSessionRenewal(previous) && hasSessionRenewal(next)
    ? { version: Math.max(previous.version!, next.version!), renewal: previous.renewal }
    : {}) };
}

export interface SessionRenewalOptions {
  read(signal: AbortSignal): Promise<WebSessionView>;
  renew(version: number, sessionId: string, signal: AbortSignal): Promise<void>;
  accept(session: WebSessionView): void;
  expire(): void;
  accessFailure(error: unknown): boolean;
  versionConflict(error: unknown): boolean;
  visible(): boolean;
  notify?(): void;
  now?: () => number;
  set?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clear?: (handle: ReturnType<typeof setTimeout>) => void;
}

// Activity can initiate a write. Focus, tab hints and deadline checks only read.
// Uncertain renewal writes retain their original version (and apiRequest key).
export class SessionRenewalController {
  #session: WebSessionView | null = null;
  #generation = 0;
  #running: { promise: Promise<void>; controller: AbortController; cancel(): void } | null = null;
  #deadlineCheck: ReturnType<typeof setTimeout> | null = null;
  #hintTimer: ReturnType<typeof setTimeout> | null = null;
  #checkedExpiry = "";
  #retryAt = 0;
  #lastHintAt = -Infinity;
  #pendingVersion: number | null = null;
  readonly #options: SessionRenewalOptions;
  readonly #now: () => number;
  readonly #set: NonNullable<SessionRenewalOptions["set"]>;
  readonly #clear: NonNullable<SessionRenewalOptions["clear"]>;

  constructor(options: SessionRenewalOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#set = options.set ?? setTimeout;
    this.#clear = options.clear ?? clearTimeout;
  }

  setSession(session: WebSessionView | null): void {
    if (!session || !this.#session || !sameSessionBoundary(this.#session, session)) {
      this.#generation += 1;
      this.#running?.cancel();
      this.#running = null;
      if (this.#hintTimer !== null) this.#clear(this.#hintTimer);
      this.#hintTimer = null;
      this.#lastHintAt = -Infinity;
      this.#pendingVersion = null;
      this.#retryAt = 0;
      this.#checkedExpiry = "";
    }
    this.#session = session;
    if (this.#deadlineCheck !== null) this.#clear(this.#deadlineCheck);
    this.#deadlineCheck = null;
    if (!session || !hasSessionRenewal(session)) return;
    const key = `${session.session_id}:${session.expires_at}`;
    if (this.#checkedExpiry === key) return;
    const generation = this.#generation;
    this.#deadlineCheck = this.#set(() => {
      this.#deadlineCheck = null;
      if (generation !== this.#generation) return;
      this.#checkedExpiry = key;
      void this.revalidate();
    }, Math.max(0, Date.parse(session.expires_at) - this.#now() - DEADLINE_CHECK_LEAD_MS));
  }

  activity(event: Pick<Event, "isTrusted" | "type">): void {
    const current = this.#session;
    if (!event.isTrusted || !ACTIVITY_EVENTS.has(event.type) || !this.#options.visible() || !current || !hasSessionRenewal(current)) return;
    const now = this.#now();
    if (this.#running || now < this.#retryAt || now < Date.parse(current.renewal!.renew_after)
      || now >= Date.parse(current.expires_at) || now >= Date.parse(current.renewal!.absolute_expires_at)
      || Date.parse(current.expires_at) >= Date.parse(current.renewal!.absolute_expires_at)) return;
    void this.#request(true);
  }

  hint(): void {
    if (!this.#session) return;
    const remaining = FAILURE_BACKOFF_MS - (this.#now() - this.#lastHintAt);
    if (remaining > 0) {
      this.#hintTimer ??= this.#set(() => { this.#hintTimer = null; this.hint(); }, remaining);
      return;
    }
    this.#lastHintAt = this.#now();
    void this.revalidate();
  }

  revalidate(): Promise<void> { return this.#request(false); }

  async deadline(): Promise<void> {
    const generation = this.#generation;
    const current = this.#session;
    if (!current) return;
    if (hasSessionRenewal(current)) await this.revalidate();
    if (generation === this.#generation && this.#session && Date.parse(this.#session.expires_at) <= this.#now()) this.#options.expire();
  }

  #request(renew: boolean): Promise<void> {
    if (this.#running) return this.#running.promise;
    const current = this.#session;
    if (!current) return Promise.resolve();
    const generation = this.#generation;
    const controller = new AbortController();
    const active = () => generation === this.#generation && !controller.signal.aborted && this.#session !== null;
    let timeout: ReturnType<typeof setTimeout>;
    let finish = (): void => {};
    const work = async (): Promise<void> => {
      try {
        if (renew) {
          this.#pendingVersion ??= current.version!;
          try { await this.#options.renew(this.#pendingVersion, current.session_id, controller.signal); }
          catch (caught) { if (!this.#options.versionConflict(caught)) throw caught; }
          if (!active()) return;
          this.#pendingVersion = null;
        }
        const result = await this.#options.read(controller.signal);
        if (!active()) return;
        this.#options.accept(mergeSessionFacts(this.#session, result));
        if (renew && active()) this.#options.notify?.();
      } catch (caught) {
        if (!active()) return;
        if (this.#options.accessFailure(caught)) this.#options.expire();
        else this.#retryAt = this.#now() + FAILURE_BACKOFF_MS;
      }
    };
    const bounded = new Promise<void>(resolve => {
      finish = resolve;
      timeout = this.#set(() => { controller.abort(); if (generation === this.#generation) this.#retryAt = this.#now() + FAILURE_BACKOFF_MS; resolve(); }, REQUEST_TIMEOUT_MS);
      void work().finally(resolve);
    });
    const running = { controller, cancel: () => { controller.abort(); this.#clear(timeout); finish(); }, promise: bounded.finally(() => {
      this.#clear(timeout);
      if (this.#running === running) this.#running = null;
    }) };
    this.#running = running;
    return running.promise;
  }
}

export const SESSION_ACTIVITY_EVENTS = [...ACTIVITY_EVENTS];

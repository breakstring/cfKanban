export interface SessionExpiryTimer {
  clear(handle: number): void;
  now(): number;
  set(callback: () => void, delayMs: number): number;
}

export interface SessionExpirySchedule {
  cancel(): void;
  scheduled: boolean;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

const browserTimer: SessionExpiryTimer = {
  clear: (handle) => window.clearTimeout(handle),
  now: () => Date.now(),
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
};

export function scheduleSessionExpiry(
  expiresAt: string,
  onExpire: () => void,
  timer: SessionExpiryTimer = browserTimer,
): SessionExpirySchedule {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= timer.now()) {
    return { cancel() {}, scheduled: false };
  }

  let active = true;
  let handle: number | null = null;
  const arm = (): void => {
    if (!active) return;
    const remaining = expiresAtMs - timer.now();
    if (remaining <= 0) {
      active = false;
      handle = null;
      onExpire();
      return;
    }
    handle = timer.set(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  arm();

  return {
    cancel() {
      if (!active) return;
      active = false;
      if (handle !== null) timer.clear(handle);
      handle = null;
    },
    scheduled: true,
  };
}

import type { ListResult } from "../types";

export function mergePageById<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  reset = false,
): T[] {
  const source = reset ? incoming : [...current, ...incoming];
  return [...new Map(source.map((entry) => [entry.id, entry])).values()];
}

export function continuationCursor<T>(result: ListResult<T>): string | null {
  if (!result.has_more) return null;
  if (typeof result.next_cursor !== "string" || result.next_cursor.length === 0) {
    throw new Error("The server reported more rows without a continuation cursor.");
  }
  return result.next_cursor;
}

export function cursorRequiresRestart(error: unknown): boolean {
  const code = (error as { body?: { code?: unknown } })?.body?.code;
  return code === "CURSOR_SCOPE_MISMATCH" || code === "INVALID_CURSOR";
}

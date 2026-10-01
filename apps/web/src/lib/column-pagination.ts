import type { ListResult } from "../types";
import { continuationCursor, cursorRequiresRestart, mergePageById } from "./pagination";

export class ColumnPagination<T extends { id: string }> {
  items: T[] = [];
  cursor: string | null = null;
  loading = false;
  loaded = false;
  error: unknown = null;
  private generation = 0;

  constructor(private readonly preserveItemsOnCursorRestart = false) {}

  reset(): void {
    this.generation += 1;
    this.items = [];
    this.cursor = null;
    this.loading = false;
    this.loaded = false;
    this.error = null;
  }

  reconcile(update: (items: T[]) => T[]): void {
    this.generation += 1;
    this.loading = false;
    this.items = update(this.items);
  }

  async load(fetchPage: (cursor?: string) => Promise<ListResult<T>>, reset = false): Promise<boolean> {
    if (reset) this.reset();
    if (this.loading || (this.loaded && this.cursor === null && this.error === null)) return false;
    const generation = this.generation;
    const cursor = this.cursor;
    this.loading = true;
    this.error = null;
    try {
      const page = await fetchPage(cursor ?? undefined);
      if (generation !== this.generation) return false;
      const next = continuationCursor(page);
      if (next !== null && next === cursor) throw new Error("The server repeated a continuation cursor.");
      this.items = mergePageById(this.items, page.items, !this.loaded && !this.preserveItemsOnCursorRestart);
      this.cursor = next;
      this.loaded = true;
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      if (cursorRequiresRestart(error)) {
        if (!this.preserveItemsOnCursorRestart) this.items = [];
        this.cursor = null;
        this.loaded = false;
      }
      this.error = error;
      return false;
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
}

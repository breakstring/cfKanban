import type { LabelResource, ListResult } from "../types";
import { continuationCursor } from "./pagination";

// SQLite NOCASE only folds ASCII; Unicode case folding would merge distinct labels.
export function labelNameKey(name: string): string {
  return name.trim().replace(/[A-Z]/g, char => char.toLowerCase());
}

export async function resolveInputLabel(
  name: string,
  list: (cursor?: string) => Promise<ListResult<LabelResource>>,
  create: (name: string) => Promise<LabelResource>,
): Promise<LabelResource> {
  const find = async (): Promise<LabelResource | undefined> => {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = await list(cursor ?? undefined);
      const match = page.items.find(label => labelNameKey(label.name) === labelNameKey(name));
      if (match) return match;
      cursor = continuationCursor(page);
      if (cursor && seen.has(cursor)) throw new Error("Repeated label cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return undefined;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    return await create(name.trim());
  } catch (error) {
    if ((error as { body?: { code?: string } }).body?.code !== "LABEL_NAME_CONFLICT") throw error;
    const concurrent = await find();
    if (concurrent) return concurrent;
    // A soft-deleted label still owns its name; never restore it implicitly.
    throw error;
  }
}

import { priorityOrder } from "./priority";
import type { PriorityKey } from "../types";

export function boardFilters(query: string): { search: string; priorities: PriorityKey[]; labels: string[] } {
  const params = new URLSearchParams(query);
  return {
    search: params.get("q") ?? "",
    priorities: [...new Set(params.getAll("priority"))].filter((value): value is PriorityKey => priorityOrder.includes(value as PriorityKey)),
    labels: [...new Set(params.getAll("label"))].filter(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)).slice(0, 20),
  };
}

export function boardPath(workspaceId: string, projectId: string, filter?: ReturnType<typeof boardFilters>): string {
  const base = `/app/w/${encodeURIComponent(workspaceId)}/p/${encodeURIComponent(projectId)}`;
  const params = new URLSearchParams();
  if (filter?.search.trim()) params.set("q", filter.search.trim());
  for (const priority of filter?.priorities ?? []) params.append("priority", priority);
  for (const label of filter?.labels ?? []) params.append("label", label);
  return `${base}${params.size ? `?${params}` : ""}`;
}

export function boardReturnPath(workspaceId: string, projectId: string, query: string): string {
  const base = boardPath(workspaceId, projectId);
  const from = new URLSearchParams(query).get("from") ?? "";
  return from.startsWith(`${base}?`) ? boardPath(workspaceId, projectId, boardFilters(from.slice(base.length + 1))) : base;
}

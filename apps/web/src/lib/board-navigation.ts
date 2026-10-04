import { priorityOrder } from "./priority";
import type { PriorityKey, StatusKey } from "../types";

export function boardFilters(query: string): { search: string; priorities: PriorityKey[]; labels: string[]; view?: "list"; status?: StatusKey; expanded?: StatusKey[] } {
  const params = new URLSearchParams(query);
  const knownStatuses: StatusKey[] = ["backlog", "todo", "in_progress", "done", "canceled"];
  const status = params.get("status") as StatusKey;
  return {
    ...(knownStatuses.includes(status) ? { status } : {}),
    ...(params.has("expanded") ? { expanded: [...new Set(params.getAll("expanded"))].filter((key): key is StatusKey => knownStatuses.includes(key as StatusKey)) } : {}),
    ...(params.get("view") === "list" ? { view: "list" as const } : {}),
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
  if (filter?.view === "list") params.set("view", "list");
  if (filter?.status) params.set("status", filter.status);
  if (filter?.expanded) {
    for (const key of filter.expanded) params.append("expanded", key);
    if (!filter.expanded.length) params.set("expanded", "");
  }
  return `${base}${params.size ? `?${params}` : ""}`;
}

export function boardReturnPath(workspaceId: string, projectId: string, query: string): string {
  const base = boardPath(workspaceId, projectId);
  const from = new URLSearchParams(query).get("from") ?? "";
  return from.startsWith(`${base}?`) ? boardPath(workspaceId, projectId, boardFilters(from.slice(base.length + 1))) : base;
}

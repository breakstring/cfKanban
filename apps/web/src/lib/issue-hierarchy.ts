export interface IssueParentSummary {
  id: string;
  identifier: string;
  title: string;
  workspace_id: string;
  project_id: string;
  status: { key: string; display_name: string };
}

export interface IssueHierarchy {
  parents: IssueParentSummary[];
  parent_count: number;
  children: { total: number; done: number };
}

const statuses = new Set(["backlog", "todo", "in_progress", "done", "canceled"]);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function readIssueHierarchy(value: unknown): IssueHierarchy | undefined {
  if (!record(value, ["parents", "parent_count", "children"]) || !count(value.parent_count)
    || !record(value.children, ["total", "done"]) || !count(value.children.total) || !count(value.children.done)
    || value.children.done > value.children.total || !Array.isArray(value.parents)
    || value.parents.length > 10 || value.parents.length > value.parent_count) return undefined;
  const parents: IssueParentSummary[] = [];
  const seen = new Set<string>();
  for (const parent of value.parents) {
    if (!record(parent, ["id", "identifier", "title", "workspace_id", "project_id", "status"])
      || !uuid(parent.id) || !uuid(parent.workspace_id) || !uuid(parent.project_id)
      || typeof parent.identifier !== "string" || !/^[A-Z][A-Z0-9]{1,11}-[1-9][0-9]{0,14}$/.test(parent.identifier)
      || seen.has(parent.identifier) || typeof parent.title !== "string" || !parent.title.trim() || parent.title.length > 8192
      || !record(parent.status, ["key", "display_name"]) || typeof parent.status.key !== "string" || !statuses.has(parent.status.key)
      || typeof parent.status.display_name !== "string" || Array.from(parent.status.display_name).length > 128) return undefined;
    seen.add(parent.identifier);
    parents.push({ id: parent.id, identifier: parent.identifier, title: parent.title, workspace_id: parent.workspace_id, project_id: parent.project_id, status: { key: parent.status.key, display_name: parent.status.display_name } });
  }
  return { parents, parent_count: value.parent_count, children: { total: value.children.total, done: value.children.done } };
}

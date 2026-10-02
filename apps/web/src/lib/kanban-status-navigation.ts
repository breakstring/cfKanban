import type { StatusKey } from "../types";

export interface KanbanStatusColumn {
  key: StatusKey;
  display_name: string;
  loaded: number;
  has_more: boolean;
  target_id: string;
}

export function loadedStatusLabel(column: KanbanStatusColumn, chinese: boolean): string {
  return chinese
    ? `${column.display_name} · 已加载 ${column.loaded} 条${column.has_more ? "，还有未加载事项" : ""}；横向定位到此列`
    : `${column.display_name} · ${column.loaded} loaded issues${column.has_more ? ", more pages available" : ""}; show this column`;
}

export function scrollToStatusColumn(region: HTMLElement | null, targetId: string): boolean {
  const column = region && Array.from(region.querySelectorAll<HTMLElement>("[id]")).find(element => element.id === targetId);
  if (!region || !column) return false;
  region.scrollTo({
    left: region.scrollLeft + column.getBoundingClientRect().left - region.getBoundingClientRect().left - region.clientLeft,
    top: region.scrollTop,
    behavior: "auto",
  });
  return true;
}

export function moveStatusNavigationFocus(region: HTMLElement | null, event: KeyboardEvent): void {
  if (!region || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(region.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  const current = buttons.findIndex(button => button === (event.target as HTMLElement | null)?.closest?.("button"));
  if (current < 0) return;
  event.preventDefault();
  const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  const button = buttons[index];
  if (!button) return;
  button.focus({ preventScroll: true });
  const bounds = region.getBoundingClientRect();
  const target = button.getBoundingClientRect();
  const offset = target.left < bounds.left ? target.left - bounds.left : target.right > bounds.right ? target.right - bounds.right : 0;
  if (offset) region.scrollTo({ left: region.scrollLeft + offset, top: region.scrollTop, behavior: "auto" });
}

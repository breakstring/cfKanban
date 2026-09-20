import type { PriorityKey } from "../types";

export const priorityOrder: PriorityKey[] = ["none", "low", "medium", "high", "urgent"];
export function prioritySaveIsUncertain(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return status === undefined || status === 0 || status >= 500;
}
export function priorityText(priority: PriorityKey, chinese: boolean): string {
  return chinese ? ({ none: "无", low: "低", medium: "中", high: "高", urgent: "紧急" } as const)[priority]
    : ({ none: "None", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" } as const)[priority];
}

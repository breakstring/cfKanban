import type { SupportedLocale } from "./locale-preference";

const defaultStatusNames = {
  backlog: { en: "Backlog", "zh-CN": "待规划" },
  todo: { en: "Todo", "zh-CN": "待办" },
  in_progress: { en: "In Progress", "zh-CN": "进行中" },
  done: { en: "Done", "zh-CN": "已完成" },
  canceled: { en: "Canceled", "zh-CN": "已取消" },
} as const;

export function statusDisplayName(status: {
  key: string;
  display_name?: string | null;
  name?: string | null;
}, locale: SupportedLocale): string {
  const name = status.display_name || status.name;
  const defaults = Object.hasOwn(defaultStatusNames, status.key)
    ? defaultStatusNames[status.key as keyof typeof defaultStatusNames]
    : undefined;
  if (!defaults) return name || status.key;
  return !name || name === defaults.en ? defaults[locale] : name;
}

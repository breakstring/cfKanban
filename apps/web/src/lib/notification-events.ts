export function isNotificationPath(path: string): boolean {
  return /^\/api\/v1\/(?:me\/(?:notifications|notification-preferences)|admin\/notifications)(?:[/?]|$)/.test(path);
}

export function notifyBusinessSuccess(path: string): void {
  if (typeof window === "undefined" || !path.startsWith("/api/v1/") || isNotificationPath(path)) return;
  // 提醒是独立检查，监听器或宿主异常不能改变已经成功的业务结果。
  try { window.dispatchEvent(new CustomEvent("cfkanban:business-success")); } catch { /* 主结果照常返回。 */ }
}

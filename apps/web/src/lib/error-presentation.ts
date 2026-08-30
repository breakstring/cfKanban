export type ErrorTranslationKey =
  | "error.authorization"
  | "error.businessQuota"
  | "error.capability"
  | "error.conflict"
  | "error.generic"
  | "error.notFound"
  | "error.platform"
  | "error.platformQuota"
  | "error.rate"
  | "error.session"
  | "error.validation";

export interface PresentableApiProblem {
  body: {
    category: string;
    code: string;
    details?: Record<string, unknown>;
    recovery: string;
    request_id: string;
    retryable: boolean;
  };
  retryAfter: number | null;
  status: number;
}

export function presentApiProblem(
  error: PresentableApiProblem,
  locale: "en" | "zh-CN",
  translate: (key: ErrorTranslationKey) => string,
): string {
  const { body } = error;
  const requestSuffix = ` · ${locale === "zh-CN" ? "请求" : "request"} ${body.request_id}`;
  const retryAfter = error.retryAfter;
  const recoveryText = (): string => {
    if (body.recovery === "wait_for_platform_reset") {
      const resetAt = typeof body.details?.reset_at === "string" ? body.details.reset_at : null;
      return locale === "zh-CN"
        ? resetAt === null ? "请等待平台额度重置后重试。" : `请等待平台额度在 ${resetAt} 重置后重试。`
        : resetAt === null ? "Wait for the platform quota to reset." : `Wait for the platform quota reset at ${resetAt}.`;
    }
    if (body.recovery === "request_owner") {
      return locale === "zh-CN" ? "请联系 Deployment Owner 处理。" : "Ask the Deployment Owner to resolve it.";
    }
    if (body.recovery === "retry_after") {
      if (retryAfter !== null) {
        return locale === "zh-CN" ? `${retryAfter} 秒后可重试。` : `Try again in ${retryAfter} seconds.`;
      }
      return locale === "zh-CN" ? "网络恢复后可使用同一操作安全重试。" : "Retry the same operation after connectivity is restored.";
    }
    if (body.recovery === "retry_or_request_owner") {
      return body.retryable
        ? (locale === "zh-CN" ? "可安全重试；持续失败时联系 Deployment Owner。" : "Retry safely; ask the Deployment Owner if it persists.")
        : (locale === "zh-CN" ? "请刷新后重试；持续失败时联系 Deployment Owner。" : "Refresh before retrying; ask the Deployment Owner if it persists.");
    }
    return "";
  };
  if (body.code === "VERSION_CONFLICT") return translate("error.conflict");
  if (
    error.status === 410
    && (body.code.includes("INVITATION") || body.code.includes("BROWSER_LAUNCH"))
  ) return translate("error.capability");
  if (body.category === "authentication") return translate("error.session");
  if (body.category === "authorization") return translate("error.authorization");
  if (body.category === "business_quota") return translate("error.businessQuota");
  if (body.category === "not_found") return translate("error.notFound");
  if (body.category === "rate_limit") {
    return error.retryAfter === null
      ? translate("error.rate")
      : `${translate("error.rate")} ${locale === "zh-CN"
        ? `${error.retryAfter} 秒后可重试。`
        : `Try again in ${error.retryAfter} seconds.`}`;
  }
  if (body.category === "platform_quota") {
    return `${translate("error.platformQuota")} ${recoveryText()}${requestSuffix}`;
  }
  if (body.category === "platform_failure") {
    return `${translate("error.platform")} ${recoveryText()}${requestSuffix}`;
  }
  if (body.category === "validation") return translate("error.validation");
  return translate("error.generic");
}

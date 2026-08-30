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
    request_id: string;
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
    return `${translate("error.platformQuota")} · ${locale === "zh-CN" ? "请求" : "request"} ${body.request_id}`;
  }
  if (body.category === "platform_failure") {
    return `${translate("error.platform")} · ${locale === "zh-CN" ? "请求" : "request"} ${body.request_id}`;
  }
  if (body.category === "validation") return translate("error.validation");
  return translate("error.generic");
}

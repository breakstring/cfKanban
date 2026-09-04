export type ErrorTranslationKey =
  | "error.authorization"
  | "error.businessQuota"
  | "error.capability"
  | "error.conflict"
  | "error.generic"
  | "error.idempotencyExpired"
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
    source: string;
  };
  retryAfter: number | null;
  status: number;
}

type SupportedLocale = "en" | "zh-CN";

const CATEGORY_LABELS: Record<string, { en: string; "zh-CN": string }> = {
  authentication: { en: "Authentication", "zh-CN": "身份验证" },
  authorization: { en: "Authorization", "zh-CN": "权限" },
  business_quota: { en: "Project quota", "zh-CN": "项目限额" },
  conflict: { en: "Concurrent change", "zh-CN": "并发变更" },
  not_found: { en: "Unavailable resource", "zh-CN": "资源不可用" },
  platform_failure: { en: "Platform failure", "zh-CN": "平台故障" },
  platform_quota: { en: "Platform quota", "zh-CN": "平台额度" },
  rate_limit: { en: "Request rate", "zh-CN": "请求频率" },
  validation: { en: "Input validation", "zh-CN": "输入校验" },
};

function categoryLabel(category: string, selectedLocale: SupportedLocale): string {
  const labels = CATEGORY_LABELS[category];
  return labels === undefined ? category : `${labels[selectedLocale]} (${category})`;
}

function recoveryAction(error: PresentableApiProblem, selectedLocale: SupportedLocale): string {
  const { body, retryAfter } = error;
  const chinese = selectedLocale === "zh-CN";
  if (body.recovery === "reauthenticate") return chinese ? "重新登录" : "Sign in again";
  if (body.recovery === "refresh_resource") {
    return chinese ? "刷新远端事实后重新决定" : "Refresh the remote facts before deciding again";
  }
  if (body.recovery === "refresh_cursor") return chinese ? "从第一页刷新列表" : "Refresh the list from its first page";
  if (body.recovery === "free_capacity_or_request_owner") {
    return chinese ? "释放对应容量，或请实例所有者调整限制" : "Release the relevant capacity or ask the Deployment Owner to change the limit";
  }
  if (body.recovery === "retry_after") {
    if (retryAfter !== null) return chinese ? `${retryAfter} 秒后重试同一操作` : `Retry the same operation in ${retryAfter} seconds`;
    return chinese ? "连接恢复后重试同一操作" : "Retry the same operation after connectivity is restored";
  }
  if (body.recovery === "wait_for_platform_reset") {
    const resetAt = typeof body.details?.reset_at === "string" ? body.details.reset_at : null;
    if (resetAt !== null) return chinese ? `等待平台额度在 ${resetAt} 重置` : `Wait for the platform quota reset at ${resetAt}`;
    return chinese ? "等待平台额度重置" : "Wait for the platform quota to reset";
  }
  if (body.recovery === "request_owner") return chinese ? "联系部署实例所有者处理" : "Ask the Deployment Owner to resolve it";
  if (body.recovery === "request_access") return chinese ? "向实例所有者申请所需权限" : "Ask the Deployment Owner for the required access";
  if (body.recovery === "request_new_browser_launch") return chinese ? "让 Agent 创建新的浏览器启动链接" : "Ask the Agent for a new Browser Launch";
  if (body.recovery === "restore_parent") return chinese ? "先恢复已删除的上级资源" : "Restore the deleted parent resource first";
  if (body.recovery === "restore_endpoint") return chinese ? "先恢复已删除的关系端点" : "Restore the deleted relation endpoint first";
  if (body.recovery === "narrow_scope") return chinese ? "缩小项目范围后重试" : "Narrow the Project scope before retrying";
  if (body.recovery === "verify_trusted_origin") return chinese ? "核对实例的可信地址" : "Verify the instance's trusted origin";
  if (body.recovery === "none") return chinese ? "根据错误调整请求" : "Adjust the request using the error facts";
  return chinese ? `按恢复代码处理：${body.recovery}` : `Follow recovery code: ${body.recovery}`;
}

function sourceLabel(body: PresentableApiProblem["body"], selectedLocale: SupportedLocale): string {
  const chinese = selectedLocale === "zh-CN";
  const normalizedByClient = body.details?.normalized_by === "client";
  if (normalizedByClient && body.source === "cloudflare_platform") {
    return chinese
      ? "Cloudflare 边缘响应，由当前浏览器归一化（非 cfKanban API 响应）"
      : "Cloudflare edge response, normalized by this browser (not a cfKanban API response)";
  }
  if (normalizedByClient && body.source === "client_transport") {
    return chinese
      ? "当前浏览器网络层，本地归一化（非 cfKanban API 响应）"
      : "This browser's network layer, normalized locally (not a cfKanban API response)";
  }
  if (body.source === "cloudflare_platform") {
    return chinese ? "Cloudflare 平台，由 cfKanban 服务确认" : "Cloudflare platform, verified by the cfKanban service";
  }
  return body.source === "service"
    ? (chinese ? "cfKanban 服务" : "cfKanban service")
    : body.source;
}

function diagnosticText(error: PresentableApiProblem, selectedLocale: SupportedLocale): string {
  const { body, retryAfter } = error;
  const chinese = selectedLocale === "zh-CN";
  const normalizedByClient = body.details?.normalized_by === "client";
  const parts = [
    `${chinese ? "错误代码" : "Code"}: ${body.code}`,
    `${chinese ? "类别" : "Category"}: ${categoryLabel(body.category, selectedLocale)}`,
    `${chinese ? "来源" : "Source"}: ${sourceLabel(body, selectedLocale)}`,
    `${chinese ? "恢复" : "Recovery"}: ${recoveryAction(error, selectedLocale)} (${body.recovery})`,
    `${chinese ? "可原样重试" : "Replay unchanged"}: ${body.retryable ? (chinese ? "是" : "yes") : (chinese ? "否" : "no")} (retryable=${body.retryable})`,
    `${normalizedByClient ? (chinese ? "本地关联 ID" : "Local correlation ID") : (chinese ? "请求 ID" : "Request ID")}: ${body.request_id}`,
  ];
  if (retryAfter !== null) parts.push(`Retry-After: ${retryAfter}${chinese ? " 秒" : " seconds"}`);
  const providerRequestId = body.details?.provider_request_id;
  if (typeof providerRequestId === "string" && providerRequestId.length > 0) {
    parts.push(`Cloudflare Ray ID: ${providerRequestId}`);
  }
  const currentUsage = body.details?.current_usage;
  const limit = body.details?.limit;
  if (typeof currentUsage === "number" && Number.isSafeInteger(currentUsage)
    && typeof limit === "number" && Number.isSafeInteger(limit)) {
    parts.push(`${chinese ? "当前用量" : "Current usage"}: ${currentUsage} / ${limit}`);
  }
  const currentVersion = body.details?.current_version;
  if (typeof currentVersion === "number" && Number.isSafeInteger(currentVersion)) {
    parts.push(`${chinese ? "远端版本" : "Remote version"}: ${currentVersion}`);
  }
  return `${chinese ? "诊断信息" : "Diagnostic facts"}: ${parts.join(" · ")}`;
}

function addVisibleRecovery(
  message: string,
  error: PresentableApiProblem,
  selectedLocale: SupportedLocale,
): string {
  const action = recoveryAction(error, selectedLocale);
  return selectedLocale === "zh-CN"
    ? `${message} 下一步：${action}。`
    : `${message} Next: ${action}.`;
}

export function presentApiProblem(
  error: PresentableApiProblem,
  locale: SupportedLocale,
  translate: (key: ErrorTranslationKey) => string,
): string {
  const { body } = error;
  let message: string | undefined;
  if (body.code === "IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED") message = translate("error.idempotencyExpired");
  else if (body.code === "VERSION_CONFLICT") message = translate("error.conflict");
  if (
    message === undefined
    &&
    error.status === 410
    && (body.code.includes("INVITATION") || body.code.includes("BROWSER_LAUNCH"))
  ) message = translate("error.capability");
  else if (message === undefined && body.category === "authentication") {
    message = addVisibleRecovery(translate("error.session"), error, locale);
  }
  else if (message === undefined && body.category === "authorization") {
    message = addVisibleRecovery(translate("error.authorization"), error, locale);
  }
  else if (message === undefined && body.category === "business_quota") message = translate("error.businessQuota");
  else if (message === undefined && body.category === "not_found") message = translate("error.notFound");
  else if (message === undefined && body.category === "rate_limit") {
    message = error.retryAfter === null
      ? translate("error.rate")
      : `${translate("error.rate")} ${locale === "zh-CN"
        ? `${error.retryAfter} 秒后可重试。`
        : `Try again in ${error.retryAfter} seconds.`}`;
  }
  else if (message === undefined && body.category === "platform_quota") {
    message = addVisibleRecovery(translate("error.platformQuota"), error, locale);
  }
  else if (message === undefined && body.category === "platform_failure") {
    message = addVisibleRecovery(translate("error.platform"), error, locale);
  }
  else if (message === undefined && body.category === "validation") message = translate("error.validation");
  else if (message === undefined) message = translate("error.generic");
  return `${message}\n${diagnosticText(error, locale)}`;
}

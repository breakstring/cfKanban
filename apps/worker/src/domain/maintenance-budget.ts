const INVOCATION_SUBREQUEST_BUDGET = 50;
const RESERVED_SUBREQUESTS = 4;
const ATTACHMENT_FIXED_QUERIES = 5;
const USAGE_MAX_SUBREQUESTS = 9;

// 共用最保守的 Free 预算；D1 batch 内的每条 statement 分别计入。
export function maintenanceBudget(attachments: boolean, usageHistory: boolean): { attachmentBatch: number; maxSubrequests: number } {
  const attachmentBatch = attachments ? 8 : 0;
  const attachmentRequests = attachments ? ATTACHMENT_FIXED_QUERIES + 2 * attachmentBatch : 0;
  const usageRequests = usageHistory ? USAGE_MAX_SUBREQUESTS : 0;
  const maxSubrequests = RESERVED_SUBREQUESTS + attachmentRequests + usageRequests;
  if (maxSubrequests > INVOCATION_SUBREQUEST_BUDGET) throw new RangeError("invalid maintenance budget");
  return { attachmentBatch, maxSubrequests };
}

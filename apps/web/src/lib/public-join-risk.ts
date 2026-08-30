import type { Locale } from "../types";

export function publicJoinRiskNotice(locale: Locale): string[] {
  if (locale === "zh-CN") {
    return [
      "未知互联网参与者可以加入。公开 writer 可创建评论、移动、完成、修改和软删除 Project 内容，并产生 D1 写入。只要 Project 仍公开，被撤销 Grant 的 Principal 就可以再次 self-join。",
      "三项 active quota 仅属于这个 Project，不是共享池，而且只在 Public Join Policy enabled 时强制。关闭 Policy 不会撤销既有 Grant；重新开启后 quota 会再次生效。",
      "limit 可以低于当前 usage；这不会自动删除资源或撤销 Grant，只会阻止该维度继续增长。soft delete 与 Grant revoke 会释放 active slot，restore 与 regrant 会重新占用 slot。",
      "恢复 soft-deleted Issue 时，Issue 本身及其全部 active Comment 必须同时容纳在 quota 中；任一 quota 不足都会让整个恢复原子失败。每次 complete 创建的不可变 completion comment 也持续计入 active Comment quota。",
      "active slot 被释放不代表数据已物理清除；tombstone、completion 与历史仍占用 D1 存储。",
    ];
  }
  return [
    "Unknown Internet participants may join. Public writers can create comments, move, complete, modify, and soft-delete Project content, producing D1 writes. While the Project remains public, a Principal whose Grant was revoked may self-join again.",
    "The three active quotas belong only to this Project, are not a shared pool, and are enforced only while the Public Join Policy is enabled. Disabling the Policy does not revoke existing Grants; enabling it again resumes quota enforcement.",
    "Limits may be below current usage; doing so never deletes resources or revokes Grants and only blocks further growth in that dimension. Soft delete and Grant revoke release active slots; restore and regrant occupy them again.",
    "Restoring a soft-deleted Issue requires capacity for the Issue and all of its active Comments together; if any quota is insufficient, the whole restore fails atomically. Every immutable completion comment created by complete continues to count toward the active Comment quota.",
    "Releasing an active slot is not physical deletion: tombstones, completion records, and history still consume D1 storage.",
  ];
}

import type { Locale } from "../types";

export function publicJoinRiskNotice(locale: Locale): string[] {
  if (locale === "zh-CN") {
    return [
      "未知互联网参与者可以加入。公开协作者（writer）可创建评论、移动、完成、修改和软删除项目内容，并产生 D1 写入。只要项目仍公开，被撤销授权的身份就可以再次自助加入。",
      "三项有效数据限额仅属于这个项目，不是共享池，而且只在公开加入策略启用时强制。关闭策略不会撤销既有授权；重新开启后限额会再次生效。",
      "限额可以低于当前用量；这不会自动删除资源或撤销授权，只会阻止该维度继续增长。软删除与撤销授权会释放有效名额，恢复资源与重新授权会再次占用名额。",
      "恢复已软删除事项时，事项本身及其全部有效评论必须同时容纳在限额内；任一限额不足都会让整个恢复原子失败。每次完成操作创建的不可变完成评论也持续计入有效评论限额。",
      "释放有效名额不代表数据已物理清除；墓碑、完成记录与历史仍占用 D1 存储。",
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

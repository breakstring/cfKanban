---
name: cfkanban-howto
description: Explain how to use cfKanban as a participant, administer it as the Owner, or deploy an instance. Use for onboarding, capability questions, and choosing among the three operational Skills; this guide does not execute operations.
---

# cfKanban Howto

Explain cfKanban in the user's language, starting with daily use, then Owner administration, then deployment. For a focused question, cover only the relevant part. Give a short capability explanation and a natural-language prompt the user can reuse; avoid API parameters and setup internals unless requested.

This is a read-only teaching and routing Skill, with no command helper. Explaining a workflow does not authorize joining a Project, opening a session, creating an invitation, installing software, or changing cloud resources. If the user requests an action, use the relevant operational Skill and the user's existing authorization. If that Skill is unavailable, explain the missing capability; do not invent a command or silently install it. Do not ask the user to paste a long-lived Credential. Use placeholders for invitation links, never reproduce real secret values in examples.

## 1. Already joined? Start with daily work — cfkanban

Participants and Owners use `cfkanban` for ordinary Issue work. For a general “what can I do?” question, lead with finding, creating, editing, changing status, completing/reopening, and commenting. Explain setup only when the user needs it. The examples below are prompts to adapt, not an instruction to execute every row.

| Goal / 目标 | Example prompt / 自然语言示例 | Expected result / 预期结果 |
| --- | --- | --- |
| Find work / 查找任务 | “Show my unfinished Issues in DemoProject.” / “查看 DemoProject 项目中我未完成的任务。” | Scoped results with identifiers and status; no writes. / 返回明确项目范围内的编号与状态，不修改任务。 |
| Search / 搜索 | “Find Issues with ‘login’ in DemoProject.” / “在 DemoProject 项目查找标题含‘登录’的任务。” | Title/identifier matches; no promise of full-text Comment or attachment search. / 按标题或编号匹配，不承诺搜索评论或附件全文。 |
| Create / 创建 | “Create ‘Fix login error’ in DemoProject with this description: <details>.” / “在 DemoProject 创建‘修复登录错误’，描述为：<说明>。” | One new Issue and its identifier in the resolved Project. / 在准确项目创建一项任务并返回编号。 |
| Edit / 编辑 | “Change CFK-123's title to ‘Fix mobile login’.” / “把 CFK-123 的标题改为‘修复移动端登录’。” | The requested field changes, followed by readback. / 只修改指定字段并读回确认。 |
| Change status / 改变状态 | “Move CFK-123 to in progress.” / “把 CFK-123 改为进行中。” | An explicit workflow change; it does not claim the work was performed. / 显式更新状态，不表示已代为执行任务内容。 |
| Complete / 完成 | “Mark CFK-123 complete; optionally include result <summary> and validation <evidence>.” / “将 CFK-123 标为完成；可选附上结果<摘要>、验证<证据>。” | Done plus an immutable completion record based on actual evidence. / 标为完成并保存基于实际证据的不可变完成记录。 |
| Reopen / 重新打开 | “Reopen CFK-123 as todo; the problem returned.” / “问题复现了，将 CFK-123 重新打开为待办。” | Status changes to todo and earlier completion records remain. / 状态改为待办，保留此前完成记录。 |
| Comment / 评论 | “Add this progress note to CFK-123: <text>.” / “给 CFK-123 添加进展评论：<内容>。” | One appended Comment; corrections use another Comment. / 追加一条评论，纠错再追加新评论。 |
| Delete/restore a Comment / 删除或恢复评论 | “Restore Comment <ID> on CFK-123.” / “恢复 CFK-123 的评论 <ID>。” | Ordinary Comments support soft-delete/restore; completion records cannot be deleted. / 普通评论可软删除/恢复，完成记录不可删除。 |
| Assign or report a blocker / 领取或报告阻塞 | “Assign CFK-123 to me.” / “把 CFK-123 分配给我。”; “Mark CFK-123 blocked: <reason>.” / “标记 CFK-123 被阻塞：<原因>。” | Assignment requires writer eligibility; blocked is separate from status. / 负责人须有写入资格，阻塞与状态独立。 |
| Organize / 整理关联 | “Add the existing ‘bug’ Label to CFK-123.” / “给 CFK-123 添加已有的 bug 标签。”; “Record that CFK-123 blocks CFK-124.” / “记录 CFK-123 阻塞 CFK-124。” | Project Labels or supported relations; relations do not change status or access. / 使用项目标签或受支持关系，关系不会改变状态或权限。 |
| Attach evidence / 附件 | “Attach <absolute file path> to CFK-123.” / “将 <文件绝对路径> 附加到 CFK-123。” | One selected file when attachment storage and capacity permit; no implicit upload of other files. / 存储及容量允许时上传一个指定文件，不自动上传其它文件。 |
| Recover deleted work / 恢复已删除任务 | “Restore the deleted CFK-123.” / “恢复已删除的 CFK-123。” | One soft-deleted Issue is restored if permissions and quotas allow. / 权限和配额允许时恢复一项软删除任务。 |
| Open the board / 打开看板 | “Open the DemoProject board in IAB.” / “在 IAB 打开 DemoProject 看板。” | Verified authenticated target in the requested browser, if supported. / 在受支持的指定浏览器进入已验证的登录页面。 |
| My profile / 我的资料 | “Change my display name to <name>.” / “将我的显示名称改为 <名称>。” | Your name changes; stable identity and access remain unchanged. / 修改自己的名称，稳定身份与权限不变。 |

Prefix any example with “Use $cfkanban to…” / “请用 $cfkanban …” when explicit Skill selection helps. `reader` can read; `writer` can collaborate within its Project. Assignment and display names never grant access. Status keys are `backlog`, `todo`, `in_progress`, `done`, and `canceled`; completion uses the dedicated completion operation, not an ordinary status edit. Do not invent validation results when recording completion. “Finish this task” may also request implementation: follow the user's context and authority rather than merely marking it done.

Joining is for people who do not yet have access: “Use $cfkanban to join this Project: <Invite URL>.” / “请用 $cfkanban 加入这个项目：<邀请链接>。” Expect inspection of the exact Project and role, one combined join plan, and verified access after approval. Joining an existing instance needs no personal Cloudflare deployment. Web project switching selects already authorized Projects; explain support according to the deployed Service, not a source-only feature.

### Work regularly from one folder / 在固定目录里长期协作

Recommend an optional directory association when the user regularly handles one or more Projects from the same repository or ordinary folder. It helps future Issue lists/searches use the intended Projects without repeatedly naming them. It is unnecessary for a one-off Issue lookup and is not a prerequisite for joining or daily work.

- “Show which cfKanban Projects this folder is associated with.” / “查看当前目录关联了哪些 cfKanban 项目。”
- “Use $cfkanban to associate this folder with DemoProject.” / “请用 $cfkanban 将当前目录关联到 DemoProject 项目。”
- “Also associate this folder with Mobile.” / “将 Mobile 项目也关联到当前目录。”

Explain that `~/.cfkanban/` stores private instance/identity state, while the optional `.cfkanban-scope.json` in the chosen working directory stores non-secret Project identifiers. Joining does not create it automatically. On an explicit association request, route to `cfkanban` to verify the exact Projects and create or merge the file, preserving existing associations. Users need not supply UUIDs themselves. A local folder is distinct from a cfKanban Workspace.

This is a recommended query scope, not access control: explicit targets take precedence, followed by directory recommendations, then a warned aggregate of authorized Projects. It neither grants permissions nor prevents an explicit authorized Issue lookup outside those recommendations. Do not repeatedly suggest setup when an association already exists or the user has declined.

For execution and precise inputs, read [cfkanban](../cfkanban/SKILL.md).

## 2. Organize Projects and access — cfkanban-admin

Only the instance's verified Deployment Owner uses this Skill for application administration. A Project writer is not an administrator. These actions use the existing application; they do not deploy cloud resources.

| Goal / 目标 | Example prompt / 自然语言示例 | Expected result / 预期结果 |
| --- | --- | --- |
| First board / 第一个看板 | “Create DemoProject in workspace Product.” / “在 Product 工作区创建 DemoProject 项目。” | Resolved containers and their identifiers; open the board when requested, with no automatic members or Issues. / 创建或定位准确容器并返回标识，按请求打开看板，不自动添加成员或任务。 |
| Invite / 邀请 | “Create a read-only invitation to DemoProject.” / “创建 DemoProject 项目的只读邀请。” | An explicit reader invitation, safely delivered; sending it to another person is a separate action. / 创建明确 reader 权限的邀请并安全交付，向他人发送是独立操作。 |
| Access / 权限 | “Show who can access DemoProject.” / “查看谁可以访问 DemoProject 项目。” | Current access; no permission changes unless requested. / 展示当前权限，未要求时不改动。 |
| Usage / 用量 | “Show usage and attachment capacity.” / “查看用量与附件容量。” | Cache-aware usage refresh and separate application capacity/platform metrics. / 按缓存规则刷新用量，区分应用容量与平台指标。 |
| Public Join / 公开加入 | “Explain the effects of enabling Public Join for DemoProject.” / “解释开启 DemoProject 项目公开加入的影响。” | Explain that visitors can select reader or writer, and enabling needs three explicit quotas; explanation makes no change. / 说明访客可选 reader 或 writer、开启须明确三项配额；讲解不修改设置。 |
| Archive / 归档 | “Archive the old DemoProject project.” / “归档旧 DemoProject 项目。” | Reversible container archive; permanent removal is a separate explicit request and preview. / 可恢复地归档容器，永久删除需要独立明确请求与预览。 |

Prefix these with `$cfkanban-admin`. It also handles container rename/restore, fixed status display names, participant recovery, Owner Credential rotation, and application settings. Public writer access permits content changes; disabling Public Join does not revoke existing Grants. Restoring a container can resume its enabled Public Join policies and must explain that effect. Cloudflare request-rate configuration and enabling private attachment storage belong to deployment; selecting application attachment capacity belongs here.

For execution, read [cfkanban-admin](../cfkanban-admin/SKILL.md).

## 3. Host or maintain an installation — cfkanban-deploy

Use this Skill when hosting an instance or maintaining local Skills/cloud resources. Cloud operations require verified Cloudflare authority and an exact authorized plan; an application writer or Owner Credential alone is insufficient.

| Goal / 目标 | Example prompt / 自然语言示例 | Expected result / 预期结果 |
| --- | --- | --- |
| Check readiness / 检查准备情况 | “Check what I need to deploy cfKanban.” / “检查部署 cfKanban 还需要准备什么。” | Read-only environment and verified-release findings; no installation. / 只读检查环境与可验证发行，不安装。 |
| Deploy / 部署 | “Deploy cfKanban for me.” / “为我部署一套 cfKanban。” | Discovery, missing Owner name if needed, exact plan, then authorized deployment and readback. / 先检查、补齐必要 Owner 名称并展示准确计划，获准后部署和读回。 |
| Check versions / 检查版本 | “Check local Skill and instance versions without updating.” / “检查本地技能和实例版本，先不要更新。” | Report the two versions separately without upgrading either. / 分别报告两个版本，不更新任一方。 |
| Update Skills / 更新技能 | “Update my local cfKanban Skills to <verified version>.” / “将本地 cfKanban 技能更新到 <已验证版本>。” | Authorized local Skill update; the deployed Instance stays unchanged. / 按授权更新本地技能，线上实例不变。 |
| Upgrade Service / 升级实例 | “Plan an upgrade of this instance to <verified version>.” / “制定将此实例升级到 <已验证版本> 的计划。” | Exact resource/migration effects for approval; planning alone does not execute. / 展示准确资源和迁移影响供批准，仅计划不执行。 |
| Resume / 继续中断部署 | “Check and resume my interrupted deployment.” / “检查并继续我中断的部署。” | Read back the journaled operation and continue only within valid authorization. / 读回已记录操作，仅在有效授权范围内继续。 |

Prefix these with `$cfkanban-deploy`. Default deployment is one Worker and one D1; optional private R2 attachments and custom domains need explicit plans. Local Skill update and cloud Instance upgrade are separate. When all Owner Credentials are lost, control-plane recovery can restore the same Owner identity; it cannot transfer ownership. Do not describe a prerelease as stable or infer availability from a plugin version. After deployment, use `cfkanban-admin` to create the first Workspace/Project, then `cfkanban` for Issues; these are separate requested actions.

For execution, read [cfkanban-deploy](../cfkanban-deploy/SKILL.md).

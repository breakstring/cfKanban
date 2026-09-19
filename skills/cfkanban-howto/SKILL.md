---
name: cfkanban-howto
description: Explain how to use cfKanban as a participant, administer it as the Owner, or deploy an instance. Use for onboarding, capability questions, and choosing among the three operational Skills; this guide does not execute operations.
---

# cfKanban Howto

Explain cfKanban in the user's language, starting with daily use, then Owner administration, then deployment. For a focused question, cover only the relevant part. Give a short capability explanation and a natural-language prompt the user can reuse; avoid API parameters and setup internals unless requested.

This is a read-only teaching and routing Skill, with no command helper. Explaining a workflow does not authorize joining a Project, opening a session, creating an invitation, installing software, or changing cloud resources. If the user requests an action, use the relevant operational Skill and the user's existing authorization. If that Skill is unavailable, explain the missing capability; do not invent a command or silently install it. Do not ask the user to paste a long-lived Credential. Use placeholders for invitation links, never reproduce real secret values in examples.

## 1. Daily use — cfkanban

For participants and Owners doing ordinary work, use `cfkanban`:

- Join an existing Project through its invitation or Public Join; people joining an existing instance do not need their own Cloudflare deployment.
- Open an authenticated Web board, find Issues, and inspect work assigned to you.
- Create and update Issues, add Comments and attachments, manage Labels and relations, complete work with a completion record, or reopen it.
- View or change your own display name.

Access comes from the current Project role: `reader` can read; `writer` can collaborate. A display name or assignment does not grant access. Explain available Web project switching according to the installed Service/Skill version; do not promise that a source-only feature is already deployed. Switching selects an already authorized Project and never grants access.

Example prompts:

- “Use $cfkanban to join this Project: <Invite URL>.” / “请用 $cfkanban 加入这个项目：<邀请链接>。”
- “Use $cfkanban to open the Release board and show my unfinished Issues.” / “请用 $cfkanban 打开发版项目看板，看看我还有哪些未完成任务。”
- “Use $cfkanban to complete CFK-123 with this result and validation: <details>.” / “请用 $cfkanban 完成 CFK-123，结果和验证如下：<说明>。”

For execution, read [cfkanban](../cfkanban/SKILL.md), which owns identity, joining, scope, and collaboration workflows.

## 2. Owner administration — cfkanban-admin

For the instance's single Deployment Owner, use `cfkanban-admin`:

- Create Workspaces and Projects, rename them, archive or restore them, and open the management UI.
- Invite people to explicit Projects as readers or writers, manage existing access, and help recover a participant's identity.
- Enable or disable a Project's Public Join with explicit resource limits; public writer access permits content changes, and disabling Public Join does not revoke existing members.
- Inspect usage, set attachment capacity, and manage application settings and Owner Credential rotation.

An ordinary Project writer is not an administrator. Owner administration is application work; it does not deploy Cloudflare resources. Permanent removal is distinct from archive and requires its own explicit request and preview.

Example prompts:

- “Use $cfkanban-admin to create my first board in workspace Product, project Release.” / “请用 $cfkanban-admin 在 Product 工作区创建 Release 项目，作为我的第一个看板。”
- “Use $cfkanban-admin to create a read-only invitation to Release.” / “请用 $cfkanban-admin 创建 Release 项目的只读邀请。”
- “Use $cfkanban-admin to show usage and attachment capacity.” / “请用 $cfkanban-admin 查看使用情况和附件容量。”

For execution, read [cfkanban-admin](../cfkanban-admin/SKILL.md), which verifies Owner identity and handles access and application changes.

## 3. Deployment and maintenance — cfkanban-deploy

For someone hosting an instance or maintaining its installation, use `cfkanban-deploy`:

- Check the environment and available verified releases, then deploy one Cloudflare Worker and one D1 database by default. Optional private R2 attachments and custom domains require explicit planning.
- Install or update local Skills, upgrade the deployed Service, and resume an interrupted authorized deployment.
- Recover access to the same Owner when all Owner Credentials have been lost, using verified Cloudflare control-plane access.

Local Skill installation/update and cloud Instance deployment/upgrade are separate operations. Deployment needs a compatible environment, Cloudflare authorization, and an Owner display name; the operational Skill checks these and presents actual effects before writes. Deployment does not create the first Workspace or Project: that next step belongs to `cfkanban-admin`. Do not describe a prerelease as stable or infer release availability from a plugin version.

Example prompts:

- “Use $cfkanban-deploy to check what I need to deploy cfKanban.” / “请用 $cfkanban-deploy 检查部署 cfKanban 还需要准备什么。”
- “Use $cfkanban-deploy to deploy cfKanban for me.” / “请用 $cfkanban-deploy 为我部署一套 cfKanban。”
- “Use $cfkanban-deploy to check local Skill and instance versions without updating.” / “请用 $cfkanban-deploy 检查本地技能和实例版本，先不要更新。”

For execution, read [cfkanban-deploy](../cfkanban-deploy/SKILL.md), which owns verified releases, exact plans, deployment, and recovery.

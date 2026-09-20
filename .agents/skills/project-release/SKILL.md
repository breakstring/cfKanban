---
name: project-release
description: 为 cfKanban 源码仓库准备和发布 RC 或正式版，校验 GitHub 工件与 stable 入口，并按授权升级默认的 cfkanban.dev 长期测试实例。用于维护者发版，不用于普通用户安装、自部署或日常看板操作。
---

# cfKanban 项目发版

这是本仓库维护者的项目级流程，位于 `.agents/skills/project-release/`。不属于对外分发的 `skills/cfkanban*`，不加入 plugin 的 `skills` 路径或 Skill/Service bundle 白名单。使用本仓库工程脚本发布 GitHub 工件；实例升级和本机插件更新复用已安装的 `cfkanban-deploy`，不另写一套凭据或 Cloudflare 操作脚本。

## 先确定本次动作

用户可以自然语言调用，不必准备 manifest、digest 或命令参数。先读仓库 `AGENTS.md`、[发行生命周期合同](../../../docs/specs/2026-09-20-stable-release-lifecycle-spec.md)及[发布操作说明](../../../docs/release-publication.md)。从本技能目录向上三级定位仓库根目录，后续命令在该根目录执行。

| 用户目标 | 处理范围 |
| --- | --- |
| 检查、讨论、建议版本 | 只读比较源码、公开发行和实例状态，给出建议 |
| 准备 RC / 准备正式版 | 完成本次获准的版本文件、说明、构建和验证；未获准的 Git/远端写入列入最后的具体预览 |
| 发布 RC / 发布正式版 | 准备包含准确 Git 提交/tag、GitHub 工件和默认测试实例升级的计划；按本次授权执行其中的动作 |
| 仅发布 GitHub / 不部署 | 只发布并验证工件和所需 Git ref，不升级实例 |
| 升级测试实例 / 同步到正式版 | 选择已公开的准确工件，走实例升级；不重新发布 GitHub |
| 更新本机插件 | 独立执行本地 Skill 与宿主更新，不隐含实例升级 |

只有技能名而无具体目标时先做只读检查。默认目标用于减少询问，不代替部署授权。若本次指令已明确授权完整发版（发布并升级默认测试实例），完成 preflight 后连续执行，不在 Git、draft、publish、deploy 每一步重复确认；只有发行授权时不得自行补出部署或本机插件更新授权。需要授权时先完成已授权准备，展示准确版本、commit、工件摘要、目标资源、migration 和影响，一次询问尚未获准的完整范围。

## 默认环境与版本

- 源码与发行仓库：`breakstring/cfKanban`，核对当前 Git remote，不能凭目录名选择仓库。
- 默认远端测试服务：`https://cfkanban.dev`；预期 instance ID 为 `d9e202ad-3909-40e1-8515-2a18b6fd0319`。它是持久的公开测试、演示和自用实例，可以领先于 stable。域名与 ID 不符时停止；不要寻找同名实例替代。
- GitHub stable 是用户自行部署的推荐发行，不代表本项目维护一套独立的正式托管服务。README、部署与加入指南仍默认 stable，不能因演示站运行 RC 就改成 RC 入口。
- 测试实例保存真实数据。自动化、破坏性与故障注入测试使用隔离环境；RC 升级、真实功能验收遵循已有数据、迁移与恢复边界。更换测试目标遵循用户显式选择，不自动创建第二实例。
- Cloudflare account、profile、Worker、D1、R2 和最新部署版本从该实例的私有 receipt/journal 解析并在线核验；不在本技能固定可能过期的资源或 profile，不枚举 profile 选择身份。

比较上个相关发行到候选 commit 的实际差异，建议纯修复用 patch、新增兼容功能用 minor；不兼容公共行为先明确合同与升级影响。示例序列是 `1.1.0-rc.1 → 1.1.0-rc.2 → 1.1.0`，不是固定下一版本。检查远端 tags/Releases 避免重名，tag 与版本相同，不加 `v`。

新开发周期将 `release/version.json` 和 `.codex-plugin/plugin.json` 同步到下一个准确预发行版本。准备发行时新增 `release/config/<version>.json` 与 `release/notes/<version>.md`；沿用当前结构和双语要求。已公开 RC 有任何修订都换新版本，不改旧 tag、manifest 或附件。API 版本、API 路径、schema 与产品版本独立，依据实际合同和 migration 更新，不机械跟随产品编号。

## 准备并发布 RC

1. 按[项目协作约定](../../../docs/project/cfkanban.md)核对准确项目和已有 Issue，复用或查重建立本次发版任务。只读检查 Git 状态、分支、远端、基线与变更；现存 dirty 修改属于用户，未经纳入本次范围不能一起发布。
2. 核对相关 Frozen 合同与实现、目标版本、兼容矩阵和 migration delta。RC config 使用 `channel: prerelease`、`urlLayout: flat`，所有工件 URL 指向准确版本下载路径。release notes 记录变化、迁移与已知限制，不宣称未做的验收。
3. 按根 `package.json` 运行 `npm run validate` 及发布说明要求的定向检查。采用本轮准确候选状态的结果；源码、依赖或构建输入变化后重验受影响部分。所有新增/变化的 migration 均需 ledger/schema 与升级路径证据。
4. 审查 staged set，在对应授权下提交并固定完整 commit。构建使用该准确源码、锁文件和干净候选状态；并行开发可能改变工作树时使用隔离 checkout/worktree。候选构建后不继续混入业务改动。
5. 用现有 `scripts/build-release-bundles.mjs` 和 `scripts/generate-release-metadata.mjs` 生成两个包、manifest、pointer 与双语 install 文档，验证重复打包一致。打包必须通过源码声明、plugin、Worker/Web 构建版本及入口摘要检查。上传目录仅含发布说明规定的六个文件，不含源码目录、本机 scope 或私有配置。
6. 在获准 Git 写入范围内推送准确提交及 tag，核对远端 tag 解引用到该完整 commit。使用 `scripts/publish-github-release.mjs inspect <config.json>`；展示具体计划后才按已有或新取得的授权设置匹配的 `approvedPlanDigest`，依次 `stage`、`publish`。工程脚本参数和六工件布局以[发布操作说明](../../../docs/release-publication.md)为准，不临时改用手工附件覆盖。
7. RC 发布必须为 prerelease，使用准确 `prerelease.json`，不推进 GitHub Latest。核对匿名下载的实际六份文件；再确认 stable 入口与发布前保持一致，若期间其他维护者已推进 stable，则核对其来源而不是回退它。

## 升级并验收默认测试实例

只有部署在当前授权范围内才执行。读取已安装 `cfkanban-deploy` 的 **Instance upgrade** 流程，以刚公开的 immutable Service 工件为来源；不从工作树直接部署，也不隐含更新本机 Skills。

1. 核对默认 origin/instance、当前 `/healthz`、discovery、认证 `/meta`/`/me` 和私有 receipt，确认真实当前版本；同时检查本地工具与目标兼容性。
2. 解析并只读核对准确 account、Worker 部署/bindings、D1、现有 R2/定时任务和 migration ledger/实际 schema。保留 Owner、Credential、业务数据和既有可选配置。
3. 生成 `plan instance-upgrade`，按当前任务、operation ID、digest 记录授权和 journal。无迁移时明确标记；有迁移时固定完整 delta、兼容性及所需恢复点证据。付费、域名、破坏性操作或其他 plan delta 重新确认。
4. 由该 Skill 执行配置生成、所需 migration、Worker dry-run、部署、部署读回与 `deployment finalize-upgrade`。最终核对产品 `release_version`、API/schema、原身份和资源，保存脱敏回执。
5. 对本次变化做真实功能验收；自用过程中发现问题则修复并发下一个 RC。涉及 Skills 时分别记录 canonical、宿主投影、当前任务加载状态；不把 `help` 或单测当作宿主真实加载证明。

## 发布正式版并同步实例

默认从已验收 RC 的准确源码基线准备正式版。比较两者业务差异，只收敛版本及发行说明；出现新的业务修改时重新验收候选。纯修复等明确获准跳过 RC 的情况，说明采用的验证证据，不伪造 RC 验收记录。

- 把版本声明/plugin/config/notes 同步到准确正式版本，config 使用 `channel: stable`。重新构建并验证正式工件；不能重命名 RC zip、就地改 RC Release 属性或复用嵌入 RC 版本的构建冒充正式版。
- 复用上述准确 commit、验证、tag、`inspect → stage → publish` 流程。发布脚本设置 `make_latest=true`；匿名读回六工件，并确认 `https://github.com/breakstring/cfKanban/releases/latest/download/stable.json` 精确指向本次 manifest、版本和 digest。
- 若已授权同步 cfkanban.dev，从其真实当前版本生成独立升级计划，部署正式工件并读回；不能仅因 RC 与正式版业务代码相同就声称网站已运行正式版。若网站已在测试更新的版本，先说明降级/兼容影响，不自动回退。
- 后续开发继续使用下一个预发行版本，默认测试实例可运行新 RC；stable 入口保持最近正式版，直到下一次正式发布。

## 中断与交付

上传/公开响应不确定时保留版本、commit、文件、notes 和摘要，先 `inspect` 读回，只补缺少资产或恢复验证；不删除、clobber 或重发同名工件。已公开但公网校验失败，报告“已公开、验证未完成”，不冒充完整成功。Cloudflare 中断按同一授权 journal 读回恢复，Worker 回滚不回退 D1，D1 restore 不自动执行。

最终分别报告 Git commit/tag、GitHub Release/Latest 校验、默认测试实例实际版本/回执、真实验收，以及本机插件是否更新和是否已加载。按项目规则将证据写入 Issue；未执行的部署或未验证项明确保留。

常用请求：

- “用 `$project-release` 准备下一个 RC，先给我范围、版本建议和验证结果。”
- “用 `$project-release` 完整发布 `1.1.0-rc.1`，并升级默认测试实例。”
- “用 `$project-release` 基于已验收 RC 发布正式版 `1.1.0`，并同步 cfkanban.dev。”
- “用 `$project-release` 仅发布 GitHub 正式版，不部署、不更新本机插件。”

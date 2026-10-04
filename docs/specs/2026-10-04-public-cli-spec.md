# 公共 CLI 与三端能力同步合同

- 状态：Frozen
- 日期：2026-10-04
- 任务：[CFK-584](https://cfkanban.dev/app/issues/CFK-584) 与 CFK-585～CFK-592
- 授权依据：用户明确要求在 `feat/v1.9` 完成公共 CLI 总卡及其子项。本文收敛其命令、安装和验证合同；源码实现不授权 Git 提交/推送、全局安装、公开发行或 Cloudflare 写入。
- 覆盖 Foundation、Bootstrap、产品简报与本地 MCP 增量中早期“不提供公共 CLI”的取舍。Service 继续作为权限、并发、幂等、领域规则和审计的唯一权威。

## 入口与兼容

公共命令为 `cfkanban`，供人类终端与非交互 Agent 使用。与 Skills 同一个不可变完整 bundle 交付预构建 `cli/cfkanban.mjs`、命令目录和 build metadata；CLI 与 MCP 并列调用共享安全 runtime，CLI 能力以三个 Skills 的完整流程为基线，不能用 MCP 的有界集合缩小范围。Node 基线 `>=22.12.0`，不首发独立 npm 渠道或免 Node binary。

无参数、`help`、仅命令组和逐级 `--help` 离线显示用途、上手步骤、日常/管理/部署导航、参数与真实例子，不读取凭据、不联网、不等待 stdin。`--locale en|zh-CN` 控制说明，`--json` 返回稳定机器结果。参数采用长选项；未知、重复、缺失或类型错误在请求前拒绝。命令目录由 `packages/cli/src/catalog.mjs` 维护，OpenAPI 提供 HTTP 字段和类型，公共 noun/action 名称独立维护，不将任意 API 透传或内部 helper 名称当作公共接口。

普通业务正文支持文件或 stdin；凭据及一次性能力禁止 argv/env 和普通 JSON 输入输出。Invite、Browser Launch、Owner Credential 与附件使用专用安全模块。非交互缺参直接失败，不猜测身份、实例、角色或管理范围。显式实例和稳定 UUID 为身份依据；目录 scope 只提供推荐过滤。

机器输出带版本化 envelope、成功/失败分类和结构化业务结果；stdout 只放结果，stderr 放脱敏诊断。业务拒绝、冲突、未知结果及中断必须返回非零。取消传递实际 AbortSignal；写入开始后取消不证明未提交，跨进程恢复沿下述原操作记录。已发布字段和命令不无声改名，破坏性变更须新合同、兼容说明及发行目标。

退出码固定为 0 成功、2 输入错误、3 认证失败、4 权限拒绝、5 冲突、6 写结果未知/待核验、7 运行时/平台失败、8 未找到。机器 envelope 为 `{schema_version:1, ok, result}`，失败保留结构化 code/category/recovery；不要从显示语言解析结果。

## 安装与版本

canonical 安装保存在本执行环境私有 `.cfkanban/skill-releases/`。active receipt 固定版本、发布者、来源、工件和完整 tree 摘要；宿主投影不成为 CLI 运行来源。启动器每次验证完整 active 工件后加载预构建入口，缺失、损坏、symlink、来源或版本不符明确停止。安装器使用独占 release lock 和原子 active 切换；未知来源、已存在同名命令或修改过的启动器不覆盖。

用户级命令目录默认 macOS/Linux `~/.local/bin`，Windows 原生 `~/.cfkanban/bin`；提供 POSIX、cmd、PowerShell 启动入口，使用核验的绝对 Node 路径，处理空格与 Unicode。PATH 缺失只报告需要用户添加目录并重开终端，不改 shell profile、系统 PATH 或默认 Node。WSL2 使用独立 Linux 工具、home、身份和登记，不复制 Windows secret。

`cli install/status/rollback/uninstall` 管理注册、读回、前一已验证完整版本和入口移除。启动器跟随 active，更新不指向不存在工件；回退检查前一版本 tree 与 CLI 入口。卸载保留身份、部署记录和已安装历史。CLI 版本、canonical active、宿主投影与已运行 MCP 分别报告；active 切换不热更新旧 MCP。Skill/CLI 本地更新与 Instance upgrade 独立，遵循[正式发行生命周期](2026-09-20-stable-release-lifecycle-spec.md)。源码构建不是 canonical release。

## 原子写入与恢复

每次公开 API 请求只执行一个原子操作，写合同以 OpenAPI 的 `x-cfkanban-write-contract` 为准。支持服务端幂等的操作使用调用方提供或 CLI 在发送前持久化生成的稳定 key；CAS-only 操作保存准确原版本和请求，不接受会误导调用方的幂等 key 参数。成功后核对真实目标与响应版本，不能用较旧的读回宣布 verified。多步流程保留各原子请求与进度，不能宣称整体原子事务。

CLI 在请求前于已核验私有状态保存非秘密 operation：稳定本地 operation UUID、原调用身份、trusted origin、实例/目标、准确请求、写合同、CAS、适用时的原 key 和阶段。未知结果锁住新写入，下一 CLI 进程使用 `operation show/recover`，核验当前身份仍匹配后通过原 caller、原路径、原 CAS 及适用时的原 key 恢复。重放遇到 403、409 等拒绝不能证明先前请求未提交，继续保留 unknown；CAS-only 的原结果可能需要准确审计与人工核验。cache-refresh 未知时仅进行只读核对，不自动追加 POST。已知幂等结果先核实，再做读回；读回值相等不能代替原操作核实。没有请求发送证据才允许换入口。不保存长期 Credential、一次性 capability、附件内容、任意异常栈或子进程输出。

写合同标记中的 `idempotent` 与 OpenAPI 的 `Idempotency-Key` 参数必须一致；CSRF 或 CAS 前缀不改变幂等能力。Service 为兼容既有客户端允许省略 key 的个人资料更新，CLI 仍持久化 key 后发送；本人 Passkey 撤销保留 Cookie 可选 key 的兼容行为，CLI 的 Bearer 请求必须携带 key。Owner 代他人撤销 Passkey 仍按其独立 CAS-only 合同执行。

## 完整能力矩阵

逐命令字段、HTTP 权限、effect 和输入 schema 由命令 catalog 与 OpenAPI 对照；公开命令目录随 build 输出 `cli/commands.json`。[逐项能力矩阵](public-cli-capabilities.json)核对三个 Skill 的 helper、多步流程及 OpenAPI operation，`scripts/check-public-cli-capabilities.mjs` 拒绝未归类能力、失效映射及双语命令示例漂移，接入根 `cli:test`。以下按任务核对多步流程，测试入口见 `packages/cli/tests/` 与既有安全 runtime/D1 集成测试。目录和矩阵检查不代表业务端到端或每个环境已实测。

| 能力 | 公共入口与流程 | 权限、副作用和读回 | 其它表面与实际差异 |
| --- | --- | --- | --- |
| 实例/身份/目录 | `connection`、`profile`、`scope`、`identity` | 核验 trusted instance 与 `/me`；明确 scope 绑定才写目录文件 | Skills 同模块；Web 不读取 OS 私有身份或目录 |
| 首次接入/恢复 | `join invite/public`、`identity pending/verify` | 检查准确目标、显式身份选择、pending 兑换与提升，不复制 Credential | 需要 Passkey 的交互在浏览器完成；秘密链接只由专用安全输入/交付 |
| 日常 Issue | `issue list/candidates/counts/show/context/create/update/complete/reopen` | reader 查询，writer 单笔 CAS/幂等写，服务端筛选后分页，完成保留实际证据 | Web/Skills 等价领域语义；MCP 仅覆盖实际工具 |
| 指派与阻塞 | `issue assign-me/block/unblock` 和 `issue update` | 实时 writer 与候选资格、旧指派历史保留，阻塞不自动更改状态 | Web 当前人工阻塞入口暂隐藏，Skills/CLI 保留服务端能力 |
| 评论、标签和关系 | `comment`、`label`、`issue label`、`relation`、`event` | append-only 评论、资源/两端 CAS、parent 防环、恢复历史 | 公开树/上下文不抓全历史，CLI 不复制权限判断 |
| 附件 | `attachment list/show/upload/download/delete/restore` | 专用受控传输、有界容量、服务端权限与单文件恢复 | 需要本地路径；不把 R2 URL 或文件内容写 operation |
| 通知与本人偏好 | `notification`、`profile`、`passkey` | 本人 CAS、逐条确认，Owner 发布/撤回独立管理权限 | Passkey 登记/认证需实际浏览器；CLI 提供安全浏览器入口 |
| 看板打开 | `web preflight/open` | 明确 local/online、目录和目标；专用 capability 交付并核验 | CLI 不能操作宿主侧栏，使用本地/系统浏览器或宿主公开工具；不伪报 opened |
| 范围管理 | `workspace`、`project`、`grant`、`administrator`、`member` | 实时 Owner/范围管理员；创建、归档、恢复、名称与权限读回 | 创建工作区→创建项目是两笔操作，保留部分结果供恢复 |
| 邀请/公开加入 | `invite`、`admin public-join/limits` | 安全交付、范围权限、配额、关闭影响和读回 | Web 和 CLI 都不能绕过最后权限与配额保护 |
| 设备/身份安全 | `owner device/rotate`、`admin credential/passkey` | 专用 Credential 生命周期、来源/最后有效凭据保护、同身份恢复 | 当前环境独立私有状态，浏览器批准可续做，不要求粘贴长期 secret |
| 实例设置/审计 | `admin homepage/notification/usage/attachment-capacity/origin/audit` | Owner 或对应范围权限、CAS、历史保留、准确设置读回 | Web 只展示 Service 支持的设置；云配置写入仍属部署计划 |
| 工件/环境准备 | `deploy release/runtime/auth`、`cli` | 固定可信发行/来源/digest，环境核验与明确本地修改，鉴权使用现有安全模块 | Web 不访问 OS/Cloudflare Credential；使用 Skills/CLI 准备 |
| 首次部署 | `deploy plan/apply/resume` | 精确账户、Worker/D1/费用、绑定授权、journal、migration/schema/Owner/版本读回 | 多步非原子；GUI/UAC/Cloudflare 登录需人在相应步骤完成 |
| 接入/升级/恢复 | `deploy attach/upgrade/recovery` | 固定 plan 与授权，漂移拒绝，同计划无漂移续做、receipt | Worker rollback 不回退 D1，不自动 Time Travel restore；外部写入需明确授权 |

新增或调整能力必须同步核对 Skills、WebUI、CLI 的语义与验收。只能记录有实际平台/交互/安全原因的差异和可用替代；“暂未实现”是交付缺口，不能伪装例外。完整命令矩阵必须核对三个 Skill 的 help/catalog、多步流程、Web 与 HTTP，不能仅统计命令数量证明能力完整。

Cloudflare 平台的 Worker rollback 与 D1 Time Travel 是不同操作。当前三个 Skills 的安全 runtime 没有 Worker rollback 执行命令或对应冻结计划；CLI 不凭边界说明新增云端回退流程。需要此操作时按 Cloudflare 控制面及原部署合同单独核对和授权，不能通过 CLI Instance upgrade 猜测回退或把 Worker 回退描述成数据库恢复。此限制与缺少其它 OS 实测是两项不同证据边界。

Cloudflare 认证使用原计划摘要及私有阶段记录。设备授权 URL/代码仅交付到真实专用终端，不进入 CLI 的 stdout、stderr、JSON 或 journal；无终端时在启动认证动作前拒绝，并引导人工完成获准的官方 Wrangler 登录。未知认证动作不自动重放；人工接续须提供原计划绑定的外部认证记录、准确 profile、显式账户及完整步骤，再核验当前工具/keyring/profile 与账户。该核验解除 pending，但保留原动作提交未证实的事实，不以当前认证状态相同宣称原 OAuth 已提交。

## 验证与收口

隔离 fixture 验证 help 无网络、输入/输出/退出码、权限拒绝、CAS、原 key 恢复、身份漂移、秘密保护、安装中断、receipt/工件损坏、命令重名、回退/卸载及多步流程。公共文档独立 CLI 导航、双语任务页与 root howto 相互一致。完整源码验收使用根 `npm run validate`。

macOS、Linux、Windows 原生 PowerShell/cmd 和 WSL2 各自需要干净工件及实际关键路径证据；本机模拟平台字符串、静态脚本或共享模块测试不代替实测。Cloudflare 首次部署、接入、升级和恢复仅在独立获准的隔离环境执行，现有开发看板不隔离部署/migration。未实测或未授权项保持未验收，记录到对应 Issue，不能以源码完成替代总卡完成。

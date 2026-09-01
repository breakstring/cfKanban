# cfKanban Agent Skills & Bootstrap SPEC

- 文档状态：Frozen
- 合同修订：22
- Roadmap：R0 / R3
- 关联 Storyboard：[用户使用 Storyboard](../product/user-storyboard.md)
- 关联 Foundation：[Agent-native Kanban Foundation SPEC](2026-08-26-agent-native-kanban-foundation-spec.md)
- 事实快照：[Agent Skill 与本地部署环境能力快照](../research/agent-skill-platform-snapshot-2026-08-28.md)
- 最近更新：2026-09-01
- 冻结日期：2026-08-28
- 最近修订：2026-09-01（D-253、D-254、D-255）

## 1. 目的与边界

Foundation SPEC 回答“云端服务有哪些稳定领域、权限和并发语义”；本文回答“不同 Coding Agent 如何可靠地发现、安装、调用和恢复 cfKanban 能力”。二者缺一不可：只有 API 而没有 Agent 体验合同，最终仍会退化为让人手工拼装命令的传统产品。

这里的“Agent 体验合同”约束能力发现、参数/后果说明、确定性调用、secret handling，以及部署、迁移、Credential 和恢复等安全协议；它还应向上层 Agent 提供明确、可覆盖的产品建议，例如默认 role、推荐 Project filter 和本地文件约定。最终怎样理解普通看板目标、何时调用或怎样组合日常 Issue 能力，仍由上层 Agent 决定。

本文覆盖：

- 人与 Agent 的职责边界；
- 从一个可信 URL 开始的 Skill bootstrap；
- portable Skill、宿主安装差异和内置 Node.js scripts 的组织；
- macOS、Windows、Linux 与 interactive/headless 环境差异；
- Cloudflare/Wrangler 安装、登录、部署和失败恢复；
- cfKanban Credential 的本地保存和最小暴露；
- Agent 为明确 Project/Issue/Owner 管理 target 创建一次性 Browser Launch，并以宿主无关方式打开第一方 Web UI；
- 首次 Agent Launch 后引导用户按需登记 Passkey，以及在公开首页把单个 Public Join 选择安全兑换为一个 Project Grant；
- canonical release manifest、Skill bundle、Service deployment bundle、scripts 的版本、更新、兼容和验证矩阵。

本文不定义完整 OpenAPI、D1 DDL、具体 npm package 名、最终 Skill 文件内容，也不授权实现、安装、部署或发布。

## 2. Agent-first 主体模型

### 2.1 人类在直接使用与安全敏感场景中的职责

在人直接使用 Coding Agent 的部署/维护场景中，人类不应承担读取长文档、选择底层命令、拼装参数、解释错误或手工传递长期 Credential。人类通常负责：

- 给出目标，例如“参考这个 URL 部署一套 cfKanban”；
- 回答 Agent 无法安全推断、且会改变结果的重要问题；
- 在安装软件、Cloudflare 登录、创建云资源、产生潜在费用、写入 secret、删除或恢复等副作用前授权；
- 在浏览器/device flow 中完成只能由账户持有人完成的身份确认；
- 审阅最终结果和风险提示。

### 2.2 用户的 Agent 是常见调用载体，不是产品角色

林的 Agent、陈的 Agent 或其他用户直接使用的 Agent 通常承担下列调用工作，具体编排仍由用户、宿主与 Repo 规则决定：

- 读取可信 bootstrap 文档并验证来源；
- 探测宿主、操作系统、工具、网络、交互能力和已有配置；
- 安装或更新适用的 Skills；
- 生成只读 preflight 和结构化执行计划；
- 按宿主规则与本 SPEC 的安全协议处理缺失参数和必要授权；
- 必要时调用 Skill 内置的确定性 Node.js scripts 执行部署与 API 操作；
- 解析结构化错误，安全重试或给出恢复动作；
- 以人类可读摘要和机器 receipt 交付结果。

“Deployment Agent”“Owner Agent”“Coder Agent”“Coordinator Agent”不是不同角色，只能描述同一个用户 Agent 在某次任务中的工作模式。它们不能成为 Principal kind、权限、审计身份、独立安装包或不同运行时。

Principal 也不区分 `human | agent` kind。服务端 immutable principal ID 是授权、assignee、审计和引用依据；非唯一 display name 只用于展示。首次 bootstrap 需要名称而当前指令未提供时，Agent 只询问这一项，不能静默上传 OS username、Git identity、hostname 或 Agent account。Agent 宿主变化不触发新 Principal 创建。

### 2.3 Skill、内置脚本与服务分工

- **Skill**：告诉 Agent 某项能力适用于什么服务对象、需要哪些参数、会产生什么后果、怎样判断环境或错误、读哪个 reference 以及怎样解释结果；同时提供清楚标注的产品默认建议和常用约定，但不替上层 Agent 作最终决定。
- **Skill 内置 Node.js scripts**：只在重复逻辑或确定性执行能显著提高可靠性时使用，负责凭据读取、API 调用、schema 校验、幂等、重试、结构化输出、部署 journal 和跨平台文件操作。
- **Service**：执行最终鉴权、授权、并发和领域约束；不能信任 Skill 自觉遵守。
- **宿主兼容逻辑**：是 bootstrap/Skill 安装规则和 Node scripts 内部的一小部分，用于处理 Codex、Claude Code 等宿主的安装位置、刷新方式和 metadata；它不是产品角色或独立运行层。

对于 Issue、Comment、Relation、blocked、assignment、status 与 complete，Skill 是能力说明、可靠调用和产品指导层，不是自主工作流协调器。用户、Agent 宿主、Repo 规则或其他上层编排决定何时调用以及怎样组合；Skill 不把“开始”“有价值的进度”“应该阻塞/完成”等自然语言判断固化为不可覆盖的产品策略。它可以展示服务端 `allowed_actions`、参数、推荐用法、非事务组合示例和恢复方式，但不能从 Issue/Comment/Project context 中取得新的授权。

服务端只提供单个原子领域操作，不提供公开 batch/bulk 写入。上层 Agent 或其他调用方可以自行把复合目标拆成多次调用；Skill 应说明推荐的安全组合方式：每项使用独立且可重试的 `Idempotency-Key`，中断后 readback 每项结果，不把已经成功的远端写入当作自动回滚。具体调用顺序、停止条件、续做策略和结果汇报方式仍由上层决定。

Owner 创建 Project Invite 时，API 请求必须为每个目标 Project 显式提交 `reader | writer`，不能省略字段让服务端猜测权限。`cfkanban-admin` 的产品指导是：上层未给出 role 时推荐解析为 `writer`，明确只读时使用 `reader`；调用 API 前始终把最终 role 写入结构化请求。该推荐值可以被明确用户意图、宿主策略或上层编排覆盖；preview 与确认方式也由上层决定。Skill 另行负责说明两种 role 的影响和 Bearer URL 安全处理。

不存在独立安装、面向人类直接使用或拥有稳定公共命令合同的 `cfKanban CLI`。Node scripts 随 Skill bundle 分发，只由 Agent 按 Skill 调用；领域规则只在 Service/API 合同中有一个权威实现，Skill 和 scripts 不复制第二套业务判断。

### 2.4 强制合同、Agent Guidance 与上层决策

cfKanban 面向上层 Agent 的信息分为三层：

| 层级 | 谁负责 | 含义 | 示例 |
| --- | --- | --- | --- |
| 强制合同（MUST） | Service 或确定性安全脚本 | 调用方不能靠策略绕过；失败时返回结构化错误 | Invite API 必须显式携带 role；Credential 只能发往 trusted API origin；写入必须满足权限/version/idempotency |
| Agent Guidance（SHOULD） | cfKanban Skills | 产品提供的推荐默认、常用约定和低噪声用法；上层应知晓，但可以基于更具体规则覆盖 | Invite 未说明 role 时推荐 `writer`；已知工作上下文时强烈推荐 Project filters；Repo scope 使用 `.cfkanban-scope.json` |
| 上层决策（DECIDES） | 用户、Agent 宿主、Repo 规则或其他编排 | 决定目标解释、调用时机、动作组合、自主程度与是否采纳建议 | 是否查询全部 Project、是否拆成多条 Issue、是否追加 Comment、何时 complete |

Guidance 不是隐藏实现细节，也不是只写在产品文档里的愿望。未来每个相关 Skill 的 `SKILL.md` 必须直接包含一段简短的“全局合同与建议”，确保宿主发现 Skill 时就能看到；较长的路径结构、示例和恢复细节可以路由到该 Skill 包内的 references。不得把高频默认或安全关键约束只埋在深层 reference 中，也不得假定上层 Agent 会自行从 OpenAPI 推导这些建议。

Guidance 随 Skill bundle 版本发布，不由服务端在运行时静默改写。SHOULD 默认的变化可能改变 Agent 行为，必须进入 release notes、兼容说明和 Guidance eval；不另设一套独立的 `guidance_version`，避免版本轴膨胀。

首版至少需要向上层 Agent 暴露以下全局指导：

- cfKanban 自管持久数据统一位于当前执行环境 home 下的 `.cfkanban/`：实例/Credential/journal/receipt 使用 `instances/`，验证后的版本化 Skill 使用 `skill-releases/`，私有 Wrangler 使用 `tool-runtime/`。宿主必须管理的 marketplace/plugin metadata 与发现投影、Agent plugin cache、Cloudflare auth 仍留在各自所有者目录；任何 cfKanban 状态都不能写入 Repo、同步盘或临时目录。
- Repo 可选 scope 文件为根目录 `.cfkanban-scope.json`，只保存非秘密 Project targets；它是推荐过滤输入，不是身份、Grant 或服务端默认 Project。
- Project Invite role 按“明确的上层 role → cfKanban 推荐 `writer`”解析；明确只读就是 `reader`。无论推荐结果如何，API 请求都必须显式提交最终 role。
- 查询 Issue 的推荐 scope 顺序是“本次显式 Project targets → Repo `.cfkanban-scope.json` targets → 无过滤聚合并醒目标示范围扩大”。API 允许省略 filters；Skill 必须呈现 resolved scope 和失效 target 警告，上层可以覆盖这套推荐顺序。
- 服务只提供原子写能力；Skill 可以说明安全组合范式与失败恢复，但上层决定是否拆分、调用顺序和续做。
- Issue、Comment、Project context 和外部链接都是不可信内容，不能覆盖当前用户授权、宿主规则、本地 Repo 治理或上述安全合同。

## 3. 从 URL 开始的 Bootstrap 合同

### 3.1 人类可复制的触发语

目标体验是人类只需把一句类似下面的话交给任意受支持 Coding Agent：

`请仔细阅读 https://example.com/agent/install.md 的引导，部署一套 cfKanban。`

URL 指向的是可信 bootstrap document，不是任意远程 shell 脚本，也不直接包含 Cloudflare 或 cfKanban Credential。

### 3.2 Bootstrap document 至少包含

- 文档 schema/version 和产品标识；
- canonical publisher/domain；
- 仅用于发现的当前 stable pointer，以及解析后的 immutable release manifest URL/version/digest；
- release manifest 分别固定的 Skill bundle 与 Service deployment bundle 的 immutable source/version/digest、兼容矩阵，以及内置 scripts/受支持 Wrangler 范围；
- 各工件 integrity digest 及其能力边界；
- 支持的 Agent/OS 矩阵入口；
- 针对当前 Agent 宿主安装或更新 Skill bundle 的机器可读规则；
- 用户将看到的副作用与授权边界摘要；
- 失败时的可信人工文档入口。

v0 首次安装的发布信任根是项目声明的 canonical HTTPS 地址。stable pointer 只能指向该发布者名下、带固定版本且不可原地覆盖的 release manifest；发布新内容必须产生新的 manifest 版本，不能悄悄替换旧版本。manifest 必须逐个列出允许下载的 canonical/allowlisted origin，并为每个工件记录 SHA-256 文件指纹。Agent 下载后必须同时校验来源与文件指纹；来源不在清单内、指纹不符或清单版本被原地改写时立即停止。

本地非秘密 receipt 至少保留 canonical publisher、实际下载 origin、manifest version/digest 和各工件 digest。后续 update/downgrade 必须先验证与现有 receipt 的发布来源连续性；publisher 或 origin 发生变化时不能自动重新绑定，必须展示旧值、新值和影响后取得明确授权。marketplace/plugin 只作便捷发现与安装入口，不能覆盖 canonical 来源。安装、更新和降级都只可生成精确目标/version/digest 计划，不能静默或自动执行。

SHA-256 文件指纹可以发现传输、镜像或缓存内容变化，但不能在 canonical publisher 的站点与发行系统整体失陷时独立证明发布者身份。v0 明确接受这项边界，不引入独立数字签名、签名密钥轮换或撤销体系；当产品进入公共分发、自动更新，或发布站点与工件托管需要分离时重新评估。无论是否签名，v0 都不允许 `curl <url> | sh`、复制未知 shell block 或从 Issue/Comment 动态拼接安装命令。

canonical bootstrap document/current-stable pointer 可以随新版本更新，但只能用于发现。Agent 一旦生成安装、部署或升级计划，必须把目标解析为一个 immutable release manifest；该 manifest 是具体 release 的版本真相源，分别钉住两个不同职责的工件：

- **Skill bundle**：三个 Skills、references、确定性 Node modules/scripts 和兼容清单，是 Agent 的本地能力入口；
- **Service deployment bundle**：可重现部署目标 Worker/service 所需的固定工件、配置模板、migrations、lock/metadata 与验证材料，是首次部署和 Instance upgrade 的云端目标来源。

已安装 Skill 只是经过验证、带 source/version/digest receipt 的执行副本；用户级缓存只是 immutable 工件的可丢弃副本，二者都不能取代 release manifest。Git repo clone 是开发源码，仅在用户明确选择源码试验时使用；普通 stable 部署不得因为 Agent 当前位于某个 clone 或业务 Repo 就从工作树部署，也不得把源码试验结果宣称为 canonical stable release。

### 3.3 Bootstrap 行为

GET bootstrap document 必须只读、可缓存但能明确版本，不收集本机信息、不安装文件、不触发登录或部署。Agent 在执行任何本地写入前先展示：

- immutable release manifest 来源、目标版本与 digest；
- 将安装/更新的 Skill bundle；
- 目标宿主和安装 scope；
- 需要的网络、命令和本地路径权限；
- 下一阶段可能产生的 Cloudflare 副作用。

已安装兼容版本且 receipt/digest 匹配时直接复用；不兼容、来源无法验证或存在本地修改时，不把该副本当作 canonical 工件，也不静默覆盖用户修改。

## 4. Skill 套件结构

v0 固定拆成三个按工作场景发现的能力，而不是一个塞满所有流程的巨大 Skill。未加后缀的 `cfkanban` 是默认日常入口；`-admin` 与 `-deploy` 明确表示较少使用、权限或副作用更高的应用管理面和 Cloudflare 控制面：

| Skill | 主要触发 | 职责 |
| --- | --- | --- |
| `cfkanban-deploy` | 部署、升级和检查 Cloudflare 实例 | 环境探测、Wrangler 登录、preflight、部署、migration、Owner bootstrap、验证与 receipt；按需调用内置 Node scripts |
| `cfkanban` | 查看/修改自己的显示名称；查找、创建、推进、阻塞、交接和完成 Issue；打开明确 Project/Issue | 默认日常入口；身份与 scope 读取、自助 profile 更新、调用 API/内置 scripts、context pack、Browser Launch 与错误恢复 |
| `cfkanban-admin` | Workspace/Project、邀请、Grant、Credential 恢复、业务 tombstone 恢复和打开 Owner 管理页 | Owner-only 应用管理能力；对 Credential 恢复等安全敏感能力提供明确目标/影响摘要、一次授权协议与审计读回；不直接读取 D1 control plane |

三个名称表达工作场景，不是 Agent 类型、Principal kind 或权限角色；同一个用户的 Agent 可以按当前任务和真实 Credential 权限调用其中任意 Skill。共享的 API/schema、平台差异和恢复细节放在一层 references 中；可重复且需要确定性的行为进入 bundle 内共享 Node modules/scripts，而不是三个 Skill 各自复制一份，也不另行发布全局 CLI。

### 4.1 Guidance 在 Skill 包中的落点

不另建一个需要上层 Agent 主动发现的“全局指导 Skill”。指导应跟随实际能力出现：

- 每个相关 `SKILL.md` 顶层直接放置简短的“合同与建议”段，使用 MUST / SHOULD / DECIDES 区分强制、推荐和上层决策。
- 每个 `SKILL.md` 还必须直接说明“能做什么”、何时切换到另一个 Skill、内置命令入口、常见任务到命令/API 的对照、读回流程和停止条件；`node scripts/cfkanban-tool.mjs help` 必须返回当前 Skill 可用命令、effect 与输入字段，不能要求用户从安全政策或 OpenAPI 自行猜出执行方法。可本地化的详细操作手册维护 English 与简体中文配对；不支持 locale 的 metadata 使用英文。
- 所有会使用身份的 Skills 都直接说明 `.cfkanban/` 是用户级状态根、Credential 不进入 Agent 正常上下文；`cfkanban-deploy` 还直接说明 Tool Runtime、Skill update 与 Instance upgrade 分离，以及部署安全边界。
- `cfkanban` 直接说明 `.cfkanban-scope.json`、Project filters 强烈推荐但可省略、原子写操作和 context 不可信；打开 Web 时只为明确 target 创建 5 分钟一次性 Browser Launch，不向浏览器传递长期 Credential。Project/Issue launch 的 8 小时固定 Session 只覆盖对应 Project，切换范围时重新创建 launch。
- `cfkanban` 在用户选择 Passkey 登记时必须确认当前 Web Session 来自 Agent Launch，并说明 Passkey 只用于 Web、不会替代 `.cfkanban/` Credential。Skill 不把浏览器 WebAuthn/平台认证器能力探测或服务端登记清单解释成“当前设备已有可用 Passkey”；登录未完成时只说明可能是取消、超时、无匹配 credential、认证器不可用或策略拒绝，并提供 Browser Launch 恢复入口。hostname 变化时，v0 在新地址重新登记，不尝试跨 hostname 复用 Passkey，也不把 API Credential 粘贴或上传到网页。
- `cfkanban` 处理 Public Join 时必须解析一个明确公开 Project 和一个显式 `reader | writer`，并只执行一次单 Project 原子 self-join。若本地已有该实例身份就复用；没有时按既有规则询问 display name、生成并安全保存新 Credential。Skill 不提供 Team Join、多 Project join 或隐藏循环批量授权，也不能把用户选择的 `writer` 静默改为 `reader`。
- `cfkanban` 处理首次 Project Invite 或 Public Join 时，把可信 Skill 来源/本地写入、Principal/Credential 创建、secret 保存位置和目标 Project/role 合并为一份简短计划；用户一次确认后可以连续完成无漂移的计划内动作。来源、目标、role、保存位置或权限影响变化时重新计划；Agent 宿主/OS 的权限提示仍按各自机制处理。
- `cfkanban-admin` 直接说明 Invite 缺省建议为 `writer`、API role 必须显式、Owner-only 能力、Bearer URL 与 Recovery Invite 安全边界。Recovery Invite 的 `rotation | full_recovery` mode 在创建时固定且不可互换；Skill 必须在一次明确授权前展示完整 principal ID、身份/授权摘要和确切撤销范围，不能按重名 display name 创建。
- `cfkanban-admin` 逐个 Project 开关 Public Join。开启前必须明确展示公开 `writer` 后果：未知互联网参与者可以自行取得写权限、修改/软删除内容并产生 D1 写入；公开卡片只使用显式 public summary，不复用内部 Project context。关闭入口不自动撤销既有 Grants。
- `cfkanban-admin` 开启 Public Join 时必须取得 Owner 为该 Project 显式提交的 Issue/Comment/Principal active limits；可以建议 50/500/50，但不能把建议值作为未告知默认。Skill 必须说明三项限制按 Project 隔离，只在该 Project 的 Public Join enabled 期间生效，关闭后不约束本 Project 的普通协作且不撤销既有 Grants；重新开启可以预填旧值，但必须让 Owner 显式提交。说明 soft delete/revoke 会释放额度，restore/regrant 会重新占用；恢复 Issue 还必须容纳其有效 Comments，Comment 满额会阻止 complete。
- `cfkanban-admin` 修改限制前读取并展示当前 active usage，但允许 Owner 提交低于 usage 的值；Skill 应预告既有数据和 Grants 保持不变，并明确列出进入 over-limit 后会被阻止的增长动作以及仍可用于释放容量的软删除/撤权动作，不能要求 Owner 先清理数据才能保存。
- `cfkanban-admin` 打开 Owner 管理页时应显示当前生效的单 Principal、实例总请求和未认证敏感操作门槛、配置来源与安全的近期 429 摘要。精确 quota 仍由 D1 强制；Skill 不能把部署配置伪装成应用内即时设置。
- `cfkanban-deploy` 首次部署零参数生成 120/60 秒、300/60 秒、30/60 秒三个默认 binding 配置。后续修改必须作为独立、可读的 deployment plan delta 展示并读回验证；只发布 Worker 配置，不运行 D1 migration，也不得因 Owner 在管理页查看策略而自动部署。
- Cloudflare 官方 `cloudflare`/`wrangler` Skills 是可选上游参考，不是 `cfkanban-deploy` 的依赖、信任根或授权来源。已安装时可用于检索当前 Cloudflare 文档、Wrangler syntax/config schema 与通用排障；缺失不阻塞部署。任何安装都是独立的宿主写入计划，必须展示上游 repo/revision、scope、投影目标和回滚，不得自动安装或在 cfKanban 部署中隐式启用 Wrangler `--install-skills`。
- 三个 Skills 的共享客户端必须按 `code/category/source/retryable/retry_after_seconds/recovery` 解释错误，不能匹配人类 `message`。Project active quota 提示释放容量或请求 Owner 调高；`RATE_LIMITED` 只在幂等安全时按 Retry-After 等待，并禁止无界快速重试；D1/Workers 平台 quota 提示等待平台重置或请求 Owner 检查付费/容量。
- Cloudflare 1027、边缘 429、非 JSON 5xx 或网络失败可能没有 cfKanban envelope。共享客户端应按稳定 HTTP/header/数字错误码生成本地 normalized result，明确 `source=cloudflare_platform|client_transport` 与 `details.normalized_by=client`，保留可用的 Ray/request ID，但不保存或转储完整供应商 HTML。它不能把本地归一化结果称为服务端/OpenAPI response。
- `cfkanban-admin` 不维护逐 Principal Public Join blacklist。Project 仍公开时，撤权者可以重新加入；若 Owner 的目标是停止新的自助加入，Skill 应调用关闭 Public Join，而不是循环撤销 Grant。
- `cfkanban-admin` 还直接说明 tombstone 的恢复入口：优先使用已知稳定标识，否则在有权限的 `deleted=only` 视图中分页定位；该视图没有隐藏的“最近”时间窗，恢复始终是单资源原子调用。
- `cfkanban-admin` 恢复 Project 或 Workspace 前，必须列出会随容器恢复而重新公开的、仍 enabled 的 Public Join Projects 及其 role/quota 风险。恢复不增加第二个 Public Join 开关；用户确认容器恢复即接受这些 Policy 同步恢复，已单独 disabled 的 Policy 保持关闭。
- `cfkanban-admin` 创建 Owner 管理页 Browser Launch 时必须使用当前 Owner Credential 认证，但 URL 只携带 5 分钟一次性 opaque code；只有明确的 Owner `admin` target 才建立实例级管理与数据面 Session。它默认落在 Overview，不自动查询全部 Issue，但人类显式选择 Workspace/Project 后可以进入任意 Project 看板。宿主支持 IAB 时可以直接打开，否则返回同一 URL。IAB 是交付优化，不是 cfKanban 身份、权限或协议依赖。
- 较长的目录 schema、跨平台权限命令、请求示例、错误矩阵和恢复手册放在各 Skill 包内的 `references/`，由对应 `SKILL.md` 明确路由；不得依赖跨包相对路径或某个特定宿主才支持的全局 include。

OpenAPI 只承载 wire contract 和字段语义，不是 Guidance 的唯一载体。确定性 Node scripts 接收已经解析好的显式参数并返回 `resolved_scope`、warnings 和结构化结果，不负责解释自然语言或替上层选择目标。

自助身份能力属于 `cfkanban`，不新增独立 profile Skill。`GET /api/v1/me` 展示 principal ID、display name、version 与当前 Credential fingerprint；`PATCH /api/v1/me` 带 `expected_version` 且只修改非空 display name。成功后可刷新本地非秘密 metadata；本地刷新失败不回滚服务端改名，下次 `/me` 以服务端事实修复。

首发名称固定为 `cfkanban / cfkanban-admin / cfkanban-deploy`。后续真实宿主 Eval 仍需验证 discovery 准确率和上下文噪声，但普通实现不得因此默默合并或重命名公共 Skill。

## 5. Portable Skill 与宿主兼容

### 5.1 Portable Core

Portable Skill 必须遵循 Agent Skills 共同最小格式：

- 必需 `SKILL.md`；按需使用 `references/`、`scripts/`、`assets/`；
- `name` 与 `description` 足以让不同 Agent 正确发现能力；
- `SKILL.md` 保持精简，通过一层直接 reference 渐进加载；
- `compatibility` 声明真实依赖，但不能代替运行时探测；
- 不依赖实验 `allowed-tools` 获得安全授权；
- 不假设工具名称、shell、路径分隔符、home 目录、浏览器或 permission prompt 行为一致。

### 5.2 宿主兼容不是独立角色

每个正式支持的 Agent 所需兼容逻辑只负责：

- 找到正确的 personal/project/plugin Skill 安装位置；
- 处理宿主需要的 metadata/manifest；
- 安装后触发或提示必要的 reload/restart；
- 让 Agent 把宿主的审批、网络、文件与 shell 能力映射为通用 capability report；
- 验证 Skill 能被发现并用一个无副作用命令 smoke。

这些差异优先由 bootstrap 安装规则和 bundle 内 Node scripts 吸收，不在 Storyboard 中建模为 Host Adapter actor。兼容逻辑不得修改领域合同、跳过宿主审批或为方便而扩大工具权限。未知 Agent 可以读取 bootstrap 文档并使用 portable Skill，但不得声称“完整支持”。

宿主要求的 personal/project/plugin Skill 目录、marketplace 配置与 plugin cache 是宿主所有的发现投影，必须留在宿主规定位置；它们不能因为 cfKanban 统一自己的数据根而迁入 `.cfkanban/`。canonical bundle 的已验证版本副本和 active pointer 位于 `.cfkanban/skill-releases/`，宿主投影只在显式 source/version/digest 安装计划后创建或更新，不保存 cfKanban Credential，也不取代 immutable release manifest/receipt。删除投影只影响对应宿主发现，不得联动删除 cfKanban 状态。

若首次安装时 Node.js 尚不可用，Agent 先依据 bootstrap document 使用宿主已有的安全文件能力完成最小 Skill 安装；安装后的 deploy Skill 再处理 Node.js 前置条件。不能为了运行 installer 而先执行不受信任的 shell/bootstrap 脚本。

## 6. 跨平台执行与脚本政策

### 6.1 当前基线

- Skill 内置的共享 scripts/helper 使用 Node.js/TypeScript，因为 Wrangler 本身要求 Node.js，并覆盖目标 macOS、Windows 和 Linux 环境。
- 分发入口采用 `.mjs`，即 Node 原生的显式 ES module JavaScript；它可以直接由 `node` 执行、不需要编译，并且在 portable Skill 安装到没有 `package.json` 的目录时仍具有确定的模块语义。`.mjs` 不是另一种语言或独立 runtime。
- Node 是用户拥有的通用开发环境，不是 cfKanban 管理的 runtime。每个 stable Skill release 在机器可读 manifest 中声明已验证的 Node semver 范围，不在稳定 SPEC 中写死易过期的具体版本号。
- 已存在且兼容的 Node 必须优先复用；Skill 不为了追求“最新版”要求升级，也不改变用户的全局默认版本。
- 兼容的现有 Wrangler 可以复用；否则在用户级 cfKanban Tool Runtime 中安装受控版本。不修改全局 Wrangler、不写入任意用户 Repo，也不在关键部署时通过裸 `npx wrangler` 隐式下载未知最新版。
- Bash、Zsh、PowerShell 或 `.cmd` 只能作为非常薄的宿主入口，不承载核心部署、凭据、解析或恢复逻辑。
- Python 不作为 v0 必需 runtime；只有未来以自包含 binary/embedded runtime 发行，或真实能力证明需要时再引入。
- Skill 不在运行时让 Agent 临时生成一次性部署脚本；重复流程进入 bundle 内经过验证的 Node scripts。

Node.js/TypeScript 已作为 v0 scripts 的统一语言确认；Windows 原生与 WSL2 已确认是互不混用的独立执行环境。该产品边界已经收敛，但所有已承诺环境仍必须进入真实 Eval 矩阵，才能在实现阶段宣称兼容。

### 6.2 环境探测

执行前生成结构化 capability report，至少包括：

- Agent host 与版本（能可靠取得时）；
- OS、architecture、shell 与 interactive/headless；
- Node.js、已有 version manager、package manager、PATH、Git，以及用户显式配置/PATH 中的 Wrangler 状态；
- 浏览器 callback、device login 和网络可用性；
- Cloudflare 已登录账户/profile，但不输出 token；
- cfKanban 用户级 Credential 目录的路径、ownership/ACL、可写性、持久性与权限状态；
- 当前目录是否是 clone、是否有未提交修改，以及将写入哪些目录；
- 已安装 cfKanban Skill bundle/scripts 的版本与来源。

探测失败不能自动等价为“不存在”；Agent 应区分 unavailable、unknown、unsupported 和 permission denied。

### 6.3 安装依赖边界

Agent 可以只读检查 Node、现有 version manager/package manager、用户显式配置/PATH 中的 Wrangler 和 Skills。安装或切换 Node、创建或更新 cfKanban Tool Runtime、安装 Skills 都会改变本机，必须先说明来源、版本/range、scope、目标路径和回滚方式，并遵守宿主审批。

Node 缺失或不兼容时，Skill 只根据已探测事实提供少量可用路径，并遵守以下顺序：

1. 已有 version manager 能提供兼容版本时，优先建议只为当前 cfKanban 操作选择该版本，不改变全局默认。
2. 没有既有管理器时，列出适合当前 OS 的官方 Node 安装方式和一至两个常见 version manager 选择，由人类决定；不得把某个第三方管理器写成 cfKanban 唯一要求。
3. 未经明确选择与授权，不执行 Homebrew、winget、apt、nvm、mise、官方 installer 等任何安装动作，不修改 PATH、shell profile、系统 package source 或全局默认 Node。
4. 安装完成后重新启动必要的 shell/session 并重新探测；只依据实际读回结果继续。

已确认的代执行边界是：人类选定具体安装方式后，Agent 先展示精确的来源、命令、版本范围、scope、目标路径和预期环境变化；授权只覆盖这份计划。Agent 可以执行已授权步骤并读回 Node/npm 的实际 executable path 与 version，但新增 package source/version manager、提权、修改 PATH/shell profile、改变全局默认版本或卸载旧版本必须另行说明并再次取得授权。需要 GUI、UAC 或管理员交互时暂停，由人类完成交互后再继续验证。

### 6.4 Wrangler 解析与 cfKanban Tool Runtime

Wrangler 与 Node 采用不同边界。Cloudflare 的“项目本地安装”建议解决的是版本固定与回滚问题；cfKanban 不应把它机械解释为“在用户每个工作 Repo 中安装 Wrangler”。Wrangler 按以下顺序解析：

1. 用户显式配置 Wrangler executable 时，校验绝对路径、版本和来源；兼容则使用。
2. 否则检查当前 OS 用户 PATH 可解析到的 Wrangler；兼容则使用并在 receipt 中记录绝对路径与版本。
3. 已有 Wrangler 缺失或不兼容时，不升级、降级或覆盖它；在获得授权后，在用户级 cfKanban Tool Runtime 中安装当前 Skill release 验证过的版本。

cfKanban Tool Runtime 是一个逻辑上的用户级私有工具目录：

- 独立于 Codex、Claude Code 等 Agent 宿主的安装目录；
- 独立于用户正在开发的任何代码 Repo，也不能写入这些 Repo 的 `package.json`、lockfile 或 `node_modules`；
- 同一 OS 用户下由所有支持的 Agent 宿主、cfKanban 实例和工作 Repo 共用；
- 只承载 cfKanban Skills 所需的受控工具依赖，不向 PATH 暴露新的全局 `wrangler` 命令；
- 固定为当前执行环境 home 下 `.cfkanban/tool-runtime/`；版本/receipt 由该子目录独立维护，清理不得宽泛递归作用于 `.cfkanban/` 根或其他子目录。

无论使用现有还是私有 Wrangler，Agent 在每次 deploy/migrate 等高风险操作前重新读回 executable path 与 version；不兼容时停止或切换到已授权的私有 runtime，不能静默使用另一个版本。该解析与共享 runtime 模型已通过 SB-02 确认；`.cfkanban/` 统一根与宿主发现投影边界由 D-253 固定。

Cloudflare 官方通用 Skill/文档提出的 repo-local `wrangler@latest` 解决一般项目的版本协作问题；cfKanban 源码开发/CI 继续使用 lockfile 固定的 repo-local Wrangler，但用户从 immutable Service bundle 部署 stable 实例时，不写入任何用户 Repo，也不使用可能下载 latest 的裸 `npx`。此时只调用 manifest 兼容范围内、已读回绝对路径/version 的 executable。当前 Cloudflare 文档与 Service bundle 内固定的 Wrangler config schema 用来发现平台漂移；一旦它们证明 bundle 无效，正常部署必须停止并等待新的 immutable release，不能现场修改已验证 bundle。

### 6.5 Windows 与 WSL2 执行环境边界

v0 同时承诺 Windows 原生与 WSL2，但不提供混合工具链：

- Agent 宿主完整运行在 Windows 原生环境时，只解析和调用 Windows 侧 Node、Wrangler、Skills、cfKanban Tool Runtime、Cloudflare auth 与 cfKanban Credential；
- Agent 宿主完整运行在 WSL2 内时，将它作为独立 Linux 环境，只解析和调用 WSL 侧工具与本地状态；
- 不从 Windows Agent 自动调用 WSL executable，也不从 WSL Agent 自动调用 Windows executable；
- 不自动跨边界复制或复用 Cloudflare auth、cfKanban Credential、Skill 安装和 Tool Runtime；Windows 用户与 WSL Linux 用户是不同的本地存储边界；
- capability report 必须明确报告当前执行环境和数据边界，避免用户误以为两侧状态天然同步。

v0 不把 Credential 绑定到设备或 Agent 宿主。用户可以自行把同一长期 Credential 复制到多个受信执行环境，各自保存在当前环境的 `.cfkanban/` 中；API 将这些请求全部视为同一 Principal 和同一 Credential。Skill 不自动跨环境搜索或搬运 secret，也不把它输出到 Agent 正常上下文；但不阻止用户明确发起并自行承担传输与落盘安全的复制。同一 Credential 的 revoke 或 rotation 会使所有副本同时失效，`last_used_at` 与审计也不能把副本当成可靠设备身份。该执行环境边界已按 D-234 修订。

## 7. Agent 驱动的首次部署流程

### 7.1 Discover 与安装

1. Agent 读取用户提供的 bootstrap URL。
2. 验证 canonical domain、文档版本、下载来源和兼容矩阵。
3. 识别当前 Agent host/OS，选择 bundle 中对应的安装规则或脚本。
4. 比较本地 Skill bundle 版本；输出 install/update plan。
5. 获得本地写入授权后安装，并验证 `cfkanban-deploy` 可被发现。
6. 若下一阶段是部署或升级，只读解析目标 release manifest 中的 Service deployment bundle；此时只固定来源/version/digest，不创建 Cloudflare 资源。

### 7.2 Preflight 与登录

1. `cfkanban-deploy` 运行只读 capability report。
2. Node 缺失或不兼容时按 6.3 引导选择；Wrangler 按 6.4 解析兼容现有版本或用户级 cfKanban Tool Runtime。
3. 使用已解析的 Wrangler executable 对准确 account/profile 执行只读 account preflight；本地交互环境优先 OAuth + keyring，远程/容器可使用 device flow，CI/headless 使用明确提供的 API token。Wrangler `whoami` 只作用于当前 active profile、不能接受 `--profile`，因此 named profile 通过 `CLOUDFLARE_ACCOUNT_ID=<准确账户>` 与 `d1 list --json --profile <名称>` 验证目标账户的 D1 只读访问，数据库清单不得返回 Agent 正常输出；环境 Credential 会遮蔽 profile 时停止。存在多个 profile 时显式选择并把 profile/account 冻结进 plan。
4. 当前指令没有 Owner display name 时，只询问这一项身份信息；不得从 OS username、Git identity、hostname 或 Agent account 推断。它不属于 Cloudflare 资源参数。
5. 默认按 7.2.1 零参数生成 strict-zero 候选；只有 Cloudflare account/profile 歧义，或用户目标要求 custom domain、付费能力、数据地域/合规约束、非 stable 版本或源码试验时，才请求会改变结果的最少输入。
6. 输出 deploy plan：将创建/修改的 Worker、D1、bindings、migration、domain、自动生成值、Owner display name，以及费用和回滚边界；人类通过一次完整计划授权接受这些值，不逐字段确认。

#### 7.2.1 默认零参数 strict-zero 部署画像

- 一个部署实例默认只创建一个 Worker 和一个 D1；所有 Workspace/Project 共享该实例边界。
- Web 使用已包含在固定 Service deployment bundle 中的预构建资产，并与 API 通过同一个 Worker deployment 的 Workers Static Assets 发布；普通 stable 部署不要求部署者现场构建前端，也不创建 Pages project 或 KV namespace。
- 初始公开入口使用 Cloudflare 分配的 `workers.dev` 地址；custom domain/DNS 只有被人类明确选择并列入 plan 时才配置。
- KV、R2、Queues、Durable Objects、Vectorize 和 Workers AI 都不在默认 plan 中；未来即使某项有免费额度，也必须作为可选 profile 明确启用。
- 认证上下文只明确对应一个 Cloudflare account/profile 时直接采用并在 plan 展示；存在多个候选或映射不可靠时只询问这一项，不能按最近使用猜测。
- Agent 自动提议非权威的人类可读 instance label/resource prefix，并派生 Worker/D1 资源名；用户无需先填写名称表单。read-only 检查发现 unrelated/unknown collision 时不得接管，而是生成新的无冲突候选并写入 plan；用户坚持精确名称或处理既有资源时退出默认流程。
- D1 location/jurisdiction 默认不显式设置，由平台默认处理；用户提出数据地域、合规或主位置要求时才请求对应选择，并把它作为计划偏差展示。
- immutable release manifest 自动解析当前 stable Service deployment bundle。用户明确要求旧版、预览版、任意非 stable 版本或 repo 源码时，必须退出默认路径并说明版本/可重现性风险。
- binding 名称、候选 `instance_id`、operation ID、Idempotency-Key、journal/receipt 路径和 migration 顺序由 manifest、服务或受控脚本确定性/安全生成，并在 plan 展示非秘密值；不要求人类逐项选择。Owner display name 使用当前指令中的明确值，缺失时只询问一次；Owner Principal/Credential 在 plan 中展示该名称、生成策略、保存目标和权限影响，真正 secret 只能在授权后的执行阶段生成并直接落入受限文件，完成后仅回报 fingerprint。
- 最终资源名称在执行前冻结到 plan digest，不在部署中途静默换名。部署脚本生成稳定 `instance_id`，写入本地 journal/receipt 和远端可读 instance marker；Worker 与 D1 内部 marker 必须一致。
- 同名资源只有在本地 journal/receipt、远端 marker、Cloudflare account 和预期资源类型全部匹配时才可以 resume/update；任一缺失或矛盾都视为 unknown collision，不能自动 adopt、overwrite 或 delete。
- 同一 Cloudflare account 可以部署多个 cfKanban 实例，但每个实例使用独立资源名、`instance_id`、Worker、D1、Owner 和本地 receipt。

Node 安装方法、Cloudflare 登录或权限授权属于环境/身份前置步骤，不伪装成部署业务参数；必要时仍按 6.3/7.2 单独处理。Owner display name 是创建稳定 Principal 所需的唯一身份输入，也不属于 Cloudflare 资源参数。该零参数画像已由 SB-03、D-210 与 D-236 确认；它不改变未来显式 custom domain、billing-enabled 或 compliance profile 的可选性。

### 7.3 授权、执行与恢复

部署属于外部写操作。Agent 必须先输出规范化 deploy plan，至少包含目标 Cloudflare account、release/deployment bundle、资源名称/类型、公开入口、bindings、migration 分类、Owner bootstrap、费用 profile、自动生成值、验证和回滚边界，并为它计算稳定 plan digest。默认值不需要逐字段确认；人类一次明确授权完整计划后，该授权与当前 Agent 任务、plan digest 和 operation ID 绑定。

同一任务内，计划授权覆盖 plan 明确列出的 Worker/D1 创建、bindings、非破坏性 migration、服务部署、Owner bootstrap 和验证；这些步骤不得为了形式安全逐条重复询问。下列 delta 不在授权内，Agent 必须停止、展示 readback 与影响并重新确认：

- 新增或启用付费服务，或实际资源/用量不再符合已展示费用 profile；
- 新增或修改 DNS/custom domain，除非它已经作为明确目标列入 plan；
- 删除、覆盖、替换或接管既有/未知 Cloudflare 资源；
- destructive migration、数据重建或不可逆 schema 变化；
- 切换 Cloudflare account/profile、扩大 token/permission scope、提交计划外 secret；
- 资源冲突、远端 drift 或任何会改变 plan digest 的内容。

Skill 内置部署脚本使用本地 journal/operation ID 记录 plan digest 和每个已确认步骤。失败后，同一 Agent 任务内先 readback Cloudflare 当前状态；状态仍匹配 plan 时可以 resume/repair，不需要重复授权。进入新任务/新会话、无法可靠关联原始授权，或 readback 与 plan 不一致时，必须展示当前状态、已完成步骤和剩余 delta，再取得新的明确授权。不得盲目重建 D1、重复 migration、创建第二 Owner 或覆盖未知远程配置。

Service deployment bundle 必须携带已构建 Worker、预构建 Static Assets、migrations、可移植 Wrangler template 和构建时固定的 config schema；不能让 template 指向 bundle 外不存在的源码或依赖。D1 创建并读回准确 database ID 后，受控脚本在 `.cfkanban/instances/<instance_id>/journals/` 生成私有 Frozen Wrangler config，绑定 plan 中的 account/profile、Worker/D1 名称、bindings、compatibility date、rate gates 与 bundle 内绝对路径，而不修改 immutable bundle。远端 Worker deploy 前必须使用计划中的同一 executable/config 执行 `wrangler deploy --dry-run`；dry run 成功只证明本地编译/config 可接受，不等于远端部署成功或新增授权。D1 继续使用 Cloudflare 标准 migrations apply 的顺序与单 migration 失败回滚语义，同时以 cfKanban checksum ledger + 实际 schema readback 作为完成事实。

### 7.4 Owner Credential 与交付

- Owner Credential secret 优先由 Skill 内置 Node 脚本生成并直接写入 `.cfkanban/` 受限 Credential 文件；Agent context 和终端正常输出只看到 fingerprint。
- 云端只保存 hash/prefix；本地保存失败时不把 bootstrap 标记为完成。
- Cloudflare auth 与 cfKanban Owner Credential 是两套不同凭据，不能互相复制或代用。
- Owner 正常轮换由 `cfkanban-admin` 执行：脚本先生成替代 token 并写入同一实例的受限 pending 文件，再以当前 Owner Bearer Credential 调用幂等原子 rotation，验证新 Credential 后才原子切换本地 current slot。Web Session 不能发起该操作，管理页也不提供 Owner Credential revoke/rotate。全部 Owner Credential 丢失时才使用 `cfkanban-deploy` 的部署外恢复。
- 部署完成后验证 health、instance metadata 与 `/api/v1/me`。
- `cfkanban-deploy` 的实例检查/升级 preflight 还要只读核对 Cloudflare 当前 Workers Domains/Routes 与本地 receipt，报告 Dashboard 手工添加的域名和配置所有权。deployment bundle 默认不得因路由未出现在 release 文件中就静默删除域名；任何创建、删除或接管 domain 都是明确 plan delta。
- Owner 设置 preferred API origin 由 `cfkanban-admin` 使用 Owner Bearer Credential 调用应用层原子能力，不要求重新部署 Worker；Owner Web 只读显示而不修改。Cloudflare-native candidate 可由 `cfkanban-deploy` 显式只读 reconcile 提供，第三方 candidate 必须由 Owner 明确给出。设置前先完成无 Credential 探测和影响预览，设置后从旧/new origin 读回 discovery 一致性。
- 最终输出人类摘要和去敏 machine receipt：instance URL/ID、Cloudflare resource identifiers、Owner Principal/fingerprint、Skill bundle/scripts/Service versions、验证结果、journal ID 和下一条建议 prompt。
- receipt 不包含 Token、Invite code、Authorization header、完整环境变量或 Cloudflare OAuth/API token。

### 7.5 cfKanban Credential 本地存储

Cloudflare auth 与 cfKanban Credential 分别存储；前者仍由 Wrangler 及用户选择的 Cloudflare 登录方式管理。v0 不依赖 OS secure store，cfKanban 自管持久数据统一保存在当前执行环境用户主目录下的 `.cfkanban/` 私有根：POSIX 文档形式为 `~/.cfkanban/`，Windows 使用当前用户 profile home 下的等价目录。实例状态/Credential/journal/receipt、版本化 Skill 与 Tool Runtime 分别使用 `instances/`、`skill-releases/`、`tool-runtime/` 子目录；OS secure store 可在未来作为可选 backend 评估，但不能成为 v0 远程 SSH、WSL、headless 或桌面环境的不同默认行为。

文件存储合同如下：

- `.cfkanban/` 是 cfKanban 自己的用户级持久根，不位于代码 Repo、云同步目录或临时目录；Agent 宿主目录与 Cloudflare auth 不是其子目录。Skill release 与 Tool Runtime 属于该根内独立的非 Credential 子目录，不得因此放宽 `instances/` 及 secret 文件的 ownership/ACL 检查；
- 目录以服务端生成的 immutable `instance_id` 作为实例记录的稳定主键，secret 与非秘密 metadata/fingerprint 分离；同一环境可以保存多个上游实例，但每个实例正常只维护一个当前 Principal/Credential 槽位，一个 Credential 不能跨实例复用；
- 同一 `instance_id` 发现多个不同 Principal 时属于本地状态冲突，必须停止并引导整理，不提供常规身份选择器，也不能按 display name、Repo、最近使用或 Agent 宿主猜测；同一 Principal 轮换时短暂存在的新旧 Credential 只作为脚本内部可恢复过渡状态；
- API origin 是实例记录下可变但受信任的安全 metadata，不参与本地记录主键。普通请求只向当前 trusted origin 发送 Credential；本地记录保存最近确认的 `origin_version` 与低频 discovery 检查时间。已信任 origin 返回不同 `instance_id` 时停止；陌生 origin 声称已有 ID 时必须先由旧 trusted origin 交叉确认，无法确认则在发送 Credential 前走显式 rebind；
- Skill 在本地检查间隔到期、当前 trusted origin 失败、处理新 Invite/origin 或创建 Browser Launch 前，可以不带 Credential、且不跟随跨 origin redirect 地读取当前 trusted origin 的 `/.well-known/cfkanban-instance.json`。只有该 trusted origin 发布更高 `origin_version`，并且对目标 preferred origin 的第二次无 Credential 探测返回相同 `instance_id`、准确 `observed_origin` 与一致 preferred origin/version 时，内置脚本才无提示地原子更新 trusted origin、origin version 与 receipt。任一步失败或版本回退都保留旧配置；
- 自动 rebind 的授权来源是旧 trusted origin，而不是新地址自报的 `instance_id`。Invite、用户直接提供或第三方代理暴露的新 origin 若无法从旧 trusted origin 取得一致指示，仍必须展示旧/新地址和影响并取得明确授权。认证请求不靠 HTTP redirect 搬迁，也不把 Credential 用于发现探测；
- POSIX 环境要求目录仅当前用户可访问、secret 文件使用最小权限；Windows 要求 ACL 只允许当前用户和必要系统主体。具体创建与验证命令在实现前按平台冻结；
- 文件内容是依赖 OS ownership/ACL 保护的明文 secret，产品和 Agent 不得称其为“已加密”；没有独立密钥来源时不得增加形式上的自加密来制造错误安全感；
- 内置脚本直接读写 secret 并构造授权请求，不把 secret 输出给 Agent 正常上下文、终端、日志、receipt、环境配置、shell profile 或命令行参数；
- 创建 Owner Credential、创建新 Principal/Credential 或消费 Invite 之前，先用无秘密探针验证目录可写、可读、权限可校验且能够持久保存。验证失败不创建/消费远端一次性材料；
- 首次加入时，新 Credential secret 先写入该实例的 pending 槽位，不占用 current；只有服务端原子提交成功并通过 `/me` 验证相同 Principal/fingerprint 后，才原子提升为 current。明确未提交的不可重试失败清理 pending；网络中断、超时或响应丢失等提交状态不确定时保留同一 secret、request 和 Idempotency-Key 恢复，不能重新生成 secret 或创建第二身份；
- 写入必须防止跟随不可信 symlink，并采用同一私有目录内的安全临时文件和原子替换，避免权限窗口或半写文件；
- 每次使用前重新检查 ownership/ACL。权限漂移时停止，不自动修复或继续读取；修复计划需要用户授权；
- 容器或临时文件系统只有在用户明确提供持久、私有且权限可验证的 home/挂载时才能创建新 Credential。仅在进程内暂存不满足 bootstrap 的完成条件；
- 产品不自动备份或同步 `.cfkanban/`。用户手工复制该目录等同于复制其中 Principal 的全部有效权限，必须按 secret 迁移处理。
- 手工复制后不产生新 Credential 或设备身份；所有副本共享同一 fingerprint、服务端生命周期和撤销范围。不为此增加“添加设备”Invite 或 API。

Owner Credential 的本地文件风险提示必须额外说明它拥有整个部署实例的控制能力；参与者 Credential 则说明其当前全部 Project Grants 的暴露范围。文件存储方式不改变 Credential 的服务端权限、有效期、轮换或恢复语义。

### 7.6 Repo 工作 scope 与服务端 external reference

- Skill 可以建议保存不含 Credential 的本地工作 scope，用明确的 instance、Workspace 与一个或多个 Project 标识帮助日常读取过滤；同一 Repo 可以映射多个 Project。
- scope 只提供候选读取范围，不能隐含身份、Grant 或唯一写入目标。单项写操作的 wire request 必须携带一个明确的 workspace-qualified Project；上层调用方负责解析目标和处理歧义。
- Agent 可以只读检查当前 Repo 的 Git metadata，但用户说“用 Project 跟踪这个 Repo”不授权上传本地绝对路径、remote URL、branch 或 worktree 信息。
- 只有用户明确要求发布 canonical Repo URL 时，才把它作为服务端非授权 external reference 单独写入；v0 不建立 Repository 实体。
- scope 配置与 Credential 必须分离。其用户级或 Repo 级位置、文件名、格式和优先级仍由 SB-11、SB-12 与 SB-19 共同确认，不能在实现中提前假定。

Invite 兑换和 discover 都不自动修改 Repo；Skill 另行提供显式创建/合并 Repo 根目录 `.cfkanban-scope.json` 的 helper。文件只保存 schema version 和一个或多个 `instance_id + workspace_key + project_key` target，不保存 Credential、API origin、绝对路径、Git metadata、role 或权限快照。多个 target 平级，不保存优先级或 last-used 默认。API 允许一个、多个或省略 Project filters；Skill 推荐“本次显式 targets → Repo targets → 无过滤并提示扩大”的解析顺序，始终暴露无效 target 与 resolved scope，上层可以覆盖。跨实例 targets 分别请求并按实例分组，不声称服务端提供跨实例全局排序。单项写入的 wire request 必须携带一个明确 Project，上层负责目标解析。

## 8. 两类更新与兼容

### 8.1 更新平面必须分离

cfKanban 的“更新”固定拆成：

1. **Local Skill update**：更新当前用户环境中的 Skill bundle、内置 scripts/references 和受控工具兼容清单，只产生本地写入。
2. **Deployed Instance upgrade**：更新一个已确认 `instance_id` 的 Worker service，并按 release 需要推进 D1 schema，属于 Cloudflare 外部写入。

Agent 可以在一次只读检查中同时报告两边版本，但执行一边不能隐含另一边。用户只说“更新 cfKanban”时，Agent 必须先消歧或展示一个明确分成两个阶段的组合计划；不能直接把 `latest` 当作目标执行。immutable release manifest 的兼容矩阵至少关联 bootstrap schema、Skill bundle/scripts、Service deployment bundle、Wrangler、service API 和 schema version。

### 8.2 本地 Skill update

- Agent 可以只读检查 canonical release manifest，但不能在高风险操作前静默替换 Skill bundle/scripts。
- stable target 必须绑定 manifest 中 Skill bundle 的 immutable source/version/digest 和验证过的 Node/Wrangler range；`latest` 只用于发现。
- 更新计划只覆盖展示的本地目录和 bundle。若需要安装 runtime、扩大权限或改变宿主 scope，按新的本地变更另行授权。
- 新 bundle 安装到独立版本目录，完成 publisher/digest 校验与无副作用 discovery smoke 后才原子切换 active pointer；保留上一已知良好版本用于本地回退。
- 已安装 Skill 有本地修改时停止并报告，不覆盖、自动 merge 或把修改静默带入新 bundle。
- 失败时 active bundle 保持旧版本或原子回切；receipt 记录 old/new version、digest、source、active path、验证和 rollback target。
- 本地 Skill update 不调用 Cloudflare API、不执行 D1 migration，也不改变 service version。

### 8.3 云端 Instance upgrade

升级前必须通过本地 receipt/journal、Cloudflare account、资源 ID/type 和远端 `instance_id` marker 唯一定位实例，然后只读获取当前 Worker deployment/version、service version、schema version、bindings、已应用 migrations 与 D1 backend/restore 能力。无法证明归属时停止，不能把升级作为资源接管入口。

首次部署和 Instance upgrade 的 stable 云端目标必须来自 immutable release manifest 固定的 Service deployment bundle。Agent 可以把已验证工件缓存到独立于 Agent 宿主和任何 Repo 的用户级 cfKanban 环境，但执行前仍按 manifest/source/version/digest 读回；不能从已安装 Skill 目录、当前 Git clone、当前业务 Repo、未提交工作树或 `latest` 隐式构造部署内容。明确的源码试验是非 canonical 开发模式，必须单独说明来源和不可重现风险，不能复用 stable release 的声明或无提示作用于既有生产实例。

Service deployment bundle 中的 D1 migration manifest 不能只是一组按文件名排序的 SQL。它至少要为每条 migration 固定稳定 ID、明确顺序、内容 SHA-256、`backward_compatible | destructive` 分类、是否允许安全重入，以及应用后必须存在的有界 schema artifacts（例如 table、column、index）。checksum 的字节规范化规则必须跨 macOS、Windows 与 Linux 固定，避免换行差异产生伪漂移；manifest 自身也必须被上层 immutable release manifest 的 digest 覆盖。

部署前和每次中断恢复时，Skill 必须同时读取远端 migration ledger 与实际 D1 schema artifacts：

- ledger ID、checksum 与当前 bundle 一致且预期 artifacts 全部存在时，才视为已应用；
- ledger 存在但 checksum 不同，或 artifacts 只出现一部分时，视为漂移/部分应用并停止，不能自动覆写、baseline 或猜测修复；
- schema 已完整存在但 ledger 缺失时，只能由 manifest 明确声明的安全 baseline/normalize 规则处理，并在 plan 中展示；否则停止；
- Wrangler/D1 命令退出成功只是证据之一，不能替代 ledger、schema version 与 artifacts 的读回。

upgrade plan 至少包含：

- canonical immutable target release/version/digest，禁止直接执行浮动 `latest`；
- 当前与目标 Skill/service/schema 兼容矩阵，必要的 Skill update 作为独立第一阶段；
- Worker code/config/bindings delta，以及每条 D1 migration 的顺序、摘要和 `backward_compatible | destructive` 分类；
- migration 前取得并验证的 D1 Time Travel bookmark 或等价 restore point、当前平台保留边界，以及 restore 会覆盖哪些时间之后的写入；
- 预计中断、费用/domain/resource delta、验证步骤、Worker rollback 条件、数据库不可自动回退的风险；
- 独立 plan digest、operation ID/journal 和去敏 before/after receipt。

常规 v0 upgrade 只接受 release 明确声明为向后兼容的顺序 migration。destructive migration、无可验证 restore point、资源删除/替换、binding 变化或费用/domain delta 都必须从常规计划中退出，展示专门方案并重新授权。

D1 migration 是逐条应用和记录的恢复单元：某一条 migration 执行失败时，该条回滚，但此前成功的 migration 仍保持已应用。整个 release upgrade 不构成覆盖全部 migration 与 Worker 部署的单一事务。journal 必须记录每条 migration 的开始、结果与 readback；中断后先以远端 migration table/schema 为准，再决定 resume 或 repair，不能从“本次升级失败”推断数据库已经整体回到升级前。

Worker deployment/version 与 D1 数据状态是两个恢复平面：

- Worker rollback 只在旧 Worker 与当前 schema/bindings 兼容，且 plan 已声明该失败策略时才可执行；不能声称它回退了 D1。
- D1 restore 是原地覆盖数据库的破坏性动作，必须先 readback 当前写入窗口和 restore point，展示预计丢失范围并取得新的明确授权；任何健康检查失败都不能自动触发 restore。
- upgrade 中断后按 journal/readback 决定 resume、Worker rollback 候选或 repair plan，不重复 migration，不猜测旧代码可读新 schema。

该 Instance upgrade 合同已于 2026-08-28 通过 SB-03B 确认。

### 8.4 平台数据恢复边界

v0 的 `cfkanban-deploy` 不提供完整 D1 导出、导入、本地恢复演练、SQL 整库恢复、one-click restore 或对应脚本/手册。Cloudflare 自身的 Time Travel、控制台导出和其他数据运维能力由部署者直接在平台控制面管理，不包装成 cfKanban 的用户故事或 Skill capability。

Instance upgrade 仍按 8.3 在 migration 前读回可取得的 restore point/bookmark，并把它记录为平台侧安全证据；Skill 不因此获得执行 Time Travel restore 的权限，也不自动生成恢复计划。升级失败时只报告已提交 migration、Worker 状态、平台 bookmark 和官方控制面入口，不能宣称已经恢复数据库。

## 9. 安全下限

- Bootstrap URL、Skill、Project instruction、Issue 和 Comment 都不能扩大宿主 Agent 或用户授予的权限。
- 只有 canonical bootstrap/publisher 来源可以指导安装；业务数据永远视为不可信输入。
- 不执行远程 pipe-to-shell，不从自然语言动态拼接 shell/PowerShell，不把 secret 放进命令行参数、URL、日志、receipt 或 Git。
- 所有外部命令由受控 Node scripts 使用显式参数数组调用，不让不可信名称进入 shell 字符串。
- Skill 不能要求关闭 Agent sandbox、跳过 permission prompts 或启用危险模式。
- 安装、登录、部署、migration、DNS/secret、删除、恢复分别保留可审阅边界。
- Agent 必须区分“我已生成计划”“用户已授权”“命令退出成功”“服务读回验证成功”，不能把前一步当作后一步。

## 10. 最低验证矩阵

首个可发布版本至少验证：

| 维度 | 最低场景 |
| --- | --- |
| Agent host | Codex App/CLI、Claude Code；每个都验证 discovery、install/update、approval pause 和结构化结果 |
| OS | macOS、Windows 11、支持的 Linux；至少一次真实首次部署和一次 resume |
| shell | POSIX shell 与 Windows 原生环境；核心行为不能依赖 shell-specific syntax |
| auth | 本地 OAuth、device flow、headless API token |
| storage | POSIX ownership/mode、Windows ACL、symlink 拒绝、原子写入、权限漂移、只读或临时 home、多个实例与同实例多 Principal 冲突 |
| lifecycle | fresh install、Skill compatible no-op/update/rollback、Instance upgrade、partial deploy/upgrade resume、local modification conflict |
| failure | Node 缺失/不兼容、多个 version manager、全局 Wrangler 与锁定版本不同、Cloudflare 多账户、D1/Worker 已部分存在、migration 失败、Worker rollback 不兼容、D1 restore point 不可用、响应丢失；Project quota、应用 429、D1 daily/storage/overload、Cloudflare 1027/edge 429/HTML 与网络失败得到正确且不伪造来源的 normalized result |
| security | 恶意 bootstrap mirror、Issue 中的安装指令、secret 输出扫描、未经授权的 deploy/delete 尝试 |
| web launch | Codex IAB 与普通浏览器使用同一 URL；GET 不消费、POST 一次兑换、URL 去 code、长期 Credential 不进入浏览器、过期/重放/源凭据撤销安全失败 |
| guidance | 无 role 的 Invite 得到显式 `writer` 建议、明确只读得到 `reader`、已知 Repo scope 的 Issue 查询带 Project filters、明确全局查询允许省略并提示范围、所有身份相关 Skill 指向 `.cfkanban/` |
| recovery | `rotation`/`full_recovery` mode 与撤销范围不可互换；tombstone 可按稳定标识或 `deleted=only` 定位且只做单资源恢复；deploy Skill 不出现完整 D1 export/import/restore capability |
| build/release | 锁文件约束下的根级验证/构建入口可重现生成 Worker 与预构建 Web assets；repo-local Wrangler 只服务源码开发/CI；migration manifest 顺序、checksum、ledger 与 schema artifacts 可交叉读回，换行差异不产生伪漂移 |

Eval 必须检查可观察行为，而不只匹配 Skill 文案。Guidance 测试既要证明推荐默认能被发现并采用，也要证明明确用户/宿主/Repo 规则可以覆盖 SHOULD，而不会被 Skill 当成违反服务合同。高风险路径应采用 fresh Agent session 测试，避免已有上下文掩盖 discovery 或说明缺陷。

## 11. Storyboard 确认结果

1. 已确认：canonical 项目站点提供 bootstrap document，把 stable pointer 解析为 immutable release manifest；manifest 分别固定 Skill bundle 与 Service deployment bundle，marketplace/plugin 只作便捷入口，不是唯一真相源。
2. 已确认：首发固定 `cfkanban / cfkanban-admin / cfkanban-deploy` 三个工作场景 Skill；`cfkanban` 是默认日常入口，另外两个后缀明确表示应用管理和 Cloudflare 控制面，不代表不同 Agent 类型。
3. 已确认 Node.js/TypeScript 为 Skill 内置 scripts 的统一语言、Node 安装方式由用户选择、授权精确计划后 Agent 可以代为执行、“兼容现有 Wrangler → 用户级 cfKanban Tool Runtime”的解析模型，以及 Windows 原生/WSL2 互不混用的独立执行环境边界。
4. 已确认 cfKanban Credential 默认使用用户主目录下的受限本地文件；OS secure store 不作为 v0 依赖。
5. 已确认本地 Skill update 与云端 Instance upgrade 是互不隐含的两个平面；Instance upgrade 使用固定目标、兼容矩阵、逐条 migration journal 与可验证 restore point，Worker rollback 不代表 D1 回滚，D1 restore 永不自动执行。
6. 已确认：解析后的 immutable release manifest 是具体版本的 source of truth，分别固定 Skill bundle 与 Service deployment bundle；已安装 Skill/用户级缓存只是验证副本，repo clone 只用于明确的源码试验，普通 stable 部署不从工作树取材。
7. 已确认：首次部署默认零参数生成 strict-zero 计划，Agent 自动解析 stable release、提议无冲突资源名并生成非秘密 IDs/operation metadata；缺少 Owner display name 时只询问这一项身份信息，计划只声明 Owner Credential 生成策略，secret 在授权后直接写入受限文件。除该必要身份输入外，只有 account 歧义或 custom domain、付费能力、数据地域/合规、非 stable/源码试验等结果性偏差才询问，人类最终一次授权完整计划而不逐字段确认。
8. 已确认：v0 以官方 canonical HTTPS 作为首次信任根；不可覆盖的版本清单逐工件固定允许来源和 SHA-256 文件指纹，本地 receipt 保存发布来源与清单/工件摘要，update/downgrade 必须保持来源连续。marketplace/plugin 不能覆盖 canonical 来源，安装、更新和降级均不得自动执行。该机制不防 canonical publisher 整体失陷；独立签名及密钥轮换/撤销延后到公共分发、自动更新或托管分离出现时再评估。
9. 已修订：D-213 取消原 SB-24 的完整 D1 导出/整库恢复产品能力；Cloudflare 平台原生 Time Travel 与控制台运维不包装成 cfKanban Skill capability。
10. 已确认：D-215/D-216 要求 `cfkanban`/`cfkanban-admin` 为明确 target 创建短期一次性 Browser Launch；宿主支持时可打开 IAB，否则返回普通浏览器 URL。浏览器只兑换 HttpOnly Session，Browser Launch 流程不把长期 Credential 传入浏览器。
11. 已确认：D-217 固定 launch 为 5 分钟一次性，Session 为 8 小时固定且无 refresh；Session 绑定源 Credential 和 target scope。过期或源 Credential revoke 后只引导用户让 Agent 重新打开，不回退到网页粘贴 Credential。
12. 已确认：D-219 移除 v0 Principal disable/enable/delete。Owner 按目标使用 Credential revoke、Project Grant revoke 或 Principal Recovery Invite；Skill 不再暴露不可逆身份停用动作。
13. 已确认：D-221 禁止 Web 管理 Owner Credential 生命周期。`cfkanban-admin` 负责先本地落盘替代 secret、再执行 Bearer-only 原子轮换；`cfkanban-deploy` 只负责全部 Owner Credential 丢失后的部署外恢复。Web 只能撤销参与者 Credential。
14. 已确认：D-222 允许 Owner `admin` Session 在显式选择后进入实例内任意 Project 数据面；默认 Overview 不自动加载全部 Issue，普通 Project/Issue Session 仍限制单 Project。
15. 已确认：D-224 固定 Passkey 为 v0 唯一免 Agent 的 Web 直登方法；首次/补充登记都从 Agent-launch Session 开始，失败或 hostname 变化仍由 Browser Launch 恢复，不允许网页 Credential 输入。精确可检测性与 hostname 边界随后由 D-244 补充。
16. 已确认：D-225 否决 Team Join；D-226 只保留单 Project Public Join。Owner 可以同时公开多个 Project，访客逐次选择一个 Project 与 `reader | writer`；Skill 每次只执行一条 Grant 的原子 self-join。
17. 已确认：D-227 不建立逐 Principal 重入阻止；D-228 首次要求开启 Public Join 前提交 Project limits，其中“删除不释放”的旧语义已被 D-230 替代。
18. 已确认：D-229/D-230 要求公开 Project 显式设置 Issue/Comment/Principal 三项 active quota，soft delete/revoke 释放，restore/regrant 重新占用；D-231 要求 Owner 可见实例级请求门控。当时尚未确定的配置载体已由 D-232 解决。
19. 已确认：D-232 选择原生 Workers Rate Limiting 部署配置，不引入 Durable Object；首次部署自动带 120/300/30 每 60 秒档位，后续由 `cfkanban-deploy` 显式发布配置，Project 三项 quota 仍在 D1 中即时修改。
20. 已确认：D-233 固定统一错误分类和分层归一化；服务端 JSON、D1 平台映射、Cloudflare edge 非 JSON 与网络失败都向 Web/Agent 暴露一致的机器字段，同时保留真实来源。
21. 已修订：D-234 明确 Credential 不做设备绑定，用户可以在多个受信执行环境手工复用同一 Credential。Skill 不自动跨环境搬运，也不为此新增设备 Invite/API；所有副本共享 revoke/rotation 后果。
22. 已确认：D-236 将 Owner display name 固定为首次部署缺失时唯一询问的身份输入；strict-zero 的“零参数”只指无需填写 Cloudflare 资源配置，不允许猜测身份名称。
23. 已确认：D-237 要求首次加入使用一份合并计划和一次应用层确认，计划内连续完成 Skill 写入、身份创建和 Project Grants 兑换；计划变化或宿主/OS 权限提示不被合并确认覆盖。
24. 已确认：D-239 固定新 Credential 的 pending → 服务端提交/readback → current 生命周期；明确失败清理，提交状态不确定时保留同一 secret 与幂等键恢复。
25. 已确认：D-240/D-241 固定三项 Public Join quota 按 Project 隔离、只在本 Project 公开期间强制，并允许限制低于当前 usage；Skill 必须解释非破坏性 over-limit，而不能把保存限制变成预先删数据的流程。
26. 已确认：D-242 固定 Project/Workspace 恢复会恢复未被单独关闭的 Public Join；`cfkanban-admin` 必须在容器恢复计划中醒目标出重新公开范围和 quota 风险。
27. 已确认：D-243 固定一个 Owner 发布的 preferred API origin、动态公开 instance discovery 与可信旧 origin 授权的自动 rebind。新 origin 自报同一 ID 不能获得自动信任；目标探测不发送 Credential，失败保留旧配置。Cookie/Passkey 的精确迁移边界由 D-244 补充。
28. 已确认：D-244 固定浏览器能力探测不等于 Passkey 存在探测，认证失败不得被解释为当前设备没有 credential。v0 的 RP ID 等于当前请求 hostname，expected origin 等于当次完整 HTTPS origin；切换 hostname 后由 Browser Launch 在新地址重新登记，不配置跨 hostname 共享。
29. 已确认：D-245 固定 canonical source 采用 monorepo 逻辑边界，但 v0 云端仍为一个 Worker + 一个 D1。stable Service deployment bundle 同时固定 Worker、预构建 Web assets 与 migrations；普通部署不创建 Pages/KV，也不要求部署者安装前端构建工具链。源码开发/CI 使用 repo-local Wrangler 不改变用户级 Tool Runtime 合同。
30. 已确认：D-246 要求源码提供锁文件约束下的根级验证/构建入口，Service deployment bundle 的 migration manifest 固定顺序、checksum、分类、重入属性和预期 schema artifacts；deploy Skill 以 ledger + 实际 schema 双重 readback 判断 migration，不把文件名或退出码当成完成事实。
31. 已确认：D-247 将持有 Cloudflare Token、执行远端写入的 GitHub Actions 部署 workflow 后置到下一阶段。v0 只有 `cfkanban-deploy` Agent-first 主部署路径；无凭据的 CI 验证 workflow 不属于第二套部署合同。
32. 已确认：D-253 将 cfKanban 自管持久数据统一到当前执行环境 home 下的 `.cfkanban/`，按 `instances/`、`skill-releases/`、`tool-runtime/` 分责；宿主 marketplace/plugin metadata、发现投影/cache 与 Cloudflare auth 继续由各自所有者管理。Windows 原生与 WSL2 仍是不同 home 下的独立边界，统一根不授权放宽 secret 权限或宽泛递归清理。
33. 已确认：D-254 要求三个分发 `SKILL.md` 直接呈现能力、切换边界、命令 catalog、任务到命令/API 对照、readback 与停止条件；详细文档维护 English/简体中文配对，不支持 locale 的 metadata 用英文。专用安全命令在内部注入 pending Credential；公开表面不显示内部阶段标签，`.mjs` 明确为 Node 原生 ESM JavaScript。
34. 已确认：D-255 将 Cloudflare 官方 `cloudflare`/`wrangler` Skills 定位为可选上游参考而非依赖或授权来源；安装不自动发生，通用 latest/repo-local/npx 建议不覆盖 stable release 合同。Service bundle 携带 portable Wrangler template/schema，D1 创建后生成私有 Frozen config，并在正式 deploy 前用同一 Wrangler/config dry run。

SB-01～SB-34 的主要产品体验与安全边界已经确认；合同修订 22 在此前确定性构建、migration readback 与唯一主部署路径之上，又固定统一 `.cfkanban/` 维护根、宿主发现投影边界、任务/命令导向的双语 Skill 表面、专用 secret 注入命令，以及 Cloudflare 官方 Skills 的可选参考边界和 portable Wrangler config/dry-run。此前 monorepo source、同 Worker Static Assets、无 Pages/KV、Passkey、preferred API origin、安全自动 rebind、容器/Public Join 恢复、quota 隔离与 Credential 恢复边界继续有效。Web/API wire 细节已由 2026-08-29 Frozen SPEC 固定。本文仍不构成安装、部署或发布授权；业务实现按独立 PLAN/Linear 执行。

## 12. 冻结范围与完成依据

本文已于 2026-08-28 冻结，依据如下：

1. 三个 Skill 的场景边界、共享能力与上层 Agent 分工已经确认。
2. canonical bootstrap、immutable release manifest、两个 bundle、SHA-256 文件指纹和来源连续性已经确认。
3. macOS、Windows、Linux、Windows 原生/WSL2、Node 与 Wrangler 环境所有权边界已经确认。
4. 首次部署、两类更新和 migration 的授权与失败报告边界已经确认；平台 restore point 只作安全证据，deploy Skill 不执行 D1 export/import/restore。
5. `.cfkanban/` 凭据/receipt/journal/scope 约定，以及 Invite、Project filter 和原子组合 Guidance 已经确认。
6. 最低验证矩阵已经定义；它约束后续实现验收，不要求在实现之前产生虚构的跨平台通过结果。
7. 合同修订 3 已固定 Browser Launch 的 Agent 侧职责、宿主无关打开方式和长期 Credential 隔离；合同修订 4 固定 5 分钟 launch、8 小时 Session、源 Credential 失效联动与 target scope。
8. 合同修订 5 已移除 Principal disable/enable/delete；离场、泄露与恢复只使用已有 Credential、Grant 和 Recovery Invite 能力。
9. 合同修订 6 已固定 Owner Credential 不经 Web 撤销或轮换；正常轮换由 `cfkanban-admin` 在本地替代 secret 已安全落盘后执行，全部丢失才进入 `cfkanban-deploy` 的部署外恢复。
10. 合同修订 7 已固定 Owner admin Session 可在显式选择后进入实例内任意 Project 数据面，同时保持默认 Overview 与普通 Project/Issue Session 的窄 scope。
11. 合同修订 8 已固定 Passkey 的 Agent 登记/恢复边界，以及 Public Join 的单 Project、显式 role、复用/创建本地身份与非批量调用合同；Team Join 已明确取消。
12. 合同修订 9 已固定 Public Join 不使用逐 Principal blacklist，并要求 `cfkanban-admin` 在开启前取得 Owner 显式提交的 Project Issue/Comment row limits 与风险确认。
13. 合同修订 10 已用三项 active quota 替代修订 9 的单调 row quota：soft delete/revoke 释放额度，restore/regrant 重新占用；同时要求 Skills 向 Owner 呈现生效的实例级请求门控。当时未冻结的配置载体已由合同修订 11 解决。
14. 合同修订 11 已固定原生 Workers Rate Limiting deployment config、首次零参数默认档位与 deploy Skill 修改边界；它不引入 Durable Object，也不把 Project quota 变成部署参数。
15. 合同修订 12 已固定三个 Skills 共用错误解释与 transport normalization：以机器字段决定提示/退避，不靠 message，也不掩盖 Cloudflare 在 Worker 外生成的失败。
16. 合同修订 13 已固定用户可以手工把同一 Credential 复制到多个受信执行环境；这不创建新身份或设备记录，且不改变自动搬运、浏览器粘贴与 secret 输出的禁止边界。
17. 合同修订 14 已固定 Owner display name 是 strict-zero 首次部署缺失时唯一询问的身份输入、首次加入采用一份合并计划和一次确认，以及新 Credential 先 pending、验证后 current 的恢复状态机。
18. 合同修订 15 已固定 `cfkanban-admin` 对 Public Join quota 的 Project 隔离、生效周期与 over-limit 解释：限制可以低于 usage，既有数据不被破坏，只阻止相应计数继续增长。
19. 合同修订 16 已固定容器恢复计划必须提示会重新公开的 Projects；Public Join Policy 跟随容器暂停/恢复，不由 Skill 创建隐藏的额外状态。
20. 合同修订 17 已固定动态 instance discovery、单一 preferred API origin 与可信旧 origin 授权的自动 rebind；域名控制面 reconcile、应用设置与本地 Credential 迁移保持分层，陌生 origin 仍不能凭相同 ID 获得 secret。
21. 合同修订 18 已固定 Passkey capability detection 不能充当 credential inventory，并明确 v0 按当前 hostname/origin 隔离 WebAuthn；新 hostname 由 Browser Launch 恢复并重新登记。
22. 合同修订 19 已固定源码 monorepo 与部署资源不是同一层级：Service deployment bundle 携带 Worker、预构建 Web assets 与 migrations，v0 实例仍只有一个 Worker 和一个 D1，不创建 Pages/KV；源码使用 repo-local Wrangler 只服务开发/CI。
23. 合同修订 20 已固定可重现根级构建与 migration manifest/ledger/schema readback，同时将持有 Cloudflare Token 的 GitHub Actions 部署路径后置；v0 仍由用户的 Agent 通过 `cfkanban-deploy` 完成计划、授权、执行与恢复。
24. 合同修订 21 已固定 cfKanban 自管持久数据统一到 `.cfkanban/` 的三个分责子目录，宿主发现投影继续留在宿主目录；三个 Skills 以可自描述命令 catalog 和任务→命令/API 的 English/简体中文文档呈现，并以专用命令内部注入 pending Credential。
25. 合同修订 22 已固定 Cloudflare 官方 Skills 只作可选事实参考，不能自动安装、替代 cfKanban 信任/授权或把通用 latest/repo-local 规则强加给 stable 部署；Service bundle 必须携带 portable Wrangler template/schema，并通过私有 Frozen config 与正式 deploy 前 dry run 证明可移植性。

本次冻结只固定上述公共 Agent 体验与安全边界，不固定尚未设计的具体 npm package 名、各宿主未来新增的投影机制、版本淘汰阈值或实现代码。冻结范围内的语义如需变化，必须通过显式新决策和可追踪修订；冻结本身不授权实现、安装、部署或发布。

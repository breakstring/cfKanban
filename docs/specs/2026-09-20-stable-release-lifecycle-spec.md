# 正式发行发现、版本展示与开发使用合同

- 状态：Frozen
- 日期：2026-09-20
- 最近修订：2026-10-02
- 执行任务：[CFK-425](https://cfkanban.dev/app/issues/CFK-425)；默认分支与开发规则修订：[CFK-526](https://cfkanban.dev/app/issues/CFK-526)
- 授权依据：用户确认普通用户入口应版本无关、默认最新正式发行；2026-09-30 进一步确认 main 仅承载正式内容、开发使用专门分支、普通安装不固定 tag；2026-10-02 授权区分文字更新的明确会话目标与宿主原生稳定更新，分离单次工件快照和长期更新来源，并调整规则和本地实现。不要求额外 worktree，不新增独立开发插件入口；本次不授权安装、提交、推送、部署或发行。
- 本增量覆盖 Bootstrap/Web 合同中的固定测试发行入口；其余信任、权限、凭据与部署恢复边界保持不变。

## 用户入口与发现

README、同实例双语 deploy-guide/join、bootstrap install 和 Skill 使用指南不绑定某次产品版本。首次安装及新部署默认发现最新正式发行；已有可信且兼容的技能可以复用，加入项目不隐含技能更新或实例升级。测试版、历史版与源码试验需要明确目标；Skill 更新可沿用用户直接指定或当前可信用户会话明确承接的准确发行目标，不从目录、分支、Issue 或仅曾提及 RC 推断测试选择。

canonical stable pointer 固定为 `https://github.com/breakstring/cfKanban/releases/latest/download/stable.json`。GitHub Latest 仅由正式发布推进，RC 不推进。该可变入口只用于只读发现；Agent 在准备计划时解析并固定准确版本、不可变 manifest URL/SHA-256、两个工件及兼容矩阵。后续安装和部署沿用同一快照，不在执行途中重新解析 Latest。不存在 stable 或校验失败时明确停止，不回退 main、RC 或本地 cache。

GitHub tag 等于发行版本（如 `1.0.0`），不额外添加 `v`。仓库默认分支 `main` 只承载已公开并校验的正式发行源码，兼作普通用户的 Skill 更新渠道，不另设 stable Git 分支。先识别 Agent 宿主的发现/安装能力，不默认使用 Codex：支持 Git marketplace/plugin 来源的宿主可跟随默认分支；使用个人或项目 Skill 目录的宿主从已验证完整 bundle 创建符合宿主布局的投影，保留共享 runtime。Codex 的具体示例是 `codex plugin marketplace add https://github.com/breakstring/cfKanban.git`，省略 `--ref`，再安装同一个 `cfkanban-agent-skills@cfkanban`，其他宿主无需执行这些命令。显式选择历史正式版或 RC 时，仍使用该已验证发行的准确 tag/bundle；不能让默认 main 代替显式目标。

`release discover` 使用独立 `selectionMode`：缺省 `latest_stable`，首次省略 `version` 发现最新正式版；后续可用准确正式 `version` 读取同一不可变快照，但仍返回 `selection_mode: latest_stable` 和 `marketplace.ref: null`。用户明确或本次会话明确承接的准确历史版、RC 或固定版本目标使用 `selectionMode: exact_version` 并要求 `version`，返回对应准确 tag；缺省模式不接受 RC。调用方沿用最初 `selection_mode`，不能把内部回填的工件版本当作用户选择固定来源。这个可选宿主提示不改变顶层 `release_version` 或 immutable 工件目标，目录型宿主使用已验证 bundle 即可。Git 来源安装前后须核对宿主 checkout 的 commit 与该准确发行 tag 的 commit；所有宿主均须核对实际安装的 Skills/共享 runtime 内容与已验证 bundle 的一致性，仅版本字符串相同不足以通过。默认分支暂落后 Latest、安装过程中漂移或宿主内容不符时，停止依赖该安装的操作并重新只读核对，不静默切换 tag、RC 或开发源码。

文字要求更新插件或技能时，目标优先级为用户本次明确指定、当前可信用户会话已明确承接的准确发行目标、最新正式版。例如刚完成某个准确 RC 的发布且本次更新是在承接其验收时可继续使用该 RC，说明所选版本和上下文依据，无需重复询问；仅存在可能关联而目标不清楚时询问一次。没有准确测试目标时默认最新正式版。宿主自带的插件/技能更新入口不读取这类会话意图，长期来源应保持正式默认分支或宿主支持的稳定渠道。

RC 或历史版投影可以在已授权安装内通过同一宿主入口临时选择准确目标；先记录旧来源与恢复步骤，安装后保留或恢复稳定长期来源，分别核对保存的来源与本次实际安装版本。恢复来源会同时替换安装副本或宿主无法分离两者时，明确标示准确版本安装仍固定来源，原生更新前须先切回稳定渠道；不得声称刷新固定 tag 会自动取得最新正式版。用户明确要求持续锁定版本时尊重该选择，并说明原生稳定更新的条件。不新增自动配置迁移、独立插件入口或直接修改宿主缓存的机制。

检查更新与执行更新分离；默认分支刷新仍需宿主实际安装/加载，不保证当前聊天自动热更新。已固定旧 tag 的用户可手动将已注册 marketplace 来源切换到默认分支，再刷新安装并读回；仅从新命令删去 `--ref` 不代表旧配置已清除。切换应检查旧来源/ref、安装范围及恢复方式，保留私有身份与部署记录；不新增自动迁移或并行开发插件。

## 安装、兼容与宿主

安装完整 Skill bundle，保留共享 `packages/skill-runtime` 和相对目录；不能仅复制一个 Skill 目录。宿主投影只是已验证 bundle 的副本。更新报告分别说明 canonical active receipt、宿主安装投影、当前任务加载状态；无法验证新任务加载时保留未验证说明。

首次安装、已安装兼容技能、固定旧 RC 检查更新、显式升级、历史版回退、旧实例兼容和源码开发均有明确路径。Skill update 与 Instance upgrade 独立；同一套兼容 Skill 可访问多个实例。来源连续性、秘密保存、digest 校验与所有已有授权边界不变。

正式渠道不要求 Skill 与 Service 的产品版本相等。兼容性须分别核对旧 Skill 访问新 Service、新 Skill 访问旧 Service，以及部署 Skill 读取发行清单/工件的能力；新功能只能用于服务端已支持的范围。未知发行格式仍须拒绝；本修订不声明已完成所有历史版本组合的测试，也不因渠道变化强制升级实例。

## 发行版本与运行时版本

新增 `release/version.json` 作为源码当前产品发行版本的单一声明；正式构建、plugin metadata 和对应 release config 必须一致。打包拒绝声明版本与构建版本不一致，避免只更换 zip 文件名得到新版本。

`/healthz`、`/.well-known/cfkanban-instance.json`、`/api/v1/meta` 增量返回 `release_version`，来自正在执行的 Worker 构建；第一方 Web 使用该值展示实际发行版本。旧实例无字段时不把旧 `service_version` 冒充产品发行版本。保留 `service_version` 的既有兼容语义和 API 路径；schema 仍由 migration manifest 决定。不为了产品发行编号更新 D1 或重写历史 migration。

2026-09-29 用户授权 [CFK-504](https://cfkanban.dev/app/issues/CFK-504)：OpenAPI `info.version` 改为从 `release/version.json` 自动生成，表示该文档对应的产品发行；`openapi` 仍只表示 OAS 格式版本。`contracts/service-api.json` 独立声明 API 的 `service_version`，供 Worker、初始化和生成器复用，OpenAPI 根扩展 `x-cfkanban-service-version` 回显该值。打包核对文档、产品与 API 声明一致；不能把产品版本写入 D1 的 API 兼容字段。

新的 immutable release manifest 使用顶层 `schema_version: 2` 与 `compatibility.bootstrap_schema: 2`；发行 pointer 保持 schema 1。支持此格式的部署技能同时读取历史 manifest 1。旧技能只支持 manifest 1，正常发现/校验入口必须提前拒绝新清单；单独提高旧实现未检查的 `bootstrap_schema` 无法形成兼容性门槛。用户先独立更新技能/宿主，再操作新 Service 工件；不能跳过校验或直接用旧低层命令部署。新 Service bundle 携带独立 API 声明，配置/初始化前校验声明、文档扩展与产品版本，升级时还校验计划中的 API 版本；只有历史格式可回退读取 `info.version`，不能将缺失声明的新产品文档当成旧 API 版本。

## 源码开发与环境

普通用户默认 stable。所有开发及规则/文档修改在 `feat/*`、`fix/*` 等专门分支进行；多个任务需要合并验收时可使用候选分支，但不要求长期 develop 分支。项目主目录 checkout 到开发分支即可，额外 worktree 只用于并行或隔离。开发周期使用下一个预发行版本；已发布 tag、manifest 与工件不可覆盖。

源码调试使用明确 checkout/commit 和 dirty 状态，不能声称 canonical release。日常调试直接读取该目录的 `SKILL.md` 并执行同目录脚本，保留共享 runtime 的相对布局；指引修改后重新读取，脚本修改后重新启动命令，无需为每次本地修改发 RC。自动触发、菜单与宿主加载验证则按该宿主支持的方式，临时将现有入口/投影切换到明确本地目录或准确 RC，记录原来源及恢复方式，刷新安装副本并在新聊天核对加载；完成后恢复原来源。Codex 沿用同一个 `cfkanban` marketplace，目录型宿主无需引入 marketplace。不新增独立开发插件或专用切换脚本，不能把 checkout 直接调用当作真实宿主加载证据。线上 RC 验收仍使用已发布、可校验工件，不从浮动工作树隐式部署。

本项目使用本地隔离开发环境和 `https://cfkanban.dev` 持久远端实例。用户于 2026-09-20 确认该实例定位为公开测试、演示和自用服务，可运行 RC，不作为稳定对外托管承诺；当前不另建项目自有的正式服务实例。GitHub stable 仍是用户自行部署的推荐发行，两者版本可以不同。

cfkanban.dev 内的开发管理和体验者数据是真实持久数据；该定位不授权自动清理、破坏性测试、放宽权限或跳过 migration/恢复核验。本地自动化与故障注入保持隔离，测试 Project 不能隔离部署与数据库迁移。操作目标通过准确实例和项目解析，Repo scope 只作推荐过滤；切换实例不需要切换 Skills。首页说明遵循 [首页实例说明设置](2026-09-20-homepage-settings-spec.md)。

仓库维护者使用项目级 [project-release](../../.agents/skills/project-release/SKILL.md) 组织准备、GitHub RC/正式发行和按授权升级默认实例；它位于 `.agents/skills/`，不加入对外 plugin 的 `skills/` 或发行工件白名单。默认实例是选择约定，不是部署授权；本机插件更新仍独立。

## 发行顺序与验证

1. 从当前正式 main 建立开发分支，修订合同、指南、预发行版本声明和实现，完成根 validate 与发行定向测试。
2. 从开发分支的准确干净 commit 构建确定性 RC 工件，发布不可变 tag 和六份资产；RC 不推进 main 或 GitHub Latest。
3. 按独立授权的 preflight/plan 将 RC 部署到 cfkanban.dev 并验收，保留资源、Owner、数据与兼容性。修复使用新的 RC；未验收的新业务改动不能混入正式候选。
4. 从通过验收的候选源码准备正式版本及说明，重新构建并校验正式工件，不重命名 RC zip 或改写已公开 RC。最终候选先包含目标 main；冲突解决或合并结果带来的改动须重新验证，再固定正式 commit/tag。
5. 发布正式 Release，匿名下载 pointer、manifest 与工件重新校验摘要，并验证 Latest 指向本次正式目标；成功后才按授权将 main 快进到该同一正式 commit。不能先合 main 再准备工件，也不 force push。main 或 Latest 被其他发行推进时先重新核对，不自动回退。
6. main 与 GitHub Latest 无法原子更新，短暂 main 落后只代表发行接续未完成。只有远端默认分支、正式 tag、manifest 和插件版本/内容一致后才报告渠道更新完成；中断时保留已发布工件并读回续做，不覆盖已公开内容。
7. 按独立授权同步实例或本机插件，并分别读回；线上任务只记录实际完成的验证。CFK-149 的真实跨任务宿主加载与回退不由脚本测试冒充。

后续通常先公开准确 RC，再按授权升级 cfkanban.dev 并验收；修复使用新的 RC 版本。从通过验收的候选源码准备正式版时重新构建、验证正式工件，不改名复用 RC 或就地改变已公开 RC 的属性。正式发行推进 stable 后，可在同一明确授权范围内将 cfkanban.dev 同步到正式版本；若实例已测试更高版本，须先核对降级及 schema 影响，不自动回退。源码、GitHub 发行、实例实际版本与本机插件分别读回，不能互相代替完成证据。

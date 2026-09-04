# cfKanban Agent-first 用户使用 Storyboard

- 文档状态：Draft
- Roadmap：R0
- 讨论目的：借助具体的人/Agent 使用场景逐段验收 cfKanban 能力，发现 Foundation 与 Agent Skills SPEC 尚未暴露的体验断点；场景不定义上层工作流
- 最近讨论：2026-08-29

## 1. 如何使用本文

这不是实现任务、API 清单或 Linear backlog，而是一组可以逐张讨论的产品验收故事卡。卡片里的林、陈及其 Agent 只是能力使用示例，不是 cfKanban 规定的调用编排。每张卡主要回答：产品提供什么能力、服务强制什么合同、Skill 解释什么信息、怎样返回结果与恢复信息，以及哪些安全协议或能力范围仍会改变体验。

讨论规则：

1. 按卡片顺序演练，但发现前置问题时允许回退。
2. 普通文案、字段默认值和低风险交互按“简单、Agent 友好”直接收敛。
3. 会改变部署方式、凭据安全、权限边界、身份恢复或主要使用习惯的选择，单独请用户确认。
4. 卡片确认只代表用户故事成立；公共合同仍回写 Foundation SPEC 或后续 API/Schema SPEC。
5. 本文全部走通后，再决定 Foundation SPEC 是否 Frozen；冻结本身仍不授权实现。
6. 人类触发语不是 cfKanban 命令格式；不同 Agent 可以用各自方式理解目标，但通过同一套 Skills/API 得到一致的能力参数、权限、不变量和错误合同。
7. 安装软件、本地长期写入、Cloudflare 登录、云端资源写入、secret、删除、恢复和付费能力必须遵守 Agent 宿主与对应 SPEC 的安全协议；普通看板动作是否需要额外确认由上层决定。
8. 日常 Issue 卡片展示服务能力和 cfKanban 推荐用法，但不替用户、Agent 宿主或 Repo 规则作最终工作决策。Skills 应提供默认建议、本地约定、安全组合范式和恢复方式；上层决定是否采纳、何时调用以及怎样组合。

## 2. 固定角色与主体关系

- **林**：提出目标、掌握 Cloudflare 账户和 Deployment Owner 身份，并在关键副作用前授权；不负责选择或拼装底层命令。
- **林的 Agent**：林直接使用的 Codex App/CLI、Claude Code、小龙虾、Workbuddy 或其他 Agent 工具。它可以在不同任务中执行部署、Owner 管理、工作协调或 Coding，但始终是同一种“用户的 Agent”，不是多个系统角色。
- **陈**：提出加入、查找或推进工作的目标，并批准其本地 Agent 的必要操作。
- **陈的 Agent**：陈直接使用的任意受支持 Agent 工具。它可以接受邀请、发现 Project、推进 Issue，也可以在获得相应身份和权限时执行管理之外的其他工作。
- **cfKanban Skills**：安装在用户 Agent 中的能力包，包含 portable `SKILL.md`、按需 references 和少量经过验证的 Node.js scripts。宿主安装/更新差异、环境探测、凭据、部署/API 调用、重试、journal 和结构化结果都由 Agent 按 Skill 指引完成；需要确定性的部分由 Skill 内置脚本承担。

“部署 Agent”“Coder Agent”“Coordinator Agent”只允许作为自然语言中的临时任务描述，不能成为产品角色、Principal kind、权限类型、审计身份或不同安装包。服务端只识别 Credential 推导出的 Principal 及其权限，不识别 Agent 当前处于哪一种工作模式。

默认情境：林把一句带可信 URL 的话交给林的 Agent，Agent 完成大部分工作，只在关键边界请求林参与。实例面向私人或小团队；所有 Workspace 共享同一 Cloudflare deployment，但 Project 分别授权。一个代码仓库可以同时关联多个 Project。

每张卡采用下面的能力链观察，而不是强制上层流程：

`上层目标与编排 → cfKanban Skill/API 能力 → 必要时调用内置 Node 脚本 → Service 强制合同 → 结构化结果与恢复信息`

只有部署、迁移、Credential、身份恢复、删除/恢复和付费等安全敏感能力，cfKanban Skill 才额外定义必要的 preflight、secret handling 与授权门槛。

## 3. 故事主线

| 阶段 | 卡片 | Agent 完成的结果 |
| --- | --- | --- |
| A. 首次部署 | SB-01～SB-03 | 服务上线，Owner 身份安全落地，能够重新连接实例 |
| B. 建立工作空间 | SB-04～SB-07 | Workspace、Project 和第一批 Issue 可以被 Agent 使用 |
| C. 邀请与身份 | SB-08～SB-11 | 参与者安全加入一个或多个 Project，身份不重复 |
| D. 日常 Issue 协作 | SB-12～SB-17 | Agent 能发现、分配、推进、阻塞、交接和完成工作 |
| E. 跨项目工作 | SB-18～SB-20 | 多 Project/Repo 场景保持低噪声，关系与增量同步可恢复 |
| F. 运维与恢复 | SB-21～SB-24 | Owner 能撤权、恢复身份、恢复误删并查看健康、配额与审计 |
| G. 人类 Web 参与 | SB-25～SB-33 | Agent 安全打开明确目标；人类查看、轻量参与、维护、再次登录、自助加入、切换语言或迁移实例入口 |

## 4. 故事卡

### SB-01：把一个可信部署 URL 交给 Agent

- **任务触发**：林对 Agent 说：`请仔细阅读 https://example.com/agent/install.md 的引导，部署一套 cfKanban。`
- **起点**：林有 Cloudflare 账户，并正在使用一个具备网络和本地工具能力的 Agent；本机可能没有 cfKanban Skills、Node.js 或 Wrangler。
- **Agent 行动**：林的 Agent 先只读获取 bootstrap document，把 stable pointer 解析为 immutable release manifest，校验官方 canonical HTTPS、不可覆盖的 manifest version/digest、逐工件允许来源与 SHA-256 文件指纹、Skill bundle 与 Service deployment bundle 兼容矩阵；识别当前 Agent host、OS 与已安装版本，生成 install/update plan。获得本地写入授权后，按 bootstrap 文档中对应宿主的规则安装或更新 Skills；如果 Node.js 已可用，可以调用 bundle 内经过验证的安装脚本处理路径和版本差异，否则先用宿主已有的安全文件能力完成最小 Skill 安装，再由 deploy Skill 处理 Node.js 前置条件。
- **授权边界**：读取 URL 和只读探测不需新增授权；安装/更新 Skill 前必须说明来源、版本、scope、目标路径和回滚方式并等待同意。此时还不能登录 Cloudflare 或创建任何云资源。
- **成功反馈**：Agent 明确报告“可信引导已验证、cfKanban Skills 可发现”，并写入不含 secret 的 publisher/origin/manifest/digests receipt，再展示下一阶段要检查的 Node/Wrangler/Cloudflare auth；不会要求林自己阅读安装文档或复制多段命令。
- **失败恢复**：来源不可信、不在 manifest 允许列表、文件指纹不符、旧版本清单疑似被原地改写、版本不兼容、宿主不受支持、Skill 有本地修改或安装验证失败时立即停止；不执行 pipe-to-shell，不覆盖本地修改，也不声称可以继续部署。更新或降级发现 publisher/origin 与现有 receipt 不连续时，必须展示旧值、新值和影响并重新取得授权。
- **已确认**：采用“官方 canonical HTTPS + immutable release manifest + 分别固定的 Skill/Service deployment bundles + 逐工件允许来源/SHA-256 文件指纹 + Skill 内宿主安装规则/脚本”；marketplace/plugin 可以作为便捷入口，但不能覆盖 canonical 来源。已安装副本和缓存不是版本真相，repo clone 只用于明确的源码试验，安装、更新和降级都不自动执行。该机制不防官方发布系统整体失陷；v0 不引入独立数字签名与密钥生命周期。

### SB-02：Agent 完成环境 preflight 与 Cloudflare 登录

- **任务触发**：林确认让 Agent 继续完成部署准备。
- **起点**：`cfkanban-deploy` 已可用，但 Node/Wrangler、Cloudflare auth、多账户选择、浏览器 callback 和用户级 Credential 目录权限可能不同。
- **Agent 行动**：林的 Agent 先只读探测 Node、版本管理器、包管理器、PATH、architecture，以及 PATH 或用户显式配置中已有的 Wrangler。已有 Node 落在本次 Skill release 声明的兼容范围内时直接复用，不要求升级或切换；缺失或不兼容时，根据当前 OS 和已存在工具向林解释少量可选安装路径，但不替林选择。已有 Wrangler 兼容时复用并记录绝对路径与版本；没有或不兼容时，在用户级 cfKanban Tool Runtime 中安装受控版本，而不是修改全局 Wrangler 或写入任意用户 Repo。随后处理 Cloudflare auth：本地交互优先 OAuth + keyring，远程/容器优先 device flow，headless 只接受明确提供的 API token。
- **授权边界**：Node 是用户拥有的通用开发环境。Agent 不得静默安装版本管理器、改变全局默认 Node、修改 PATH/shell profile 或覆盖现有版本；林选择具体方法并授权后，Agent 才可以执行相应安装步骤。创建或更新用户级 cfKanban Tool Runtime、发起浏览器/device login、保存 Cloudflare auth 也分别在动作前说明。Agent 不能替林完成 Cloudflare 账户授权，也不能静默选择多个账户中的一个。
- **成功反馈**：Agent 汇报实际复用的 Node、实际调用的 Wrangler 绝对路径与版本、Wrangler 来源是“用户现有”还是“cfKanban Tool Runtime”、目标 account/profile、认证存储方式和 strict-zero 可用性，并进入 deploy plan；不会在当前用户代码仓库安装 Wrangler，也不要求复制 Cloudflare token。
- **失败恢复**：Node 安装方式未选择、版本不兼容、unsupported OS、Credential 目录 ownership/ACL 不安全、device code 过期、权限不足或账户歧义都保留明确状态并停止；不擅自换安装器、改变用户默认 Node，或把 secret 写到其他位置绕过检查。
- **已确认**：Skill 可以引导 Node/Wrangler 准备，但不能替用户决定 Node 的版本管理习惯、安装路径或全局版本。Wrangler 优先复用用户系统中已存在且兼容的版本；否则使用独立于 Codex/Claude 和任意用户 Repo 的“用户级 cfKanban Tool Runtime”，由同一 OS 用户下的所有 Agent 宿主和 Repo 共用并锁定受控版本。林选定 Node 安装方式后，Agent 先展示精确计划；获得授权后可以执行并读回验证。新增 package source/version manager、提权、修改 PATH/shell profile、改变全局默认 Node 或卸载旧版本必须另行授权，GUI、UAC 或管理员交互由林亲自完成。Windows 原生与 WSL2 都支持但互不混用，每次执行只使用当前环境内的工具与本地状态。
- **已确认（Credential 存储）**：cfKanban Credential 默认保存在当前执行环境用户主目录下的 `~/.cfkanban/` 私有目录；Windows 使用当前用户 home 下的等价目录。它依赖 POSIX ownership/最小权限或 Windows 用户专属 ACL，是“权限受限的明文 secret”，不依赖 OS secure store，也不声称已加密。Agent 必须在云端部署、Owner Credential 创建或 Invite 消费前先验证目录可持久写入且权限有效；失败则不继续产生不可恢复副作用。目录不能位于 Repo、同步盘、临时目录、Skill 或 Agent 宿主目录。
- **已确认（跨环境复用）**：Credential 不绑定设备。用户可以自行把同一 Credential 复制到其他受信执行环境并分别保存到各自 `.cfkanban/`；API 不区分这些副本，也不创建新 Principal。Skill 不自动跨环境寻找或搬运 secret，但不阻止用户明确发起的复制。撤销或轮换该 Credential 会同时影响全部副本。
- **已确认**：SB-02 的环境与 Credential 准备口径已按 D-234 校正；不增加“添加设备”Invite/API，部署授权范围和新增副作用仍由 SB-03 约束。

### SB-03：Agent 展示部署计划、执行并交付 Owner 身份

- **任务触发**：林审阅 Agent 给出的资源计划后说“按这个计划部署”。
- **起点**：Cloudflare account 已确认，林的 Agent 已通过 deploy Skill 和 immutable release manifest 固定 Service deployment bundle，并生成 Worker、D1、bindings、migration、公开地址和 strict-zero 成本计划。
- **Agent 行动**：生成最终 deploy plan 前，当前指令若没有提供 Owner display name，林的 Agent 只询问这一项身份信息，不从 OS username、Git identity、hostname 或 Agent account 猜测；已有明确名称则直接使用。取得云端写入授权后，Agent 校验 deployment bundle source/version/digest，再调用 Skill 内置 Node 脚本，以 operation ID/journal 分阶段部署；每步先读回再创建或更新。服务就绪后，脚本在本地生成 Owner Credential，直接写入已通过 preflight 的 `.cfkanban/` 受限 Credential 文件，云端只保存 hash/prefix；随后由 Agent 验证 health、instance metadata 和 `/api/v1/me`。
- **授权边界**：一次部署授权绑定规范化 plan digest 与 operation ID，覆盖同一 Agent 任务内计划明确列出的 Worker/D1 创建、bindings、非破坏性 migration、服务部署、Owner bootstrap 和验证，不在每一步重复确认。新增付费服务、DNS/custom domain、删除/覆盖既有资源、破坏性 migration、未知资源接管、Cloudflare account 变化或其他 plan delta 必须停止并单独确认。Owner Credential 不进入 Agent 正常上下文。
- **成功反馈**：Agent 返回去敏 receipt：instance URL/ID、Cloudflare resource IDs、Owner Principal 与 credential fingerprint、Skill bundle/Service versions、验证结果、journal ID，以及“创建第一个 Workspace”的下一句建议。
- **失败恢复**：任一步失败后保留 journal；同一 Agent 任务内先读回真实云端状态，实际状态仍匹配已授权 plan 时可以 resume/repair。新任务、新会话无法可靠证明原授权，或 readback 出现 plan drift 时，先展示当前状态与剩余 delta 并重新确认。不得重复建 D1、重复 migration、创建第二 Owner或把部分成功说成全部完成。
- **已确认**：cfKanban Credential 使用用户 home 下的 `.cfkanban/` 受限文件；OS secure store 不是部署前置条件。采用“计划级一次授权”，而不是逐 Cloudflare 命令确认；计划外高风险副作用和无法证明仍处于原任务/原计划的恢复必须重新授权。
- **已确认（默认零参数部署画像）**：strict-zero profile 每个部署实例只创建一个 Worker 和一个 D1，先使用 `workers.dev` 公开地址，不启用 custom domain、KV、R2、Queue、DO、Vectorize 或 Workers AI。单一 Cloudflare account/profile 明确时直接采用；Agent 自动提议 instance label 和无冲突资源名，并生成 binding、instance/operation IDs、journal 等非秘密值，林只需在完整 plan 中一次接受，不先填写资源配置表或逐字段确认。若指令没有 Owner display name，Agent 只询问这一项必要身份信息；“零参数”指无需手工填写 Cloudflare 资源参数，不表示用猜测值创建身份。计划只声明 Owner Credential 的生成/保存策略，secret 在授权后的执行阶段才直接写入受限文件。只有 account 歧义，或 custom domain、付费能力、数据地域/合规、非 stable 版本、源码试验等偏差才询问。未知同名资源绝不接管或覆盖，默认改提新名称；坚持精确名称时退出默认流程。

### SB-03A：Agent 更新本地 cfKanban Skills

- **任务触发**：林说“检查并更新本地 cfKanban Skills”，或 Agent 在开始维护前建议只读检查更新。
- **起点**：本地已经安装一个可识别 source/version/digest 的 Skill bundle；云端可能存在零个或多个不同版本的 cfKanban 实例。
- **Agent 行动**：先从 canonical bootstrap 的 stable pointer 解析 immutable release manifest，分别报告“本地 Skill 当前版本、目标 Skill bundle 版本”和已知服务兼容范围；`latest` 只用于发现，实际计划固定 manifest 与 Skill bundle version/source/digest。Agent 对照本地 receipt 校验 publisher/origin 来源连续性；来源变化时停止并请求重新绑定，不能由 marketplace/plugin 覆盖。取得本地写入授权后，Agent 安装到新版本目录，验证允许来源、SHA-256 文件指纹和 discovery smoke，再原子切换 active bundle，并保留上一已知良好版本。
- **授权边界**：本地 Skill update 只授权展示的 Skill bundle/scripts 写入，不登录 Cloudflare、不执行 migration、不部署 Worker，也不改变任何实例。已安装副本有本地修改、来源不一致、权限范围扩大或需要安装新 runtime 时停止并展示 delta。
- **成功反馈**：分别报告旧/新 Skill version/digest、兼容的 service range、active path、验证结果和回退版本；不声称云端已经升级。
- **失败恢复**：下载、校验、安装或 discovery smoke 失败时保持/恢复上一 active bundle；不留下指向半安装目录的 active 状态，不覆盖本地修改。
- **已确认**：Skill update 与 Instance upgrade 是独立动作；前者采用 canonical immutable bundle、原子切换与上一版本回退。

### SB-03B：Agent 升级已部署的 cfKanban 实例

- **任务触发**：林说“检查这个 cfKanban 实例是否需要升级”或“把这个实例升级到稳定版本”。
- **起点**：Agent 通过本地 receipt/journal 与远端 `instance_id` marker 定位唯一实例，并能读回当前 Worker deployment/version、service version、schema version、bindings 和 D1 状态。
- **Agent 行动**：只读检查 canonical release manifest 和兼容矩阵，明确报告本地 Skill、当前 service/schema、目标 Service deployment bundle version/digest；若需要先更新 Skill，把它列为独立阶段。云端 upgrade plan 固定 deployment bundle，列出 Worker 变化、逐条 migration 及其兼容分类、D1 restore point、预计中断、验证、Worker rollback 能力和不能自动回退的部分。授权后按 journal 执行，每步读回并在最终切换后验证 health、instance metadata、schema 和 `/api/v1/me`。
- **授权边界**：只读检查不授权任何更新。“升级到最新版”不能直接执行，必须解析为一个精确 stable target。常规计划只包含 release 明确声明为向后兼容的 migration；破坏性 migration、无可验证 D1 restore point、新增/删除 binding 或资源、费用/DNS 变化另行确认。D1 Time Travel restore 会覆盖数据库，永不作为自动失败处理。
- **成功反馈**：去敏 upgrade receipt 同时记录 before/after service、Worker deployment/version、schema/migrations、D1 restore point、Skill compatibility、验证与剩余风险；Skill 版本和云端版本分别报告。
- **失败恢复**：失败后先停止写入并 readback。只有 plan 已声明且兼容矩阵证明旧 Worker 能读取当前 schema 时，才可按已授权策略回滚 Worker；否则报告 repair plan。D1 restore 必须展示会丢弃 restore point 之后写入的数据并重新取得破坏性授权，不能自动执行。
- **已确认**：Skill update 与 Instance upgrade 分属两个更新平面，检查或执行一边都不隐含另一边。云端常规升级必须有固定目标版本、兼容矩阵、可验证 D1 restore point 和计划级授权；数据库 restore 始终是独立破坏性动作。
- **迁移边界**：migration 按 release 顺序逐条执行。失败的单个 migration 会回滚，但此前已经成功的 migration 保持已应用，所以整次 upgrade 不是一个跨 migration 与 Worker 的大事务；Agent 必须在 journal 中逐项记录并依靠 readback 判断 resume 或 repair。

### SB-04：创建第一个 Workspace

- **任务触发**：林对自己的 Agent 说“创建一个名为个人产品的 Workspace”。
- **起点**：Owner 已连接，实例中还没有 Workspace。
- **上层调用示例**：林的 Agent 可以自行从目标中形成 display name 与稳定 key，再调用 Workspace 创建能力；如何解析话术、预览或确认由林的 Agent/宿主规则决定。
- **能力边界**：服务只接受 Owner Credential，并校验目标实例、显式 display name、显式唯一 key、幂等键和资源上限；它不解释林的话术，也不决定 Agent 是否应执行。
- **成功反馈**：返回 Workspace 摘要、稳定 key 和创建者；不会隐式创建 Project、Grant 或默认成员。
- **失败恢复**：key 冲突时返回结构化冲突和可用 key 候选；重复请求用 Idempotency-Key 返回原结果。上层调用方自行决定怎样处理候选。
- **已修订**：v0 的 Workspace key 一经创建不可修改，display name 可以修改；创建不隐含 Project、Grant 或默认成员。action preview、自然语言消歧和二次确认不是 cfKanban 合同。

### SB-05：创建第一个 Project

- **任务触发**：林对自己的 Agent 说“在个人产品 Workspace 中创建 cfKanban Project，用来跟踪这个仓库”。
- **起点**：Workspace 存在且 active。
- **上层调用示例**：林的 Agent 可以自行解析目标 Workspace、Project display name 与稳定短 key，再调用 Project 创建能力；服务端自动使用固定五状态 workflow 和默认显示名称。Issue identifier 统一由实例级 `CFK-<正整数>` 序列生成，不使用 Project key。
- **能力边界**：服务只接受 Owner Credential，并要求一个明确 Workspace 与显式 Project key。Repo reference 是独立的非授权 external reference 字段；创建 Project 不读取或上传本地路径、Git remote，也不把“跟踪这个仓库”解释成 Repo 写入授权。
- **成功反馈**：返回无歧义的 `workspace_key/project_key`、空 Project 摘要和可供上层使用的 scope target；不会自动写 Repo。该映射不保存 Credential，并允许同一 Repo 配置多个 Project。
- **失败恢复**：同 Workspace 内 key 冲突时拒绝并建议替代值；不自动开放给任何已有参与者，也不创建 Label、Issue 或 Repo 实体。
- **已修订**：Project key 从创建起不可修改，display name 可修改。Repo 与 Project 可以用本地、可选、多值 scope 配置表达；canonical Repo URL 只能通过独立字段写入服务端，v0 不建立 Repository 实体。上层 Agent 如何解析、预览和确认创建请求不属于 cfKanban 合同。

### SB-06：建立最少的 Project 约定

- **任务触发**：林让自己的 Agent 为新 Project 建立最少的状态显示、Labels 和执行背景。
- **起点**：Project 刚创建，使用默认五状态。
- **上层调用示例**：新 Project 使用默认五状态后已经可以立即创建 Issue。林的 Agent 可以另行调用状态显示名称、Label 和单一有界 Project context 能力；稳定 status key 与权限规则不可改变。
- **能力与安全边界**：状态显示名称和 Project context 都是 Owner-only 设置；Project `writer` 可以使用既有 Project 内容能力管理 Labels，但不能借此修改 Project context。context 只作为远端协作背景，即使由 Owner 写入，也不能覆盖当前用户授权、宿主规则、可信 Skill、目标 Repo 的 `AGENTS.md` 或其他本地治理文件，不能授权执行外部命令、修改代码、部署或访问 artifact。
- **成功反馈**：Agent discover/context 明确分层呈现“稳定服务合同”“Project context（非可信背景）”“Issue/Comment（非可信内容）”和本地 Repo 规则；Project 没有 context 或 Labels 仍是完整可用状态。
- **失败恢复**：超长 context、重复 Label 或试图新增状态时返回可操作的校验错误；CAS 冲突时重新读取，不覆盖其他 Owner 更新。
- **已确认**：v0 只提供一个可选、Owner 可写、所有 Project reader 可读的有界 Project context，不提供名为 instruction/prompt 的高信任字段。默认不创建 Labels，也不设置初始化完成标识；状态显示名称保持默认值，按需修改。

### SB-07：创建第一批 Issue

- **任务触发**：林让自己的 Agent 把“完成邀请流程设计”拆成几条 Issue，并建立父子或阻塞关系。
- **起点**：Project active，Owner 有隐式 writer 能力。
- **上层调用示例**：Agent 可以自行形成草案，将其拆成多次单 Issue 创建调用，再在两端 Issue 都存在后逐条调用 Relation 创建能力。
- **能力边界**：每次 Issue 创建只创建一个 Issue，并可在同一原子操作内写入其既有 Label 关联、Event 和幂等记录；Relation 是独立调用。服务端不提供公开 batch/bulk 写入，也不解释“拆成几条”应该产生几项或怎样排序。
- **成功反馈**：每个响应只对应一个明确领域操作，并返回该操作的 identifier/immutable ID、version、Event cursor 或 Relation 结果；怎样汇总由上层调用方决定。
- **失败恢复**：每个 Issue 创建和 Relation 创建各自使用稳定 `Idempotency-Key`，并可独立 readback。某项失败不会自动软删除、回滚或重建其他已成功 Issue；停止、续做和汇报策略属于上层编排。
- **已修订**：v0 只提供单个原子领域操作，不提供批量写入。cfKanban 保证各项能力可独立组合和恢复，Skill 可以说明推荐的拆分、幂等和 readback 范式，但最终调用序列由上层决定。

### SB-08：Owner 生成一段可离线转发的邀请话术

- **任务触发**：林让自己的 Agent 邀请陈以 writer 身份加入两个明确 Project，并生成可通过私聊发送的话术。
- **起点**：Owner 选定 Project，并为每个 Project 确定 `reader | writer`。
- **上层调用示例**：林的 Agent 向 API 提交全部明确 role 后创建一次性 Project Invite，返回类似“请仔细阅读 `<invite-url>` 以加入这些 Project”的短话术。
- **能力与安全边界**：API 不从缺失 role 或自然语言猜测默认值。Invite 是 Bearer capability，Skill 说明全部 Project/role、7 天时效和泄露风险；完整 URL 只返回给 Owner，不写日志/receipt，cfKanban 不负责通过外部渠道发送。
- **成功反馈**：同时显示 7 天到期时间、目标 Project/role 摘要和撤销命令；完整 URL 只在必要输出中出现，不写入日志。
- **失败恢复**：Owner 选到已删除 Project、无效 role 或过多 Project 时，邀请不创建。
- **已修订**：Invite 请求必须逐项显式携带 `reader | writer`，服务端不提供 role 默认值。`cfkanban-admin` 明确告诉上层：未指定 role 时推荐 `writer`，明确只读时使用 `reader`；更具体的用户、宿主或上层规则可以覆盖。preview、二次确认和目标消歧方式由上层决定；cfKanban 强制 Owner 权限、字段校验、Bearer 安全、一次性兑换和 7 天时效。

### SB-09：新参与者首次兑换邀请

- **任务触发**：陈把邀请话术交给自己的 Coding Agent，并要求它完成加入流程。
- **起点**：本机没有该 `instance_id` 的 Credential，邀请未过期且未兑换。
- **Agent 行动**：陈的 Agent GET 邀请说明，核对服务域名和目标授权，安装/更新可信 Skills；没有现有 Credential 时，先取得一个非秘密 display name，再由 Skill 内置 Node 脚本在本地生成并保存 Credential secret，发起幂等 POST 兑换。Agent 不读取并上传 OS username、Git user、hostname 或 Agent 账户名来静默命名身份。
- **授权边界**：读取邀请和只读探测无副作用。Agent 在一份简短的加入计划中分别列出可信 Skill 来源/版本及本地写入、将创建的长期 Principal/Credential、secret 保存位置和全部目标 Project/role；陈一次确认后可以连续完成计划内动作，不要求为三个紧密相连的阶段重复机械确认。来源、目标、role、保存位置或权限影响变化时必须重新展示计划；Agent 宿主或 OS 自身的权限提示仍照常生效，不能因持有 URL 或这次应用层确认而绕过。
- **成功反馈**：返回服务端保存的 principal ID、display name、Credential fingerprint、逐 Project 的 `created` Grant 结果和推荐 scope；同时给出“打开明确 Project 看板”和“为当前 Repo 添加明确 Project scope”两个可选下一步，但不自动打开页面或写 `.cfkanban-scope.json`。后续跨用户 Principal/assignee 摘要同时显示稳定 ID 与当前名称，明文 secret 不被服务端再次返回。
- **失败恢复**：本地生成的新 secret 先写入该实例的 pending 槽位，不占用 current 身份。服务端成功并经 `/me` 读回后才原子提升为 current；本地保存失败则不兑换，明确未提交的不可重试失败清理 pending。兑换响应丢失或提交结果不确定时保留同一 secret 与 Idempotency-Key 重试，不创建重复身份；不能生成第二个 secret 猜测恢复。
- **已确认**：v0 删除 `Principal.kind=human|agent`；服务端 Principal 保存稳定 immutable ID、非唯一 display name 和 version。principal ID 用于授权、assignee、审计和引用；display name 仅用于展示，允许重名，不能用于认证、去重或恢复。接收方已在当前指令给出名称时直接预览使用，否则 Agent 只询问一次名称。Skill 仍优先复用该实例唯一有效的现有 Credential，不主动为不同 Agent 宿主重复创建 Principal。
- **已确认（自助改名）**：不新增独立 profile Skill；默认日常入口 `cfkanban` 公开“查看我的身份”和“修改我的显示名称”两项能力，分别调用 `GET /api/v1/me` 与带 `expected_version` 的 `PATCH /api/v1/me`。改名只更新当前 Principal 的非空 display name 并写 Audit/Event，不改变 principal ID、Credential、Grants、assignment 或历史；v0 不允许 Owner 代改其他 Principal 的名称。
- **已确认（统一个人资料入口）**：Owner 与参与者都可以在已认证 Web 的轻量“我的资料”入口查看稳定 principal ID、当前 display name 与身份摘要，并修改自己的 display name；Web 与 Skill 调用同一 `/me` 合同。v0 的可编辑个人信息仅此一项，不增加头像、邮箱、简介或独立用户档案。
- **失败恢复**：version 冲突时重新读取 `/me`，不盲目覆盖。服务端改名成功但本地非秘密 metadata 更新失败时，以服务端为准；下次 `/me` 刷新本地显示信息，不回滚远端名称。

### SB-10：已有身份接受新的 Project 邀请

- **任务触发**：陈把新的 Project Invite 交给已有 cfKanban 身份的 Agent。
- **起点**：本地已有该 `instance_id` 的当前 Principal/Credential 槽位。
- **Agent 行动**：陈的 Agent 按 Skill 验证并直接复用该 Credential 对应的稳定 Principal，只新增或重新授予邀请中的 Project Grants；不会因为换了 Repo、Agent 宿主或新增 Project 再创建身份。
- **授权边界**：Credential secret 始终留在内置脚本内。`.cfkanban/` 可以保存多个上游实例，但每个执行环境对每个实例只维护一个当前本地 Principal；不提供日常身份切换器。
- **成功反馈**：逐 Project 返回 `created | regranted | already_has_access`；已有有效 role 不被邀请静默改变。
- **失败恢复**：Credential 明确被撤销时进入恢复/新身份分支，不能按名字接管旧身份；网络或服务错误导致状态 unknown 时停止，不能当作失效。若手工复制、导入或中断操作造成同一实例出现多个不同 Principal，视为本地冲突并停止，引导用户整理而不是猜测选择。同一 Principal 轮换中短暂存在的新旧 Credential 由脚本作为恢复状态处理，不算多个身份。
- **已确认**：本地状态根可以承载多个 cfKanban 上游实例，但每个 `instance_id` 正常只有一个当前 Principal/Credential 槽位；一个 Credential 不能跨实例复用。
- **已确认（地址变化）**：`instance_id` 作为稳定主键，trusted API origin 是可变安全 metadata。陌生新域名只声称同一 ID 时，Agent 在发送 Credential 前展示旧/新地址与权限影响并取得显式 rebind 授权；D-243 另允许由当前 trusted origin 发布更高版本迁移指示、再经无 Credential 目标探测验证后自动 rebind。只改变 Invite/展示域名而 API origin 未变时无需 rebind。

### SB-11：参与者第一次发现自己的工作范围

- **任务触发**：陈问 Agent：“我现在能访问哪些 Project，可以做什么？”
- **起点**：Credential 有效，至少一个 Grant active。
- **上层调用示例**：陈的 Agent 可以调用 discover/me，列出可见 Workspace、Project、role 和 allowed actions；如需固定常用范围，可另行调用本地 scope 文件的创建/合并 helper。
- **能力边界**：discover 是只读操作；Invite 兑换或发现 Project 不自动修改当前 Repo。scope helper 只接收显式 targets，拒绝覆盖不兼容配置，并返回变更摘要；何时调用、是否提交 Git 由上层 Agent/用户决定。
- **成功反馈**：不会显示无权 Project；能够清楚区分 reader 与 writer。
- **失败恢复**：Project 被暂停或 Grant 随后撤销时，旧列表不会被当作当前权限，下一次操作按 D1 当前事实拒绝并提示请求 Owner。
- **已修订**：Repo 根目录可使用单个 `.cfkanban-scope.json`，只保存 schema version 与 `instance_id + workspace_key + project_key` targets；不保存 secret、API origin、role 或权限快照。文件只是上层可选用的过滤输入，Invite/discover 不自动创建或修改它。

### SB-12：Agent 在十几个 Project 中找到相关工作

- **任务触发**：陈让自己的 Agent 在当前 Repo 中寻找下一项相关工作。
- **起点**：该 Principal 有多个 Workspace/Project Grants，仓库可能配置一个或多个推荐 Project scope。
- **上层调用示例**：上层 Agent 可以从显式请求或 Repo scope 取一个或多个 Project filters 调用候选列表，也可以明确省略过滤来做授权范围内的聚合读取。
- **能力边界**：API 允许省略 Project filters，但响应必须返回 resolved scope；Skill 在已知工作上下文中强烈推荐传入 filters，并在 scope 缺失、失效或发生扩大时暴露警告，不替上层 Agent 选择 Project 或任务。
- **成功反馈**：结果包含 workspace/project/identifier、priority、status、assignee 和 blocked 摘要，并说明 resolved scope。
- **失败恢复**：配置的 Project 已无权或不存在时返回明确的无效 target；helper 不把它静默改写成全部 Project，也不保存最近使用的 Project 作为隐式默认。上层可自行选择修复、缩小或改用聚合读取。
- **已修订**：scope 文件可以声明多个平级 targets，不保存隐式优先级或“最近使用”默认。`cfkanban` 推荐“本次显式 Project targets → Repo scope targets → 无过滤并提示扩大”的解析顺序；Project filters 仍可省略，上层可以覆盖推荐并决定怎样使用结果。多个上游实例分别查询并按实例分组，不宣称存在跨实例服务端全局排序。

### SB-13：明确把 Issue 分配给自己

- **任务触发**：陈要求自己的 Agent 开始某条 Issue，或已授权它从候选中选择并开始工作。
- **起点**：Agent 是该 Project 的 writer，持有刚读取的 Issue version。
- **Agent 行动（示例而非强制工作流）**：上层 Agent 可以先读取候选，再按自己的用户意图与宿主/Repo 规则调用 assign-to-me 和独立状态更新。服务端从 Credential 推导 assign-to-me 的 Principal，不让客户端提交自己的 ID；两种写入不是一个复合 `start` 命令。
- **能力边界**：cfKanban 不解释“找”“开始”“接手”等话术，也不决定是否调用。assignment 不是锁；服务只校验调用者 writer 权限、expected version 和目标 assignee 资格，其他 writer 的业务能力不受影响。
- **成功反馈**：分别返回 assignment/status 的新 version、assignee 摘要和 Event cursor，并明确记录实际完成了哪些动作。
- **失败恢复**：并发冲突返回当前 version 与刷新指引，不会改为操作另一条 Issue；两个原子调用之间失败时不回滚已成功动作，并可读取当前 assignee/status。是否刷新、换目标或续做由上层决定。
- **已修订**：候选读取、assign-to-me、一般 assignment 与状态转换都是独立能力；何时及怎样组合完全属于上层 Agent。cfKanban 不提供复合 `start`/assign-next，也不把自然语言触发策略写入 Skill 或服务合同。
- **已确认（Issue 引用）**：所有 Project 的 Issue 都使用实例级全局 `CFK-<正整数>` identifier；序号单调递增、允许空洞、删除后不复用。Project key 不再进入 Issue 编号；跨实例引用时由 `instance_id` 消歧。

### SB-14：读取刚好够用的执行上下文

- **任务触发**：陈的 Agent 在执行已选 Issue 前需要取得刚好够用的上下文。
- **起点**：Issue 可读，可能关联同 Workspace 的其他 Project。
- **Agent 行动**：请求 agent context；服务端按权限返回核心事实、正文/Project context 摘要、直接关系与最近 10 条可见评论，并携带 allowed actions、`truncated` sections 和续读信息。
- **授权边界**：读取已授权 Project context 不需额外确认；任何外部 artifact 仍遵循其自身权限，cfKanban assignment 不授权下载或执行它。
- **成功反馈**：identifier、workspace/project、version、status、priority、assignee、blocked 与 allowed actions 始终存在；无权关系端点完全不出现，大日志只以 external artifact reference 呈现。
- **失败恢复**：64 KiB 内无法容纳时先裁剪更旧评论和低相关关系，再对正文/Project context 提供有标记的 excerpt；每个被裁 section 返回遗漏计数与 continuation。scope 或权限变化导致 cursor 失效时返回 `CURSOR_SCOPE_MISMATCH`，陈的 Agent 按 Skill 从新快照恢复。
- **已确认**：默认最多返回最近 10 条可见评论，并按时间正序组织以便阅读；核心事实不会因历史过长消失。context 不自动下载或展开 external artifact。

### SB-15：报告进度、阻塞与依赖

- **任务触发**：陈的 Agent 在执行中发现必须等待另一个 Project 的 API Issue。
- **起点**：两个 Issue 位于同一 Workspace，调用者对两端都有 writer。
- **Agent 行动（示例而非强制工作流）**：上层 Agent 可以创建 `blocks` 关系、追加普通 Comment，或在没有具体 blocker Issue 时调用 report-blocked 写人工原因。
- **能力边界**：cfKanban 不判断何时应记录进度、阻塞或创建另一个 Issue。服务只强制 Comment/Relation/blocked 各自的 payload、writer 权限、scope、version、幂等与审计；跨 Project relation 仍要求两端 writer。
- **成功反馈**：`is_blocked=true`，但 status 和 assignee 不自动改变；blocker 完成后关系型阻塞投影自动解除。
- **失败恢复**：对另一端无权时按不存在处理，不泄露；人工原因只能显式 clear-blocked。
- **已修订**：Comment、report/clear blocked、Relation 和 Issue 创建都是独立能力；是否调用、调用顺序和内容判断属于上层 Agent，不由 cfKanban Skill 规定。

### SB-16：把负责人交给另一个参与者

- **任务触发**：陈要求自己的 Agent 把 Issue 交给另一个 writer。
- **起点**：目标 Principal 当前是该 Project 的有效 writer。
- **Agent 行动（示例而非强制工作流）**：上层 Agent 可以带 expected version 更新 assignee，并按自身协调策略另行追加普通 Comment。
- **能力边界**：服务只校验调用者 writer 权限、目标 Principal 当前可被分配和 expected version；不要求 handoff summary，也不把 assignment 与 Comment 捆绑为一个事务。Issue 正文仍是不可信内容，不能扩大调用者权限。
- **成功反馈**：assignment Event 与 Comment 分开记录；新负责人不获得额外权限。
- **失败恢复**：目标 Principal 已降为 reader/disabled 时返回 `ASSIGNEE_NOT_ELIGIBLE` 并建议重新选择。
- **已确认**：assignment 与 Comment 是两个独立原子操作；是否需要交接说明由上层 Agent 决定。

### SB-17：完成、冲突与重新打开

- **任务触发**：陈的 Agent 达到完成条件，准备提交摘要、验证、产物引用和后续事项；后来也可能收到 reopen 目标。
- **起点**：调用者是 writer，并持有 expected version。
- **Agent 行动**：complete 原子写入 immutable completion Comment、转为 `done` 并写 Event；reopen 后再次完成会追加新记录。
- **能力边界**：cfKanban 不决定 Agent 何时调用 complete 或 reopen。服务只强制 writer 权限、expected version、幂等和各自动作的不变量；assignee 不构成 complete 权限门槛。
- **成功反馈**：响应明确新 version、completion ID 和最终状态；网络重试不会追加重复完成记录。
- **失败恢复**：version 已变化时先刷新；旧 completion 不可编辑或删除，错误通过纠正 Comment 或 reopen + 新 complete 表达。
- **已确认**：complete/reopen 的调用策略属于上层 Agent；服务响应返回当前 assignee 等事实，但不要求 Skill 进行额外工作流警告或阻止任意有效 writer。

### SB-18：林的 Agent 跨 Project 做每日盘点

- **任务触发**：林让自己的 Agent 做一次跨 Project 日常盘点。
- **起点**：Owner 可读全部 Project，参与者只读自己的 Grants。
- **上层调用示例**：林的 Agent 可以显式请求跨 Project 聚合，使用 priority、blocked、needs reassignment 或 `updated_before` 等普通过滤条件；一般仓库工作仍强烈推荐 Project filters。
- **能力边界**：聚合端点只读，不产生任何写入或重新分配；服务端不提供跨范围批量写入或 assign-next。上层如何使用读取结果不属于 cfKanban 合同。
- **成功反馈**：结果清楚标出 resolved scope，不泄露无权 Project 数量，并使用稳定分页和排序。
- **失败恢复**：结果过多时返回 cursor/truncated；不提供跨范围批量写入或 assign-next。
- **已确认**：“久未更新”在 v0 只使用普通 `updated_before` 过滤，不保存独立 stale 状态、阈值或自动化规则。

### SB-19：同一 Repo 同时跟踪多个 Project

- **任务触发**：Agent 进入一个同时关联产品、基础设施和集成 Project 的 Repo。
- **起点**：目录配置声明多个推荐 Project，某条 Issue 还可能关联另一个 Project。
- **上层调用示例**：Agent 可以把 Repo scope 作为过滤输入，也可以自行缩小或扩大；结果始终输出 effective scope，不以 Credential 暗含默认 Workspace。
- **能力边界**：读取允许零个、一个或多个 Project filters；创建 Issue 等单项写入的 wire request 必须携带其所属的一个明确 Project。cfKanban 不规定上层如何解析或选择该目标。
- **成功反馈**：创建和写入始终使用 workspace-qualified 目标；不会因当前目录猜错 Project。
- **失败恢复**：写入请求缺少 Project 或目标不存在时返回结构化校验错误；cfKanban 不保存最近使用的 Project 作为隐式默认。
- **已确认**：单项写入的 API 合同始终包含一个明确 Project；上层 Agent 可以用任意符合自身规则的方式得出它。

### SB-20：从 Event cursor 恢复一次中断的 Agent 会话

- **任务触发**：Agent 会话中断后恢复，或林再次让自己的 Agent 继续追踪原 scope。
- **起点**：上层调用方可能保存了 opaque cursor 和对应规范化 scope；cursor 不暴露内部 sequence。
- **上层调用示例**：调用方可以按同一 scope 增量读取 Event，并按 Event ID 幂等应用。
- **能力边界**：cursor 不能被当作访问凭据或跨 Principal 复用。Skill 说明可选的本地保存格式、校验和重新快照能力，但不规定会话是否或何时持久化。
- **成功反馈**：正常容忍 sequence gap，并只返回仍有权读取的 Project 事件。
- **失败恢复**：Grant 或 Project filter 变化时返回 `CURSOR_SCOPE_MISMATCH`，并提供重新获取有界快照的恢复指引；是否执行由上层调用方决定。
- **已确认**：cursor 持久化时机和生命周期属于上层编排；cfKanban 只定义 opaque、scope-bound 的增量读取合同。

### SB-21：Owner 撤销或重新授予 Project 权限

- **任务触发**：林要求自己的 Agent 只撤销陈在某个 Project 的权限，或以后重新授予。
- **起点**：Principal 拥有多个 Project Grants。
- **上层调用示例**：林的 Agent 可以先读取目标 Principal/Project 与现有 Grant，再调用服务撤销；以后通过管理能力或新 Project Invite 重新授予同一 Grant 记录。
- **能力与安全边界**：撤权与重新授予都是 Owner-only 原子能力，请求使用稳定 principal/project ID，不能按 display name 猜测，也不能顺带撤销 Credential 或其他 Grants。Skill 说明影响，但不规定上层 preview/确认方式。
- **成功反馈**：其他 Project 不受影响；原 assignee 引用保留并投影 `needs_reassignment=true`。
- **失败恢复**：普通 Invite 遇到 active Grant 返回 `already_has_access`，不静默升降 role。
- **已确认**：不为确认界面增加专用协议。现有按 Project、assignee、needs reassignment 的读取能力足以让上层按需查询影响；Grant 变更响应只返回该 Grant 与权限投影变化。

### SB-22：参与者轮换或恢复丢失的 Credential

- **任务触发**：林让自己的 Agent 为明确的陈 Principal 发起轮换或全失恢复。
- **起点**：Owner 能明确识别目标 Principal；Recovery Invite 固定有效 1 小时。
- **Agent 行动**：林的 Agent 可以按精确 principal ID、display name 文本或 Project membership 查找候选，但必须展示完整 immutable principal ID、当前名称、状态、创建时间、Grant/assignee 摘要和 active Credential 非秘密摘要，并最终按 principal ID 选择。创建时固定 `rotation` 或 `full_recovery`；陈的 Agent 醒目说明将继承全部 Grants、assignment 与历史以及确切撤销范围。
- **授权边界**：创建 Recovery Invite 是不能被普通“加入 Project”目标隐含授权的高风险身份操作。林只需对“确切 Principal + 固定 mode + 撤销影响”做一次明确授权，不要求重复机械确认；服务端以显式字段强制该选择，Skill 负责在授权前完整呈现。display name 不能作为创建或恢复标识。
- **成功反馈**：新 Credential 建立后立即验证 whoami；Audit 清楚区分轮换和全失恢复。
- **失败恢复**：`rotation` 必须用该 Principal 的 active Credential 证明身份，成功后只撤销用于兑换的旧 Credential；`full_recovery` 以一小时 Bearer Invite 授权，成功后撤销该 Principal 的全部先前 Credential。模式不能在兑换现场互换；身份不匹配不消费邀请。Owner 无法确认身份映射时只能新建 Principal 并重新授权。
- **已确认**：Principal 搜索与安全摘要只辅助 Owner 选出稳定 ID；Recovery Invite 创建时必须固定不可互换的 mode。一次明确授权足够，安全性由服务端显式合同、短时一次性 Bearer 能力和审计保证，而不是靠多次相同确认。

### SB-23：恢复误删的 Issue、Project 或 Workspace

- **任务触发**：陈或林让相应 Agent 恢复一条误删 Issue，或恢复被错误暂停的 Project/Workspace。
- **起点**：资源只是软删除，尚未执行未来可能存在的受控 purge。
- **Agent 行动**：用户的 Agent 先只读定位 tombstone 与父容器状态；持有 writer 权限时可恢复 Project 内容，只有使用 Owner Credential 的林的 Agent 才能恢复 Project/Workspace 容器。
- **能力与安全边界**：恢复是单资源显式写能力；服务不提供批量恢复端点。恢复候选通过现有单资源读取或列表上的显式 `deleted=only` 视图获得，只对有恢复权限的调用者开放，不新增带隐含时间窗的“最近删除”端点。恢复容器只解除父容器暂停，不复活已单独删除内容或已撤销 Grants；上层若要恢复多个资源，只能自行组合多个原子调用。
- **成功反馈**：容器恢复后，未单独删除的子资源和未撤销 Grants 自动恢复；此前仍 enabled 的 Public Join Policy 也以同一 public ID、summary 与 limits 自动恢复，已由 Owner 单独关闭的 Policy 不会复活。completion Comment 仍不可删除。
- **失败恢复**：恢复视图只列出资源自身的 tombstone，不把父容器暂停下的全部子资源伪装成“已删除”。摘要返回稳定标识、删除者/时间、version、父级状态和结构化 `restorable` 原因；父容器仍暂停时，子资源恢复请求说明必须先恢复父级；key/identifier 不被复用。
- **已确认**：既支持已知稳定标识直接定位，也支持有权限的 Agent 分页列出 tombstone；默认按删除时间倒序，但不存在服务端定义的“最近”期限。查询只是恢复入口，是否恢复仍由上层决定。恢复 Project 或 Workspace 前，Agent 必须列出会随容器恢复而重新公开的 Project；用户确认恢复即同时接受这些仍 enabled 的 Public Join 恢复，不增加隐藏的第二个状态开关。

### SB-24：健康、配额与审计

- **任务触发**：林让自己的 Agent 检查服务健康、解释失败、查看近期安全事件或判断是否接近免费层限制。
- **起点**：系统运行在 Cloudflare 免费层，可能遇到应用错误、读写额度或平台故障。
- **Agent 行动**：林的 Agent 通过健康与管理读取能力查看 service/schema version、D1 reachability、近期安全事件和可理解的配额提示，并按机器 `category/source/recovery` 把平台错误转换成有界、可恢复的说明；不解析人类 message。
- **授权边界**：健康与审计读取本身不修改 cfKanban 或 Cloudflare 状态。Owner Credential 重新签发、删除、停机或其他 Cloudflare 控制面写入仍必须在只读 preflight 后按对应能力单独授权。
- **成功反馈**：可选 AI/Vectorize/Queues 关闭或超限不影响核心；Project quota、应用限流、D1 quota 和平台故障分别返回稳定分类、request ID、可重试性和恢复建议，不产生意外账单。
- **失败恢复**：Cloudflare 1027/edge 429/HTML 可能在 Worker 外产生。Skill/Web 以 `normalized_by=client` 保留真实来源并给出同类提示，不声称它是 cfKanban JSON；诊断结果区分已确认事实、未知状态和建议动作，不能触发无限快速重试。
- **合同修订**：D-213 已取消原 SB-24 的完整 D1 导出、导入、本地恢复演练和整库灾难恢复能力。Cloudflare 原生 Time Travel、控制台导出及其他数据运维由部署者直接在平台控制面管理，不包装为 cfKanban API、Skill 或用户故事。

### SB-25：Agent 为人类打开明确的 Project 或 Issue

- **任务触发**：陈说“把这个 Project 的看板打开给我看看”，或“打开 CFK-123”。
- **起点**：陈的 Agent 已在当前执行环境中持有该实例的有效 Credential；目标可能来自本次明确指令、Issue 引用或 Repo scope。
- **Agent 行动**：陈的 Agent 先解析明确实例与 target，再调用专用 `web launch`。命令先确认本地浏览器 opener 可用，创建 Browser Launch 后通过只存在于内存的 loopback redirect 直接打开，普通输出只保留安全 metadata；宿主提供等价的不落 transcript 安全通道时也可直接打开 IAB。浏览器首次 GET 只加载启动页，显式 POST 才兑换为 HttpOnly Session，成功后立即移除地址中的 launch code 并进入目标。
- **能力与安全边界**：Browser Launch 只把当前 Principal 已有权限安全带入浏览器，不授予新 Grant。长期 Credential 不进入 URL、浏览器脚本或存储，远端 launch URL/code 也不进入普通 stdout、日志、journal 或 receipt。服务不能依赖 Codex IAB 等专有接口；真正 headless 的手工 URL 交付只有在用户明确接受宿主留存风险后才使用标记的一次性输出。
- **成功反馈**：陈直接看到明确 Project 看板或 Issue；页面可见 scope 与身份摘要，不需要再与 Agent 往返询问当前状态，也不暴露 Credential。
- **失败恢复**：target 不明确时上层 Agent自行决定怎样消歧；launch 已用、过期、撤销、资源无权或不存在时，页面不泄露目标详情，只建议回到 Agent 重新创建或选择目标。
- **已确认**：launch 固定 5 分钟一次性；Session 固定 8 小时、不滑动续期且无 refresh，绑定源 Credential，并限制在 launch target 的 Project/admin scope。到期后只能让 Agent 重新创建 launch，不提供网页密码或 Credential 粘贴入口。

### SB-26：reader 查看，writer 进行轻量 Issue 参与

- **任务触发**：陈在网页中浏览看板；若拥有 writer 权限，也可能新建 Issue、改状态、追加 Comment、调整 assignee/label/relation 或完成工作。
- **起点**：浏览器已有有效 Session，Project Grant 可能是 `reader` 或 `writer`。
- **页面行动**：reader 只能读取；writer 只对单个资源执行服务已有的原子动作。看板固定五列且不保存手工 rank；writer 可以拖拽一张卡，落列后立即用 expected version 自动保存状态。拖入 `done` 自动改走 complete；没有 summary 时先弹出极简完成框，提交后落列，取消则回原列。菜单/selector 保留为非拖拽等价入口。
- **个人资料**：任何已认证 Principal 都可以从页面身份摘要进入“我的资料”，查看只读 principal ID 和当前 display name，并原子修改自己的非空 display name。它不受 Project `reader | writer` 差异影响，也不允许修改他人资料；Passkey 管理仍是独立的认证设置。
- **能力边界**：页面按服务端 `allowed_actions` 展示操作，但服务端仍逐请求校验真实权限、expected version、幂等与软删除规则。Web 不提供多选、批量编辑、隐藏批量循环或第二套业务写入。
- **成功反馈**：读取与 Agent API 看到相同事实；写入返回新 version/Event，并即时反映 assignee、blocked 与 completion 结果。
- **失败恢复**：拖拽期间卡片显示 saving，服务确认前不宣称成功；version 冲突、无权或失败时按 readback 回到服务端真实列。文本字段仍显式 Save，冲突时只在当前页面内存保留未提交输入、显示远端当前事实，不自动 merge/replay。Grant 被撤销或降级后，下一请求立即按新权限处理。
- **已确认**：reader/writer/Owner 不因使用 Web 获得新角色或新权限。v0 支持固定五列间的单卡拖拽和状态自动保存，但不保存手工 rank、不支持多卡/批量写入。正文与 Comment 使用 Markdown 源码编辑和安全渲染，不引入 WYSIWYG；所有 Issue、Comment、Label、Relation、blocked、assignment、complete/reopen 与 tombstone 恢复仍是逐项能力。

### SB-27：Owner 使用极简管理页做低频维护

- **任务触发**：林让自己的 Agent 打开管理页，随后直接查看健康、创建 Project Invite、调整 Grant，或维护 Workspace/Project。
- **起点**：林的 Agent 使用 Owner Credential 创建指向明确管理入口的 Browser Launch。
- **页面行动**：管理页保持四个简单分区：Overview、Workspaces/Projects、Access、Audit。它提供已有 Owner-only 原子能力：Workspace/Project 创建、改名、软删除/恢复；Invite 创建/撤销与话术复制；Principal/Grant/参与者 Credential 的非秘密摘要与管理；服务健康、版本、应用资源计数和 Audit 查看。Project Invite 可以在一个既有邀请领域操作中明确选择多个 Project 并逐项指定 role，但其他写入仍逐资源执行。
- **能力边界**：高风险动作仍展示明确目标与影响，但 Web 不新增 Owner transfer、第二管理员、直接 D1 操作、完整导出/导入、Time Travel restore、Cloudflare 资源删除、DNS 或计费设置。
- **成功反馈**：林能在一个简洁页面完成低频维护，并可按稳定 ID 核对跨用户身份；所有结果与 Agent/API readback 一致。
- **失败恢复**：Owner Session、源 Credential 失效或远端状态冲突时停止写入并提供结构化恢复提示；不能降级成在页面粘贴长期 Credential。Web 不持有 Cloudflare API 凭据，因此只显示应用可观察的健康与计数；Cloudflare account 的权威用量/配额检查仍由 `cfkanban-deploy` 执行。
- **已确认方向**：Owner 管理是 Web 必需表面，但保持应用层维护，不包装 Cloudflare 数据控制面。
- **已确认**：v0 移除 Principal disable/enable/delete。Owner 使用 Credential revoke、Project Grant revoke 与 Principal Recovery Invite 分别处理认证停止、Project 撤权和同一身份恢复；Principal、assignment 与历史稳定保留。
- **已确认（Owner Credential 防锁死）**：Web 可以撤销参与者 Credential，但只读显示 Owner Credential 摘要，不提供任何 Owner Credential revoke/rotation。Owner 正常轮换由 `cfkanban-admin` 引导：本地先安全保存替代 secret，再用 Bearer-only 原子 rotation 建立新凭据并撤销当前旧凭据，验证后切换本地槽位；全失恢复仍只走 `cfkanban-deploy`。因此当前 Session 来源和最后一个 Owner Credential 都不能从 Web 被撤销。

### SB-28：浏览器 Session 过期、撤销与攻击面收口

- **任务触发**：陈长时间未操作、源 Credential 被撤销、Grant 改变，或攻击者尝试重放 launch URL/跨站提交写请求。
- **起点**：浏览器可能仍开着旧页面或拥有旧 cookie。
- **服务行动**：每次请求重新校验 Session、源 Credential 和当前 Project 权限；launch 只能兑换一次且短时失效。cookie-auth 写请求同时验证同源与 CSRF token，Markdown/URL 作为不可信输入安全渲染。
- **安全边界**：Session 不能成为长期 Credential 的替代品，也不能因为页面曾经打开就缓存旧权限。日志、Referrer、第三方资源、Service Worker 和浏览器可读存储都不能泄露 launch code 或 secret。
- **成功反馈**：正常过期只要求用户回到 Agent 重新打开；退出只撤销当前 Web Session，不影响本地长期 Credential。
- **失败恢复**：重放、跨站请求或已撤销源 Credential 都被拒绝；页面清除无效 cookie，并保留不敏感的重新打开指引。
- **已确认**：固定 8 小时、源 Credential/Session 显式撤销联动和 target scope 已按 D-217/D-219 收敛。到期时页面清除已渲染远端数据，刷新/下一请求清除失效 cookie；未提交表单不自动重放，也不持久化到 Web Storage。

### SB-29：未认证访客第一次打开网站

- **任务触发**：周直接打开 canonical 项目站点或某个 cfKanban 部署实例，但尚未登录，也不一定理解 Agent-first 产品如何开始使用。
- **页面行动**：页面用很短的产品介绍说明“这是供用户的 Agent 使用的 Kanban”。视觉中心提供一段可复制话术，例如“请仔细阅读 `https://canonical.example/bootstrap` 的说明，帮我安装或更新 cfKanban Skills，并部署一个新实例”；页面只复制文字，不内嵌 shell 命令或执行远程脚本。
- **实例差异**：canonical 项目站点只承担产品介绍和可信部署入口；独立部署实例还显示非秘密 instance label、登录入口，以及 Owner 明确开启 Public Join 的 Project 卡片。两者使用同一 canonical bootstrap 信任根，但部署实例不能伪装成官方发行站点。
- **隐私边界**：未认证首页不枚举非公开 Workspace/Project、Principal、Issue 数量、健康细节或版本漏洞信息。没有公开 Project 时，访客不能从响应差异推断内部 Project。
- **成功反馈**：周可以一次复制完整且短小的话术交给自己的 Agent，不需要先理解 Node、Wrangler、Skill 或 Cloudflare 资源。
- **状态**：D-223 已确认公开首页和居中 Agent 话术方向；具体文案与视觉层级仍由 Draft Web UI SPEC 收敛。

### SB-30：既有参与者不再依赖 Agent 重复打开网页

- **任务触发**：陈此前已通过 Agent Browser Launch 进入过实例，现在直接访问首页，希望不用再次唤起 Agent，也不想复制长期 API Credential。
- **确认行动**：陈只能在一次由 Agent Browser Launch 建立的已认证 Session 内显式注册 Passkey。浏览器/OS authenticator 保存私钥，服务只保存与同一 Principal 绑定的 public key metadata；以后陈从首页完成 WebAuthn challenge 后获得新的固定 8 小时 Web Session。
- **页面判断**：页面可以判断浏览器是否提供 WebAuthn、平台认证器或 conditional mediation，但这些都不等于“当前设备已有本站 Passkey”。WebAuthn 可用时显示由陈主动点击的“使用 Passkey”；平台认证器探测为否时仍保留按钮，因为安全密钥、手机或 credential manager 可能可用。WebAuthn 不可用时直接突出 Agent Browser Launch。
- **能力边界**：Passkey 只认证 Web Principal，不是 API Credential、Project Grant 或 Owner role，不能被 Agent Bearer API 使用。Passkey Session 按当前 Principal 的实时权限工作：参与者先选择其当前有权 Project，Owner 先进入 Overview 并可显式选择任意 Project；页面不自动发起无 Project filter 的全量 Issue 查询。页面永远不提供粘贴、上传或持久化 `.cfkanban/` Credential 的登录框。
- **生命周期**：一个 Principal 可以登记多个 Passkey，便于多设备与更换设备；当前 Principal 可以列举并撤销自己的 Passkey，Owner 可以撤销参与者的 Passkey，所有登记、认证与撤销都写安全 Audit。Passkey 撤销会使由它签发且尚未到期的 Web Sessions 立即失效，但不撤销 API Credential 或 Project Grants。
- **失败与恢复**：只有陈主动发起并成功完成认证才能证明 Passkey 本次可用；取消、超时、无匹配 credential、认证器不可用或策略拒绝都只显示“Passkey 登录未完成”，不声称当前设备没有 Passkey。陈可以重试或让 Agent 创建 Browser Launch；不能按 display name 恢复身份。首次登记和补充登记都要求 Agent-launch Session，避免已经取得一个 Web 登录方法后静默扩散新的认证器。
- **设备与域名边界**：已认证页面列举的是“为你的 cfKanban 身份登记的 Passkeys”，不是当前设备清单。v0 主动令 RP ID 等于当前请求 hostname、expected origin 等于当次完整 HTTPS origin，不启用跨 hostname 共享；hostname 变化时陈通过 Agent Launch 在新地址重新登记。
- **候选比较**：长期“记住浏览器”cookie 会引入可重放 bearer secret 与 refresh rotation；Cloudflare Access/企业 IdP 会引入外部身份映射和额外部署配置。二者不作为 strict-zero 默认候选。
- **状态**：D-224/Q-228 已确认直登方向；D-244 已固定 capability/credential 区分与精确 hostname 边界，精确 wire schema 继续由 Draft API/Schema 收敛。

### SB-31：公开访客自助选择并加入 Project

- **任务触发**：林不想逐人创建离线 Invitation，或者希望公开若干 Project 供公司成员或外部访客自行选择体验。
- **Owner 行动**：林逐个 Project 开启或关闭 Public Join，并为公开卡片填写一段有界公开摘要。一个实例可以同时公开多个 Project，但不提供 Team Join Link，也不创建一次授予多个 Project 的公开入口。
- **访客行动**：访客在首页先选择一个公开 Project，再明确选择 `reader` 或 `writer`。未登录时页面生成一段只指向该 Project 与所选 role 的 Agent 话术；访客的 Agent 复用该实例已有 Principal/Credential，或按现有规则创建并安全保存新身份，然后执行一次原子 self-join。已经用 Passkey 登录的 Principal 可以在网页完成同一个单 Project 原子动作。
- **成功反馈**：Agent 路径返回 Project、实际 role、Principal/Credential fingerprint 与 resolved scope，并建议但不自动执行“打开看板”或“写入当前 Repo scope”；Passkey Web 路径成功后直接进入刚加入的 Project 看板。
- **能力边界**：Public Join 不是 7 天一次性 Invitation，不把长期 Credential 放进 URL，也不暴露未公开 Workspace/Project、内部 Project context、Issue 或成员。每次调用最多创建或恢复一条明确 Project Grant，不能批量加入；公开 Project 的 Grant 同样不自动过期。
- **公开 writer 风险**：访客可以自行选择 `writer`，因此 Owner 开启 Public Join 时必须看到并明确接受：未知互联网参与者可以修改、评论、移动、完成以及软删除该 Project 内容，并产生 D1 写入。系统不把公开 role 静默收窄为 `reader`。
- **幂等与已有权限**：无 Grant 时按所选 role 建立 Grant；已有同等或更高权限时返回当前访问且不重复建行；已有 `reader` 选择 `writer` 时可以按公开策略提升；已有 `writer` 选择 `reader` 不自动降权。
- **必填成本上限**：Owner 开启前必须显式设置该 Project 独立的 Issue、Comment 与 Principal 三项 active quota；页面可以建议 50/500/50，但不代替 Owner 提交。这三项只在本 Project 的 Public Join 开启期间生效，不与其他 Project 共享或互相影响；关闭后不再约束本 Project 的普通协作，也不撤销既有 Grants，重新开启时须显式重交。Owner 可以把限制调到低于当前 usage，系统保留现有数据，只阻止继续增加相应计数；随后可通过软删除/撤权降低 usage 或调高限制。Issue/Comment soft delete 与 Grant revoke 释放 slot，restore/regrant 重新占用并在无容量时原子失败。删除只释放 active quota，不声称清除了 D1 tombstone。
- **简单重入**：不建立逐 Principal blacklist。Project 仍公开时，被 Owner 撤销 Grant 的 Principal 可以再次加入并复用同一 Grant 行；要停止所有公开加入，Owner 关闭 Public Join。
- **频率门控**：首次部署自动提供单 Principal 120/60 秒、实例动态 API 300/60 秒、未认证敏感操作 30/60 秒的原生边缘门控。Owner 查看当前值、来源和近期 429 摘要；修改时让 Agent 使用 `cfkanban-deploy` 发布 Worker 配置，不触发 D1 migration。它只降低突发滥用，不能替代 D1 精确 quota。
- **状态**：D-225 原 Team/Public 拆分已否决；D-226/D-227/D-229～D-232/D-240～D-242 已确认单 Project Public Join、简单重入、Project 隔离且只在公开期间生效的三项 active quota、允许非破坏性 over-limit、容器恢复时恢复未关闭 Policy、透明限流、部署配置载体与初始档位。

### SB-32：人类切换 Web UI 语言

- **任务触发**：周第一次打开公开首页，或陈已经进入 Project 看板，希望界面使用自己更熟悉的语言。
- **页面行动**：公开首页、登录、Project 看板、Issue 详情、Owner 管理、错误与恢复提示等第一方 Web 公共文案至少提供 English 与简体中文，并在所有页面提供明确语言切换入口。
- **默认与持久化**：首次访问按浏览器首选语言选择简体中文或 English，无法识别时回退 English；用户显式选择后保存为非秘密浏览器偏好，不与 Principal、Credential、Grant 或 Web Session 绑定。
- **内容边界**：`backlog / todo / in_progress / done / canceled` 等稳定 key 永远是英文；Project 未设置显示名称覆盖时，五列默认显示名也保持英文。Workspace/Project 名称、Issue 标题与 Markdown、Comment、Label、Project context、状态显示名称覆盖等业务内容按原文展示，不自动翻译。
- **协议边界**：API/OpenAPI 的字段、枚举、机器错误 code/category/recovery 不随 UI 语言变化。Web 依据稳定机器字段选择本地化提示；Skill 输出继续由上层 Agent 的语言环境决定，cfKanban 不增加 Skill locale 合同。
- **失败恢复**：缺少某条翻译时只回退 English，不显示裸翻译 key、不改变领域数据，也不因为语言包失败阻止核心读写。
- **状态**：用户于 2026-08-29 明确要求最少支持 English/简体中文与自行切换；按 D-235 进入 Draft Web UI 合同。

### SB-33：Owner 发布新推荐域名，已有 Agent 安全迁移

- **任务触发**：林首次部署时使用 `workers.dev`，后来在 Cloudflare 控制台为同一 Worker 添加 Custom Domain，或在第三方系统中增加一个可以到达同一 Worker 的 HTTPS 域名，希望已有参与者今后优先使用新地址。
- **控制面行动**：域名绑定本身仍由 Cloudflare 或第三方控制面完成。林让 Agent 使用 `cfkanban-deploy` 只读列举 Cloudflare-native domains/routes，或明确提供第三方候选；Agent 对候选执行不携带 Credential、不跟随 redirect 的发现探测。候选确实返回同一 `instance_id` 后，林再让 `cfkanban-admin` 使用 Owner Bearer Credential 发布唯一 `preferred_api_origin`。这个应用设置不需要重新部署，也不会替 Owner 创建或删除域名。
- **服务行动**：实例在所有能到达该 Worker 的地址动态提供 `/.well-known/cfkanban-instance.json`，返回同一 `instance_id`、本次请求的 `observed_origin`、唯一 preferred origin、递增 `origin_version`、service version 与更新时间；响应不含 secret、alias 清单或 Cloudflare Token，并使用 `no-store`。认证 API 不用跨 origin redirect 搬运请求。
- **参与者 Agent 行动**：陈的 Agent 只从本地当前 trusted origin 低频读取发现文档。发现更高 `origin_version` 时，它先不带 Credential 探测 preferred origin，并要求目标的 instance ID、observed/preferred origin 与 version 全部匹配；验证成功后可以原子更新 `.cfkanban/` 中该实例的 trusted origin，无需再次打断陈。下一次 API 请求才把 Credential 发送到新地址。
- **失败与陌生入口**：目标探测失败、发生 redirect、version 未增加或回退、instance ID 不同、目标不能证明自己就是该 preferred origin 时，本地记录保持不变并给出恢复提示。Agent 若先从 Invite、第三方说明或任意陌生地址看到同一个 instance ID，不能靠该地址自报自动取得信任；只有仍可访问的旧 trusted origin 能给出上述迁移证据，否则必须由用户显式 rebind。
- **Web 边界**：任一仍绑定到 Worker 的域名都可以打开页面，但 Web Session cookie 不随 Agent Credential 配置迁移。WebAuthn 标准可以支持部分相关域名共享；cfKanban v0 主动按精确 hostname 隔离，因此换到任何新 hostname 都要通过 Agent Browser Launch 重新建立 Session并重新登记 Passkey。页面在当前地址不是 preferred origin 时只显示推荐地址提示，不自动重定向已认证页面。
- **切换顺序**：Owner 应先保持旧地址可用、发布 preferred origin、等待常用 Agent 迁移，最后再决定是否从外部控制面下线旧域名。若旧地址先失效，系统无法从它自动证明迁移，只能通过离线说明、Invite 或用户显式 rebind 恢复。
- **状态**：D-243 已确认单一 preferred origin、动态发现文档与可信旧 origin 驱动的自动 rebind；第三方域名不可自动枚举，陌生 origin 仍不得自证信任。

## 5. 逐卡讨论顺序

建议每次只确认一张重要卡，必要时把相邻的低风险细节一起收敛：

1. 先讨论 SB-01～SB-03，确定部署和本地身份体验。
2. 再讨论 SB-04～SB-07，验证从空实例到可用 Project。
3. 然后讨论 SB-08～SB-11，完整演练邀请和身份复用。
4. SB-12～SB-20 验证 Agent 日常协作与跨项目噪声控制。
5. 用 SB-21～SB-24 验证撤权、身份恢复、误删恢复、健康、配额和审计边界。
6. 用 SB-25～SB-28 验证 Browser Launch、Web 直接参与、Owner 维护和 Session 安全；SB-27 已按 Q-226/D-222 完成 Credential 防锁死与 Owner admin scope 收敛。
7. 用 SB-29～SB-33 从未认证与已认证人类视角验证公开首页、Passkey 直登、单 Project Public Join、双语界面和实例域名迁移；限流已固定为带默认档位的部署配置，不引入 Durable Object，下一步继续收敛 API/DDL 绝对边界。

每张卡确认后，将结论记录到[决策登记表](../project/decision-register.md)。领域、权限、并发与服务端 API 语义回写 [Foundation SPEC](../specs/2026-08-26-agent-native-kanban-foundation-spec.md)；bootstrap、宿主差异、Skills/Node scripts、跨平台部署与本地凭据体验回写 [Agent Skills & Bootstrap SPEC](../specs/2026-08-28-agent-skills-bootstrap-spec.md)；人类页面与浏览器会话回写 [Web UI SPEC](../specs/2026-08-29-web-ui-spec.md)。

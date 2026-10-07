# cfKanban 极简 Web UI SPEC

> 2026-10-01 增量：[Web 会话活动续期](2026-10-01-web-session-renewal-spec.md)（Frozen）覆盖固定八小时到期的旧表述；仅真实前台输入触发续期，后台读取不续期，草稿留在当前页面内存并由本人重新登录后显式恢复，不自动重放写入。

> 2026-10-01 增量：[活动历史倒序](2026-10-01-event-history-order-spec.md)（Frozen）增加显式历史浏览和 schema 16 时间索引，Web 最新在前；既有正序增量 feed 与 write cursor 保持兼容。

> 2026-10-01 增量：[Owner 实例通知](2026-10-01-instance-notifications-spec.md)（Frozen）仅覆盖 Owner 单向实例公告，定义本人接收偏好、逐条确认、Web/Agent 提醒与历史；其他通知、mention、外部投递及实时唤醒仍在范围外。

> 2026-09-29 增量：[Issue 结构化筛选与有界查询](2026-09-29-issue-query-filters-spec.md)（Frozen）定义优先级、标签、未分配筛选和 schema 13 查询索引，以及 Web / Agent 等价入口。

> 2026-09-20 增量：[正式发行生命周期](2026-09-20-stable-release-lifecycle-spec.md)（Frozen）规定版本无关用户入口、最新 stable 发现与执行时固定版本，以及独立的 `release_version` 展示；既有 API/schema 兼容字段保持不变。

> 2026-09-20 增量：[工作区与项目分级管理员](2026-09-20-scoped-administrators-spec.md)（Frozen，schema 9）覆盖仅 Owner 管理与工作区无继承权限的旧表述：两级支持多人，工作区管理员继承全部子项目，管理员计入项目人数并集配额；局部管理员不获得实例身份恢复、公开加入/限额配置或永久删除能力。新增 workspace Browser Launch 保持限定范围，既有窄 Session 不升级。

> 2026-09-20 增量：[Principal 唯一显示名称](2026-09-20-principal-names-spec.md)（Frozen）覆盖用户显示名非唯一旧合同，定义字符、规范化判重、精确指派候选与 schema 8 迁移；容器名称不受影响。


> 2026-09-19 增量：参与者 Agent Launch 会话的项目切换以 [D-272 Frozen 合同](2026-09-19-participant-project-switching-spec.md) 为准；旧固定 scope 会话和 Owner 明确 Project/Issue 会话不扩大。

> 2026-09-19 增量修订：[管理员用量与限额](2026-09-19-usage-statistics-spec.md) 定义 Owner 只读统计、schema 6 快照与可选云端采集；默认部署不增加统计凭据。

> 2026-09-19 增量修订：[Issue 私有附件](2026-09-19-issue-attachments-spec.md) 增加详情附件区域、单文件上传/下载、安全图片预览与删除恢复；取代下文“附件管理不包含”的范围。默认部署不启用 R2。视觉层级按 DESIGN.md 的当前修订。

> 当前容器身份合同由 [工作区与项目 UUID 寻址重构](2026-09-08-container-uuid-spec.md)（Frozen，2026-09-08）覆盖：Workspace/Project 取消 key，创建仅使用名称，服务端生成 UUID；REST/Web 使用 UUID，本地 scope 使用 schema 2。用户明确授权开发阶段不兼容旧 API、URL 和配置。本文保留的早期 key/DDL 描述不再是当前实现依据；其他身份、权限、并发和安全合同保持有效。

> 2026-09-08 增补：[工作区与项目归档及永久删除合同](2026-09-08-container-purge-spec.md) 已冻结。仅 Owner 可预览并永久删除已归档项目或已归档空工作区；该特例覆盖本文相应的 hard-delete 禁止及项目内历史永久保留表述，其余软删除、权限与恢复合同不变。

- 文档状态：Frozen
- 冻结日期：2026-08-29
- Roadmap：R1 / R3
- 关联 Storyboard：[用户使用 Storyboard](../product/user-storyboard.md)
- 关联 Foundation：[Agent-native Kanban Foundation SPEC](2026-08-26-agent-native-kanban-foundation-spec.md)
- 关联 Agent Skills：[Agent Skills & Bootstrap SPEC](2026-08-28-agent-skills-bootstrap-spec.md)
- 关联 API/Schema：[API & D1 Schema SPEC](2026-08-28-api-schema-spec.md)
- 事实快照：[Web 认证与公开加入能力快照](../research/web-auth-public-enrollment-snapshot-2026-08-29.md)
- 最近更新：2026-10-05（统一系统语言回退与默认状态显示，保留 CFK-567 服务端语言偏好）

## 1. 目的与边界

本文定义 cfKanban v0 极简第一方 Web UI 的产品、交互与安全边界。它回答四个问题：人为什么需要 Web、怎样从 Agent 安全进入浏览器、不同权限能做什么，以及怎样避免 Web 演变成第二套产品或重型前端。

本文不是视觉稿、组件库、实现计划或编码授权。具体 HTTP 字段与 D1 DDL 仍由 API/Schema SPEC 冻结；视觉实现开始前还需要独立确认或实现授权。

## 2. 已确认方向

- Agent-first 不等于 Agent-only。用户的 Agent 仍是主要调用载体，但 v0 必须提供同一部署实例托管的极简第一方 Web UI。
- Web 面向三类低频、直接任务：查看 Project Kanban、参与常用 Issue 操作、执行 Owner 简单维护。
- Web 不建立新的 Principal kind、Project role 或授权体系。`reader`、`writer` 与 Deployment Owner 的权限和 API 完全一致。
- Web 不直接访问 D1，不复制领域规则；所有读取和写入都经过同一 Worker REST 服务、权限、version/CAS、幂等与 Audit/Event 合同。
- 浏览器不读取 `~/.cfkanban/`，不要求用户粘贴长期 Credential，也不把长期 Credential 放入 URL、页面脚本、localStorage 或 sessionStorage。
- 已认证 Agent 为明确 target 创建短期一次性 Browser Launch URL；浏览器通过显式 POST 兑换 HttpOnly Session。
- 首次 Agent Launch 后可以显式登记 Passkey；Passkey 是 v0 唯一不依赖 Agent 的直接 Web 登录方法，且永远不接受长期 API Credential 粘贴或上传。
- Owner 可以逐个 Project 开启 Public Join。未认证访客可以从多个公开 Project 中选择一个，再明确选择 `reader` 或 `writer`；每次加入只产生一个 Project Grant，不提供 Team Join 或多 Project 公开授权。
- Codex App 的应用内浏览器（IAB）只是一个使用示例。Skill 默认通过专用命令和纯内存 loopback relay 直接打开系统浏览器，不把远端 launch URL/code 写进普通工具输出；IAB/指定浏览器按 Bootstrap SPEC 修订 31（D-270）使用 `host_browser`：宿主只接收本机一次性、60 秒有效的 loopback handoff，远端 launch URL/code 不进入 transcript/log；本机入口不得向用户复述或另行持久化。headless 的一次性 URL 输出必须由用户明确接受宿主留存风险，并标记为不得复述或保存的单次 capability。服务端仍返回同一 URL 且不依赖任何宿主专有协议。
- v0 不提供公开 batch/bulk 写入；Web 的拖拽一次只移动一张卡，不能通过多选、拖拽多卡或隐藏循环制造批量写接口。
- 公开首页与认证后 Web UI 公共文案至少支持 English 与简体中文，并允许用户随时切换；这不引入业务内容自动翻译或 Skill/API locale。
- 同一 Worker 可以通过多个有效域名访问，但实例只发布一个 preferred API/Web origin。页面不替 Cloudflare 管理域名，也不把跨域 Session/Passkey 迁移伪装成普通导航。
- Web 客户端技术栈保持 Vue 3 + TypeScript + Vite，已登录页面统一采用 Nuxt UI 组件，不引入 Nuxt SSR。2026-10-01 用户授权 CFK-528 实施：视觉遵循仓库根目录 `DESIGN.md` 的 Nuxt UI Kanban workbench 基线；旧视觉规则与组件框架冲突时，以简洁、高效的业务操作及框架约定为主，安全、权限、并发和无障碍合同继续有效。保留同 Worker Static Assets 的部署拓扑，使用系统字体与本地打包图标，不增加运行时第三方字体或图标请求。
- 本轮 UI 改造覆盖全部已登录页面：看板、事项详情/新建、个人资料、项目选择、工作列表、活动、标签、已删除事项、局部管理与全部 Owner 管理页面。公开首页和文档站不改视觉布局。各页面保留已有业务能力与权限入口。

## 3. 产品表面

### 3.0 未认证首页

2026-09-20 用户授权增补：介绍与部署入口下方提供简洁的产品介绍视频，随 Web locale 选择英文或简体中文版。视频由同一 Service bundle 的静态资源承载，使用内容指纹缓存；仅展示简短标题、封面与原生播放控件，不添加时长、演示说明或直接打开链接，默认不自动播放、不预加载视频，并在语言切换时停止旧版播放。中英文 README 分别使用对应视频的 GitHub 附件 URL，独立成段以生成页内播放器；不跳转到官网或 MP4 文件页，也不展示时长、分辨率或无声说明。

2026-09-21 用户选定布局增补：首页按四个滚动停靠区组织，依次为页头与介绍/部署指导、Agent first/免费额度/分级权限三栏亮点、介绍视频、公开项目加入与页脚。首屏部署说明精简为环境准备短句，费用与权限说明放入亮点区，均支持中英文。采用浏览器原生轻度吸附；分区按内容紧凑排列并限制空白，允许下一区域出现在当前视口，不强制满屏。页头吸顶且吸附位置避开页头，页脚在最后区域自然呈现。内容超出时正常延伸，不截断项目列表、不接管滚轮/触摸/键盘事件。减少动态效果偏好下关闭吸附，离开首页后不影响认证页面的滚动。复制失败的手动恢复入口仍靠近对应操作。

2026-10-01 用户授权 CFK-534：首页沿用暖色画布，body、吸顶页头及页脚的背景连续覆盖整个视口，不能被认证 UI 框架的全局白底或主题覆盖。页头/页脚与正文使用同一现有最大宽度和响应式边距，页脚只保留一条外边界，品牌/链接/版本与实例信息正常对齐及换行；窄屏链接至少 44px 高。仅修正页头、页脚及必要首页样式隔离，不改变 hero、亮点、视频、加入流程和滚动停靠规则。

任何人直接打开实例根地址时先看到一个极简公开首页，而不是 Credential 输入框或空白错误页。首页说明 cfKanban 是 Agent-first Kanban、当前地址是一个独立部署实例，并在视觉中心提供一段可以直接复制给 Agent 的短话术；话术指向同实例、同语言的专用 `deploy-guide.md`，由该指南逐步说明 Skill 安装、环境前置、计划/授权、Cloudflare 部署和读回，并继续把具体发行真相交给项目声明的 canonical HTTPS pointer 与 immutable manifest。首页不把通用 README 当作部署指南，也不内嵌可执行 shell、远程脚本或 secret。

`cfkanban.dev` 是项目长期使用的公开测试、演示和自用实例，可运行 RC；真实数据继续受既有保护合同约束，用户部署入口仍默认发现 stable。Owner 可配置双语纯文本首页实例说明；未配置时的语言和域名回退、Owner 设置界面及持久化遵循 [首页实例说明设置](2026-09-20-homepage-settings-spec.md) Frozen 增量合同。

首页可以显示 Owner 明确开启 Public Join 的多个 Project 卡片，每张只包含 Project 显示名称、有界公开摘要与 `reader | writer` 选择，不得枚举未公开 Workspace/Project、内部 context、成员、Issue 数量或其他实例事实。canonical 项目站点可以复用产品介绍和部署话术，但没有某个部署实例的登录状态或 Public Join。

若当前请求 origin 与实例发布的 preferred origin 不同，未认证首页可以显示一个清楚标注的“推荐地址”链接；页面仍可在当前有效 alias 上工作，不把这个差异显示成实例错误。它不得自动携带 URL 中的 capability、长期 Credential 或已有 cookie 跳转到新 origin。

首页标题按 English/简体中文分别固定两条有意换行的短句，并通过 locale-specific 响应式字号保证每一条在 320px 窄屏内不再次断行或造成横向溢出。页面以一条克制分隔线和简短页脚收尾；页脚提供品牌短句、文档、源码、Service 版本与缩短的 Instance ID。2026-10-05 用户授权 CFK-618：文档与 GitHub 文字链接前增加本地装饰图标，移除公开页脚的 API 合同入口，保留 API 和 OpenAPI 端点；图标不重复读出链接名称，窄屏继续保持换行与 44px 点击高度。公开文档的四栏目导航、双语内容、旧指南兼容和静态打包遵循[站内双语文档中心](2026-09-29-documentation-center-spec.md)，首页不扩张为站点地图或营销面板。

### 3.1 Project Kanban

Project 是 Web 的默认工作范围。看板固定展示五列：`backlog`、`todo`、`in_progress`、`done`、`canceled`，列标题使用 Project 的显示名称覆盖，但状态 key、顺序与 terminal 语义不可改变。

卡片保持有界，只显示：`CFK-<number>`、标题、priority、assignee、labels 摘要、needs-reassignment 标记和 version 对应的当前状态。v0 不保存手工 rank，因此列内使用公开稳定排序。

v0 支持 writer 在五列之间拖拽单张卡片。落到新列就是一次明确的状态写意图，前端立即使用该卡当前 `expected_version` 保存；卡片在请求期间显示 `saving`，但只有服务端确认后才算成功。失败、无权或 `VERSION_CONFLICT` 时读取服务端当前事实并把卡片放回真实列，不静默覆盖，也不改变列内 rank。

拖入 `done` 时 UI 自动路由到原子 complete 合同，不能调用普通 status PATCH 绕过完成记录。2026-09-20 用户授权修订：完成说明可选。详情操作优化修订：详情页收敛为一个“完成事项”入口，点击或从详情状态选择 done 时打开同一个选填说明弹窗，确认以一次 complete 完成，取消不改变状态；不再并列“填写完成说明”。看板拖拽/状态选择仍直接 complete，看板小卡片移除独立完成说明入口，需要说明时进入详情页。空摘要的历史记录显示“已完成”，不生成虚构说明；完成后补充信息使用普通 Comment，不修改不可变记录。拖入其他列使用普通单 Issue CAS 状态更新；从 terminal 列拖出按既有 reopen/status 合同执行。卡片菜单和详情页 status selector 保留为键盘、触屏和辅助技术的等价操作入口。

### 3.2 Issue 详情与常用参与

- `reader`：查看 Project、看板、Issue 详情、可见 Comments、Labels、Relations、completion history 和当前 allowed actions。
- `writer`：在 reader 基础上创建/编辑/软删除/恢复单个 Issue，修改 priority/status/assignee，追加或软删除/恢复普通 Comment，管理单个 Label/Relation，report/clear blocked，complete/reopen。
- Deployment Owner：在 writer 数据面能力之外，进入 Owner 管理页。

UI 只呈现服务端返回的 allowed actions，不靠缓存角色猜测权限。每次写入仍以服务端当前授权和 expected version 为准；冲突时刷新当前事实并让用户重新判断，不静默覆盖。

SB-26 的 v0 交互进一步固定为：

- Project header 展示 Workspace/Project；已登录页面右上角只保留独立的语言切换与账户菜单触发器。当前名称、角色摘要收进账户菜单，并与「工作清单」「管理中心」（当前权限与 Session scope 允许时）、「个人设置」「退出登录」统一组织。桌面与小屏使用同一菜单，Session 到期说明与推荐访问地址统一置于应用页脚，不另设头部 Session 信息行或独立退出按钮；菜单具备键盘、触屏和可见焦点，关闭后焦点返回触发器。reader 页面仍醒目标记“只读”，不渲染无效写按钮。
- 账户菜单中的“个人设置”打开当前 Principal 的资料页。所有已认证 Principal，不论 Owner、reader 或 writer，都可以查看只读 principal ID、当前 display name、主题偏好与身份摘要，并通过同一 `PATCH /api/v1/me` + `expected_version` 合同修改自己的 display name 或主题；不增加头像、邮箱、简介或他人资料编辑。名称继续满足唯一名称增量合同。Passkey 列举/撤销属于认证设置，不与资料修改合并成隐藏复合写入。
- Board 卡片点击进入同页 Issue 详情；writer 可以从 Board 创建单个 Issue，卡片 priority 与 assignee 支持独立快捷修改，负责人选择包含未分配及当前项目有资格的人员；候选按需分页，同一看板共享读取结果，不逐卡重复请求。只读者仍仅看到负责人摘要，历史负责人失去资格时保留显示及需重新指派提示。labels、relations 等编辑集中在详情。
- 拖拽落列采用状态自动保存；Issue title/body 等文本编辑仍使用普通文本框/textarea 和显式 Save，不做后台 autosave，避免输入过程持续写 D1。正文与 Comment 以 Markdown 源码编辑，并在详情、评论流和可选预览中安全渲染；不引入 WYSIWYG 富文本编辑器。
- 每次保存只提交一个资源的显式改动，并等待服务端成功后更新页面。`VERSION_CONFLICT` 保留尚未提交的当前页草稿，展示远端新 version 与刷新/复制草稿选项，不做自动 merge 或自动重放。
- 普通 Comment 只有追加、软删除和恢复，没有编辑；completion Comment 只读。评论输入使用普通 Markdown textarea，不做 WYSIWYG。
- Issue soft delete 只需一次带 identifier/title 的明确确认，因为它可恢复；「项目设置 → 已删除事项」使用显式 `deleted=only` 查询定位单个 tombstone 并逐项恢复，不提供多选或批量恢复。
- Project/Workspace 恢复确认必须列出会随容器恢复而重新公开的 Public Join Projects，并显示其公开 role 选择与三项 quota 摘要。确认恢复后这些仍 enabled 的 Policy 自动恢复；已单独关闭的 Policy 保持关闭，UI 不增加“恢复但保持暂时隐藏”的第二套状态。
- Label 与 Relation 都是单项操作。跨 Project Relation 的目标选择必须同时显示 `workspace/project + CFK identifier + title`，并继续受同 Workspace/两端权限合同约束。
- report/clear blocked、assign/unassign、complete/reopen 都是各自独立的显式动作。UI 可以相邻展示，但不能把它们捆绑成隐藏复合写入或失败后自动补偿。
- 任何写入按钮或拖拽保存，在请求进行中都防止同资源重复提交；超时后先 readback，不把“请求已发送”显示为成功。

### 3.3 Owner 简单维护

项目名称同行用可聚焦的紧凑图标展示 Public Join 开启、关闭或未知；悬停及键盘聚焦显示双语准确说明，图形与可访问名称共同区分状态，公开加入设置入口与权限保持原合同（CFK-625）。

Owner 管理面只承载已有管理能力：

- Workspace/Project 的创建、改名、软删除与恢复；
- Project workflow display name 与有界 Project context；
- 创建、查看状态和撤销未兑换 Invite，复制可离线发送的话术；
- 按稳定 principal ID 查看 Principal、Project Grants 与 Credential 非秘密摘要，变更/撤销 Grant，撤销参与者 Credential，发起固定 mode 的 Principal Recovery Invite；
- 查看服务健康、schema/service version、应用可观察的资源计数和近期 Audit。

v0 已按 D-219 移除 Principal disable/enable/delete。Owner 通过 Credential revoke 停止认证、通过 Project Grant revoke 停止具体 Project 权限、通过 Principal Recovery Invite 恢复同一身份；Web 不显示全局停用身份按钮。

按[Owner 设备网页与身份切换增量](2026-09-28-owner-device-web-identity-switch-spec.md)，Owner admin Web 在 Access 提供设备列表、非秘密配对预览、明确批准和专用撤销；不要求 Passkey 二次确认。Cookie 写入校验同源与 CSRF，服务端原子保护当前 Session 来源及最后一份有效 Owner API Credential。网页不接触长期 secret，批准后仍需新设备验证并本地提升。Owner 可按准确 Credential ID 修改有效设备显示名称（包括当前和历史未命名设备），保留凭据、权限及会话；改名沿用 Owner version/CAS、幂等及原子审计。普通轮换由 `cfkanban-admin` 使用本地受限文件与 Bearer-only 原子 rotation 完成；全失恢复仍由 `cfkanban-deploy` 执行。

Owner 管理面按四个简单分区组织：Overview、Workspaces/Projects、Access、Audit。它不做可配置 Dashboard；Overview 只展示实例自身能够读取的健康、版本、资源计数、preferred/current observed origin 与近期错误摘要。preferred origin 在 Web 中只读，页面提供一段让 Owner 交给 `cfkanban-admin` 的简短话术；修改只能使用 Owner Bearer Credential，避免一个被劫持的 Cookie Session 把后续 Agent Credential 导向攻击者地址。Web 不保存 Cloudflare API token，也不声称提供权威 account quota/usage 或域名清单；Cloudflare-native domain reconcile 属于 `cfkanban-deploy`，第三方 alias 由 Owner 明确提供。

Audit 默认读取实例级 domain + security 最近事件，同时提供一个 Project 与一个 stream 的可选筛选。页面显示当前事件的 stream 与 Project scope；改变筛选会清空旧列表并开始新的 cursor 序列，不能把旧 `next_cursor` 接到新筛选上。Project 选择器复用按需分页的容器清单；工作区及每个工作区的项目各 20 条一页，用户可继续加载全部目标，不自动遍历所有页。

Owner `admin` Session 默认落在 Overview，不自动读取全部 Project 或 Issue。Owner 显式选择 Workspace/Project 后可以在同一 Session 进入任意 Project Board/Issue 数据面，再返回管理区；这是 Owner 已有隐式数据面权限的 Web 呈现，不创建 Grant。Owner Project/Issue 和既有固定 scope Session 仍不能导航到其他 Project 或管理区；D-272 允许新兑换非 Owner Session 切换当前实时授权 Projects，但仍不能进入管理区。

Web 不提供 Owner transfer、第二管理员、直接 D1 浏览、完整导出/导入、Time Travel restore、Cloudflare 资源删除、DNS 或计费设置。这些不属于应用内维护面。

### 3.4 语言与内容边界

- 公开首页、登录/Launch、Project 看板、Issue 详情、Owner 管理、错误与恢复页等第一方 Web UI 公共文案至少提供 `en` 与 `zh-CN`。
- 登录后优先应用当前 Principal 的服务端 `locale`；不存在偏好（`null`）、旧响应未提供偏好或尚未取得本人设置时，按当前浏览器首选语言回退，不继承其它账号或旧匿名本地选择。未登录时保留用户显式选择的本地非秘密语言；没有显式选择则检测浏览器首选语言，自动检测结果不保存为显式偏好。任何 `zh` / `zh-*` / `zh_*` 使用 `zh-CN`，其他或无法检测时默认 `en`；`navigator.languages` 为空时使用 `navigator.language`。DSH、Codex 与独立本地工作台遵循相同优先级，使用可用宿主语言，没有宿主语言时使用当前浏览器系统语言。
- 登录后的页头语言切换通过 `PATCH /api/v1/me` 显式保存本人 `locale` 与当前 Principal `expected_version`，不新增设置页；服务端确认后更新公共文案与 HTML `lang`。保存失败显示可本地化提示，CAS 冲突先读回且不自动重放；结果未确定时保留原请求与幂等键，只能显式恢复原修改。语言偏好与主题共用 Principal version，旧 Session/profile 响应不能覆盖已确认的新偏好，不能继承另一身份的偏好。
- 切换入口统一位于全局页头，使用通用翻译图标按钮，可访问名称和提示同时明确当前语言与点击效果；业务弹窗不重复提供语言入口，跟随当前全局语言。切换只更新公共文案，不导航、不重建表单或丢失草稿。看板列头、卡片、导航、筛选和状态选择使用同一状态显示规则；优先级、未分配、筛选及加载/错误提示随 locale 更新。
- 2026-10-05 用户授权：稳定 API/workflow key 永远保持英文，五个默认状态显示值随界面语言使用 `Backlog / Todo / In Progress / Done / Canceled` 或 `待规划 / 待办 / 进行中 / 已完成 / 已取消`。显示名称缺失或与该 key 的默认英文名称完全相同时视为默认显示值，其余项目自定义名称保留原文。现有 API 不提供名称来源标记，因此自定义值恰好等于默认英文名时也按默认显示值处理；不通过翻译修改服务端名称或状态 key。
- Workspace/Project 显示名、Issue 标题/Markdown、Comment、Label、Project context、status override 和其他业务内容始终按原文展示，不做自动翻译。
- Web 只根据稳定 `code/category/recovery` 选择本地化错误与操作提示；API/OpenAPI 字段、枚举和机器错误不因 `Accept-Language` 或 Web locale 改变。Skill 输出由上层 Agent 语言环境决定。
- 每个页面设置与当前 locale 一致的 HTML `lang`；日期/时间可按 locale 展示，但 wire 值仍保持已冻结的 UTC/RFC 3339 合同。
- 缺少翻译时逐条回退 English，不显示裸 translation key，也不阻断核心读写。更多语言是后置扩展，不影响 v0 对 English/简体中文的承诺。

### 3.5 多域名与推荐入口

- 根页面、静态资源和 API 都以本次请求 origin 同源工作；服务端不把认证请求 30x 到 preferred origin，也不跨 origin 复制 cookie、CSRF token、launch code 或页面状态。
- `/.well-known/cfkanban-instance.json` 是公开、动态、`no-store` 的机器发现入口，Web 只把其中的 preferred origin 当作展示和生成未来链接的提示，不把任意新 origin 的自报当作信任迁移证据。
- Agent 新建 Browser Launch、Invite 话术与后续可复制链接时优先使用已经安全绑定的 preferred origin。已经生成的旧 URL 不在后台改写；只要旧 alias 仍绑定同一 Worker，就按原 origin 完成其一次性交换。
- Web Session cookie 是 origin-specific；换域名后用户需要在新 origin 重新建立 Session。cfKanban v0 主动把 Passkey RP ID 固定为当前 hostname，不启用跨 hostname 共享；换 hostname 后 Agent Browser Launch 是重新进入和登记的恢复路径。
- 已认证页面仅在当前 origin 与 `preferred_api_origin` 不同时，在应用页脚显示非干扰性的推荐地址链接；不放入账户菜单，也不自动重定向。这样可以避免正在编辑的内容丢失，也不会把旧 origin 的 Session 或 capability 错误地当作能跨域继承。

### 3.6 个人主题偏好

- 最少提供「暖橙 / Warm orange」（`orange`）与「静蓝 / Calm blue」（`blue`）两种主题，默认 `orange`。主题只改变强调色、配套浅色及色彩状态，不改变布局、字号、间距、控件位置、导航或交互。
- 所有已认证身份均可从账户菜单进入「个人设置」，选择主题并显式保存；未保存的选择不形成服务端偏好。保存成功后，当前页面及其他已登录页面使用服务端确认的主题。主题切换不触发导航或业务写入。
- 偏好属于当前实例中的 Principal，由 D1 保存；登录读取 `WebSession.principal.theme`，个人页通过 `GET /api/v1/me` 读取当前值和 version。换浏览器或重新登录后读取同一已保存值，不将其仅保存在浏览器本地。未认证时和新建 Principal 均使用 `orange`。
- Web 和 Agent 均通过 `PATCH /api/v1/me` 保存 `theme`，携带当前 Principal `expected_version`；仅修改主题时不提交未编辑的名称。Cookie 写入继续校验同源和 CSRF。权限不因主题改变，任何 Session scope 的已认证身份都只可修改本人。
- 保存期间防止重复提交；失败保留尚未保存的选择并显示恢复入口，不把选择值当作已保存值。版本冲突按既有 CAS 合同刷新服务端事实并让用户重新判断，不自动覆盖并发的名称或主题更新。
- 主题不作为新的工作流、角色、项目设置或系统深浅模式。错误、优先级、只读和状态在两种配色下均保留文字或图标提示，颜色不是唯一信号。

### 3.7 项目设置入口与标签页

- 看板的项目级操作收敛为一个「项目设置 / Project settings」按钮。进入后使用同一项目页头和标签导航，承载「项目管理 / Management」「标签 / Labels」「项目活动 / Activity」「已删除事项 / Deleted issues」，不在看板上并列重复这些入口。
- 「项目管理」只按当前 Project 服务端 `allowed_actions` 的实际管理能力显示；不将普通 writer 或 Principal 名称当作管理授权。「标签」与「项目活动」对可读者提供，标签修改仍要求有效 writer；「已删除事项」及逐条恢复仅对有效 writer/Owner 提供。隐藏标签不预加载其数据，每次访问和写入仍经实时服务端权限与 Session scope 核验。
- 看板入口对有实际项目管理能力者默认选择「项目管理」，其余可读者默认选择「项目活动」。所有标签切换和返回看板均保留同一项目及已提交筛选条件，`from` 只接收准确同项目看板路径，不接受任意外部跳转。
- 保留已有地址：项目管理为 `/app/manage?workspace={workspace_id}&project={project_id}`；其余分别为 `/app/w/{workspace_id}/p/{project_id}/labels`、`/activity`、`/deleted`。这些地址直接进入对应标签，不新增替代业务 API 或破坏旧链接。仅工作区的管理地址保留原页面，不引入项目标签。
- 各标签复用原有业务能力、错误恢复和分页；聚合导航不扩大权限、不合并原子写入、不把项目活动变为 Owner 安全审计。 已归档项目只显示仍有权访问的「项目管理」标签，页头出口改为「选择项目 / Choose project」并进入 `/app`，不导航至不可读的归档看板。

## 4. Browser Launch 与 Web Session

### 4.1 正常路径

1. 用户让 Agent 打开一个明确的 Project、Issue 或 Owner 管理目标。
2. Agent 解析实例和 target；Project 工作仍优先使用本次显式 scope，其次才参考 Repo scope。
3. Agent 使用当前长期 Credential 调用 Browser Launch 创建能力。请求只包含明确 target，不把 Credential 返回给浏览器。
4. 服务创建短期、一次性的 opaque launch code，只在响应中返回一次完整 URL。
5. 宿主支持应用内浏览器时 Agent 可以打开该 URL；否则把 URL 交给用户在普通浏览器中打开。
6. 首次 `GET` 只加载带 `no-store` 的同源启动页，不消费 capability。页面使用显式 `POST` 兑换；这避免链接预览器或安全扫描器消费一次性 code。
7. 成功兑换后服务设置 `HttpOnly + Secure + SameSite` Session cookie，使 launch code 失效，并用不含 code 的 URL 替换浏览器地址后进入 target。
8. 页面之后通过同源 API 工作；退出登录只撤销当前 Web Session，不撤销长期 Credential。

路由形态固定为 `/app`、`/app/w/{workspace_id}/p/{project_id}`、`/app/issues/{identifier}`、`/app/admin` 与 `/app/launch?code=...`。它们是 Web 信息架构入口，具体 API 调用仍以 Frozen API/Schema 合同为准。

### 4.2 target 与权限

Browser Launch 只保存服务端可校验的 target，例如 Project、Issue 或 Owner 管理入口。兑换时和每次后续请求都重新校验 Principal、Credential/Session 状态、Project Grant、容器状态与资源存在性。

创建 launch 不授予权限；打开 URL 也不能扩大权限。Issue target 在兑换后按所属 Project 校验，无权或已删除资源按既有隐藏规则处理。Grant 变化后，旧页面的下一次请求立即使用新权限。

### 4.3 安全下限

- D1 只保存 launch code 的安全散列，不保存明文；完整 URL、code、cookie 和长期 Credential 不进入日志、Audit payload、analytics、错误或 receipt。
- 启动页和已认证页面使用严格 `Referrer-Policy: no-referrer`、`Cache-Control: no-store, no-transform`；`no-transform` 阻止 Cloudflare Web Analytics 等边缘功能自动改写 HTML，不通过放宽 CSP 加载第三方脚本、字体、图片或统计资源。
- launch code 短时、一次性、可撤销；失败兑换不得泄露目标、Principal 或 Project 是否存在。
- Web Session 使用不可预测 token 的安全散列或等价服务端 session 记录；cookie 不可被 JavaScript 读取。
- 所有 cookie-auth 写请求必须有 CSRF 防护。v0 固定采用 Origin/同源校验 + double-submit CSRF cookie/header；不能只依赖 SameSite。CSRF token 可被同源脚本读取，但不是认证凭据，不进入持久浏览器存储。
- 页面内容视为不可信业务数据，Markdown 渲染必须去除脚本、事件属性、危险 URL 与任意 HTML 执行能力。
- 不在 Service Worker、IndexedDB、localStorage 或 sessionStorage 保存长期 Credential、launch code 或 Web Session secret。

launch/Session 生命周期、源 Credential 失效联动已按 D-217 确认；参与者选择 scope 由 D-272 增量修订；§8 只保留确认结果和后置增强。

### 4.4 Passkey 直接登录

正常页面不接受 `.cfkanban/` 长期 Credential 的粘贴、上传或浏览器持久化。即使只用于一次兑换，复制过程仍会把可跨 Project、无自动过期的 Bearer secret 暴露给剪贴板、页面脚本、浏览器扩展和误填表单，不应成为普通登录方式。

v0 固定使用 Passkey：用户先通过一次 Agent Browser Launch 建立已认证 Session，再显式为同一 Principal 注册一个仅用于 Web 的 WebAuthn authenticator。首次登记与补充登记都要求 Session 来源是 Agent Launch。浏览器/OS 保存私钥，D1 只保存 credential ID、公钥和验证 metadata；后续首页通过 challenge/assertion 验证后签发同样固定 8 小时的 Web Session，不签发或暴露 API Credential，也不引入密码、邮箱或 refresh token。

Passkey 是 Web authentication method，不是 Project Grant，也不能调用 Agent Bearer API。一个 Principal 可以登记多个 Passkey；当前 Principal 可以列举/撤销自己的 Passkey，Owner 可以撤销参与者的 Passkey。Passkey 撤销立即使其来源 Sessions 失效，但不撤销 API Credential 或 Grants。所有登记、成功认证和撤销都写安全 Audit。

Passkey 登录后的 Session 不继承某个旧 Browser Launch 的单 Project target：参与者进入当前有权 Project 的选择页，之后每个请求仍按实时 Grant 校验；Owner 进入 Overview，并可显式进入任意 Project。两者都不自动执行无 Project filter 的 Issue 聚合查询。

未认证首页按以下渐进增强规则呈现登录：

- 没有 `PublicKeyCredential` 时隐藏或禁用 Passkey 登录，并醒目提供 Agent Browser Launch 话术；
- WebAuthn 可用时显示由用户主动点击的“使用 Passkey”按钮；`isUserVerifyingPlatformAuthenticatorAvailable()` 只用于调整帮助文案，返回 `false` 不能隐藏按钮，因为外接安全密钥、手机或 credential manager 仍可能可用；
- `isConditionalMediationAvailable()` 只决定是否可增加 autofill/conditional mediation 体验，不是 v0 必需路径，也不能被解释为 credential 存在；
- 页面不尝试静默枚举或探测“当前设备/当前域名是否已有 Passkey”。只有用户主动发起并成功完成 WebAuthn ceremony 才证明本次可用；取消、超时、无匹配 credential、认证器不可用或策略拒绝统一显示“Passkey 登录未完成”，并提供 Agent Browser Launch，不断言“没有 Passkey”。

已认证页面的列表标题固定表达为“为你的 cfKanban 身份登记的 Passkeys”，因为它展示的是服务端记录，而不是当前设备 inventory。cfKanban v0 的 RP ID 固定为登记/认证请求的当前 hostname，expected origin 固定为当次规范化完整 HTTPS origin，不启用跨 hostname credential 共享或 Related Origin Requests。preferred origin 换成另一个 hostname 后，用户通过 Agent Browser Launch 在新地址建立 Session并重新登记；旧地址仍可达时，其旧 Passkey 仍只服务旧地址。这是 v0 的简化与安全选择，不是 WebAuthn 标准的一般限制。

长时“记住此浏览器”的 bearer refresh cookie 虽然实现更直观，但会重新引入长期可重放 secret、轮换和盗用恢复；Cloudflare Access/企业 IdP 则需要额外账户配置与外部身份映射。二者只作为后续可选部署 profile，不作为 strict-zero v0 默认。

### 4.5 单 Project Public Join

普通 Project Invitation 仍是 7 天、一次性 capability，不能把同一个 code 暴露在首页供多人兑换。Public Join 是独立、Owner 按单个 Project 开启或关闭的公开授权策略，不是 Invitation、Team Link 或多 Project Grant bundle。

一个实例可以同时展示多个已公开 Project。访客每次先选择一个 Project，再明确选择 `reader` 或 `writer`：未登录访客复制与该选择绑定的 Agent 话术，话术必须指向同实例、同语言的专用 `join.md`，再携带准确 origin、Public Join ID 与 role；该指南先覆盖 Skill 安装与安全计划，不能假设接收方已经安装 Skill。Agent 随后复用或创建本地 Principal/Credential，并执行一次 self-join；已通过 Passkey 登录的 Principal 可以直接执行同一原子动作。首页不生成或下载长期 Credential。

加入成功后，Passkey Session 直接进入刚加入的 Project 看板。Agent 路径返回实际 Project/role、Principal/Credential fingerprint 与 resolved scope，并只建议打开看板或显式写入当前 Repo scope；不能自动打开页面或修改 Repo 文件。

Public Join 每次最多建立或恢复一条 Project Grant，不提供批量入口。已有同等或更高权限时幂等返回当前权限；`reader` 可以按公开选择提升到 `writer`，`writer` 选择 `reader` 不自动降级。Grant 不自动过期，直到 Owner 显式改变或撤销。

Owner 开启 Public Join 时必须明确接受公开 `writer` 的后果：未知互联网参与者可以修改、评论、移动、完成和软删除 Project 内容并制造 D1 写入。公开卡片只包含显示名称、有界公开摘要和 role 选择，不泄露内部 Project context、Issue、成员或未公开资源。

开启表单必须要求 Owner 显式填写该 Project 独立的 Issue、Comment 与 Principal 三项 active quota；UI 可以预填建议值 50/500/50，但必须由 Owner 提交。页面必须说明三项限制不与其他 Project 共享，只在本 Project 的 Public Join enabled 期间生效。当前 active usage 和新上限同时显示，但允许把上限调到低于 usage；提交前提示既有资源与 Grants 不会被自动删除或撤销，只有继续增加相应计数的操作会被阻止。开启、更新、关闭 Policy 和更新 resource limits 的 `expected_version` 一律来自响应中的 `project.version`；`policy_version` 只展示 Policy 历史，不能用作写入 CAS。

Issue/Comment soft delete 与 Grant revoke 释放 slot，restore/regrant 重新占用。soft-delete Issue 还会让其当前有效 Comments 暂时不占 Comment quota；restore 时必须同时容纳 Issue 与这些 Comments，任一不足都整体失败。completion comment 不可删除，所属 Issue active 时持续计数。页面必须区分“active quota 已释放”和“tombstone 仍保留在 D1”，不能暗示已回收物理存储。

Public Join 不建立逐 Principal blacklist。Project 仍公开时，被撤销 Grant 的 Principal 可以重新加入并重新占用 Principal slot；要停止新的 self-join，Owner 关闭 Public Join。关闭入口不撤销既有 Grants，同时停止本 Project 三项 quota 的强制，不影响其他 Project。重新开启表单可以预填上次使用的 limits，但 Owner 必须显式提交；服务端不能静默沿用。

Owner Overview 展示当前访问频率限制、配置来源和有界的近期 429 摘要。按 [Owner Cloudflare 管理增量](2026-10-07-owner-cloudflare-control-spec.md)，具备已核验配置授权的 Owner 可在概览预览并应用五个 scope 的单项变更；未接入时说明原因并指向同页连接入口。它们是近似频率门控，不是精确业务 quota 或费用封顶；实际动作是显式 Worker 配置部署，不运行 D1 migration。

## 5. 简洁性约束

### 5.1 功能克制

v0 不包含：自定义列/工作流、手工 rank、批量选择/编辑、复杂报表、Saved Views、实时协同、WebSocket、通知中心、mention、富文本编辑器、附件管理、自动化市场或可安装前端插件。

搜索只使用 API 已有的结构化过滤与基础 title 搜索。未来 Vectorize 是可选、可重建的检索增强，不影响 Web 的核心可用性。

### 5.2 技术克制

- Web 预构建资产由同一 Worker 的 Workers Static Assets 提供，复用同一 origin、部署版本和 API；它们随固定 Service deployment bundle 一起发布，普通部署者不需要现场构建前端。v0 不新增独立 Pages project、KV namespace、R2、Durable Objects 或第三方认证服务。
- `deploy-guide.md`、`deploy-guide.zh-CN.md`、`join.md` 与 `join.zh-CN.md` 是 Service bundle 中受版本控制的公开静态文档；路径稳定但内容随部署版本更新，因此使用 `no-store`、`no-referrer` 与 MIME sniffing 防护，不能被 SPA fallback 替代。
- API、Invite/bootstrap、Web auth/session 与 `/.well-known/` discovery 等动态/协议路径必须优先进入 Worker；普通 UI navigation 可以使用 SPA fallback。带内容指纹的不可变 assets 可以长期缓存，包含身份、邀请、实例发现或动态业务数据的响应沿用各自安全缓存合同，不能被 SPA fallback 或静态缓存吞掉。
- 前端只调用公开或同合同的 REST 能力；不出现直接 SQL、隐藏管理员后门或仅 Web 可用的第二套业务动作。
- 前端固定使用 Vue 3 + TypeScript + Vite。具体 minor/patch 版本、依赖管理器、测试库、状态管理和目录结构仍由实现计划在兼容范围内选择；不得为框架便利引入第二套 API、服务端渲染、常驻 Node 服务或额外云资源。
- 产物、依赖和运行时代码应保持可审计。优先使用 CSS tokens、平台能力和少量可替换组件，不引入需要远端运行时、遥测或完整重型组件平台的视觉依赖。
- 页面必须支持窄窗口和普通桌面浏览器；IAB 与系统浏览器使用同一响应式页面，不维护两套 UI。
- 2026-10-01 用户授权 CFK-535：业务页面与仅认证页面需要的框架/页头按需加载；入口与同步依赖的总下载量一并验收，不通过提高大包告警阈值代替优化。页面加载期间提供随当前语言更新的反馈，失败后提供显式重试和刷新获取最新版本；禁止自动刷新、自动重放业务写入或改变 Session/路由。重试不重建已加载的兄弟组件，页面离开后忽略旧加载结果；刷新继续遵循已有未保存草稿保护。
- Web 构建生成 Vite manifest，构建与 Service 打包核对入口、同步/动态 chunk、CSS 和静态资源完整性，沿用 HTML `no-store` 与内容指纹 assets 的 immutable 缓存。旧页面请求已被新发行替换的 chunk 时显示可恢复错误，用户显式刷新后读取当前 HTML。构建体积预算与同条件冷缓存测量见[首次加载性能基线](../research/2026-10-01-web-initial-load-performance.md)，不把本地结果表述为线上效果。

### 5.3 视觉克制

仓库根目录 [`DESIGN.md`](../../DESIGN.md) 是第一方 Web 的视觉与交互设计真相源；本文继续负责产品、安全和行为合同。已确认方向是简洁、高效的 Nuxt UI Kanban 工作台，使用白色与 slate 中性色组织内容，并提供暖橙、静蓝两种个人配色。主题仅改变色彩，布局与交互保持一致；标志沿用既有品牌图形。

- 默认 Board 不设置持久重型侧栏；Workspace/Project、搜索与一个主要创建动作收敛在紧凑顶部区域。右上角仅语言切换与账户菜单触发器，名称、角色与账户操作统一在菜单中呈现；Session 到期说明和有条件出现的推荐地址放在应用页脚。
- 五列依靠排版、间距与轻微表面差异组织；卡片使用轻边界，必要时可有一层克制阴影，不使用玻璃、渐变、霓虹、装饰插画或 cards-inside-cards。
- 已登录页面标题、控件、卡片和正文统一使用系统 sans，Issue identifier 可使用系统 monospace。保留公开首页现有排版，不加载第三方字体；图标随应用本地打包。
- 选定视觉稿只固定气质、信息层级与可见密度。图中的任意日期、重复 Add issue、装饰头像或其他未进入产品合同的生成式偶然细节不得被实现；D-264 明确要求的有界产品页脚不属于该类偶然元素。
- 精确颜色、间距、圆角、组件状态、无障碍和响应式规则由 `DESIGN.md` 明确；任何有意偏离必须同时更新设计合同与视觉证据，不能在代码中静默漂移。

## 6. 错误与恢复体验

- Launch 已用、过期、撤销或无效：显示不泄露实例内容的统一失败页，建议回到 Agent 重新创建 URL。
- Session 过期或被撤销：清除 cookie，保留不敏感 target 提示；浏览器支持 WebAuthn 时允许用户主动尝试 Passkey，是否已有可用 credential 只能由成功 ceremony 证明；同时始终提供 Agent 重新打开的路径，不要求粘贴 Credential。
- Passkey 认证未完成：使用不泄露 credential 是否存在的统一提示，允许用户再次主动尝试或改用 Agent Browser Launch；前端可以按浏览器本地错误改善操作提示，但不得把取消、超时或 `NotAllowedError` 映射成“没有 Passkey”。
- version 冲突：展示远端当前事实和本地未提交输入，允许用户刷新后重新决定；不得自动覆盖或无限重试。
- Grant 被撤销或降级：立即隐藏/禁用不再允许的动作；后续服务端拒绝仍是最终事实。
- Project active quota：使用 `business_quota` 显示“释放容量或请求 Owner 调高”的明确动作；只有已授权用户看到 usage/limit，Public Join 访客只看到容量已满。
- 应用限流：使用 `rate_limit` 显示倒计时与稍后重试；以 `Retry-After` 为准，不用固定轮询或无限自动重试。
- D1/Workers 平台额度：使用 `platform_quota` 区分可等待 UTC 重置的日额度与需要 Owner 处理的 storage/付费问题；展示 request/Ray ID 和来源，但不展示 Cloudflare 原始错误全文。
- Cloudflare 在 Worker 外返回 1027、429 或非 JSON 错误时，由前端 transport 层生成明确标记 `normalized_by=client` 的本地错误结果；页面提示与 Agent 保持同一 category/recovery，但不能假装收到了 cfKanban JSON。未知网络/平台故障进入 `platform_failure`，不把它误报为额度已满或业务成功。

## 7. Storyboard 验收映射

- SB-25：Agent 为明确 target 创建 Browser Launch，并在 IAB/普通浏览器安全建立 Session。
- SB-26：reader 直接查看、writer 用同一原子合同轻量参与 Issue。
- SB-27：Owner 在极简管理面完成低频维护，不进入 Cloudflare 数据控制面。
- SB-28：launch/session 过期、撤销、权限变化和 CSRF 等失败路径可恢复且不泄密。
- SB-29：未认证访客理解产品并复制可信 Agent 部署话术。
- SB-30：已建立身份的人类不粘贴 API Credential，也能通过可恢复的 Web authentication method 再次登录。
- SB-31：Owner 可以同时公开多个 Project，访客每次选择一个 Project 与 `reader|writer` 后原子加入；不提供 Team Join 或多 Project 公开授权。
- SB-32：人类可以在 English 与简体中文间切换 Web UI，但稳定 key、默认 workflow 显示名和业务内容不自动翻译。
- SB-33：Owner 发布新 preferred origin 后，Web 在 alias 上保持可访问并提示推荐地址；Session 不跨 origin 自动迁移，v0 Passkey 不跨 hostname 共享，Agent 负责安全重绑长期 API origin。

## 8. 已确认生命周期与可后置问题

### Q-WEB-01：Launch 与 Session 生命周期（已确认）

v0 固定：Browser Launch 生成后 5 分钟内可兑换且只能成功一次；Web Session 自建立起固定有效 8 小时，不滑动续期、不提供 refresh token。刷新页面、切换项目或继续操作都不延长当前 `expires_at`。Session 绑定 `principal_id + source_kind + source_id`：Agent Launch Session 的 source 是发起 launch 的 Credential，Passkey Session 的 source 是完成认证的 Web Authenticator；对应 source revoke 或 Session 显式 revoke 都立即使其失效，Project Grant 始终按请求实时校验。

新兑换的非 Owner Agent Project/Issue Launch Session 使用已有 `project_selection` scope，初始仍进入指定目标，可在当前实时授权项目之间切换；逐项目校验 reader/writer。既有固定 scope Session 和 Owner 明确 Project/Issue target Session 不扩大，Owner admin 与 Passkey 规则保持不变。 详见 [Frozen 增量合同](2026-09-19-participant-project-switching-spec.md)。所有入口都不自动执行无 Project filter 的 Issue 聚合读取。

五分钟给普通浏览器复制/切换留出余量，一次性与实时授权范围限制了暴露；八小时覆盖一个工作日而不形成长期网页登录。到期时已打开页面清除已渲染的远端业务数据；刷新或下一次 API 请求返回稳定的 Session 过期错误并清除 cookie。会话期限及过期提示遵循 [Web Session 活动续期增量](2026-10-01-web-session-renewal-spec.md)，页脚不持续显示到期时间。到期后可回到同站点首页用已登记 Passkey 重新登录，或让 Agent 重新打开当前 target，建立新的 Session；不显示密码框或 Credential 粘贴入口。写入到期失败时不自动重放；尚未提交的本地表单文本可以暂存在当前页面内存中，待新 Session 建立后由用户重新判断并提交，但不能写入 Web Storage。

### Q-WEB-02：后置增强

以下问题不阻塞 v0 合同：Owner 是否需要“退出该 Principal 的全部 Web Sessions”、是否显示 active session 摘要、是否增加键盘快捷键、是否为极窄窗口提供列表替代布局，以及是否增加 English/简体中文之外的其他语言。它们可以在真实使用证据出现后决定。

## 9. 冻结依据

本文冻结时已经满足：

1. Q-WEB-01 已按 D-217 确认并回写 Foundation、Agent Skills 和 API/Schema。
2. API/Schema SPEC 定义 Browser Launch、Session、cookie/CSRF、撤销和所需 D1 事实。
3. SB-25～SB-33 的主要产品方向逐卡验收通过；Q-232 已固定原生限流部署配置与初始档位，D-243 已固定推荐域名的 Web 边界，D-244 已固定 Passkey capability/credential 区分与精确 hostname 选择，D-245 已固定同 Worker Static Assets 与无 Pages/KV 的部署拓扑；API/DDL 原型已验证，D-252 已固定 Passkey 非零签名计数异常策略。
4. reader/writer/Owner 的 Web 能力不超出既有权限，也不存在仅 Web 可用的领域后门。
5. 明确验证在 Codex IAB 与普通浏览器中使用同一页面的实现计划，但不要求绑定某个宿主专有 API。
6. 根目录 `DESIGN.md` 的视觉 token、主要组件状态与选定参考图已经过实现前复核，且 Vue 3 + TypeScript + Vite 的构建边界进入实施计划。

冻结本文提供稳定实现依据，但不表示任一 Linear 实现 Issue 已完成，也不授权部署、迁移、提交或推送。


## 2026-09-20 Issue 操作与邀请历史优化

- 负责人字段使用项目可指派人员名称下拉框，含“未指派”，保留当前不可用负责人提示及有界候选分页；移除“指派给我”和手输 UUID。选中同一个人不发送重复写入，写入继续采用当前 version/CAS 与服务端资格复核。候选可见范围以 Principal names 增量合同为准。
- CFK-430（2026-09-20 用户授权）：暂时隐藏 Web 阻塞筛选整体、卡片与详情的阻塞标识、原因及人工标记/解除入口。看板请求不发送 blocked 条件，旧 URL 不启用隐藏筛选，已有阻塞事项照常展示。后端字段、API、Agent 能力、依赖关系与 workflow 语义保持不变。
- Owner 人员页默认只展示人员与权限，不读取或铺陈历史邀请。入口打开 `/app/admin?section=invitations`，20 条一页，提供上一页/下一页、空态、失败重试和撤销。
- 日常历史分页与邀请创建中断后的完整安全复核独立。按需展开完整复核仍须遍历全部页；普通历史翻页不解锁邀请创建，不清除待恢复操作或自动确认。

## 2026-09-20 标签输入与管理（CFK-431）

- 详情仅显示当前 Issue 的标签；writer 输入名称后按 Enter 复用或创建一个标签，再以独立原子操作关联。空白不写入，组合输入确认不提交，重复不重复写入；匹配建议仅在输入后出现。名称长度与 ASCII NOCASE 沿用 API 合同。
- 查找覆盖服务端分页；同名创建冲突重新读取并复用获胜标签。创建成功而关联失败时保留输入和已创建标签，重试复用既有资源；不自动恢复软删除标签或扩大权限。移除仅删除 Issue association。
- 「项目设置 → 标签」沿用 `/app/w/{workspace_id}/p/{project_id}/labels` 地址，也可从详情标签区进入对应标签。reader 可读，writer 可维护名称和颜色；权限不因进入项目设置而改变。CAS 冲突保留草稿并要求重新核对；中英文及键盘操作可用。

## 2026-09-20 看板渐进加载（CFK-433）

- 每个固定状态列独立通过既有 `status` + `limit=20` + `cursor` 请求；首屏每列一页，不自动遍历后续页。列内有界滚动，接近末尾后追加，也提供键盘可达的“加载更多”按钮。
- 看板按视口及顶部实际内容高度分配剩余空间，列内容在该空间内滚动；不以固定减数估算列高，也不保留把页面撑出视口的列最小高度或底部留白。窗口变高、变矮、工具栏换行时自动适配；极矮窗口或长提示占满空间时，允许看板容器滚动以保留工具栏和列的可操作性。窄屏横向滚动仍限制在看板区域，其他页面保留原有文档滚动。
- 每列独立呈现加载中、失败重试、已加载完毕。2026-10-01 用户授权 CFK-532：列头通过独立 Project `/issues/counts` 读取该状态的未删除 Issue 匹配总数，不随加载页数变化；无筛选是该状态全部未删除 Issue，有筛选则按当前已提交搜索、优先级及标签共同匹配。计数与列表使用同一项目、当前权限和筛选；加载为省略号，失败为不可用及独立重试，不假装为 0、不阻塞已有卡片。可访问名称和中英文提示说明匹配总数。搜索在服务端分页前执行，改变搜索/项目会重置各列及计数并丢弃旧响应；尚在编辑而未提交的搜索不改变后续页或计数过滤。
- 每次提交搜索/筛选、创建、状态移动、完成或优先级修改后重新读取总数；删除/恢复后返回看板重新读取。计数请求代次保护阻止迟到响应覆盖新筛选或已失去权限的投影；计数和列表不是同一快照，并发外部写入通过显式刷新核对。不拉取所有页、不维护放大业务写入的持久计数器。
- 相同列只允许一个有效分页请求，按 Issue ID 去重；过期游标保留当前卡片，显式重试首屏并合并去重。2026-10-01 用户授权 CFK-533：状态移动、完成、新建及优先级修改后，使用服务端确认的 Issue 按 ID 更新或移动卡片，保留其他卡片、已加载页、可用 cursor 和列滚动位置；按 `updated_at DESC, number DESC` 排序，并按已提交的完整筛选决定进入或退出。只失效受影响列的迟到分页请求，防止旧响应覆盖已确认版本；筛选/项目/权限变化仍清除失效投影。恢复或返回看板重新读取；CAS/幂等和权限不变。
- 保存反馈和重复提交保护限定在单卡。CAS 冲突定向读取该 Issue 并核对计数，保留修改意图供用户重新判断，不清空五列或自动覆盖。响应不确定时先读回事实，保留原资源版本/请求/幂等键和明确的核实入口，不自动重放写入；未核实期间禁止该卡再次修改及改变查询条件。单 Issue 不可见时移除该卡，项目授权失效时清除整个项目投影，不遍历全部分页核对。
- 首屏最多渲染 100 张卡片。后续 DOM 随用户加载累积；当前不引入虚拟列表，不宣称无限追加解决所有规模性能问题。

## 2026-09-20 优先级快捷修改（CFK-434）

- 详情侧栏与看板卡片提供同一组 none/low/medium/high/urgent 选项；无优先级也显示明确入口。原编辑表单保留，选项及排序复用同一来源。
- 选择不同值仅提交 priority_key 和 expected_version；同值、取消和保存中的重复输入不写入。卡片选择器独立于详情打开按钮，并隔离点击和拖拽。reader 仅查看；writer 能力来自实时服务端项目投影，详情继续使用 allowed_actions。
- 服务端确认后更新视图；看板按既有更新时间排序局部更新该卡，保持已加载分页和滚动位置并重新核对总数。失败不展示未保存的值，CAS 冲突定向读取该 Issue 的新事实并保留草稿。详情快捷修改不关闭或覆盖 title/body 等未保存内容；编辑表单未独立改动的优先级随已确认快捷修改同步。

## 2026-09-28 Agent/Web 能力补齐（CFK-448）

用户授权完成 CFK-448，沿用服务端现有业务接口及权限，不恢复 CFK-430 暂缓的 Web 阻塞操作。

- Owner 工作区/项目、归档清单及成员/审计/邀请等依赖的项目选择器提供按需分页；每种状态、每个工作区分别保留 cursor，20 条一页。失败可在原页重试，条件改变或 cursor 失效从首页重读；离开分区丢弃迟到结果。归档项目与已归档工作区均可继续访问，不再将首 20 条视为完整清单。
- Owner 可在一份普通邀请中选择 1–20 个不重复项目并分别设置 reader/writer；表单和一次性响应校验覆盖完整授权集合。恢复记录保留整份请求及原幂等键，不因修改表单创建第二份能力。局部管理员表单及服务端仍限定一个受管项目，跨范围或多项目恢复记录不能由局部页面处理。
- `/app/work` 允许显式选择 1–20 个当前 Session 可见项目 UUID。初始不读取事项，项目或筛选变化清除旧结果与游标，用户确认后查询；展示服务端 `resolved_scope` 的实际项目和不可访问目标。固定 Session 不扩权，不自动执行无项目过滤的全实例查询。
- “我的任务”使用普通事项列表 `assignee=当前 Principal ID`，支持全部五种状态；全部事项提供所选项目负责人、状态和标题/编号筛选。待领取和需重指派使用 candidates 的 `todo`、默认 `blocked=exclude` 及优先级/FIFO 排序，明确说明候选策略。Reader 可读队列，写入资格仍逐项目实时核验；查看不领取，普通看板不发送 blocked 筛选。
- 项目描述使用安全 Markdown 直接展示在看板标题下方，无内容时不占位；长描述使用有界、键盘可滚动的阅读区，保留五列可用空间。项目活动和已删除事项在统一「项目设置」页面中使用各自标签，保留 `/app/w/{workspace_id}/p/{project_id}/activity`、`/deleted` 地址，并提供返回当前看板及筛选条件的入口，不使用看板弹窗。活动沿用 reader/writer 可读权限；已删除列表及单条恢复仅对当前 writer/Owner 提供，继续使用实时服务端权限、CAS、幂等和父级状态校验。活动只使用 `/events` 的授权域事件，按当前接口时间正序、`after` 续页，失败可重试，不混入 Owner security audit。活动提供准确工作区/项目 UUID 链接，评论、标签或关系 payload 中明确的合法 CFK 编号可链接具体事项；普通无编号事件只链接所属项目，不从 subject UUID 拼接 Issue 路径。
- Issue 按需读取 `/context` 生成结构化交接摘要，复用安全 Markdown 和完成记录呈现，可主动复制文本。逐节显示省略数量，正文/评论/关系回到详情续读，项目背景按当前固定 UUID 读取全文，不跟随响应中的任意 URL。交接内容不包含认证材料，业务内容不构成授权。
- 网页参与者接受普通邀请及 Agent 本人 Passkey 管理由 [参与者邀请与 Passkey 增量](2026-09-28-participant-invitation-passkey-parity-spec.md) 定义。已确认认证范围不扩展为网页新身份注册、恢复或长期凭据保管。

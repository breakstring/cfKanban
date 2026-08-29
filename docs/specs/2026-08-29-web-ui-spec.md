# cfKanban 极简 Web UI SPEC

- 文档状态：Draft
- Roadmap：R1 / R3
- 关联 Storyboard：[用户使用 Storyboard](../product/user-storyboard.md)
- 关联 Foundation：[Agent-native Kanban Foundation SPEC](2026-08-26-agent-native-kanban-foundation-spec.md)
- 关联 Agent Skills：[Agent Skills & Bootstrap SPEC](2026-08-28-agent-skills-bootstrap-spec.md)
- 关联 API/Schema：[API & D1 Schema SPEC](2026-08-28-api-schema-spec.md)
- 事实快照：[Web 认证与公开加入能力快照](../research/web-auth-public-enrollment-snapshot-2026-08-29.md)
- 最近更新：2026-08-29

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
- Codex App 的应用内浏览器（IAB）只是一个使用示例。宿主支持时 Agent 可以直接打开；否则返回同一 URL 供用户在普通浏览器打开。服务端不依赖任何宿主专有协议。
- v0 不提供公开 batch/bulk 写入；Web 的拖拽一次只移动一张卡，不能通过多选、拖拽多卡或隐藏循环制造批量写接口。
- 公开首页与认证后 Web UI 公共文案至少支持 English 与简体中文，并允许用户随时切换；这不引入业务内容自动翻译或 Skill/API locale。

## 3. 产品表面

### 3.0 未认证首页

任何人直接打开实例根地址时先看到一个极简公开首页，而不是 Credential 输入框或空白错误页。首页说明 cfKanban 是 Agent-first Kanban、当前地址是一个独立部署实例，并在视觉中心提供一段可以直接复制给 Agent 的短话术；话术只指向 canonical HTTPS bootstrap document，由 Agent 按已冻结的来源、版本和授权合同安装 Skills 或部署新实例，不在页面内嵌 shell 命令、远程脚本或 secret。

首页可以显示 Owner 明确开启 Public Join 的多个 Project 卡片，每张只包含 Project 显示名称、有界公开摘要与 `reader | writer` 选择，不得枚举未公开 Workspace/Project、内部 context、成员、Issue 数量或其他实例事实。canonical 项目站点可以复用产品介绍和部署话术，但没有某个部署实例的登录状态或 Public Join。

### 3.1 Project Kanban

Project 是 Web 的默认工作范围。看板固定展示五列：`backlog`、`todo`、`in_progress`、`done`、`canceled`，列标题使用 Project 的显示名称覆盖，但状态 key、顺序与 terminal 语义不可改变。

卡片保持有界，只显示：`CFK-<number>`、标题、priority、assignee、labels 摘要、blocked/needs-reassignment 标记和 version 对应的当前状态。v0 不保存手工 rank，因此列内使用公开稳定排序。

v0 支持 writer 在五列之间拖拽单张卡片。落到新列就是一次明确的状态写意图，前端立即使用该卡当前 `expected_version` 保存；卡片在请求期间显示 `saving`，但只有服务端确认后才算成功。失败、无权或 `VERSION_CONFLICT` 时读取服务端当前事实并把卡片放回真实列，不静默覆盖，也不改变列内 rank。

拖入 `done` 时 UI 自动路由到原子 complete 合同，不能调用普通 status PATCH 绕过完成记录。若本次拖拽尚无必填 `summary`，立即打开极简完成框；提交后执行 complete 并最终落入 `done`，取消则回原列。拖入其他列使用普通单 Issue CAS 状态更新；从 terminal 列拖出按既有 reopen/status 合同执行。卡片菜单和详情页 status selector 保留为键盘、触屏和辅助技术的等价操作入口。

### 3.2 Issue 详情与常用参与

- `reader`：查看 Project、看板、Issue 详情、可见 Comments、Labels、Relations、completion history 和当前 allowed actions。
- `writer`：在 reader 基础上创建/编辑/软删除/恢复单个 Issue，修改 priority/status/assignee，追加或软删除/恢复普通 Comment，管理单个 Label/Relation，report/clear blocked，complete/reopen。
- Deployment Owner：在 writer 数据面能力之外，进入 Owner 管理页。

UI 只呈现服务端返回的 allowed actions，不靠缓存角色猜测权限。每次写入仍以服务端当前授权和 expected version 为准；冲突时刷新当前事实并让用户重新判断，不静默覆盖。

SB-26 的 v0 交互进一步固定为：

- Project header 始终展示 Workspace/Project、当前 Principal display name、`reader | writer | owner` 摘要和 Session 到期时间；reader 页面醒目标记“只读”，不渲染无效写按钮。
- 当前 Principal display name 提供轻量“我的资料”入口。所有已认证 Principal，不论 Owner、reader 或 writer，都可以查看只读 principal ID、当前 display name 与身份摘要，并通过同一 `PATCH /api/v1/me` + `expected_version` 合同修改自己的非空 display name；v0 不增加头像、邮箱、简介或他人资料编辑。Passkey 列举/撤销属于认证设置，不与资料修改合并成隐藏复合写入。
- Board 卡片点击进入同页 Issue 详情；writer 可以从 Board 创建单个 Issue，但 priority、assignee、labels、relations 等编辑集中在详情，避免卡片堆满快捷控件。
- 拖拽落列采用状态自动保存；Issue title/body 等文本编辑仍使用普通文本框/textarea 和显式 Save，不做后台 autosave，避免输入过程持续写 D1。正文与 Comment 以 Markdown 源码编辑，并在详情、评论流和可选预览中安全渲染；不引入 WYSIWYG 富文本编辑器。
- 每次保存只提交一个资源的显式改动，并等待服务端成功后更新页面。`VERSION_CONFLICT` 保留尚未提交的当前页草稿，展示远端新 version 与刷新/复制草稿选项，不做自动 merge 或自动重放。
- 普通 Comment 只有追加、软删除和恢复，没有编辑；completion Comment 只读。评论输入使用普通 Markdown textarea，不做 WYSIWYG。
- Issue soft delete 只需一次带 identifier/title 的明确确认，因为它可恢复；Project 内提供显式 `deleted=only` 入口定位单个 tombstone 并逐项恢复，不提供多选或批量恢复。
- Label 与 Relation 都是单项操作。跨 Project Relation 的目标选择必须同时显示 `workspace/project + CFK identifier + title`，并继续受同 Workspace/两端权限合同约束。
- report/clear blocked、assign/unassign、complete/reopen 都是各自独立的显式动作。UI 可以相邻展示，但不能把它们捆绑成隐藏复合写入或失败后自动补偿。
- 任何写入按钮或拖拽保存，在请求进行中都防止同资源重复提交；超时后先 readback，不把“请求已发送”显示为成功。

### 3.3 Owner 简单维护

Owner 管理面只承载已有管理能力：

- Workspace/Project 的创建、改名、软删除与恢复；
- Project workflow display name 与有界 Project context；
- 创建、查看状态和撤销未兑换 Invite，复制可离线发送的话术；
- 按稳定 principal ID 查看 Principal、Project Grants 与 Credential 非秘密摘要，变更/撤销 Grant，撤销参与者 Credential，发起固定 mode 的 Principal Recovery Invite；
- 查看服务健康、schema/service version、应用可观察的资源计数和近期 Audit。

v0 已按 D-219 移除 Principal disable/enable/delete。Owner 通过 Credential revoke 停止认证、通过 Project Grant revoke 停止具体 Project 权限、通过 Principal Recovery Invite 恢复同一身份；Web 不显示全局停用身份按钮。

Web 只允许撤销参与者 Credential。Owner Credential 在 Web 中只显示 ID、fingerprint、issued/last-used/revoked 等非秘密摘要，不显示 revoke/rotate 操作。Owner 正常轮换由 `cfkanban-admin` 使用本地受限文件与 Bearer-only 原子 rotation 完成；全部丢失时才由 `cfkanban-deploy` 做部署外恢复。Cookie Session 不能调用 Owner Credential lifecycle API，因此当前 Session 来源和最后一个有效 Owner Credential 都不存在 Web 自锁路径。

Owner 管理面按四个简单分区组织：Overview、Workspaces/Projects、Access、Audit。它不做可配置 Dashboard；Overview 只展示实例自身能够读取的健康、版本、资源计数与近期错误摘要。Web 不保存 Cloudflare API token，也不声称提供权威 account quota/usage；这类控制面检查属于 `cfkanban-deploy`。

Owner `admin` Session 默认落在 Overview，不自动读取全部 Project 或 Issue。Owner 显式选择 Workspace/Project 后可以在同一 Session 进入任意 Project Board/Issue 数据面，再返回管理区；这是 Owner 已有隐式数据面权限的 Web 呈现，不创建 Grant。普通 Project/Issue Session 仍不能导航到其他 Project 或管理区。

Web 不提供 Owner transfer、第二管理员、直接 D1 浏览、完整导出/导入、Time Travel restore、Cloudflare 资源删除、DNS 或计费设置。这些不属于应用内维护面。

### 3.4 语言与内容边界

- 公开首页、登录/Launch、Project 看板、Issue 详情、Owner 管理、错误与恢复页等第一方 Web UI 公共文案至少提供 `en` 与 `zh-CN`。
- 首次访问根据浏览器首选语言选择 `zh-CN` 或 `en`，不能归入简体中文时默认 `en`。全局显式切换器保存一个非秘密 locale 偏好，不与 Principal、Credential、Grant 或 Session 生命周期绑定。
- 稳定 API/workflow key 永远保持英文。Project 未配置 status display-name override 时，五列默认显示名也保持 `Backlog / Todo / In Progress / Done / Canceled`，不随 Web locale 改变。
- Workspace/Project 显示名、Issue 标题/Markdown、Comment、Label、Project context、status override 和其他业务内容始终按原文展示，不做自动翻译。
- Web 只根据稳定 `code/category/recovery` 选择本地化错误与操作提示；API/OpenAPI 字段、枚举和机器错误不因 `Accept-Language` 或 Web locale 改变。Skill 输出由上层 Agent 语言环境决定。
- 每个页面设置与当前 locale 一致的 HTML `lang`；日期/时间可按 locale 展示，但 wire 值仍保持已冻结的 UTC/RFC 3339 合同。
- 缺少翻译时逐条回退 English，不显示裸 translation key，也不阻断核心读写。更多语言是后置扩展，不影响 v0 对 English/简体中文的承诺。

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

建议的路由形态为 `/app`、`/app/w/{workspace_key}/p/{project_key}`、`/app/issues/{identifier}`、`/app/admin` 与 `/app/launch?code=...`。这些路径在本文 Draft 中只是信息架构建议，最终以 API/路由合同为准。

### 4.2 target 与权限

Browser Launch 只保存服务端可校验的 target，例如 Project、Issue 或 Owner 管理入口。兑换时和每次后续请求都重新校验 Principal、Credential/Session 状态、Project Grant、容器状态与资源存在性。

创建 launch 不授予权限；打开 URL 也不能扩大权限。Issue target 在兑换后按所属 Project 校验，无权或已删除资源按既有隐藏规则处理。Grant 变化后，旧页面的下一次请求立即使用新权限。

### 4.3 安全下限

- D1 只保存 launch code 的安全散列，不保存明文；完整 URL、code、cookie 和长期 Credential 不进入日志、Audit payload、analytics、错误或 receipt。
- 启动页和已认证页面使用严格 `Referrer-Policy: no-referrer`、`Cache-Control: no-store`，不加载第三方脚本、字体、图片或统计资源。
- launch code 短时、一次性、可撤销；失败兑换不得泄露目标、Principal 或 Project 是否存在。
- Web Session 使用不可预测 token 的安全散列或等价服务端 session 记录；cookie 不可被 JavaScript 读取。
- 所有 cookie-auth 写请求必须有 CSRF 防护。v0 Draft 采用 Origin/同源校验 + double-submit CSRF cookie/header；不能只依赖 SameSite。CSRF token 可被同源脚本读取，但不是认证凭据，不进入持久浏览器存储。
- 页面内容视为不可信业务数据，Markdown 渲染必须去除脚本、事件属性、危险 URL 与任意 HTML 执行能力。
- 不在 Service Worker、IndexedDB、localStorage 或 sessionStorage 保存长期 Credential、launch code 或 Web Session secret。

launch/Session 生命周期、源 Credential 失效联动与 target scope 已按 D-217 确认；§8 只保留确认结果和后置增强。

### 4.4 Passkey 直接登录

正常页面不接受 `.cfkanban/` 长期 Credential 的粘贴、上传或浏览器持久化。即使只用于一次兑换，复制过程仍会把可跨 Project、无自动过期的 Bearer secret 暴露给剪贴板、页面脚本、浏览器扩展和误填表单，不应成为普通登录方式。

v0 固定使用 Passkey：用户先通过一次 Agent Browser Launch 建立已认证 Session，再显式为同一 Principal 注册一个仅用于 Web 的 WebAuthn authenticator。首次登记与补充登记都要求 Session 来源是 Agent Launch。浏览器/OS 保存私钥，D1 只保存 credential ID、公钥和验证 metadata；后续首页通过 challenge/assertion 验证后签发同样固定 8 小时的 Web Session，不签发或暴露 API Credential，也不引入密码、邮箱或 refresh token。

Passkey 是 Web authentication method，不是 Project Grant，也不能调用 Agent Bearer API。一个 Principal 可以登记多个 Passkey；当前 Principal 可以列举/撤销自己的 Passkey，Owner 可以撤销参与者的 Passkey。Passkey 撤销立即使其来源 Sessions 失效，但不撤销 API Credential 或 Grants。所有登记、成功认证和撤销都写安全 Audit。

Passkey 登录后的 Session 不继承某个旧 Browser Launch 的单 Project target：参与者进入当前有权 Project 的选择页，之后每个请求仍按实时 Grant 校验；Owner 进入 Overview，并可显式进入任意 Project。两者都不自动执行无 Project filter 的 Issue 聚合查询。WebAuthn credential 受 Relying Party ID/domain 限制，实例 API/Web 域名变化时不能假定旧 Passkey 自动迁移；Agent Browser Launch 始终作为兼容与恢复入口。

长时“记住此浏览器”的 bearer refresh cookie 虽然实现更直观，但会重新引入长期可重放 secret、轮换和盗用恢复；Cloudflare Access/企业 IdP 则需要额外账户配置与外部身份映射。二者只作为后续可选部署 profile，不作为 strict-zero v0 默认。

### 4.5 单 Project Public Join

普通 Project Invitation 仍是 7 天、一次性 capability，不能把同一个 code 暴露在首页供多人兑换。Public Join 是独立、Owner 按单个 Project 开启或关闭的公开授权策略，不是 Invitation、Team Link 或多 Project Grant bundle。

一个实例可以同时展示多个已公开 Project。访客每次先选择一个 Project，再明确选择 `reader` 或 `writer`：未登录访客复制与该选择绑定的 Agent 话术，由 Agent 复用或创建本地 Principal/Credential 后执行一次 self-join；已通过 Passkey 登录的 Principal 可以直接执行同一原子动作。首页不生成或下载长期 Credential。

加入成功后，Passkey Session 直接进入刚加入的 Project 看板。Agent 路径返回实际 Project/role、Principal/Credential fingerprint 与 resolved scope，并只建议打开看板或显式写入当前 Repo scope；不能自动打开页面或修改 Repo 文件。

Public Join 每次最多建立或恢复一条 Project Grant，不提供批量入口。已有同等或更高权限时幂等返回当前权限；`reader` 可以按公开选择提升到 `writer`，`writer` 选择 `reader` 不自动降级。Grant 不自动过期，直到 Owner 显式改变或撤销。

Owner 开启 Public Join 时必须明确接受公开 `writer` 的后果：未知互联网参与者可以修改、评论、移动、完成和软删除 Project 内容并制造 D1 写入。公开卡片只包含显示名称、有界公开摘要和 role 选择，不泄露内部 Project context、Issue、成员或未公开资源。

开启表单必须要求 Owner 显式填写 Project Issue、Comment 与 Principal 三项 active quota；UI 可以预填建议值 50/500/50，但必须由 Owner 提交。当前 active usage 和新上限同时显示，调低值不能小于当前 active usage。

Issue/Comment soft delete 与 Grant revoke 释放 slot，restore/regrant 重新占用。soft-delete Issue 还会让其当前有效 Comments 暂时不占 Comment quota；restore 时必须同时容纳 Issue 与这些 Comments，任一不足都整体失败。completion comment 不可删除，所属 Issue active 时持续计数。页面必须区分“active quota 已释放”和“tombstone 仍保留在 D1”，不能暗示已回收物理存储。

Public Join 不建立逐 Principal blacklist。Project 仍公开时，被撤销 Grant 的 Principal 可以重新加入并重新占用 Principal slot；要停止新的 self-join，Owner 关闭 Public Join。关闭入口不撤销既有 Grants。

Owner Overview 必须只读展示实例当前的单 Principal 120/60 秒、实例动态 API 300/60 秒、未认证敏感操作 30/60 秒门槛、配置来源，以及有界的近期 429 摘要。它们是近似频率门控，不是精确业务 quota；Web 不提供编辑或“保存”按钮。需要调整时，页面给出调用 `cfkanban-deploy` 的简短 Agent 话术；实际动作是显式 Worker 配置部署，不运行 D1 migration。

## 5. 简洁性约束

### 5.1 功能克制

v0 不包含：自定义列/工作流、手工 rank、批量选择/编辑、复杂报表、Saved Views、实时协同、WebSocket、通知中心、mention、富文本编辑器、附件管理、自动化市场或可安装前端插件。

搜索只使用 API 已有的结构化过滤与基础 title 搜索。未来 Vectorize 是可选、可重建的检索增强，不影响 Web 的核心可用性。

### 5.2 技术克制

- Web 静态资源优先由同一 Worker 的 Static Assets 提供，复用同一 origin、部署版本和 API；v0 不因此新增独立 Pages 项目、KV、R2、Durable Objects 或第三方认证服务。
- 前端只调用公开或同合同的 REST 能力；不出现直接 SQL、隐藏管理员后门或仅 Web 可用的第二套业务动作。
- 可以使用少量构建工具，但产物、依赖和运行时代码应保持可审计。是否采用具体框架属于实现阶段的可逆技术选择，不在本 SPEC 冻结。
- 页面必须支持窄窗口和普通桌面浏览器；IAB 与系统浏览器使用同一响应式页面，不维护两套 UI。

## 6. 错误与恢复体验

- Launch 已用、过期、撤销或无效：显示不泄露实例内容的统一失败页，建议回到 Agent 重新创建 URL。
- Session 过期或被撤销：清除 cookie，保留不敏感 target 提示；已登记 Passkey 时可以重新认证，否则引导用户让 Agent 重新打开，始终不要求粘贴 Credential。
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

## 8. 已确认生命周期与可后置问题

### Q-WEB-01：Launch 与 Session 生命周期（已确认）

v0 固定：Browser Launch 生成后 5 分钟内可兑换且只能成功一次；Web Session 固定有效 8 小时，不滑动续期、不提供 refresh token。Session 绑定 `principal_id + source_kind + source_id`：Agent Launch Session 的 source 是发起 launch 的 Credential，Passkey Session 的 source 是完成认证的 Web Authenticator；对应 source revoke 或 Session 显式 revoke 都立即使其失效，Project Grant 始终按请求实时校验。

Agent Launch Session 同时按 launch target 限定 Web scope：Project target 只访问该 Project；Issue target 只访问该 Issue 所属 Project，并以该 Issue 为初始页面；Owner `admin` target 才允许访问实例级管理与数据面。普通 Project/Issue Session 即使对应 Principal 还有其他 Grants，也不能靠导航扩大 scope，需要切换时由 Agent 创建新的 Browser Launch。Passkey Session 没有旧 launch target：参与者先选择当前有权 Project，Owner 先进入 Overview 并可以显式选择任意 Workspace/Project；两者都不自动执行无 Project filter 的 Issue 聚合读取。

五分钟给普通浏览器复制/切换留出余量，一次性与 target scope 又限制了暴露；八小时覆盖一个工作日而不形成长期网页登录。到期时已打开页面清除已渲染的远端业务数据；刷新或下一次 API 请求返回稳定的 Session 过期错误并清除 cookie。页面只引导用户让 Agent 重新打开当前 target，不显示密码框或 Credential 粘贴入口。写入到期失败时不自动重放；尚未提交的本地表单文本可以暂存在当前页面内存中，待新 Session 建立后由用户重新判断并提交，但不能写入 Web Storage。

### Q-WEB-02：后置增强

以下问题不阻塞 v0 合同：Owner 是否需要“退出该 Principal 的全部 Web Sessions”、是否显示 active session 摘要、是否增加键盘快捷键、是否为极窄窗口提供列表替代布局，以及是否增加 English/简体中文之外的其他语言。它们可以在真实使用证据出现后决定。

## 9. 冻结条件

本文至少满足以下条件后才可 Frozen：

1. Q-WEB-01 已按 D-217 确认并回写 Foundation、Agent Skills 和 API/Schema。
2. API/Schema SPEC 定义 Browser Launch、Session、cookie/CSRF、撤销和所需 D1 事实。
3. SB-25～SB-32 的主要产品方向逐卡验收通过；Q-232 已固定原生限流部署配置与初始档位，只剩 API/DDL 绝对边界待冻结。
4. reader/writer/Owner 的 Web 能力不超出既有权限，也不存在仅 Web 可用的领域后门。
5. 明确验证在 Codex IAB 与普通浏览器中使用同一页面的实现计划，但不要求绑定某个宿主专有 API。

冻结本文仍不授权实现、创建 Linear 实现 Issue、部署、迁移、提交或推送。

# cfKanban 极简 Web UI SPEC

- 文档状态：Frozen
- 冻结日期：2026-08-29
- Roadmap：R1 / R3
- 关联 Storyboard：[用户使用 Storyboard](../product/user-storyboard.md)
- 关联 Foundation：[Agent-native Kanban Foundation SPEC](2026-08-26-agent-native-kanban-foundation-spec.md)
- 关联 Agent Skills：[Agent Skills & Bootstrap SPEC](2026-08-28-agent-skills-bootstrap-spec.md)
- 关联 API/Schema：[API & D1 Schema SPEC](2026-08-28-api-schema-spec.md)
- 事实快照：[Web 认证与公开加入能力快照](../research/web-auth-public-enrollment-snapshot-2026-08-29.md)
- 最近更新：2026-09-05（D-269）

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
- Codex App 的应用内浏览器（IAB）只是一个使用示例。Skill 默认通过专用命令和纯内存 loopback relay 直接打开系统浏览器，不把远端 launch URL/code 写进普通工具输出；宿主只有在提供不进入 transcript/log 的等价安全通道时才直接打开 IAB。headless 的一次性 URL 输出必须由用户明确接受宿主留存风险，并标记为不得复述或保存的单次 capability。服务端仍返回同一 URL 且不依赖任何宿主专有协议。
- v0 不提供公开 batch/bulk 写入；Web 的拖拽一次只移动一张卡，不能通过多选、拖拽多卡或隐藏循环制造批量写接口。
- 公开首页与认证后 Web UI 公共文案至少支持 English 与简体中文，并允许用户随时切换；这不引入业务内容自动翻译或 Skill/API locale。
- 同一 Worker 可以通过多个有效域名访问，但实例只发布一个 preferred API/Web origin。页面不替 Cloudflare 管理域名，也不把跨域 Session/Passkey 迁移伪装成普通导航。
- Web 客户端技术栈固定为 Vue 3 + TypeScript + Vite；视觉实现遵循仓库根目录 `DESIGN.md` 的 warm editorial workbench 基线。该选择不改变同 Worker Static Assets 的部署拓扑，也不授权开始实现。

## 3. 产品表面

### 3.0 未认证首页

任何人直接打开实例根地址时先看到一个极简公开首页，而不是 Credential 输入框或空白错误页。首页说明 cfKanban 是 Agent-first Kanban、当前地址是一个独立部署实例，并在视觉中心提供一段可以直接复制给 Agent 的短话术；话术指向同实例、同语言的专用 `deploy-guide.md`，由该指南逐步说明 Skill 安装、环境前置、计划/授权、Cloudflare 部署和读回，并继续把具体发行真相交给项目声明的 canonical HTTPS pointer 与 immutable manifest。首页不把通用 README 当作部署指南，也不内嵌可执行 shell、远程脚本或 secret。

首页可以显示 Owner 明确开启 Public Join 的多个 Project 卡片，每张只包含 Project 显示名称、有界公开摘要与 `reader | writer` 选择，不得枚举未公开 Workspace/Project、内部 context、成员、Issue 数量或其他实例事实。canonical 项目站点可以复用产品介绍和部署话术，但没有某个部署实例的登录状态或 Public Join。

若当前请求 origin 与实例发布的 preferred origin 不同，未认证首页可以显示一个清楚标注的“推荐地址”链接；页面仍可在当前有效 alias 上工作，不把这个差异显示成实例错误。它不得自动携带 URL 中的 capability、长期 Credential 或已有 cookie 跳转到新 origin。

首页标题按 English/简体中文分别固定两条有意换行的短句，并通过 locale-specific 响应式字号保证每一条在 320px 窄屏内不再次断行或造成横向溢出。页面以一条克制分隔线和简短页脚收尾；页脚只提供品牌短句、部署/加入指南、OpenAPI、源码、Service 版本与缩短的 Instance ID，不扩张为站点地图、营销面板或第二套导航。

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
- Project/Workspace 恢复确认必须列出会随容器恢复而重新公开的 Public Join Projects，并显示其公开 role 选择与三项 quota 摘要。确认恢复后这些仍 enabled 的 Policy 自动恢复；已单独关闭的 Policy 保持关闭，UI 不增加“恢复但保持暂时隐藏”的第二套状态。
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

Owner 管理面按四个简单分区组织：Overview、Workspaces/Projects、Access、Audit。它不做可配置 Dashboard；Overview 只展示实例自身能够读取的健康、版本、资源计数、preferred/current observed origin 与近期错误摘要。preferred origin 在 Web 中只读，页面提供一段让 Owner 交给 `cfkanban-admin` 的简短话术；修改只能使用 Owner Bearer Credential，避免一个被劫持的 Cookie Session 把后续 Agent Credential 导向攻击者地址。Web 不保存 Cloudflare API token，也不声称提供权威 account quota/usage 或域名清单；Cloudflare-native domain reconcile 属于 `cfkanban-deploy`，第三方 alias 由 Owner 明确提供。

Audit 默认读取实例级 domain + security 最近事件，同时提供一个 Project 与一个 stream 的可选筛选。页面显示当前事件的 stream 与 Project scope；改变筛选会清空旧列表并开始新的 cursor 序列，不能把旧 `next_cursor` 接到新筛选上。Project 选择器仍遵守 Owner 页面既有的有界容器清单；超出 Web 清单的 Project 由 `cfkanban-admin` 使用 immutable Project ID 精确读取。

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

### 3.5 多域名与推荐入口

- 根页面、静态资源和 API 都以本次请求 origin 同源工作；服务端不把认证请求 30x 到 preferred origin，也不跨 origin 复制 cookie、CSRF token、launch code 或页面状态。
- `/.well-known/cfkanban-instance.json` 是公开、动态、`no-store` 的机器发现入口，Web 只把其中的 preferred origin 当作展示和生成未来链接的提示，不把任意新 origin 的自报当作信任迁移证据。
- Agent 新建 Browser Launch、Invite 话术与后续可复制链接时优先使用已经安全绑定的 preferred origin。已经生成的旧 URL 不在后台改写；只要旧 alias 仍绑定同一 Worker，就按原 origin 完成其一次性交换。
- Web Session cookie 是 origin-specific；换域名后用户需要在新 origin 重新建立 Session。cfKanban v0 主动把 Passkey RP ID 固定为当前 hostname，不启用跨 hostname 共享；换 hostname 后 Agent Browser Launch 是重新进入和登记的恢复路径。
- 已认证页面只显示非干扰性的推荐地址提示，不自动重定向。这样可以避免正在编辑的内容丢失，也不会把旧 origin 的 Session 或 capability 错误地当作能跨域继承。

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

路由形态固定为 `/app`、`/app/w/{workspace_key}/p/{project_key}`、`/app/issues/{identifier}`、`/app/admin` 与 `/app/launch?code=...`。它们是 Web 信息架构入口，具体 API 调用仍以 Frozen API/Schema 合同为准。

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

launch/Session 生命周期、源 Credential 失效联动与 target scope 已按 D-217 确认；§8 只保留确认结果和后置增强。

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

Owner Overview 必须只读展示实例当前的单 Principal 120/60 秒、实例动态 API 300/60 秒、未认证敏感操作 30/60 秒门槛、配置来源，以及有界的近期 429 摘要。它们是近似频率门控，不是精确业务 quota；Web 不提供编辑或“保存”按钮。需要调整时，页面给出调用 `cfkanban-deploy` 的简短 Agent 话术；实际动作是显式 Worker 配置部署，不运行 D1 migration。

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

### 5.3 视觉克制

仓库根目录 [`DESIGN.md`](../../DESIGN.md) 是第一方 Web 的视觉与交互设计真相源；本文继续负责产品、安全和行为合同。已确认方向是温暖浅色、纸张般安静、以单一深橙色主操作色组织的工作台；标志可以使用更明快的橙色，控件与链接使用满足对比度要求的深橙色，不再保留蓝色品牌交互层。

- 默认 Board 不设置持久重型侧栏；Workspace/Project、搜索、语言、身份/Session 与一个主要创建动作收敛在紧凑顶部区域。
- 五列依靠排版、间距、细分隔线和轻微表面差异组织；普通卡片无阴影，不使用玻璃、渐变、霓虹、装饰插画或 cards-inside-cards。
- 拉丁 Project 页面标题可以使用克制的系统 serif 建立编辑感；高频控件、中文界面、卡片和正文保持系统 sans，Issue identifier 使用系统 monospace。v0 不加载第三方字体。
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

v0 固定：Browser Launch 生成后 5 分钟内可兑换且只能成功一次；Web Session 固定有效 8 小时，不滑动续期、不提供 refresh token。Session 绑定 `principal_id + source_kind + source_id`：Agent Launch Session 的 source 是发起 launch 的 Credential，Passkey Session 的 source 是完成认证的 Web Authenticator；对应 source revoke 或 Session 显式 revoke 都立即使其失效，Project Grant 始终按请求实时校验。

Agent Launch Session 同时按 launch target 限定 Web scope：Project target 只访问该 Project；Issue target 只访问该 Issue 所属 Project，并以该 Issue 为初始页面；Owner `admin` target 才允许访问实例级管理与数据面。普通 Project/Issue Session 即使对应 Principal 还有其他 Grants，也不能靠导航扩大 scope，需要切换时由 Agent 创建新的 Browser Launch。Passkey Session 没有旧 launch target：参与者先选择当前有权 Project，Owner 先进入 Overview 并可以显式选择任意 Workspace/Project；两者都不自动执行无 Project filter 的 Issue 聚合读取。

五分钟给普通浏览器复制/切换留出余量，一次性与 target scope 又限制了暴露；八小时覆盖一个工作日而不形成长期网页登录。到期时已打开页面清除已渲染的远端业务数据；刷新或下一次 API 请求返回稳定的 Session 过期错误并清除 cookie。页面只引导用户让 Agent 重新打开当前 target，不显示密码框或 Credential 粘贴入口。写入到期失败时不自动重放；尚未提交的本地表单文本可以暂存在当前页面内存中，待新 Session 建立后由用户重新判断并提交，但不能写入 Web Storage。

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

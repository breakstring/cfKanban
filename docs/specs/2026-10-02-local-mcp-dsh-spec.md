# 本地 MCP、共用 Vue 工作台与 DSH 接入增量 SPEC

- 文档状态：Frozen
- 授权依据：2026-10-02 用户要求在 `feat/v1.8.0` 完成 CFK-548、CFK-544、CFK-546，并授权本机 DSH 桌面 / Web、网络与 LLM 验证；随后明确采用本地/线上两种 WebUI、共享 Vue、列表/看板快捷修改及复制编号/链接/原始 Markdown，取消发送到 Agent 和重复交接摘要。2026-10-03 授权 [CFK-563](https://cfkanban.dev/app/issues/CFK-563)：通用技能按宿主可用能力打开视图，由 DSH 插件提供 Agent 侧栏导航工具。
- 适用范围：本地 stdio MCP、通用回环 Web 服务、共用 Vue 精简工作台、Skills 本地/线上打开能力与 DSH 薄适配；不修改 REST / D1 的业务语义。
- 上游：[Bootstrap](2026-08-28-agent-skills-bootstrap-spec.md)、[API / Schema](2026-08-28-api-schema-spec.md)、[发行生命周期](2026-09-20-stable-release-lifecycle-spec.md)。

## 职责与边界

MCP adapter、本地 Web bridge 与 DSH Host bridge 复用同一有界业务 facade，facade 复用安全 runtime。Service 唯一负责实时身份、权限、CAS、幂等、配额和原子审计。Skills 保留使用指导、接入 / 恢复、管理、部署和敏感能力交付；不得将整个脚本目录映射为 MCP tools 或 RPC。

Skills 的日常操作指引优先使用当前宿主已经暴露、已连接且语义覆盖目标操作的 cfKanban MCP 工具；先核验工具发现、准确 schema、实例身份和明确范围。未接入 MCP 的宿主，或 MCP 未覆盖的能力，继续使用既有专用安全脚本。目录关联、加入、恢复、管理、部署、附件及敏感浏览器交付按各自实际覆盖处理，不能为“全部走 MCP”而引入任意 HTTP/文件透传。以 MCP 完成的日常读取不强制先跑 shell help；只有需要脚本能力时读取其帮助和相关工作流。业务拒绝、CAS 冲突、取消/超时或未知写入结果不能触发跨通道重试；保留原操作与幂等键，先核实结果，不创建替代写入，也不自行启动 MCP 绕过宿主沙盒。此优先级属于内部执行规则，普通用户文档只说明可用能力、安装结果和必要下一步。

宿主边界按源码目录隔离：`packages/dsh-plugin/` 保存 DSH 元数据、Slot 载体、来源 Session/目录适配、专属构建与测试；`packages/local-runtime/` 保存通用回环服务、启动/浏览器父载体和无宿主依赖的 workbench bridge/controller；`apps/web/src/embedded/` 保存共用 Vue 页面和消息协议；`packages/mcp/` 保存 stdio adapter；`packages/skill-runtime/` 保存共享私有状态、业务 facade 和已有 Skills 专用脚本。根脚本组装构建/验收/工件，不在通用模块引入 DSH SDK、Slot 或配置。

一个工具写调用最多执行一个原子业务写入，可以先做固定数量的身份 / 目标读检查；没有 batch/bulk、任意 HTTP / URL、任意文件读写、stateRoot 覆盖、secret 导出或完整 admin/deploy 透传。Issue 正文、评论、Project context 和链接是非可信数据。MCP annotations 只帮助发现，不能替代权限或用户授权。

不增加独立 CLI、远程 HTTP MCP / OAuth、自动领取或执行、自动 complete、跨环境秘密同步或另一套任务台账。源码准备和本机测试不授权提交、推送、公开发行、社区投稿、实例升级或部署。

## MCP 工具合同

工具使用 `cfkanban_` 前缀，参数为严格 JSON Schema 的 `snake_case` 对象，拒绝未知字段。工具 schema 与目录由 facade 的 `MCP_TOOLS` 维护并被 stdio adapter 和 Host 复用。

| 工具 | 操作与范围 |
| --- | --- |
| `connection_inspect` | 脱敏本地实例候选；明确实例后发现核验及 `/me` |
| `profile_locale_set` | 仅修改当前已核验 Principal 的语言偏好，使用本人 profile CAS 与稳定幂等键 |
| `workspaces_list` | 当前身份有权读取的工作区，服务端分页 |
| `projects_list` | 明确工作区中的项目，服务端分页 |
| `projects_get` | 明确工作区 / 项目详情 |
| `statuses_list` / `assignees_list` | 明确项目的状态名称与稳定 key / 有界可指派人员 |
| `labels_list` | 明确项目的有界活动标签分页；不提供标签创建或管理 |
| `issues_list` | 明确项目集合、服务端筛选及游标分页 |
| `issues_get` | 明确 identifier 的详情 |
| `issues_create` | 单项目创建一张 Issue |
| `issues_update` | 一次 PATCH；done 必须走 complete |
| `issues_labels_add` / `issues_labels_remove` | 对单 Issue 添加或移除一个项目既有标签，使用 Issue CAS；移除关联不删除标签 |
| `comments_list` / `comments_create` | 单 Issue 评论查询 / 单条追加 |
| `relations_list` / `relations_create` / `relations_delete` | 单 Issue 查询 / 一条关系建立或移除 |
| `issues_complete` | 原子 complete，保存实际摘要、验证、产物及后续事项 |

表中工具均带前缀 `cfkanban_`。实例和容器使用稳定 UUID；身份不从显示名或 OS 推断。列表保留服务端 `resolved_scope`、`next_cursor`、`has_more`、`allowed_actions` 等字段。查询页大小上限 100，不通过全历史扫描或后台轮询维护面板。Issue 列表默认要求明确项目；全授权聚合仅接受显式 `allow_unfiltered: true`，结果回显扩大后的实际范围。

每个写请求必须提供稳定 `idempotency_key`；API 合同要求 CAS 的已有资源变更提供当前 `expected_version`，关系操作沿用两端 CAS。追加评论沿用 append-only API，只要求稳定幂等键。工具不能自行编造 key、忽略冲突或将终态更改映射为普通状态 PATCH。服务端验证错误和恢复信息保留；本地异常只返回固定脱敏分类，不回传任意异常 message、栈或子进程输出。

## 私有状态、绑定与恢复

每次调用重新读取实际执行环境私有 `.cfkanban/`，核验 ownership / mode / ACL、symlink、metadata 与 secret 一致性、身份切换锁及可信 origin。长期进程不缓存 Credential。一次调用固定已验证的 instance / origin / current credential 快照用于发现、`/me`、目标预读和业务请求，避免先用身份 A 读、切换后用身份 B 写。下一次调用看到轮换、撤销或切换；正在进行的请求不能被本地切换追溯取消，远端实时权限仍为最终判断。

每个本地/DSH视图使用内部 `binding: { instance_id, expected_principal_id, project_ids }`。Client 不能覆盖 binding。身份改变要求用户重新选择并核验；同 Principal 的 Credential 轮换由下一调用重读。针对 identifier 的操作先核对真实 Issue Project，关系检查双方，不能只相信 Client 自报的项目。

所有请求有界超时并接收 AbortSignal；stdout 只输出 MCP 协议消息，诊断走固定脱敏 stderr。取消、超时、连接中断或进程退出不证明远端未提交。写已发出而响应未核验时返回 `outcome_unknown` 和原请求 key；调用者保留原参数 / key，先读回，必要重试使用完全相同请求，不能生成另一笔写。普通只读失败和 CAS 冲突不能被解释为成功。

视图写入在首次异步权限 / CAS 预读前，由 Host 登记完整原请求与幂等键，并区分尚未发送和可能已发送阶段。预读取消或暂时失败仍可显式恢复同一请求，恢复时重新核验权限与 CAS；明确拒绝保留确定失败结果，不发送业务写入。已发送阶段继续沿原参数 / key 核实结果，恢复预读失败不得继续发送。页面刷新不能使仍保存的原 checkpoint 因 Host 缺少预读阶段记录而永久锁住视图。

语言保存与单 Issue 标签增删沿用该账本和 checkpoint。语言原请求使用当前 binding、`operation:set_locale`、Principal `expected_version`、`change:{locale}` 与原 key，不携带 Issue identifier；只接受 `en` / `zh-CN`，不能透传其它 profile 字段或目标身份，reader 也可修改本人偏好。标签原请求固定为 `label_add` / `label_remove`、Issue 当前 version 与单个 Label UUID；Service 实时核验其归属、活动状态和写权限。未知结果锁住新写入及绑定切换，恢复保留原请求、原 CAS 与原 key，不以偏好或标签读回相等替代幂等结果核实。

多个 MCP 进程和 Skills 可以读取同一私有状态。凭据写入仍由现有专用锁 / 原子落盘处理，MCP 不新增凭据写入口。测试区分锁拒绝、轮换一致性、并发业务请求和崩溃，不声称现有局部锁覆盖一切并发。

## 工件与生命周期

Git plugin 投影保存指引和源码，不携带 ignored 的预构建页面。投影的本地 `web open` 在自身固定构建布局缺失时，只能加载当前环境私有 canonical Skill active 中同发行的完整预构建 runtime；先核验私有路径、receipt、完整 tree、发布者/来源以及投影内容一致性。缺失、被修改或版本/来源不符须明确拒绝，不接受 Client 路径覆盖，不在启动时构建、拉包或改用线上模式。

预构建 `mcp/server.mjs` 提供 stdio 入口，`mcp/facade.mjs` 提供 Host 内部业务接口；构建包含固定 SDK 依赖与 runtime，不依赖源码 checkout、启动时编译、开发机 node_modules、npx/bunx 或在线拉包。Node 基线为 `>=22.12.0`。宿主配置使用已核验 Node 的绝对路径与固定工件入口；带空格路径使用 argv 数组，不拼 shell。

MCP、`local-runtime/{server,launcher,browser,workbench}.mjs` 与固定 `local-runtime/embedded/{embedded.html,embedded-build.json}`、metadata/第三方声明随完整 Skill bundle 分发。DSH 元数据单独生成，包含 `dsh.bundle`、Cordis patch、四 Skills 全部资源、共享 runtime、MCP 预构建入口、同字节通用 Web runtime/Vue 页面与 Client / Host 产物；不把 Codex manifest 当 DSH metadata。Vue 页面由现有 Web Vite / Nuxt UI 工程生成，JS、CSS 与 logo 内联，不在安装或启动时下载依赖。版本跟随 `release/version.json`，摘要与不可变 bundle 绑定；源码测试包明确记录 checkout / dirty 状态，不能冒充 canonical release。已有公开发行资产不改写，未来发行资产 / manifest 由原有工程生成流程纳入，不能手改生成结果。

DSH 使用独立 filesystem provider，保留其它 providers；官方 MCP client 使用独立 cfKanban server entry，保留其它 servers。面板可独立停用。配置移除 / 卸载不删除 `.cfkanban/` 身份或历史。更新 active pointer 不更新运行中的 MCP；宿主必须停止 / 重启并通过 initialize 和连接检查核验实际版本。

2026-10-03 用户明确将受支持宿主的 MCP 启用纳入默认安装体验：外层 Agent 在已授权 cfKanban 安装/更新范围内核对宿主支持，通过宿主公开配置机制注册已校验的绝对 Node/工件入口并执行初始化、工具发现和连接核验；已有 DSH 插件配置不重复添加。不修改无关服务器或绕过沙盒/宿主拒绝，不由底层 bundle 安装器猜测宿主并隐式写配置。保留明确只安装 Skills 的用户选择；宿主不支持、工件缺失、Node 不兼容或必要批准未完成时报告具体未完成项，不能仅凭文件已安装声称 MCP 就绪。身份尚未建立时可以验证启动与空候选，但不能声称业务鉴权成功。首次加入/部署可在其安装步骤使用同一默认，不额外改变业务授权和既有凭据处理。

## 通用本地 Web 服务与打开模式

2026-10-04 的[导航与 Issue 层级增量](2026-10-04-issue-hierarchy-navigation-spec.md)覆盖下述普通视图闲置删除、无 view 时退出及分组列表展示条款；固定 8 小时上限和实时身份 / 权限核验继续有效。

保留本地 stdio MCP，增加按需回环服务；Worker 仍托管 REST 与线上 Web，远程 Worker MCP/OAuth 是独立后续设计。MCP 降低部分宿主 shell 沙盒访问私有状态的摩擦，但实际运行用户、OS/ACL、容器及宿主限制仍适用，不保证所有 Agent 沙盒可访问同一 home。

服务只监听确切 `127.0.0.1` 的系统分配随机端口，Node `>=22.12.0`，启动先核验固定工件 release/protocol/files 摘要，安装或启动不编译/下载。服务在当前进程内持有，不 fork 全局 daemon。单次随机 `/launch/<code>` 能力60秒有效，专用交付换为干净 `/view/<UUID>/` 地址和每 view 独立 HttpOnly/SameSite=Strict Cookie，Cookie路径与该view API一致，不覆盖其它视图。普通视图30分钟无请求后由服务端拒绝。Cookie仅存活至服务固定8小时截止，原pending视图可在普通超时后核实原操作，新视图不能继承；无未确定写入时闲置15分钟关闭，服务最长8小时。

所有API严格校验实际端口对应的Host、同源Origin、JSON/CSRF、method、body大小、固定endpoint及并发/速率上限；不开放宽CORS或任意HTTP/文件透传。未认证请求不枚举本地身份。父载体只拿受控bridge结果；Vue不拿Cookie/CSRF或长期凭据。每view独立Bridge/Controller，不能通过换视图继承另一binding。API取消/超时实际传AbortSignal，不以外层超时掩盖仍运行的写请求。

浏览器父载体加载同一Vue srcdoc与专属MessagePort。当前认证view可在进程内保留严格校验的Controller checkpoint，页面刷新恢复原binding/pending；Host核对checkpoint与其当前绑定、原请求及key精确匹配，旧页面不能替换正在恢复的操作；不落文件或浏览器存储。普通关闭遇pending拒绝并保留原请求/key；强制终止不自动重放，不承诺跨进程恢复，应按原操作读回核实。进程关闭丢失未提交草稿，不能据此推断远端未提交。

Skills 新增 `web open`：项目/Issue默认 `mode:local`，要求真实工作目录，支持准确instance/target；显式 `mode:online` 使用既有Browser Launch。旧 `web launch` 保持线上兼容。管理/Workspace管理目标本地拒绝 `LOCAL_TARGET_UNSUPPORTED`，不静默切模式。未知明确目标不选择其它实例。可信宿主上下文确认Codex App且可用IAB工具时优先本地IAB，先 `web preflight` 验证同环境回环可达；不从环境变量猜宿主，不绕过明确宿主拒绝。其它已支持浏览器通过已核验的指定交付路径打开。

本地启动能力只经专用relay callback或系统opener即时交付，不进入普通结果/文件/日志/回复；本地HttpOnly会话不同于线上5分钟Browser Launch与Web续期。父载体提供“在系统浏览器打开完整看板”，先重新核验当前Principal/Project/Issue，再将expectedPrincipal绑定到同次凭据快照，通过已有专用Browser Launch helper交付；线上ticket不进入Vue/MessagePort。打开结果未确定时保留原目标/key并锁住绑定切换与新写入，页面刷新继续恢复原操作，不创建替代launch。通用父载体与DSH父载体复用同一在线交付broker；已知结果保留到父载体以预先生成且由Host核验生命周期内不重复的非秘密receipt ID明确确认收到。同目标恢复只回放已知脱敏结果，旧确认不能清除后续新交付。Host保留有界已用ID且不淘汰，容量耗尽时明确拒绝新交付，待原操作解决后重启所属服务。DSH Host多个Tab共享在线交付恢复状态，启动前同时核对业务写入的预读在途状态与未确定账本，不允许两类恢复互相阻断；ticket不经Client路由返回。

## DSH 桌面与 Web

依据 [DSH 官方桌面说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)，桌面是 Electron 包装的共享 Web Client / Host，但使用独立 `desktop` profile 和随应用提供的运行时。Web profile 的安装不等于桌面安装。桌面目录选择、浏览器载体、PATH / Node 与 profile 更新分别验收；不得用普通 npm 安装的 CLI 修改桌面 profile。

同一 Client / Host 实现通过官方 right-sidebar / slots / RPC 适配两种载体。官方 React Slot 仅提供挂载载体与 Host 适配，业务界面由同一 Vue Web 嵌入页面承载，不复制 React 任务 UI。独立文档隔离样式、弹层、焦点及滚动锁；不注入 DSH DOM 或覆盖聊天样式。浏览器不读取本机私有状态或接收长期 Credential。

DSH `0.2.0-rc.2` 的 `connection.rpc.handle` 在默认 Connection provider 中缺少 `webServer` 注入，实机不能由调用方追加注入修复。适配使用公开 `connection.fetch.register` 注册固定 `/api/cfkanban-panel/<endpoint>` POST 路由，保留官方 RPC envelope / correlator，并复用原 `/api` admission、Host Origin、认证、请求上限和取消信号。路径、method、protocol 和字段分别严格核验；没有任意路由或方法透传，不修改用户已有 Connection 配置或认证载体。

该版本 Client RPC channel 只接受单段路径，使用 `/api` channel 和 `cfkanban-panel/<endpoint>` method，不能把 `/api/cfkanban-panel` 当 channel。Host 固定核对完整命名空间再映射逻辑端点；真实官方 Client、默认 Connection admission 和安装后的桌面 / Web 都必须验证，不能只用自制 RPC mock 证明兼容。

首版支持用户明确授权的本机单用户 Host。Host 要求可用的官方 WebServer 服务，仅在确切回环监听且当前 operator Peer 匹配时开放 RPC，未知 / 公网载体拒绝；不靠 Client hostname 判断。DSH operator Peer 不是每个浏览器用户的独立 OS 身份，远程 / 多租户 Host 共享同一 OS Owner 凭据不受支持。远程服务器、容器及 WSL 的 home 与本机 home 独立，缺失凭据走该环境已有接入流程，不自动搬运秘密。

## 共用工作台、快捷操作与复制

### Agent 打开宿主视图

通用技能首先发现当前宿主已暴露的视图工具及准确 schema；业务目标仍由原 MCP / 安全 runtime 解析核验，不新增 DSH 专用 Skill 或将宿主界面控制混入通用业务 MCP。普通项目 / Issue 打开优先可用宿主工作台，否则沿既有本地浏览器路径；明确侧栏、指定浏览器或线上模式时遵守用户选择。缺少侧栏工具或界面时直接报告，不为打开而翻插件源码、猜内部路由、安装插件或擅自换载体。权限拒绝、目标不符和结果不确定不能触发跨载体重试。

DSH 插件提供 `cfkanban_view_open`，只接受明确 `instance_id`、`workspace_id`、`project_id` 和可选 `identifier`；来源 Session 取自宿主工具执行上下文，不允许模型指定 Session、任意 URL、文件路径或 Credential。Host 复用业务 facade 核验实时身份及准确目标，导航不得写入业务数据或关联文件。一个前台 Client 订阅自己的 Session 导航；无可用 Client、多 Client 歧义、取消和超时返回固定分类，不将请求转发到另一聊天。订阅经已有 Connection admission 的固定 RPC，等待事件后重建；没有定时业务查询或持久导航队列。

Client 使用官方 `sidebarRight.openTab` 与导航参数展开并复用 cfKanban 标签，保留原会话归属。已有未确定业务写入或线上投递先恢复，不能被导航覆盖。Host 发出请求仅表示投递；Client 核验当前前台 Session、准确身份 / 项目 / Issue，并等待共用 Vue 页的匹配渲染确认后才回报 `opened`。未确认、超时、界面关闭、切换会话及迟到结果都不冒充打开成功。

共用 MessagePort 增加可选 `render_check` / `rendered` / `render_cancel`，不改变既有 protocol 1 的快照和业务动作合同。确认使用一次性随机非秘密 nonce，绑定准确实例、身份、工作区、项目及可选 Issue；Vue 应用最新快照并完成渲染后回传。新快照、替代等待、取消、超时及卸载使旧确认失效；确认本身不授予权限、不执行写入、不携带凭据。

### 视图与业务操作

官方右侧 Tab 与聊天并排。面板展示已核验 Instance / Principal / Project，提供项目切换、Kanban/列表、项目 / 我的任务筛选、分页、详情、状态 / 优先级 / 负责人、评论与完成证据，通过手动刷新取新数据。写入口按 `allowed_actions` 展示；冲突先刷新核对，响应不确定保留原 key。任务数据源仍为 Service。

聊天入口使用现有 cfKanban logo 图标，提供双语可访问名称及 tooltip。面板打开时由 Host 核对来源 Session 及其准确 DSH 工作区；本地浏览器使用启动时已核验的真实目录。两者只读取该目录固定的 `.cfkanban-scope.json`，沿用 schema 2 的 UUID targets。单目标在可信实例、实时 `/me` 和项目权限核验后自动绑定；多目标先在推荐范围内选择，不静默选第一个。无文件、非法文件或无权目标保留明确结果和手动入口，不退回全实例聚合；Client 不能提交路径或扩大读取范围。读取有界并拒绝 symlink，返回仅包含固定分类和已校验的非秘密 targets。自动绑定不领取、执行或写入 Issue。

面板沿用 [Web 视觉合同](../../DESIGN.md) 的字体、间距、控件层级与中性表面，并应用实时核验的本人 `theme`（暖橙或静蓝，未设置时暖橙），复用 Vue / Nuxt UI、Markdown 与完成记录组件，宽窄屏均使用完整状态列的横向看板，与完整版共享状态跳转导航（数量表示已加载事项，另有下一页时标注“+”），提供可见且可访问的横向滚动提示和每列独立滚动区；窄侧栏调整工具栏、弹层和卡片布局，同时保留同一业务能力。父载体的线上打开、恢复和关闭使用图标按钮，说明放在当前语言的tooltip及可访问名称，不同时铺开双语长文案。每次列表/列查询最多25条，最多5个状态；列内和列表滚动接近底部时自动追加下一页，与完整版保持一致，移除“第一页”按钮，保留手动加载作为无滚动空间或辅助技术的后备。按 identifier 去重且保留更高 version，失败保留既有事项与原 cursor，明确重试；同一 cursor 的连续滚动不重复请求，切换项目/筛选/视图或主动刷新使迟到响应失效。每列与列表最多累计1000条摘要及40次成功分页；累计集合不超过1MiB，公开快照仍受2MiB与20k结构节点上限约束；达到容量保留现有事项和远端仍有数据标识，显示筛选或完整看板提示，不冒充已加载全部。列表/列投影不携带正文，正文通过详情按需读取。不显示未经验证的全量总数，不因resize修改业务状态。项目名称、任务标题和业务状态优先；准确身份、origin 和 UUID 保留在信息图标打开的连接详情；筛选按需展开，已应用条件显示数量。项目菜单与完整版共用展示组件，支持搜索、当前项目标识和键盘操作，数据范围仍由各自宿主实时核验。打开菜单失败保留原绑定和当前事项。通用嵌入页面不依赖 DSH SDK，也不启动 WebSession、Cookie 认证、全站 router 或普通 Web 的全局 API 状态；它通过明确的 Host 能力获取数据，不伪造其它 Web API 或以任意 HTTP 透传补齐能力。正文与评论不接受原始 HTML，不自动加载外部图片；链接仍需用户显式打开，相对链接以已核验的实例 origin 为基准。

DSH 将自包含页面挂载为 opaque `srcdoc` iframe，仅开放 `allow-scripts allow-popups allow-popups-to-escape-sandbox`。不开放同源、顶层导航或表单提交。页面 CSP 默认拒绝资源及网络请求，脚本仅允许构建产物的内联摘要，图片仅允许 data URL。页面不访问宿主 DOM、浏览器存储或凭据。

每个 Slot 视图拥有独立 Controller、iframe 和 MessagePort。父载体仅向该 iframe 发送一次 `cfkanban.embed.connect` / protocol 1 及专属 Port；opaque origin 所需的 `*` 仅用于不含业务数据的初始连接。子页面核对 `event.source === parent`、协议及唯一 Port，此后快照、动作与结果仅经 Port 传输。双端严格核验动作白名单、字段与请求上限；没有任意 RPC / URL。Session、binding、路径、幂等键和请求恢复由父 Controller / Host 管理，子页面不能覆盖；Slot 所属 Session 不随其它聊天激活而重绑。停用及 Slot signal 终止清理 Port、订阅、请求和 Controller；保留挂载的后台 Session 视图保留自身状态。

2026-10-04 用户授权 CFK-567：本地工作台页头提供 English/简体中文切换；绑定项目后通过固定 Host 能力保存本人服务端 `locale`，快照优先应用本人已保存的偏好，无偏好时采用宿主语言。保存沿 Principal CAS、幂等与原操作恢复合同，不建立独立主题设置页或改变宿主主题。主题在打开及显式刷新时读取，不增加后台轮询。

Issue 详情移除窄屏独有的“查看属性”跳转，属性区域仍按同一响应式布局呈现。详情显示当前标签，writer 可逐个添加项目已有标签或移除当前标签；reader 只读，不提供标签创建、改名、删除或恢复等管理入口。候选按项目有界分页与名称筛选，每次只写一个标签关联，使用当前 Issue CAS 与幂等；Client 不提交 version/key 或其它项目的候选。失败保留当前标签，不确定结果使用原操作恢复。

列表/看板每行直接修改优先级、负责人和状态，复用Web的PrioritySelect、AssigneeMenu与UI主题。父Controller仅从当前已加载行取version，核对当前绑定与真实Issue，再执行单笔CAS/幂等写；iframe不能提交version、key或扩大项目。可指派人员按准确项目有界分页；无权/已失资格不静默换人。快捷完成打开详情完成表单，不把done映射为PATCH。冲突保留草稿并要求核对，不确定写锁住切换并保留原操作恢复。

各载体统一提供复制准确CFK编号与canonical实例Issue URL；详情正文与每条评论旁可复制原始Markdown。复制动作不执行Agent、不改变Issue状态、不创建分享能力；复制链接也不提供接收者权限。剪贴板被宿主限制时显示原文本供手动选择，不伪造复制成功。取消发送到Agent、自动prompt/执行会话关联和重复交接摘要区，DSH来源Session用于scope目录核验与显式请求的侧栏导航。该展示合同覆盖基础WebUI SPEC原 `/context`摘要展示条款；服务端有界context API继续供Agent按需读取最新业务信息。复制和Issue内容不构成新增授权。

## 验证证据要求

根验证包含协议生命周期、schema、业务权限 / CAS / 幂等 / 不确定响应、私有状态 / 身份绑定、固定工件、通用 Vue 页面及 DSH bridge 测试。隔离 Worker / D1 与明确的 Skill E2E Project 分别提供行为证据；后者不能隔离部署 / migration。真实 DSH smoke 分别记录桌面与 Web profile、DSH / Node / OS、工件摘要、四 Skills 加载、MCP 调用、右栏、快捷编辑、复制及浏览器交付及卸载恢复，并核验嵌入页面窄屏布局、弹层隔离及消息连接。

macOS、Windows 原生、Linux、WSL 各自报告实际证据；本机 macOS 不代替其它平台。缺失 / 不兼容 Node、GUI PATH、空格路径、ACL 漂移等未覆盖项逐项记录，不把静态核对、help 或 metadata 通过当作真实宿主全能力验收。

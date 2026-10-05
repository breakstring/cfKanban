# 官方桌面插件工作台增量 SPEC

- 状态：Draft，CFK-600 授权实现及隔离验收的基线；当前桌面宿主实际安装和生命周期验收后再决定冻结
- 日期：2026-10-04
- 关联：[CFK-600](https://cfkanban.dev/app/issues/CFK-600)
- 基础：[本地 MCP / DSH](2026-10-02-local-mcp-dsh-spec.md)、[Foundation](2026-08-26-agent-native-kanban-foundation-spec.md)、[导航与层级](2026-10-04-issue-hierarchy-navigation-spec.md)

## 范围与共用

在现有本地 stdio MCP 上增加官方 Plugin Extensions 的 global 和 thread 入口，直接挂载共享 Vue 工作台。继续使用同一安全 facade、Controller、Bridge 和受控动作协议。现有 DSH 和独立本地工作台保留自己的连接适配，不嵌套 iframe，不建立第二个业务客户端或任务事实源。

适用当前支持 Extensions 的桌面客户端，不提供旧版兼容、远程 HTTP MCP、OAuth、公共目录发布、自动发送对话、mentions、Model-App Context、deep links 或执行会话关联。Service 继续核验身份、权限、CAS、幂等、审计和领域规则。只有一个已校验本地实例候选时自动核验其当前 Principal，并打开可访问的默认项目；多个候选且没有明确目标或可重新核验的偏好时保留连接选择，核验失败不切换其他身份。thread 入口由 Agent 在可信对话目录解析仓库推荐与默认，global 使用独立偏好；用户可在工作台切换所有有权限的工作区及项目。MCP 不以长期进程 cwd、聊天 ID 或客户端目录猜测仓库。

## 官方协议与可信边界

依据 [Extensions](https://developers.openai.com/plugins/build/extensions)、[入口协议](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#mcp-app-entrypoints)、[MCP Apps 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/v1.7.5/specification/2026-01-26/apps.mdx) 和 [结果 metadata](https://developers.openai.com/plugins/reference#tool-results)。官方协议允许自行实现有界 JSON-RPC bridge；本增量不引入浮动 SDK 或启动期依赖安装。

global 入口接受严格空对象 `{}`；thread 入口接受严格可选 `target` 或 `recommended_targets`，以及可选 `repository_key`，声明相同的 `_meta.ui.resourceUri`。`cfkanban_workbench_open` 只声明 `_meta["openai/ui"].entrypoints = [{type:"thread"}]`，`cfkanban_workbench_global_open` 只声明 `[{type:"global"}]`；服务端以实际工具名区分入口，不以页面 displayMode 或客户端字段推断。调用只初始化视图、核验身份并按入口读取范围，不执行业务写入。发行工件的资源 URI 为 `ui://cfkanban/workbench/<release_version>/<html_sha256>/index.html`，其中 `html_sha256` 是实际 HTML 字节的 SHA-256；MIME 为 `text/html;profile=mcp-app`。`resources/list` / `resources/read` 仅交付固定静态工件，不承载身份、视图 ID、请求、快照或凭据；资源可以被宿主预取或缓存。

每次入口调用由服务端生成新的非秘密 UUID `view_id`，经 tool-result `_meta["cfkanban/viewId"]` 交付。它只用于定位当前 MCP 进程内独立的服务端视图对象，不是 Credential、授权能力或聊天身份。页面只存内存，在后续 tools/call 的 `arguments.view_id` 返回；不使用请求 `_meta` 传递视图或动作 ID，因为当前原生 Extensions 适配器会丢弃自定义请求 metadata。旧版 32 字节秘密句柄不改名、不转入 arguments，新协议生成全新的 UUID。视图 ID 不进入 content、structuredContent、URL、日志、widgetState、浏览器存储或文件；静态资源读取不创建视图。

当前 stdio 与官方 metadata 没有足以认证宿主聊天归属的合同。`openai/session`、`openai/widgetSessionId`、JSON-RPC ID 和 SDK transport session 不能被当作业务身份或可信聊天 ID。本增量承诺**每次入口调用的服务端对象隔离**，不宣称防止持有同一视图 ID 的可信本机调用者访问该对象。只连接获准的本机单用户 Host；app-only visibility 是发现提示，不能替代视图对象校验、私有身份与 Service 授权。缺失、无效、过期或 MCP 重启前的 ID 必须拒绝，不能回退最近视图、全局视图或默认项目。

## UI 调用与状态

| 工具 | 业务输入 | 用途 |
| --- | --- | --- |
| `cfkanban_workbench_open` | `{target? 或 recommended_targets?, repository_key?}` | 创建独立 thread 视图并实时核验初始项目 |
| `cfkanban_workbench_global_open` | `{}` | 创建独立 global 视图 |
| `cfkanban_workbench_snapshot` | `{view_id, action_id?}` | 获取当前对象的白名单快照及可选原动作 receipt |
| `cfkanban_workbench_action` | `{view_id, message: ActionMessage}` | 执行现有受控导航或单笔写入 |
| `cfkanban_workbench_release` | `{view_id}` | 显式释放没有运行或待恢复操作的对象 |

后三项声明 app-only。`view_id` 和可选 `action_id` 严格校验 UUID，逐次检查目标视图，拒绝额外字段、客户端 binding、版本、业务 key、凭据、路径和任意 HTTP 目标。`ActionMessage.id` 是页面动作 receipt ID，不是业务幂等键。动作继续经过共享协议校验、Controller 和 Bridge；内部 operator 只用于复用单用户 stdio admission，不代表跨聊天授权。

模型可见结果仅为 `{ok,protocol:1,version,error?:{code},outcome_unknown?}`。白名单 `SnapshotMessage` 在 `_meta["cfkanban/snapshot"]` 中交付；不能序列化原 Controller state、checkpoint、Bridge result、binding ID、业务 key 或游标。英文和简体中文、看板 / 列表、详情、原 Markdown 与稳定编号 / URL 复制复用同一组件。语言优先采用当前 Principal 已保存的偏好，没有可用偏好时采用宿主语言，再回退当前浏览器系统语言；任何中文使用简体中文，其余或未知使用英文。没有偏好时快照省略 locale，不能将服务端默认英文误作已保存设置；宿主初始化与后续语言通知不覆盖有效账号偏好。默认状态和产物类型标签使用共享本地化显示，机器 key 与业务内容保持原值。

snapshot 可在 `arguments.action_id` 提供原页面动作 UUID，结果 `_meta["cfkanban/actionReceipt"]` 仅返回当前视图的 `{id,result:PublicResult|null}`。运行中或没有记录均为 null，不返回请求内容、fingerprint 或业务 key。同一动作 UUID 在两个视图中不能共享 receipt。写入桥接超时后，即使新快照的 pending 已清空，页面仍须核对原 receipt；已知成功或明确拒绝才解除该动作锁，未知则沿原 pending 显式恢复。不能以快照值看似相同推断原动作提交。

## 全局入口偏好与默认项目

global 入口在本机私有 `.cfkanban/workbench/codex/last-project.json` 保存最后一次成功绑定的项目推荐；文件严格只含 `instance_id`、`principal_id`、`workspace_id` 和 `project_id` 四个 UUID。使用私有路径校验、属主 / 权限检查、拒绝 symlink 和原子写入；读取损坏、不可信或不可用文件时忽略偏好，保存失败不妨碍当前视图操作。此偏好与 CLI 的 context、仓库关联和 thread 视图相互独立，不新增服务端业务事实。

重新打开 global 入口时，只能从当前本地已校验实例候选中匹配偏好，重新读取当前 Principal 并验证其与记录完全一致，再核验项目及工作区归属和实时访问权限。偏好失效但身份仍准确时，可在该身份下按有界项目发现选择首个可访问项目；没有有效偏好时采用同样默认。仍有多个未解决的实例候选时先选择连接，没有可访问项目时保留手动选择。不得从偏好授予权限、跨身份回退、全实例无界扫描或猜测 repo 范围；项目切换继续可用，只有成功绑定才更新推荐。

thread 入口不读取或更新全局偏好文件。没有仓库推荐时，单个已核验实例也自动打开可访问默认项目；多个未解决连接仍需选择连接。全局推荐不恢复视图 ID、binding、筛选、选中 Issue、草稿、receipts、pending、业务请求或幂等键；不确定写入仍须在原视图沿原操作核实。

## 对话仓库推荐与上次项目

本增量同时依据 2026-10-04 用户授权完善仓库自动打开、最后项目记忆及跨工作区切换。Agent 使用当前对话可信的绝对工作目录，只读完整 bundle 的 `context show --directory ... --json --no-interactive`；没有 CLI 时使用 `scope inspect-directory`。后者确认 Git 仓库时返回 `workbench_context_key = canonicalDigest({directory:scope_directory})`，CLI 透传此字段；子目录归一到工作树根，不同 worktree 独立。非仓库、未知或不可用时为 null，不从目录名、Git remote、Skill 目录或 MCP 进程 cwd 推断业务目标。

`target` 严格只含 instance / workspace / project 三 UUID；`recommended_targets` 为 1..50 个唯一的同形 target，二者互斥。`repository_key` 只接受 64 位小写 hex，也可单独提供以恢复未配置推荐的仓库上次项目；它只定位本机偏好桶，不认证仓库、聊天或业务权限。入口拒绝目录、URL、角色、凭据和额外字段。明确项目或兼容的 CLI `saved_directory` 默认以 target 打开；这类目标失效保留具体诊断，不默默换项目。否则将完整仓库推荐集合交付服务端，先恢复该仓库上次项目；没有有效记忆时按推荐顺序验证并打开首个可访问项目。只可跳过已明确无权或不存在的项目，网络、认证和身份漂移不能触发跨身份回退；不会从推荐集合扩大到任意全局项目。

仓库偏好在私有 `.cfkanban/workbench/codex/repositories/<repository_key>.json` 保存与全局同形的四 UUID，复用全部安全路径、权限、文件及原子写校验。成功初始绑定或用户主动切换后更新；用户选择的项目可在仓库初始推荐之外，下次仍须实时核验准确 Principal、Project 与 Workspace。记忆中项目 403/404 时，仅在同一准确 Principal 下回到仓库推荐；身份改变保留诊断。无效 key 或不存在的仓库桶不读取全局偏好。此记忆不修改 `.cfkanban-scope.json`、CLI 显式 context 或服务端事实，不保存目录、请求、pending 或业务 key。

## 跨工作区项目切换

全部共用工作台复用 `ProjectSwitcherMenu`，当前已验证实例与 Principal 的可访问工作区按组展示项目。新动作 `project_menu {workspace_id?,next?}` 只读菜单，不清空当前 binding、Issue 或筛选；`project_switch {workspace_id,project_id}` 只接受当前已加载候选。菜单每页最多八个工作区、每组最多五十个项目，工作区及项目分别分页、检测重复游标，翻页可继续到达后续项目，不进行无界预取。公开快照只投影菜单分组、是否还有下一页和脱敏错误，不公开游标或 binding ID。

切换使用原已验证 Principal 重新检查新 Project/Workspace 和 statuses，验证成功后客户端应用新绑定并清除原项目页面；失败保留原看板。Bridge 在新引用首次请求确认交付前保留旧引用，回复丢失时旧引用继续可用；旧引用请求不确认新绑定交付。每个 Bridge 最多暂存一个未确认替换，后续替换、明确放弃或视图关闭时清理；正常收到新引用后不累计绑定。确认或淘汰旧、新引用前均核对未知或在途写入，不丢弃 pending；这些交付规则同时适用于共享层的 Codex、DSH 与本地浏览器载体。内部私有 `replace_binding_id` 不进入页面动作。global 与具备 repository_key 的 thread 只在成功切换后更新各自最后项目。

## 共享工作台受控增量

本 Draft 授权实现同时为全部共用工作台补充 `create_issue {change:{title,body?,status_key?,priority_key?}}` 和已有 update 的 title / body 字段，保持 Service API 不变。标题为非空字符串、最多 256 字符；正文最多 65,536 UTF-8 字节，允许清空，安全渲染仍沿原 Markdown 合同。动作 envelope 上限增至 262,144 字节，覆盖合法正文的 JSON 转义；集合和快照上限保持原合同。

创建 capability 只从当前已验证 Owner 或准确工作区 / 项目 writer grant 投影。Bridge 在登记原 key 后重新读取身份和项目，按稳定绑定调用现有 `cfkanban_issues_create`；不接受客户端项目、Issue 编号或伪造创建 CAS。结果未知时沿完全相同目标、正文和 key 核实；拿到创建结果中的稳定编号后读回该 Issue。创建的原操作和 checkpoint 不带 expected_version，更新继续使用已显示 Issue 的真实 CAS。界面为新建 / 编辑保存当前页面内存草稿，未知或失败不清空，不自动重新提交。

页面先注册通知处理，再执行 `ui/initialize`；验证 parent source、协议版本、响应 ID 和消息形状后发送 `ui/notifications/initialized`。握手与初始 tool-result 均到达才能启用操作。tool-result 的 params 是完整 CallToolResult，不能误读为 params.result。重复同一视图 ID 只更新快照；已连接视图收到不同 ID 时拒绝替换。初始结果缺失、视图失效或 MCP 重启提示重新打开，不能从资源读取、聊天 ID 或缓存内容恢复权限。

页面处理 HostContext 主题 / 安全样式变量和 displayMode，不加载外部字体、样式、脚本或网络数据。资源声明空网络 CSP 与 clipboardWrite 权限；权限被拒绝时保留可选择文本 / 既有复制 fallback。链接保留明确用户点击的安全外链语义，不自动发送消息。pagehide 和 ui/resource-teardown 只关闭页面连接，不删除服务端待恢复操作。

## 写入、取消与生命周期

每个视图 ID 对应的对象独立拥有 Controller、Bridge、Adapter、绑定、筛选、选中 Issue 和 receipts。身份及项目约束由准确 instance / expected Principal / project IDs 固化；每次业务调用由 facade 重新核对私有状态和实时身份。权限撤销或 CAS 冲突不能靠 UI 快照绕过。

首次异步预读前登记原写入、身份、目标和业务 key。取消沿真实 AbortSignal 传递到 facade，不用外层 race 伪装终止；一次取消不删除整视图。未知结果继续锁住新写入与绑定切换，只能显式沿原请求恢复。重挂载、重复通知或超时不能自动重放动作。一个视图的运行信号不能被并发请求覆盖。

最多 128 个对象，闲置期限 8 小时。只有没有运行、没有 pending 的对象可以释放 / 淘汰；未知操作保留至明确核实或所属 MCP 进程结束。关闭进程清理 timer、Adapter、Controller、Bridge 和 registry，保留私有身份，不自动执行业务操作。本增量不承诺跨 MCP 进程保存工作台原操作；重启前应完成恢复，意外退出后经原操作证据核对，不以重启证明远端未提交。

## 工件与分发

同一不可变 Skills bundle 的 `mcp/` 增加 `workbench.html` 和构建 metadata；运行时资源版本与 server 版本一致，摘要、大小、文件集合和本地 CSP 在打包前校验。资源 URI 同时绑定发行版本和已核验 HTML 内容摘要：即使本地候选沿用相同版本号，HTML 字节变化也使用新的 URI，使宿主选择对应内容的缓存。HTML 随源码构建预生成，不在宿主启动时编译或安装依赖。Node 继续使用已核验的绝对路径及 `>=22.12.0` 基线。现有 MCP 连接只注册一次；源码 / Git 插件投影不是已验证 canonical release。

品牌图形使用同一简洁看板线条 SVG。Codex 导航遵循官方 `currentColor` 单色图标约束；可用彩色图标的位置使用透明背景的橙色 `#D86F45` 线条版本，覆盖 Web UI、文档、favicon、插件展示及 DSH 入口。PNG 与 favicon 由同一 SVG 源生成，不分别绘制或缩放旧复杂 logo；此变化不改变业务主题或布局。

按现有安装与 MCP 配置流程指向已验证完整 bundle。新版宿主按工具 metadata 发现入口；安装 / 更新前先核实原视图未确定写入，更新后关闭旧工作台、重启所属 MCP、读回运行版本与新资源 URI，再从入口重新打开。只刷新旧视图不能证明已加载新工件。停用或卸载仅移除属于该连接的入口，不删除私有身份和历史。公共 universal directory 的远程 endpoint 要求与本地 marketplace / stdio 示例分开核验，不从官方本地示例推导公共发布资格。

## 验收边界

协议 fixture 覆盖空输入、资源预取、两个对象及同动作 ID receipts 隔离、额外字段拒绝、只读身份、writer / reader、身份漂移、CAS、取消、未知结果同 key 恢复、pending 保留、资源损坏与 spaced path / empty PATH 离线启动。另模拟宿主丢弃全部请求 `_meta`，验证仅 arguments 即可完成快照、动作和 receipt 核对，以及无效 / 过期 / 重启前视图 ID 不回退。前端 fixture 覆盖握手次序、parent source、通知重放、视图 ID 替换拒绝、超时、teardown 与 HostContext。偏好 fixture 覆盖私有路径、严格字段、损坏 / 不可信文件、身份或权限失效、global 默认与 thread 独立、不恢复 pending / key。共享工作台及 D1 的既有安全测试继续执行。

渲染检查使用隔离业务 fixture，验证窄 / 宽布局、键盘、双语、主题和实际点击；普通浏览器 fixture 不替代官方桌面发现、安装、挂载、重开、更新、停用和卸载验收。当前桌面实际验收受工具或环境限制时，CFK-600 保持进行中并记录缺口，不把源码测试或 DSH smoke 宣称为官方宿主通过。

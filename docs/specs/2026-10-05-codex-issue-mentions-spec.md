# Codex Issue 引用增量 SPEC

- 状态：Draft；用户授权 CFK-601 编号引用及 CFK-605 持久搜索优化的实现和隔离验证，宿主实际支持与性能证据另行验收
- 日期：2026-10-05
- 关联：[CFK-601](https://cfkanban.dev/app/issues/CFK-601)、[CFK-605](https://cfkanban.dev/app/issues/CFK-605)；同步与缓存遵循[持久搜索索引增量](2026-10-05-persistent-search-index-spec.md)
- 基础：[Foundation](2026-08-26-agent-native-kanban-foundation-spec.md)、[API / Schema](2026-08-28-api-schema-spec.md)、[本地 MCP](2026-10-02-local-mcp-dsh-spec.md)、[Codex 工作台](2026-10-04-codex-workbench-spec.md)

本增量只覆盖此前工作台 Draft 排除的 Composer mentions；不改变入口、业务操作、公开列表及详情语义。实现依据 [OpenAI Extensions](https://developers.openai.com/plugins/build/extensions) 及其[官方 mentions 协议](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#composer-at-mentions)。宿主声明、实际触发频率、预取和选中后的上下文交付须在提供对应能力的真实桌面客户端核验。

## 输入与身份范围

专用 `cfkanban_mentions_search` 仅接受严格 `{query:string}`。MCP initialize 响应通过 `capabilities.experimental["openai/mentions"] = {searchTool:"cfkanban_mentions_search"}` 声明搜索工具，工具保留 `_meta["openai/extensions"]["mentions/search"]` 和 app-only visibility。现代 capability 决定宿主按 query-only 协议调用；仅有旧工具 metadata 时，已核对的宿主会走附带 `path:[]` 的 legacy 分支，不能替代 initialize 声明。不扩展输入以接受 legacy 控制字段。

MCP initialize 通过标准 `serverInfo.title: "cfkanban-search"` 提供用户显示名，保留稳定 `serverInfo.name: "cfkanban-mcp"`；搜索工具的 title 和 description 说明用途。普通本地 MCP 的 `_meta.connector_name` 会被 Codex App Server 过滤，不能用该保留字段改名；已核对桌面菜单按保留的 connector metadata、serverInfo.title、serverInfo.name、宿主注册名顺序取显示名。工具名、query-only 协议和业务工具保持不变。插件合并菜单可能使用插件 displayName，真实客户端显示另验。客户端先从 `@` 菜单选择 provider，再在名称标签后输入纯查询；手打包含服务名称的整串文字不构成 provider 选择。

完整、大小写准确且数字为正安全整数的 `CFK-N` 精确匹配优先；至少两位的 `CFK-60` / `60` 也匹配编号前缀。标题或标题片段至少两个 Unicode 字符，采用 NFKC 和大小写无关片段匹配，不匹配正文或评论。空输入、只有 `CFK-` 或过短输入返回空候选。可信 HTTPS `/app/issues/CFK-N` 链接可定位实例，禁止用户信息、查询参数和片段；无效链接不能回退为标题查询，也不请求输入 URL。

候选只在一个明确本地可信实例中查询私有 SQLite，验证当前本地身份绑定，不发送 HTTP 或等待同步。多个实例必须以可信规范链接定位，歧义、未知 origin 和本地连接错误明确返回错误，不遍历实例。不用 MCP cwd、最近工作台或未经验证聊天 metadata 推断范围。缓存同步使用明确所选实例中的当前授权范围，新获权项目先补齐历史快照。

候选允许上次成功同步的标题短暂过期；撤权或删除可能在后台同步确认前仍显示旧候选。引用包含稳定 instance、Principal、Project、Issue ID 和编号，不授予当前权限、不选择 Credential。资源读取只接受当前进程已发出的引用，重新核验 discovery、`/me`、原目标及实时权限；身份、归属或 trusted origin 改变时重新选择，不跨身份重试。

## 轻量公共读取

新增只读 `GET /api/v1/issues/{identifier}/reference?projection=mention|resource`，默认 `mention`。与日常 API 共用实时认证、活跃容器、有效 reader grant 和 Cookie Session scope，编号使用唯一索引点查。`mention` 只投影稳定 ID、编号、标题、Project 与 Workspace ID / 名称；`resource` 另投影当前正文、状态、优先级、版本、更新时间。此路径不装配评论、关系、层级、标签、历史计数或 Project context，不替代原 `get` / `context` 的完整语义。

Discovery 与 Meta 静态声明 `capabilities.issue_reference: true`，不新增数据库查询。MCP 在发送 Credential 请求前要求 discovery 明确支持；旧实例返回 `MCP_ISSUE_REFERENCE_UNSUPPORTED`，不把缺失路由的 404 当作零候选，也不自动升级实例。普通日常工具兼容不变。

资源正文在 D1 查询阶段最多取 8192 个 UTF-8 字节，保留完整 Unicode 字符。`body_bytes` 表示原正文总字节数，`body_truncated` 明确任何截断；控制字符的 JSON 转义还可能触发响应总预算裁剪。评论、关系及更多正文由 Agent 后续按需读取。未匹配或无权资源仍遵循既有不泄露存在性的错误合同，后端失败不能转为空候选。

公共 CLI 的 `issue reference` 与 MCP 共用该只读 Service 语义，原 Issue 详情命令保持完整含义；Web 的现有详情路径无需改变。候选与资源的区别为载体读取优化，不新增数据权限或领域动作。

## 预算与生命周期

| 项目 | 硬边界 |
| --- | --- |
| mentions query | 4096 UTF-8 字节 |
| 候选 | 最多 10 条，完整 MCP tool result 最多 32768 字节，精确编号先于前缀/标题 |
| 资源 | 完整 MCP resources/read result 最多 32768 字节 |
| Service 投影 | 候选 4096 字节、资源 16384 字节；正文最多 8192 UTF-8 字节 |
| 同进程 admission | 最多 2 个运行、8 个排队、启动间隔至少 300 ms；候选与资源共用预算 |
| 端到端 deadline | 从排队开始最多 5 秒，取消传入真实 fetch / body I/O |
| 引用登记 | 最多 512 条非秘密目标；淘汰、未知引用或 MCP 重启后重新选择 |

每个请求有独立取消信号，不能用“最后一次输入”取消其他聊天。同一已核验本地身份/实例/origin/query 的在途查询可共享，订阅者取消互不影响；全部取消或共同 deadline 才中止共享操作。队列满、超时和能力错误明确返回。`resources/list` 继续只列固定 UI，不枚举 Issue。后台 SQLite 同步按持久索引增量的启动/30秒活动/5分钟idle生命周期运行，不由每次输入发起 HTTP。引用登记只核验是否由本进程发出，不缓存正文或 ACL；宿主可能预取的资源仍实时核权并受上述预算限制。

## 验收边界

协议 fixture 应通过 initialize 的实际 server capability 选择现代调用参数，再执行候选搜索与资源读取；缺失 capability 时构造 legacy 参数须能暴露拒绝，不能仅断言工具 metadata。预构建 stdio 工件同样核验 initialize 声明。已核对的桌面客户端版本为 26.930.51102；其公开 Composer 实现的静态核对不替代用户测试电脑的真实安装、调用与可见候选验收。

隔离 fixture 覆盖候选无 HTTP、标题/前缀/精确排序、单实例 / 多实例 / trusted link、首次准备/重启、身份切换、撤权后的过期候选与实时拒绝、Credential 撤销、容器暂停、Cookie scope、目标漂移、正文边界、JSON 转义、队列、间隔、并发、真实取消和错误区别。不同规模的 Issue / 评论 / 关系数据覆盖同步和读取，记录 D1 `meta.rows_read/rows_written`、请求 / 查询数量、响应大小与冷暖延迟；只看 LIMIT、索引计划、防抖或缓存不构成成本验收。

本地 D1 fixture 的 rows_read 是隔离环境测量，不能冒充 Cloudflare 线上计费证据。真实桌面发现、搜索、候选选择、资源交付、错误展示与调用频率需记录客户端和实际 MCP 工件版本；源码及 mock 通过不替代该验收。内容随新的不可变版本分发，不原地改写已发行包或 tag。

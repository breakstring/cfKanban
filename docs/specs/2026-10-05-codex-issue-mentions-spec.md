# Codex Issue 引用增量 SPEC

- 状态：Draft；本轮用户授权 CFK-601 的编号优先实现及隔离验证，宿主实际支持与性能证据另行验收
- 日期：2026-10-05
- 关联：[CFK-601](https://cfkanban.dev/app/issues/CFK-601)
- 基础：[Foundation](2026-08-26-agent-native-kanban-foundation-spec.md)、[API / Schema](2026-08-28-api-schema-spec.md)、[本地 MCP](2026-10-02-local-mcp-dsh-spec.md)、[Codex 工作台](2026-10-04-codex-workbench-spec.md)

本增量只覆盖此前工作台 Draft 排除的 Composer mentions；不改变入口、业务操作、公开列表及详情语义。实现依据 [OpenAI Extensions](https://developers.openai.com/plugins/build/extensions) 及其[官方 mentions 协议](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#composer-at-mentions)。宿主声明、实际触发频率、预取和选中后的上下文交付须在提供对应能力的真实桌面客户端核验。

## 输入与身份范围

专用 `cfkanban_mentions_search` 仅接受严格 `{query:string}`，按 `_meta["openai/extensions"]["mentions/search"]` 和 app-only visibility 注册。仅支持完整、大小写准确且数字为正安全整数的 `CFK-N`，或已校验私有实例 metadata 中 trusted origin 的 HTTPS `/app/issues/CFK-N` 链接；链接不得有用户信息、查询参数或片段。解析输入仅用于匹配本地可信实例，不请求输入 URL。

空输入、`CFK-` 前缀及不支持格式返回空候选，不读取远端。编号仅在一个明确本地实例时精确读取；多个实例必须以已信任的规范链接定位，歧义、未知 origin 和连接错误明确返回错误，不遍历远端实例。不得用 MCP 进程 cwd、最近工作台或未经验证的聊天 metadata 推断范围。标题搜索不属于本增量。

候选请求验证私有当前身份、discovery 连续性及 `/me` 返回的 Principal / Credential fingerprint，随后调用轻量精确点查。引用包含稳定 instance、Principal、Project、Issue ID 和编号；这些非秘密值不授予权限、不选择 Credential。资源读取只接受当前进程已发出的引用，再逐次检查当前身份、原目标及实时权限。身份、归属或 trusted origin 改变时重新选择引用，不跨身份重试。

## 轻量公共读取

新增只读 `GET /api/v1/issues/{identifier}/reference?projection=mention|resource`，默认 `mention`。与日常 API 共用实时认证、活跃容器、有效 reader grant 和 Cookie Session scope，编号使用唯一索引点查。`mention` 只投影稳定 ID、编号、标题、Project 与 Workspace ID / 名称；`resource` 另投影当前正文、状态、优先级、版本、更新时间。此路径不装配评论、关系、层级、标签、历史计数或 Project context，不替代原 `get` / `context` 的完整语义。

Discovery 与 Meta 静态声明 `capabilities.issue_reference: true`，不新增数据库查询。MCP 在发送 Credential 请求前要求 discovery 明确支持；旧实例返回 `MCP_ISSUE_REFERENCE_UNSUPPORTED`，不把缺失路由的 404 当作零候选，也不自动升级实例。普通日常工具兼容不变。

资源正文在 D1 查询阶段最多取 8192 个 UTF-8 字节，保留完整 Unicode 字符。`body_bytes` 表示原正文总字节数，`body_truncated` 明确任何截断；控制字符的 JSON 转义还可能触发响应总预算裁剪。评论、关系及更多正文由 Agent 后续按需读取。未匹配或无权资源仍遵循既有不泄露存在性的错误合同，后端失败不能转为空候选。

公共 CLI 的 `issue reference` 与 MCP 共用该只读 Service 语义，原 Issue 详情命令保持完整含义；Web 的现有详情路径无需改变。候选与资源的区别为载体读取优化，不新增数据权限或领域动作。

## 预算与生命周期

| 项目 | 硬边界 |
| --- | --- |
| mentions query | 4096 UTF-8 字节 |
| 候选 | 最多 1 条，完整 MCP tool result 最多 4096 字节 |
| 资源 | 完整 MCP resources/read result 最多 32768 字节 |
| Service 投影 | 候选 4096 字节、资源 16384 字节；正文最多 8192 UTF-8 字节 |
| 同进程 admission | 最多 2 个运行、8 个排队、每秒最多启动 4 次；候选与资源共用预算 |
| 端到端 deadline | 从排队开始最多 5 秒，取消传入真实 fetch / body I/O |
| 引用登记 | 最多 512 条非秘密目标；淘汰、未知引用或 MCP 重启后重新选择 |

每个请求有独立取消信号，不能用“最后一次输入”取消其他聊天。取消不改变 Credential 或业务状态；队列满、超时和能力错误明确返回。`resources/list` 继续只列固定 UI，不枚举 Issue，也不建立后台轮询。引用登记只核验是否由本进程发出，不缓存正文或 ACL；可能的宿主资源预取同样受上述 admission、时间和字节边界限制。

## 验收边界

隔离 fixture 覆盖零远端无效输入、单实例 / 多实例 / trusted link、未知资源和重启、身份切换、权限及 Credential 撤销、容器暂停、Cookie scope、目标漂移、正文边界、JSON 转义、队列、频率、并发、真实取消和错误区别。不同规模的 Issue / 评论 / 关系数据覆盖命中、零匹配和连续输入，记录 D1 `meta.rows_read`、请求 / 查询数量、响应大小与端到端延迟；只看 LIMIT、索引计划、防抖或缓存不构成成本验收。

本地 D1 fixture 的 rows_read 是隔离环境测量，不能冒充 Cloudflare 线上计费证据。真实桌面发现、搜索、候选选择、资源交付、错误展示与调用频率需记录客户端和实际 MCP 工件版本；源码及 mock 通过不替代该验收。内容随新的不可变版本分发，不原地改写已发行包或 tag。

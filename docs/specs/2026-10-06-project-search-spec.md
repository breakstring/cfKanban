# 项目类型化搜索与即时快捷候选

- 状态：Frozen
- 授权依据：2026-10-06 用户要求在 `feat/v1.10` 完成 [CFK-624](https://cfkanban.dev/app/issues/CFK-624)
- 基础：[API / Schema](2026-08-28-api-schema-spec.md)、[Web UI](2026-08-29-web-ui-spec.md)、[Issue 筛选](2026-09-29-issue-query-filters-spec.md)、[公共 CLI](2026-10-04-public-cli-spec.md)

## 兼容搜索合同

Issue 普通列表、项目列表、待领取候选和项目 counts 新增可选 `q_mode=typed`。省略该参数保留既有 `q` 的完整编号精确 OR 标题子串语义及原 cursor filter hash。typed 只扩展显式选用它的调用；[持久搜索索引](2026-10-05-persistent-search-index-spec.md) 的普通列表兼容边界仍成立，不修改 Codex provider 或其 SQLite 生命周期。

typed 对输入执行 Unicode NFKC、lowercase、首尾清理，规范化后最多 128 UTF-8 bytes。标题至少两个 Unicode code points，字面子串匹配，不解释 pattern、不搜索正文或评论。裸编号必须从 1～9 开始且至少两位；完整 `CFK-1` 允许单个位。编号最多 16 位且不得超过 JavaScript safe integer；前缀或裸数字无效时拒绝，不回退标题。`cfk-` 大小写无关，兼容全角输入。空白 Web 输入可显式清除搜索，HTTP 的空 `q` 拒绝；省略 `q` 不过滤。重复 `q_mode`、非 typed mode 及 typed 重复 `q` 均拒绝。

`CFK-62`、`62` 都只按编号前缀匹配 62、620、624 等，不同时搜索数字标题；`CFK-624` 同样匹配精确 624 及 6240 等前缀，精确不存在仍保留其他前缀结果。所有搜索仍限定所选项目、当前 Principal、Credential/Session、有效授权及删除范围，不能因输入编号跳转其他项目。其他结构化筛选 AND 联用，分页前过滤。业务列表仍按原更新顺序或候选队列顺序；counts 使用相同搜索类型、文本及筛选，保持独立读取的快照边界。typed cursor 额外绑定 `q_mode`，不能与旧 q 或其他类型/文本混用。

编号前缀转为最多 16 个互不重叠的整数区间，通过既有 `issues.number INTEGER PRIMARY KEY` 查询，再按实时项目授权及其他筛选收敛。区间使用 BigInt 计算并封顶 MAX_SAFE_INTEGER，绑定为一个 JSON 参数，保持 D1 参数预算。编号查询不加 schema、索引或额外写入；标题子串、排序、聚合计数和剩余筛选仍可能随匹配规模增大，不宣称固定读取上界。保留实际本地 rows_read、rows_written 与 EXPLAIN 证据，不能代表线上计费。

公开 CLI 的 `issue list / project issue list / issue candidates / issue counts` 提供 `--q-mode typed --q ...`，Agent 的 `issues_list` 支持同名可选字段；HTTP/OpenAPI 为各入口提供等价模式。旧调用方无需变更。

## Web 的两个明确动作

项目看板、列表及共享工作台复用同一搜索组件。输入阶段只计算当前 `columns[*].items` 的真实事项；不读取列表生成的父项上下文，不发送请求、不翻页、不展开组、不更新计数或 appliedSearch。已加载池可能受已提交关键词和结构化筛选限制，界面标明“当前已加载结果中的快捷匹配”；存在旧搜索时说明来自当前结果。

候选按 stable ID 去重，保留最高 version，同版本保留最新 updated_at，排除已删除或非当前项目项。编号候选精确项优先，其余编号升序；标题候选按 updated_at DESC、number DESC、stable ID 排序。最多显示 10 个，并明确截断；零候选说明“已加载事项中未找到，可搜索项目”。过短/无效输入显示输入提示，不当作无匹配且不能提交 HTTP。

点击候选或方向键显式选中后 Enter 打开既有详情入口；不隐式提交草稿，返回保留此前应用的条件。默认没有活动候选，输入后直接 Enter 或“搜索项目”提交 typed 查询并刷新当前项目列表和 counts，保持所有已选筛选。折叠状态组仍显示最新匹配计数并可展开，不能把已加载组为空当作整个项目无匹配。

活动项按 ID 保存；池变化时复核，消失即清除，选中前再次检查当前池。Escape 收起并清除活动项；输入保留焦点，listbox/option、aria-activedescendant 和 polite 状态消息提供读屏反馈。指针按下阻止提前失焦，鼠标/触屏点击不会被 blur 丢失；IME composition 的 Enter 不提交或打开，结束后更新候选。候选标题使用安全 Vue 文本渲染。

项目、Principal、Session、权限变化清除活动候选和失效池，详情与后续操作仍实时核权。saving / 待恢复写入禁用搜索及候选导航，原 CAS、幂等、导航草稿、响应代次和分页隔离继续生效。多项目工作清单与 Codex provider 不改变。

## 验证

覆盖标题/中英文/全角/大小写、完整和裸编号、精确不存在的前缀、数字标题、最短及超长/unsafe integer 输入；候选最新版本去重、10 条截断、稳定 ID 活动项和池移除。组件验证默认 Enter 提交、显式选择打开、Escape、IME、pointer/blur、状态反馈及零新增网络请求。隔离 D1 验证旧 q、typed 列表/候选/counts、权限及项目范围、组合筛选、cursor 绑定、代表性规模与深页；CLI 和 MCP 验证模式传递。运行适用 typecheck、contracts:check、docs:check 和 git diff --check，记录未实测的浏览器或线上性能边界。[2026-10-06 本地读取证据](../research/2026-10-06-project-search-cost.md)保存实际测量及适用限制。

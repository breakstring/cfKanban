# 项目类型化搜索隔离验证

日期：2026-10-06。对应 [CFK-624](https://cfkanban.dev/app/issues/CFK-624) 与[增量合同](../specs/2026-10-06-project-search-spec.md)。

## 环境与范围

使用 `wrangler.wp02-test.jsonc` 的全零本地 D1 ID、`createTestHarness`、`127.0.0.1:0` 和 `persist:false`；没有访问部署实例。测试文件为 `scripts/tests/typed-issue-search.integration.test.mjs`，一次构造跨两个项目的 3,600 个编号，包含已删除项、数字标题、稀疏标题、优先级、负责人和标签。通过 D1 `meta.rows_read / rows_written` 与相同 SQL 的 `EXPLAIN QUERY PLAN` 验证读取；这里的延迟和计费读量不代表线上。

运行入口：`WRANGLER_LOG_PATH=/private/tmp/cfk-624-wrangler-logs WRANGLER_SEND_METRICS=false node --experimental-strip-types --test scripts/tests/typed-issue-search.integration.test.mjs`。临时日志只用于隔离执行环境，命令不读取凭据。

## 实际读取

下表为单条业务列表/聚合 SQL 的计量，不包含服务端鉴权和层级投影等其他查询。

| typed 查询 | 返回 | rows_read | rows_written |
| --- | ---: | ---: | ---: |
| 编号前缀 `62`，第一页 limit 3 | 3 | 98 | 0 |
| `62` + 高优先级，limit 3 | 1 | 76 | 0 |
| 空编号前缀 `9999`，limit 3 | 0 | 29 | 0 |
| 稀疏标题 `needle`，limit 3 | 3 | 1,779 | 0 |
| 空标题 `no matching title`，limit 3 | 0 | 2,515 | 0 |
| `62` 后续页，limit 3 | 3，SQL 额外读取一个分页探针 | 95 | 0 |
| `62` 按状态计数 | 2 个非空状态 | 75 | 0 |

编号前缀计划包含 `SEARCH prefix_issue USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)` 及最终 Issue 的 `rowid=?` 查找。该 range 源明确使用 `NOT INDEXED` 保留 rowid seek，防止优化器选项目排序索引并逐区间扫描项目；外层按原业务排序执行临时排序。编号区间数由安全整数的十进制位数限定，不增加索引、migration 或业务写入。

标题仍使用项目列表索引与字面 substring 剩余筛选；空和稀疏匹配的读取显著超过页大小。编号匹配数量、跨项目同前缀、排序、聚合及其他过滤也会增加读取；不能把上述结果推广为任意规模的固定上界。

## 行为与兼容性

五项 D1 用例通过：NFKC/大小写及项目范围；typed 与旧 q 语义分别保持；列表/counts/候选组合条件一致；分页排序和 cursor 模式隔离；请求中撤权拒绝旧结果。无效 mode、重复参数、过短/超长和 unsafe integer 输入拒绝。

`scripts/tests/web-project-search.test.mjs` 的六项组件用例通过，其中真实 ProjectBoardView 的看板和列表 fixture 连续输入、空匹配及改回编号触发的新增 list/counts/metadata 请求均为 0。显式提交才读取 typed 项目结果；列表未展开组保持未加载。键盘、IME、指针、最新版本去重、候选移除、待写入与身份重置由组件事件测试覆盖。

另用已有 Playwright Chromium 在隔离 fixture 中运行真实 ProjectBoardView 与 Nuxt UI，覆盖 1280×900 桌面和 390×844 触屏、中英文、方向键/Enter/Escape、合成 composition 事件、鼠标与触屏选择、十条截断及活动候选滚动可见；连续输入的新增请求为 0，控制台无错误、移动端无横向溢出。临时证据位于 `/private/tmp/cfk-624-qa/result.json` 与同目录截图。操作系统原生 IME、真实辅助技术播报和线上 D1 性能未实测。

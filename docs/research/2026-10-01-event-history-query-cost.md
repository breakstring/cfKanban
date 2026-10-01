# CFK-540 活动历史查询成本快照

- 日期：2026-10-01
- 环境：隔离本地 workerd D1，Wrangler TestHarness，`persist:false`、随机本地端口、全零测试 D1 ID。
- 合同：[活动历史倒序](../specs/2026-10-01-event-history-order-spec.md)。
- 可复现入口：`node --experimental-strip-types --test scripts/tests/event-history.integration.test.mjs`。
- 结果：8 项通过。覆盖时间与 sequence 不同序、同时间多页、多项目/stream、旧 feed/write cursor、历史读取期间新增、筛选/Principal/权限范围变化、跨项目关系、Owner 的 Project Session 范围、返回前撤权与查询成本。

## 深页读取

基础夹具在两个项目及实例安全流中写入 1540 条 Event，另有 bootstrap 与验收期间新增的事件；分页大小 20，比较第五页。旧查询将同一 SQL 强制绑定既有 sequence 索引（实例无筛选时使用原始表），新查询使用时间索引。两者结果逐行一致；完整投影返回 `limit+1=21` 条候选。

| 范围 | 旧 rows_read | 新 rows_read | 旧耗时 ms | 新耗时 ms |
| --- | ---: | ---: | ---: | ---: |
| Domain 单项目 | 493 | 232 | 10.43 | 4.53 |
| Domain 两项目 | 2164 | 320 | 15.90 | 8.46 |
| Owner 实例双 stream | 3143 | 166 | 34.88 | 6.09 |
| Owner 实例 security | 1179 | 154 | 9.61 | 4.32 |
| Owner 单项目双 stream | 710 | 305 | 8.90 | 4.05 |
| Owner 单项目 domain | 472 | 216 | 8.46 | 2.62 |

代表性 `EXPLAIN QUERY PLAN`：

```text
Domain:
SEARCH event USING INDEX idx_events_project_stream_history
  (project_id=? AND stream=? AND created_at<?)
Owner 全实例:
SEARCH event USING COVERING INDEX idx_events_history (created_at<?)
Owner 单 stream:
SEARCH event USING COVERING INDEX idx_events_stream_history
  (stream=? AND created_at<?)
Owner 单项目:
SEARCH event USING COVERING INDEX idx_events_project_stream_history
  (project_id=? AND stream=? AND created_at<?)
完整投影:
SCAN selected_event
SEARCH event USING INTEGER PRIMARY KEY (rowid=?)
```

外层可有临时排序，但它只归并每项目/stream的有界候选或最终一页。关系可见性检查保留在内部时间索引读取中，不先取一页后丢弃隐藏关系，也不泄露另一端项目。

## 首屏规模与写入代价

同一隔离数据库从 1547 条 Event 增加 1200 条另一项目的较早历史后，Domain 单项目首屏维持 `rows_read=230`，Owner 实例首屏维持 `rows_read=142`。首屏 Explain 为时间索引扫描受 `LIMIT` 截止，完整投影从已物化候选按主键读取。测试同时保护首屏和有时间 keyset 的深页，避免仅验证后续页。

完整投影使用 `CROSS JOIN` 固定由有界候选驱动。普通 JOIN 曾被本地 SQLite 优化器重排为沿整个时间索引扫描、再匹配候选；此形状虽有 `LIMIT` 和索引仍随历史增长，已由规模测试复现并修正。

在测试私有 D1 中，以完全相同的 Event INSERT 比较有无三个新增时间索引：原 `rows_written=7`，新增后 `rows_written=10`，额外三个索引项。测试结束前恢复全部索引，不修改任何线上资源。

这些数字为一次本地运行快照，耗时会随宿主负载变化。读取还受项目数、stream数、隐藏关系与被首屏 sequence 上界排除的事件分布影响；本快照不代表线上测量，也不宣称任意筛选只读取页大小。

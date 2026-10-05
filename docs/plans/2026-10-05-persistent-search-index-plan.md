# 持久搜索索引实施与验证计划

依据：[持久搜索索引 Draft SPEC](../specs/2026-10-05-persistent-search-index-spec.md)。动态任务与证据保存在 [CFK-605](https://cfkanban.dev/app/issues/CFK-605) 及关联执行卡；本文件只保存实施配方。

1. 追加 Service migration，以既有原子事件维护轻量搜索文档、相关变更、独立 revision 和有界保留；状态读取容器名称和授权范围，正文/评论不维护标题投影。
2. 实现逐项目 status/snapshot/changes，复用实时鉴权和 opaque cursor；建立稳定编号分页→增量追平测试，验证旧/迟到 revision、删除标记、保留失效和 Cookie scope。
3. 实现固定预构建 SQLite Worker、私有路径检查、事务、租约/fence/cursor CAS 和 staging generation。仅缓存标题 metadata，实际临时 HOME 中验证重启、多进程和中断恢复。
4. 为共享 facade 增加本地身份检查和受限后台同步读取；Credential 不离开安全 runtime。候选仅查询 SQLite；资源读取沿用实时 reference 权限合同。
5. 更新 provider metadata、编号前缀/标题分类、最多十条候选、排序和引用登记；平滑 admission、同 query 在途共享、订阅者独立取消。启动/30秒活动/5分钟idle控制后台同步，输入不等待网络。
6. 更新中英文使用说明、OpenAPI/migration 生成源及工件固定集合；执行定向测试、typecheck、contracts:check、docs:check、D1集成和根 validate。把真实环境缺口保留到在线验收卡。

所有数据库和身份 fixture 使用隔离临时路径；本地 Worker harness 使用全零本地 D1 配置，不读取真实用户凭据或在线项目。真实 Codex 和其他 OS 的验收只记录实际证据，不为这轮源码验证自动更新插件或部署实例。

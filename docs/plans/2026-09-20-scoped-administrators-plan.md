# 分级管理员实施计划

- 状态：Frozen
- 合同：[工作区与项目分级管理员 SPEC](../specs/2026-09-20-scoped-administrators-spec.md)
- 授权：2026-09-20 用户授权文档、cfKanban Development Issue 和源码实现；不包含 Git 提交/推送或部署。
- 执行任务：[CFK-421 总任务](https://cfkanban.dev/app/issues/CFK-421)、[CFK-422 后端](https://cfkanban.dev/app/issues/CFK-422)、[CFK-423 Web](https://cfkanban.dev/app/issues/CFK-423)、[CFK-424 技能与合同](https://cfkanban.dev/app/issues/CFK-424)；动态状态以线上任务为准。

## 实施顺序

1. 追加 schema 9，建立独立管理授权、有效项目访问、去重人数和邀请签发授权绑定；统一实时解析、Session 范围和原子能力检查。
2. 开放限定范围的容器、成员、普通邀请管理；补管理授权 CRUD、有效成员读取、empty Workspace 发现、审计与永久清理兼容。保持实例身份恢复、Public Join/配额、永久删除 Owner-only。
3. Web 添加工作区/项目管理入口、管理员和有效成员来源；Owner 页复用入口。按服务端 allowed_actions 驱动，不以 is_owner 替代局部能力。
4. 更新 OpenAPI、schema/readback 机器合同、双语技能及说明，确保用户级管理与部署权限分离。
5. 定向权限/配额/邀请/Session/迁移集成回归，执行项目 validate；将实际验证、产物及未发布边界写入结构化完成记录。

## 分工与集成

权限与 schema 合同由主代理负责；可并行将容器/普通成员/邀请接入、Web、技能与 OpenAPI 分别委托明确文件所有者。共享授权 helper、API 和迁移由主代理统一集成；任何合同分歧先协调，不能静默放宽范围。

## 验证重点

- 不同 Principal、不同工作区、同工作区不同项目及多人管理员的允许/拒绝矩阵。
- 升权/降权/撤权 CAS 与重放；撤权后未兑换邀请失效，重新授予不复活；已兑换普通成员保留。
- 直接授权与继承权限并集；重复身份只计一次；工作区授权任一公开项目满额时整次回滚。
- 归档/恢复、Public Join、空工作区、未来项目、assignee、关系、附件、事件 cursor 的一致行为。
- Owner 原功能和旧 reader/writer 均保持；局部管理员无全实例查询和身份恢复能力。
- Web 双语、实际交互与能力隐藏；技能禁止错误管理范围或一次性能力泄露。
- migration 单次 query 大小、schema artifacts、只读读回、生成工件一致性及旧数据不升权。

## 停止条件

遇到需改变已冻结矩阵、公开授权/配额口径或不可逆迁移合同的事实时，暂停依赖部分并报告；不以测试夹具或文档修改掩盖权限失败。不部署、不更新已安装技能、不擅自提交或推送。

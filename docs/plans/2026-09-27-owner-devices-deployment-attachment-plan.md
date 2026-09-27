# Owner 多设备与已有部署接入实施配方

- 合同：[Frozen SPEC](../specs/2026-09-27-owner-devices-deployment-attachment-spec.md)
- 执行：[CFK-443](https://cfkanban.dev/app/issues/CFK-443)

## 实施顺序

1. 扩展 Owner Bearer 的原子添加/撤销接口与可空设备名称，补 Principal CAS、审计、限额、现有轮换和全失恢复并发验证。保持通用 DELETE 与 Web 限制。
2. 新增 Skill 的 prepare/request/approve/verify/list/revoke；新设备本地生成 secret，旧设备冻结请求，最终化核对精确身份。使用两个隔离 home 验证响应丢失和重试。
3. 新增 deployment inspection/plan/attachment：真实控制面与 HTTP 调用、schema/ledger 核验、journal 授权、本地登记和 unknown provenance。扩展已有升级 receipt 基线，未知来源必须在后续升级计划显式接受。
4. 接入 CLI surface、双语操作说明、OpenAPI 与 migration 生成入口；同步现有合同引用，避免互相矛盾。
5. 运行相关单测、typecheck、contracts:check、d1:check 和 build；独立核对凭据泄露、跨实例、并发、接入来源和升级授权。

## 验证环境与交付

测试仅使用临时私有 home、注入模拟 Cloudflare/HTTP 和本地隔离 D1/Miniflare。不得访问用户真实 Credential 或将持久 cfkanban.dev 当作测试环境。线上操作仅为本任务已授权的 Issue 记录、关系和完成证据。

完成记录区分源码验证、已发行/已部署和真人跨设备验收；这轮不发行、不部署、不执行线上 migration，不提交或推送 Git。执行状态只保存在 Issue。

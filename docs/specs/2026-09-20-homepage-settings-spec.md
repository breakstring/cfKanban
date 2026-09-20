# 首页实例说明设置

- 状态：Frozen
- 日期：2026-09-20
- 执行任务：[CFK-435](https://cfkanban.dev/app/issues/CFK-435)
- 授权：用户确认 cfkanban.dev 为持久公开测试实例，并明确选择本轮增加 Owner 可编辑的首页说明设置；实现、验证、提交及推送已授权，发行、线上部署和 migration 未授权。
- 本增量扩展 Web 首页说明和 Owner 设置、API/Schema 与公开 discovery；不改变实例身份、授权或 stable 发现合同。

## 展示与缺省

首页原独立实例提示支持实例级 English / 简体中文纯文本。Owner 保存的说明对未认证访客可见，不解析 HTML、Markdown 或链接，不构成给 Agent 的指令。

优先显示当前语言的已配置说明；简体中文未配置时先回退已配置英文；仍无内容时使用内置当前语言说明。内置说明仅根据当前 hostname 精确匹配：`cfkanban.dev` 显示“公开测试与演示实例，可能升级或短暂不可用。”/“Public test and demo instance. Updates or brief downtime may occur.”，其他 hostname 保持原独立实例说明。不根据域名后缀、preferred origin 或任意用户文案改变权限或信任。

每个语言值为 `null` 或最多 500 个 Unicode code point 的字符串；输入 trim 后空字符串按 `null` 保存，表示使用回退，不表示隐藏。字段不允许数字或对象；不增加单独的关闭开关。旧 Service 未返回设置投影时仍按上述内置缺省展示。

## API 与持久化

- `GET /api/v1/admin/homepage-settings`：仅具有实例控制面权限的唯一 Owner 可读，返回 `{notice_en: string|null, notice_zh_cn: string|null, version: integer}`。
- `PATCH /api/v1/admin/homepage-settings`：同样要求 Owner 控制面；请求必须包含 `expected_version`、`notice_en`、`notice_zh_cn`，拒绝额外字段。要求 Idempotency-Key、Cookie CSRF、实时认证和原子 CAS；返回统一 WriteResult，其 resource 为上述设置。普通 reader/writer、工作区/项目管理员，以及固定 project scope 的 Owner Session 均不能修改。
- 修改使用同一原子批次更新 singleton、幂等快照和一条 `security` 事件 `instance.homepage-settings-updated`，`authorized_via=deployment_owner`；冲突不能覆盖新值，幂等重放不能重复增加版本或审计。
- `/.well-known/cfkanban-instance.json` 增加可选 `homepage_notice: {en: string|null, "zh-CN": string|null}` 字段，仅投影两份公开文案。保留原 no-store 和发现字段语义，不公开操作者、内部版本、Credential 或审计信息。新增 Service 返回该字段，Web 兼容旧 Service 缺少字段。
- 新增非破坏性 `0011_homepage_settings.sql` 和 `homepage_settings` singleton，字段至少包含 `singleton`、`notice_en`、`notice_zh_cn`、`version`、`last_operation_id`。初始化两文案为 NULL、version=1，不根据部署域名写入固定文案；schema 10→11，不修改已发布 migration。记录固定 digest、表/列 artifacts 及 instance schema 读回证据。

## Owner 界面与验证

`cfkanban-admin` 的主入口与双语操作说明直接暴露读取、设置和恢复默认的参数、Owner 边界及读回要求；旧实例需先核对 schema/端点支持，不能因本地 Skill 更新就自动升级服务。日常 Issue 优先级能力由 `cfkanban` 主入口及双语指南说明，复用既有单字段 PATCH，不扩展本增量的设置权限。

Owner Overview 提供单独的“首页实例说明”区域，含中英文输入、公开可见/纯文本/长度/留空回退提示，以及保存和恢复默认操作。恢复默认只是将表单两值清空，需保存后生效；不在只读服务信息区域混入编辑功能。加载失败应可重试且不能保存未知版本；保存失败保留输入，CAS 冲突需明确读取最新版本后再决定是否覆盖。响应丢失或成功响应结构无效时锁定原 payload 与幂等键，暂停新的保存；只允许原请求重试，或在读回版本已推进、原 CAS 不再可能新提交后，由用户核对最新内容并明确恢复新保存。

验证覆盖双语与域名回退、旧 Service 兼容、纯文本渲染、Owner 与范围权限拒绝、CSRF、输入限制、CAS 与并发、幂等和单次审计；migration 验证已有数据保留和完整 schema 11 读回。检查 Owner 恢复的已支持 schema 范围，不能因新增设置表破坏恢复能力。新增行为只在后续准确发行/升级后线上生效。

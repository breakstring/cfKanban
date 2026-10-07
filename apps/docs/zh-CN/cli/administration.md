# CLI 范围管理

管理权由 Service 实时核验。Owner、工作区管理员和项目管理员有不同范围，命令分组或本地名称不提供权限。

```text
cfkanban workspace --help
cfkanban project --help
cfkanban grant --help
cfkanban invite create --help
cfkanban owner device --help
cfkanban admin --help
```

工作区/项目命令负责创建、设置、状态名称、归档与恢复。Grant、管理员、成员命令分别保留继承和直接权限。永久删除需要准确 preview 与既有破坏性确认；归档不物理删除历史。

普通工作区/项目命令只从当前上下文解析其需要的目标层级，同一工作区的多个项目不会让工作区命令产生歧义。结合返回的 `resolved_context` 和实时权限核对结果。永久删除仍明确提供准确目标并完成 preview 确认；Owner 安全流程保留必要的显式实例/身份目标和确认，保存默认范围不能提供破坏性授权。

创建普通/恢复邀请使用专用安全交付。公开加入配置明确 role、独立 quota 和关闭影响。Owner 设备批准/撤销、身份切换和凭据轮换保留最后有效凭据保护。capability URL 和 token 不进入日志或普通 JSON 输出。

首页说明、公告、容量/限额、用量、origin 和审计命令与网页管理页复用同一 API。Cloudflare 资源、迁移和 Owner 全失恢复由部署计划承接。失败时按[恢复指南](./recovery.md)保留原操作。

Owner 的 Cloudflare 设置与网页复用相同的固定目标 Service API。可以读取连接能力、通知策略/收件邮箱和 WAF 状态，为一个限流组或受支持的用量设置生成并应用计划。美元预算策略只读：未知金额不是零，普通策略中的 limit 也不是已经确认的美元阈值。

```text
cfkanban admin cloudflare --help
cfkanban admin rate-limits plan --help
cfkanban admin rate-limits apply --help
cfkanban admin usage history --help
cfkanban admin usage collect --help
```

应用使用计划的准确版本。Cloudflare 结果待核验或不确定时，保留原操作并调用 `admin cloudflare verify-operation`；核实只读取 Cloudflare，不重复设置写入。历史查询从本实例 D1 读取 1–90 个完整 UTC 日并保留缺日；显式采集一次只接受最近七个完整 UTC 日中的一个，不将未知量补成零。

Cloudflare Token 是明确的浏览器秘密输入例外。使用既有 `web open` 流程打开 Owner 管理页，再进入 **Cloudflare 设置**。只在受保护的瞬时表单输入凭据，最终保存普通 Worker Secret。没有将 Token 写进 CLI 恢复日志的普通参数、输入文件或 API 命令。参见[连接和权限](../deployment/optional.md)。

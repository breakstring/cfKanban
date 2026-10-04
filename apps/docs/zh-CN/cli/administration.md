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

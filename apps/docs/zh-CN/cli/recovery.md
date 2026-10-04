# 错误与原操作恢复

已知权限拒绝或 CAS 冲突需要重新核对身份、目标和版本，不静默改账户或覆盖较新数据。

```text
cfkanban operation show --instance <instance-uuid> --operation-id <operation-uuid> --json
cfkanban operation recover --instance <instance-uuid> --operation-id <operation-uuid> --json
```

未知写结果将原调用身份、目标、请求、写合同、CAS 与适用时的 key 保存在受保护的非秘密状态中，支持后续 CLI 进程恢复。恢复原连接、检查记录并使用其恢复命令；重放被拒绝或冲突不能证明原请求未提交。CAS-only 的原结果可能需要准确审计及人工核验；未知缓存刷新只读恢复。当前数据相等不能证明原结果；服务端幂等重放窗口过期后查远端审计证据，不提交替代写入。

提交后读回失败与服务端拒绝分别报告。部分部署沿准确获批计划和 journal 续跑，计划变化需新授权。本地安装失败保留原 active，已修改启动器不覆盖。

`current_principal` 加入操作绑定原 Principal、Credential 和可信地址；切换身份后须恢复原调用者，再恢复原操作。Owner 轮换响应丢失时，保留原 pending Credential，使用 `operation recover` 重放原轮换请求；恢复不会先用已撤销的旧凭据请求 `/me`。轮换已提交但验证失败仍保留恢复限制；仅当前凭据有效不足以证明原轮换已提交。

管理员、设备凭据和通知的提交后读回会沿游标查找目标，每次最多读取 10 页；达到上限后保留下一页位置，再运行同一恢复命令继续只读核验，不重复已确认的写入。确定发生在写请求前的输入或本地状态拒绝会保存失败结果并释放写入限制，恢复仍返回原失败和非零退出码。

Invite、Browser Launch、Passkey、附件遵循专用安全恢复。浏览器错误不授权再创建能力或身份；剪贴板/浏览器不可用是交付限制，不将秘密输出 JSON 或日志。云端和 Owner 全失规则见[部署恢复](../deployment/recovery.md)。

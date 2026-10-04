# CLI 日常协作

开始工作前先发现连接、核验本人身份并选择准确目标。目录 scope 只推荐项目，不提供权限。

```text
cfkanban connection list --json
cfkanban profile show --instance <instance-uuid>
cfkanban issue list --instance <instance-uuid> --project <project-uuid>
cfkanban issue show --instance <instance-uuid> --identifier CFK-123
cfkanban issue complete --help
```

`join`、`identity`、`scope` 覆盖首次接入与 pending 身份恢复。邀请使用专用安全输入，不复制长期 token；Passkey 登记和认证需要浏览器实际交互。

`issue` 支持筛选列表、候选、统计、创建、修改、指派、阻塞、完成和重新打开。`comment`、`label`、`relation`、`attachment`、`profile`、`notification` 提供协作、单文件传输、本人偏好与逐条确认。每次写入遵循对应 Service 权限及写合同；帮助区分 CAS-only 与服务端幂等操作，稳定 key 适用于后者。

```text
cfkanban comment create --instance <instance-uuid> --identifier CFK-123 --body-file ./note.md --idempotency-key <stable-key>
cfkanban web open --help
```

`web open` 保留明确 local/online 模式、目标和真实工作目录，本地浏览器工作台与宿主侧栏是不同入口。搜索与分页保持有界。完成说明可以留空，不能自动编造验证结论。

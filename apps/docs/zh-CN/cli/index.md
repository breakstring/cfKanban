# 在终端使用 cfKanban

公共 `cfkanban` 命令用于查找任务、查看或创建 Issue、追加进展评论、记录完成和打开看板。从实际工作目录运行，已核验仓库上下文或唯一连接提供普通目标；终端有歧义时可作临时选择，`context use` 才明确记住本 worktree 的项目。

```text
cfkanban
cfkanban context show
cfkanban issue list
```

按[日常任务流程](./daily.md)使用：选定或切换项目 → 查找任务 → 查看或创建 → 推进与评论 → 记录完成 → 打开看板。处理一个 Issue 无需逐个掌握所有命令。

CLI 来自同一个完整、已验证的 Skills bundle，随其 active 版本更新，没有独立 CLI 升级渠道，见[安装与更新](./installation.md)。当前执行环境需要 Node.js >=22.12.0；本文是源码文档，不表示 CLI 已发布到 stable 渠道。

重复工作见[脚本与 Agent 使用](./automation.md)，明确 UUID 与机器输出仍可使用；参数与不确定结果按需查[命令参考](./reference.md)和[恢复指南](./recovery.md)。[管理](./administration.md)及[部署](./deployment.md)服务各自获准任务。

网页使用同一 Service 权限与任务语义。CLI 通过安全流程打开浏览器，宿主侧栏需要该宿主已暴露的视图工具；本地名称或目录默认范围不提供权限。

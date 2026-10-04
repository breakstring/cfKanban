# CLI 概览

公共 `cfkanban` 命令随已验证的完整 Skills 工件交付，与 Skills、MCP 复用受保护身份和 Service 规则。当前执行环境需要 Node.js >=22.12.0。CLI 正在源码中准备；本文不表示能力已发布到 stable 渠道。

```text
cfkanban
cfkanban --locale zh-CN
cfkanban issue --help
cfkanban --version --json
```

先阅读[安装与版本](./installation.md)，再选择[日常协作](./daily.md)、[范围管理](./administration.md)或[部署](./deployment.md)。[命令参考](./reference.md)说明输入输出，[Agent 自动化](./automation.md)说明脚本执行，[错误恢复](./recovery.md)说明不确定结果。

网页继续使用同一 Service。CLI 无法控制宿主侧栏；使用宿主已暴露的视图工具，或 `web open` 打开浏览器。命令不会从本地名称或目录推断权限。

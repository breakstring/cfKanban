# 脚本与 Agent 使用

Shell、CI 或 Agent 使用同一批任务命令；CLI、Skill API 与 MCP 复用 Service 业务结果及权限规则。`--json` 只改变输出格式，不增加定时器、触发器或批量操作。

## 在 Shell 中读取任务

唯一仓库上下文或连接提供普通目标，先列当前工作区项目，再查看推荐项目的 Issue：

```text
cfkanban project list
cfkanban issue list --status todo
```

固定自动化目标仍可使用明确 UUID 参数；创建 Issue 等操作仍需真实提供业务必填字段，例如标题和描述文件。

## 在 CI 中只读检查仓库范围

只读 scope 检查报告目录推荐，不加入项目或提供权限；其它程序需要处理稳定 ID 与结果字段时可选择 JSON：

```text
cfkanban scope inspect --json --no-interactive
cfkanban issue list --status todo --json --no-interactive
```

CI 读取 Service 数据前，必须已有获准的可信连接保存在私有状态中。Credential 不进入 argv、环境变量、日志或请求文件；仓库 scope 文件只保存非秘密推荐目标。

## 让 Agent 处理目标选择

检查当前上下文后进行普通范围查询。多目标匹配时，返回结构化候选 ID，不等待输入：

```text
cfkanban context show --json --no-interactive
cfkanban issue list --json --no-interactive
cfkanban issue list --instance <instance-uuid> --project <project-uuid> --json --no-interactive
```

最后一条展示选择后的明确目标。依据用户已知意图选择稳定 ID，仅在意图仍有真实歧义时询问；用户未要求保存偏好时不调用 `context use`。结合返回的 `result.resolved_context` 与 Service `resolved_scope` 了解实际采用范围；全显式调用可保留原结果结构，不要求每个响应都有上下文字段。

JSON、非 TTY、`--no-interactive` 或 stdin 已用于正文/安全输入时永不提问，`--interactive` 不能覆盖这些限制。普通正文支持文件/stdin，秘密与一次性能力使用专用安全通道；缺少业务输入或未解决的写目标在请求前拒绝。

固定单项目写入可使用明确自动化示例：

```text
cfkanban issue create --instance <instance-uuid> --workspace-id <workspace-uuid> --project-id <project-uuid> --title "Fix login" --body-file ./issue.md --json --no-interactive
```

机器结果为 `{schema_version:1, ok, result}`，stdout 承载结果，stderr 承载脱敏诊断，失败返回非零。退出码为 0 成功、2 输入错误、3 认证失败、4 权限拒绝、5 冲突、6 未知写结果、7 运行时/平台失败、8 未找到；同时检查结构化结果与退出码。

CLI 在发送普通写入前记录已解析目标与恢复信息；结果未知时保留该操作并按[恢复指南](./recovery.md)处理，切换 cwd 或其它通道重试不证明原操作失败。浏览器/Passkey 步骤保留必要交互；本地浏览器工作台需要 CLI 进程持续运行。

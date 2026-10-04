# 在终端推进任务

从实际工作目录运行这些命令。CLI 从仓库推荐、保存上下文或唯一连接解析稳定目标，再核验实时 Service 权限；需要固定目标时仍可提供明确 UUID。

## 选定或切换项目

要记住本 worktree 的项目时使用 `context use`，终端中需要时会提供选择；`context show` 展示最终范围。这只保存私有本地状态，不加入项目或提供权限。

```text
cfkanban context use
cfkanban context show
```

子目录共用本 worktree 的选择，不同 worktree 和嵌套仓库各自保存目录上下文。普通命令的选择仅用于本次调用，明确保存时才保留；`context clear` 清除保存选择，不改仓库推荐文件。

## 查找任务

按标题或 Issue 编号搜索，或按状态查找工作：

```text
cfkanban issue list --q "login"
cfkanban issue list --status todo --status in_progress
```

仓库推荐同实例的两个项目时，Issue 列表覆盖两个项目，选择更窄范围后才收窄；单项目写入需要选定一个项目。范围失效或不可访问时命令停止，不静默换项目；搜索与分页保持有界。

## 查看或创建 Issue

使用列表返回的准确编号。创建时提供真实标题，并将描述写入文本文件：

```text
cfkanban issue show --identifier CFK-123
cfkanban issue create --title "Fix login" --body-file ./issue.md
```

## 推进并评论

修改状态或追加进展评论。CLI 核验当前权限和版本；遇到并发变更时重新判断，不覆盖较新工作。

```text
cfkanban issue update --identifier CFK-123 --status-key in_progress
cfkanban comment create --identifier CFK-123 --body-file ./note.md
```

## 记录完成

在完成说明中写下实际交付，验证和产物只记录真实证据；将 Issue 标为完成不代表已执行其实际工作。

```text
cfkanban issue complete --identifier CFK-123 --body-file ./completion.md
```

完成保留不可变记录。重新打开和未知写结果处理见已安装帮助及[恢复指南](./recovery.md)。

## 打开看板

在本地浏览器工作台打开当前已核验项目；项目仍有歧义时，使用相同终端选择或非交互结构化候选：

```text
cfkanban web open
```

默认 local 模式，需要 CLI 进程持续运行；显式 online 模式使用既有安全 Browser Launch，参数按需查已安装帮助。宿主侧栏使用该宿主已暴露的视图工具。首次接入见[加入与登录](../usage/access.md)，更多参数与默认上下文见[命令参考](./reference.md)。管理和部署按独立任务处理。

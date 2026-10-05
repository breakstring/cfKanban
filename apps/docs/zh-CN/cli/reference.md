# 命令、参数与结果

根帮助和命令组帮助按工作流程提供导航；逐命令帮助突出相关参数、影响和例子，与不可变工件中的命令目录来自同一来源。帮助专用 `--advanced` 按需展示高级与兼容命令，以及结构化输入等高级参数；`--json` 保留完整机器目录。`--advanced` 不作为业务参数或独立安装入口。

```text
cfkanban help
cfkanban issue --help
cfkanban issue create --help
cfkanban issue create --help --advanced
cfkanban help --advanced
cfkanban issue show --instance <instance-uuid> --identifier CFK-123 --json
```

使用长选项和稳定 ID。`--instance` 与 `--instance-id` 等价；单值工作区/项目参数也支持 `--workspace` / `--workspace-id`、`--project` / `--project-id` 等价写法。重复列表筛选保留原数组语义与 cursor，不抓全历史再本地筛选。`--locale en|zh-CN` 选择说明语言，`--json` 选择版本化机器 envelope。结果写 stdout，诊断写 stderr，业务失败返回非零。

`issue reference --identifier CFK-123 --projection mention|resource` 提供受权限约束的简短读取，可选有界正文。实际执行时选一个 projection 值，不输入 `|` 分隔符；它与完整的 `issue show` 响应分开，截断及后续评论/关系读取见[查看任务](./daily.md#查看或创建-issue)。可用性以实际安装的 CLI 和 Service 版本为准。

`search-index status`、`search-index snapshot` 和 `search-index changes` 提供与 Codex 搜索缓存相同的只读 Issue 编号／标题同步能力，返回元数据和不透明游标，不返回本地搜索候选或 Issue 正文。Status 使用明确的重复 `--project` 过滤或当前目录关联的项目；两者都没有时，必须明确提供 `--allow-unfiltered true` 才能选择当前全部授权项目，此参数不授予权限。Snapshot 和 changes 必须明确提供一个项目及其返回的游标，每页最多 100 条。

```text
cfkanban search-index status --instance <instance-uuid> --project <project-uuid> --json
cfkanban search-index snapshot --instance <instance-uuid> --project <project-uuid> --cursor STATUS_CURSOR --limit 100 --json
cfkanban search-index changes --instance <instance-uuid> --project <project-uuid> --after NEXT_CURSOR --limit 100 --json
```

将 `STATUS_CURSOR` 替换为 status 返回的对应项目游标。沿 snapshot 的 `next_cursor` 读取到 `has_more` 为 false，再将该游标作为 changes 的 `--after`。增量页即使 `items` 为空也要继续使用返回的游标；游标重置或过期时，重新完整读取该项目的快照。

## 上下文选择与保存默认范围

明确 ID 优先；否则 CLI 仅解析命令需要的目标层级，使用仓库推荐、兼容的目录保存选择、全局默认或唯一已登记连接/Service 候选。仓库推荐优先于全局默认；目录选择只能收窄仓库候选，不能扩大范围。仓库 scope 保持非秘密实例/工作区/项目 UUID 元组的扁平列表，没有优先项目或最近使用项目。

`context show/use/clear` 默认操作当前目录，可用 `--directory` 指定另一个工作目录。Git 探测使用当前 worktree 根目录，子目录共用本根，嵌套仓库使用最近的自身根目录；各 worktree 独立保存选择，确认非 Git 时使用该目录。探测失败明确报告，不静默绕过仓库 scope。

| 命令 | 影响 |
| --- | --- |
| `context show` | 诊断 Git、仓库候选、保存上下文与已解析 ID；多候选可保持未选定，项目可为 null。 |
| `context use` | 明确保存私有目录默认范围，通常选一个项目，并核验所属工作区及仓库候选关系。 |
| `context clear` | 清除私有目录选择，保留仓库 scope 文件与连接。 |
| `context use/show/clear --global true` | 操作明确的私有全局默认；在仓库执行命令时仍优先使用仓库推荐。 |

无 ID 的 `context use` 从仓库候选选择；没有仓库推荐时通过有界 Service 发现选择。明确提供工作区而未提供项目时保存工作区层级；仅明确提供实例时保存实例层级，即使仓库项目候选存在；自动提供的更窄候选不因此保存为项目选择。全局 show/use/clear 不依赖 cwd 的 Git 探测或仓库 scope，scope 文件损坏或 Git 缺失也不阻止这些操作。明确保存的全局目标可以位于当前仓库之外。普通命令的终端选择只作用于本次调用，不自动执行 `context use`。

```text
cfkanban context show --json
cfkanban context use --instance-id <instance-uuid> --workspace-id <workspace-uuid>
cfkanban context use --instance <instance-uuid> --workspace-id <workspace-uuid> --project-id <project-uuid> --global true
cfkanban context show --global true --json
cfkanban context clear --global true
```

真实 TTY 命令可自动提供选择菜单；`--interactive` 与 `--no-interactive` 互斥。JSON、非 TTY、`--no-interactive` 或 stdin 已用于正文/安全输入时永不提问，`--interactive` 不能覆盖这些限制。推荐或默认目标失效、不可访问时停止解析，不改选另一个目标或扩大到全部可访问 Issue。

业务命令至少自动补齐一个上下文字段时，在 `result.resolved_context` 报告稳定目标 ID 及来源；全显式旧调用保留兼容结果结构，不要求每个响应新增该字段。`context show/use` 总有诊断元数据；`show` 使用 `result.data.resolved_context`，并附 `git`、`repo_targets`、`saved_context`，`selection_required` 可保持 true。来源为 `explicit`、`repository`、`saved_directory`、`saved_global`、`local_connection`、`service_unique`。结合 Service 的 `resolved_scope` 核对返回的上下文，本地对象不提供权限。

| 结构化 code | 下一步 |
| --- | --- |
| `CLI_CONTEXT_SELECTION_REQUIRED` | 依据稳定 ID 选择候选，用明确参数重试；仅在用户要求保存偏好时明确保存。 |
| `CLI_CONTEXT_CONFLICT` | 查看所选 ID 与保存上下文，修正不匹配关系。 |
| `CLI_CONTEXT_STALE` | 检查不可用目标，明确选择有效替代目标或清除过期选择。 |
| `CLI_CONTEXT_UNAVAILABLE` | 查看连接、Git、Service 诊断，或提供已验证的准确 ID。 |

退出码：0 成功、2 输入错误、3 认证失败、4 权限拒绝、5 冲突、6 写结果未知或待核验、7 运行时/平台失败、8 未找到。同时检查结构化错误，不能只看退出码。

普通正文支持 `--body-file` 或 `--body-stdin`；非秘密结构化字段支持 `--input-file` 或 `--input-stdin`。未知、冲突、重复或缺失业务输入在写入前拒绝，省略的上下文 ID 则须先完成解析；help 不读取 stdin。Credential、邀请能力和浏览器 ticket 不进入参数、环境变量或普通输入文件，使用专用安全流程。

浏览器与 CLI 的权限和完成语义相同。`issue complete` 只记录实际证据，重新打开保留历史记录。公共命令和字段属于兼容合同，已安装版本的准确参考以同工件帮助为准。

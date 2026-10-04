# CLI 入口与 Skills 更新

公共 CLI 属于同一个完整、已验证的 cfKanban Skills bundle，按既有[Skills 安装流程](../integrations/general.md)安装、更新或移除。只有插件投影不能提供 canonical 可执行入口；不存在独立 CLI 下载或升级渠道。

bundle 已安装不代表命令已注册。`cfkanban-deploy` 安装流程可在核验 canonical 来源后完成一次受控入口注册；来源或登记缺失时，先完成该流程，不以修改 PATH 替代核验。

安装后检查本机命令和版本：

```text
cfkanban cli status --json
cfkanban --version
```

已注册启动器随 bundle 的 active 版本运行，每次启动验证私有 receipt 和完整工件。更新获准 Skills bundle 即更新该 CLI 来源；已经运行的 MCP 仍需重启并核验版本。本地 Skills/CLI 更新不升级远端实例。

macOS/Linux 默认注册到 `~/.local/bin`，Windows 原生默认 `~/.cfkanban/bin`。返回的目录未在 PATH 中时，明确将该用户目录加入 PATH 并重开终端；安装器不修改 PATH、shell profile 或默认 Node。Windows 使用生成的 cmd/PowerShell 入口，WSL2 保留独立 Linux 安装与身份状态。

兼容命令保留为高级本机维护：`cli install` 注册受控入口，`cli uninstall` 只移除拥有的入口；`cli rollback` 在验证前一完整发行后切换整个 canonical Skills bundle 的 active，不是单独降级 CLI。正常发行回退遵循 Skills update 流程及获准来源核验。同名命令、已修改启动器或未验证的旧工件会被拒绝，本地整包回退与线上实例独立。

目录/全局上下文保存在当前执行环境私有本地状态，与非秘密仓库 scope 文件分开。不同 worktree 独立保存目录选择；Windows 原生与 WSL2 各自保留上下文和连接状态。通过 `context show` 检查，更新不授权改变所选身份或实例；浏览器中的 Service 版本另行核对。

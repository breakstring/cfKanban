# 安装、更新与卸载

先按[安装流程](../integrations/general.md)取得完整、不可变 Skills 工件，执行前核对来源、manifest 和摘要。只有插件投影不能提供 canonical 公共 CLI。

```text
node <verified-skills>/cli/cfkanban.mjs cli install
cfkanban cli status --json
cfkanban --version
cfkanban cli rollback
cfkanban cli uninstall
```

macOS/Linux 默认注册到 `~/.local/bin`，Windows 原生默认 `~/.cfkanban/bin`。返回的目录未在 PATH 中时，明确将该用户目录加入 PATH 并重新打开终端；安装器不会改 PATH、shell profile 或默认 Node。Windows 使用生成的 cmd/PowerShell 入口。WSL2 是独立 Linux 安装与身份环境。

同名命令或已修改启动器会被拒绝。每次启动核对 canonical active receipt 与完整工件。更新已验证的本地 bundle 与升级 Instance 分开；回退要求前一版本包含完整 CLI，卸载只移除本安装拥有的入口，保留私有身份和部署记录。

已经运行的 MCP 在重启和核验前仍用旧版本；CLI 更新不表示宿主已加载新 Skills/MCP。浏览器中的 Service 版本另行核对，本地与远端可以不同。

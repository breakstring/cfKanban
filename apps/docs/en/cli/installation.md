# CLI entry points and Skills updates

The public CLI is part of the same complete, verified cfKanban Skills bundle. Use the existing [Skills installation workflow](../integrations/general.md) to install, update or remove it. A plugin projection alone does not provide the canonical executable. There is no independent CLI download or upgrade channel.

Having the bundle installed does not mean the command is registered. The `cfkanban-deploy` installation workflow can register its controlled entry once after verifying the canonical source. If the source or registration is missing, complete that workflow before changing PATH.

After installation, inspect the local command and version:

```text
cfkanban cli status --json
cfkanban --version
```

The registered launcher follows the bundle's active version and verifies its private receipt and complete payload at every start. Updating the approved Skills bundle updates that CLI source; already running MCP processes need a restart and version check. Updating local Skills/CLI does not upgrade a remote instance.

Registration defaults to `~/.local/bin` on macOS/Linux and `~/.cfkanban/bin` on native Windows. If the reported directory is absent from PATH, explicitly add that user directory and reopen the terminal. The installer does not change PATH, shell profiles or your default Node. Use the generated cmd/PowerShell entry on Windows; WSL2 has its own Linux installation and identity state.

Compatibility commands remain for advanced local maintenance: `cli install` registers the controlled entry, and `cli uninstall` removes only owned entries. `cli rollback` switches the active version of the entire canonical Skills bundle after verifying the previous complete release; it does not downgrade the CLI alone. Normal release rollback follows the Skills update workflow and approved-source verification. A same-name command, modified launcher or unverified previous bundle is refused. Local bundle rollback is separate from the online instance.

Saved directory/global context stays in this environment's private local state, separate from the non-secret repository scope file. Worktrees keep separate directory choices; native Windows and WSL2 keep separate context and connection state. Inspect it through `context show`; an update does not authorize changing the selected identity or instance. The browser's Service version is checked separately.

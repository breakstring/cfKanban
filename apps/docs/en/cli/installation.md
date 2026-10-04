# Install, update & remove

Install a complete immutable Skills bundle using the existing [installation workflow](../integrations/general.md). Verify its source, manifest and digest before executing it; a plugin projection alone does not supply the canonical public CLI.

```text
node <verified-skills>/cli/cfkanban.mjs cli install
cfkanban cli status --json
cfkanban --version
cfkanban cli rollback
cfkanban cli uninstall
```

Registration defaults to `~/.local/bin` on macOS/Linux and `~/.cfkanban/bin` on native Windows. If the reported directory is absent from PATH, add that user directory explicitly and reopen the terminal. The installer does not change PATH, shell profiles, or your default Node. Use the generated cmd/PowerShell entry on Windows. WSL2 is an independent Linux installation and identity environment.

A same-name command or modified launcher is refused. The launcher verifies the canonical active receipt and full payload at every start. Update the verified bundle independently from an Instance upgrade. Rollback requires the previous complete CLI release; uninstall removes owned launchers and preserves private identity and deployment records.

Already running MCP processes keep their version until restarted and checked. A CLI update does not mean a host has loaded new Skills/MCP. Use the browser's Service version separately; local and remote versions may differ.

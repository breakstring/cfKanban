# Agent 与脚本自动化

非交互流程使用明确目标与稳定 operation ID。JSON 表达冲突、不确定结果等实际业务状态，不能只表达 dispatch 已接受。

```text
cfkanban issue show --instance <instance-uuid> --identifier CFK-123 --json
cfkanban issue update --input-file ./non-secret-request.json --json
cfkanban operation show --instance <instance-uuid> --operation-id <operation-uuid> --json
```

普通正文通过有界文件/stdin 传输。缺少必要输入直接失败，不等待终端提示。Credential、浏览器 ticket 和邀请能力不放普通请求文件。每次公开写入为原子操作；多步命令保留进度并准确报告部分完成。

重试前保留原 operation 和 key。取消、超时、重启 CLI 或切换 CLI/Skills 都不证明未提交；不确定操作核实前阻止新写入，不生成新 key 绕过恢复边界。

长驻的本地 `web open` 保持进程和浏览器工作台，终止后本地载体关闭，未保存文字可能丢失。浏览器导航与 Passkey 交互需明确执行。宿主侧栏打开使用该宿主工具，并核对准确目标实际渲染。

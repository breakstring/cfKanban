# 命令、参数与结果

根帮助和命令组帮助列出公共命令、影响与字段；详细帮助与不可变工件中的命令目录来自同一来源。

```text
cfkanban help
cfkanban issue --help
cfkanban issue create --help
cfkanban issue show --instance <instance-uuid> --identifier CFK-123 --json
```

使用长选项和明确稳定 ID。重复数组选项保留服务端筛选与 cursor，不抓全历史再本地筛选。`--locale en|zh-CN` 选择说明语言，`--json` 选择版本化机器 envelope。结果写 stdout，诊断写 stderr，业务失败返回非零。

退出码：0 成功、2 输入错误、3 认证失败、4 权限拒绝、5 冲突、6 写结果未知或待核验、7 运行时/平台失败、8 未找到。同时检查结构化错误，不能只看退出码。

普通正文支持 `--body-file` 或 `--body-stdin`；非秘密结构化字段支持 `--input-file` 或 `--input-stdin`。未知、冲突、重复或缺失输入在写入前拒绝；help 不读取 stdin。Credential、邀请能力和浏览器 ticket 不进入参数、环境变量或普通输入文件，使用专用安全流程。

浏览器与 CLI 的权限和完成语义相同。`issue complete` 只记录实际证据，重新打开保留历史记录。公共命令和字段属于兼容合同，已安装版本的准确参考以同工件帮助为准。

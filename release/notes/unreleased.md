# 未发布变更

- 目录关联使用跨平台只读 Git 检测，仓库子目录和 linked worktree 关联到各自工作树根。Git 仓库缺关联时可提醒一次；普通文件夹只按用户主动要求处理，同意建议后才保存，保留既有关联。
- 文字更新按用户明确目标或当前会话明确承接的准确发行选择，否则发现最新正式版。宿主自带更新保持稳定渠道；RC 临时安装分别核对实际副本与长期来源，不能把刷新固定 tag 当成稳定升级。
- `release discover` 新增 `selectionMode` 和输出 `selection_mode`，分离本次工件快照与长期 marketplace 来源。默认 `latest_stable`，即使回填正式版本也不生成 ref；准确固定版本或 RC 使用 `exact_version` 并传入 `version`。

兼容说明：`scope read/merge` 保留指定目录的精确读写语义。旧的 RC discovery 调用须补充 `selectionMode: exact_version`；仅传正式 `version` 现在表示稳定渠道下的工件快照。REST API、凭据、服务端权限和数据库结构不变。本文件不代表已发布、安装或部署。

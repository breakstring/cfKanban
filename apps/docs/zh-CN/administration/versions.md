# 版本与更新

**网页入口：** 具有实例管理范围的 Owner 可打开 **管理中心 → 版本与更新**。页面展示当前实例实际产品版本及 GitHub 公开 `releases/latest` 重定向选定的正式版；另从公开发行列表第一页最多检查二十张卡片，展示最多三份预发行版。通道按 GitHub 原生 Pre-release 标记识别，列表按发行发布时间倒序，每项链接到官方说明。

较新版本仍须核验兼容性和不可变工件；晚发布时间不能证明适合升级当前实例。预发行版须明确准确版本，不替代默认正式目标。发现直接读取 GitHub 公开网页，无需 token、不请求 REST API。成功信息在 Worker isolate 内缓存十五分钟，**重新检查** 可能复用缓存。网页访问受限或解析结构变化时展示未知或过期状态与检查时间，其他功能继续可用。

在 **交给 Agent 升级** 区，默认目标为「最新正式版」，其余选项仅为已发现的准确预发行版本，不会自动选中。复制一句话请求交给自己的 Agent：先给出「最新正式版」或所选准确预发行版本，再请求使用 `cfkanban-deploy` 技能将本地 cfKanban 插件和浏览器当前站点 origin 的线上部署都升级到该版本。刷新后所选预发行不再可用或 Session 改变时，目标重置为「最新正式版」。

站点无法检查本地技能，复制只生成文本。本地插件更新与实例升级仍遵循技能中的独立更新与升级授权要求。详细步骤见[更新流程](../deployment/updates.md)。

```text
请以 最新正式版 为目标版本，使用 cfkanban-deploy 技能将本地 cfKanban 插件和 <当前站点 origin> 的线上部署都升级到该版本。
```

```sh
cfkanban admin updates show --json --no-interactive
```

API 为 `GET /api/v1/admin/release-updates`，仅限项目的 Owner Session 和局部管理员不能读取。同页的自动公告设置见[实例升级](../deployment/updates.md)。

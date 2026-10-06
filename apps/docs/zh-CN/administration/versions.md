# 版本与更新

**网页入口：** 具有实例管理范围的 Owner 可打开 **管理中心 → 版本与更新**。页面展示当前实例实际产品版本、GitHub 最新正式版，以及最近二十份发行中的最多五份预发行版，每项链接到官方说明。数字预发行编号按语义版本比较，例如 `rc.10` 高于 `rc.2`。

较新版本仍须核验兼容性和不可变工件。预发行版须明确准确版本，不替代默认正式目标。成功信息在 Worker isolate 内缓存十五分钟，**重新检查** 可能复用缓存。查询失败或限流时展示未知或过期状态与检查时间，其他功能继续可用。

站点无法检查本地技能。请在本地执行 `cfkanban --version` 并核对完整 bundle 和宿主安装。**更新本地技能** 与 **升级此实例** 链接到独立[更新流程](../deployment/updates.md)，检查不会执行更新。

```text
使用 $cfkanban-admin 检查此实例实际版本、可选正式版和预发行版。说明本地技能更新与实例升级的选择，不执行更新。
```

```sh
cfkanban admin updates show --json --no-interactive
```

API 为 `GET /api/v1/admin/release-updates`，仅限项目的 Owner Session 和局部管理员不能读取。同页的自动公告设置见[实例升级](../deployment/updates.md)。

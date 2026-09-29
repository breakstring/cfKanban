# 部署

`cfkanban-deploy` 负责本地技能安装与更新、Cloudflare 实例部署与升级、已有部署接入和部署外 Owner 恢复。加入他人的项目或使用看板，不需要部署自己的实例。

## 从你的目标开始

```text
请用 $cfkanban-deploy 检查我部署 cfKanban 还需要准备什么，先只读检查。
```

Agent 会检查可验证的正式发行、工具与环境能力，说明已满足的条件和仍缺少的准备。检查不会自动安装工具、登录 Cloudflare 或创建资源。

| 你要完成的事 | 对应路径 | 需要的权限 |
| --- | --- | --- |
| 安装或更新本地技能 | [准备](./setup.md)、[更新](./updates.md) | 本地安装权限，无需 Cloudflare |
| 创建自己的实例 | [首次部署](./first-deployment.md) | 准确 Cloudflare 账户控制权限 |
| 升级线上实例 | [更新与升级](./updates.md) | 实例维护记录、Owner 与 Cloudflare 权限 |
| 换电脑管理应用 | [Owner 设备](../administration/devices.md) | 现有 Owner 批准 |
| 换电脑维护部署 | [接入已有部署](./attach.md) | 当前 Owner 与准确 Cloudflare 权限 |
| 继续中断操作或恢复 Owner | [中断与恢复](./recovery.md) | 对应计划与恢复路径所需权限 |
| 配置域名、R2、统计或限流 | [可选配置](./optional.md) | 明确的部署与外部影响授权 |

Owner 是应用内的唯一所有者；Cloudflare 登录控制基础设施。两者分别核验，不因拥有其中一种身份就假定另一种权限。

## 默认部署与发行

默认使用一个 Worker、一个 D1 数据库和 `workers.dev` 地址，包含网页。默认选择最新正式版；附件、域名及测试版需要明确选择。

**在网页中：** 管理中心可查看实例版本、用量和部分应用设置。cfKanban 不提供云端部署控制台；部署通过 Agent 与已核验工具完成。浏览器可能参与 Cloudflare 登录或批准，但不会替代部署计划。

## 预期交付

执行前核对资源和影响；完成后获取站点地址和验证结果。中断时保留维护记录，让 Agent 检查后继续。

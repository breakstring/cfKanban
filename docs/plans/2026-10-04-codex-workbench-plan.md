# CFK-600 官方插件工作台实施与验证计划

依据：[增量 SPEC](../specs/2026-10-04-codex-workbench-spec.md)。执行状态与实际证据保存在 [CFK-600](https://cfkanban.dev/app/issues/CFK-600)，本文件只维护可复用实施配方。

1. 在现有 MCP 进程增加固定 resources 和 global / thread 入口；global 保持严格空输入，thread 只接收 Agent 解析的稳定目标、推荐集合和非秘密仓库偏好 key，不接收目录，不新增业务真相源。
2. 每次入口建立独立 Controller / Bridge / Adapter 与非秘密 UUID 视图 ID；通过严格 arguments 路由，身份与权限由私有绑定核验。thread 重新核验仓库最后项目或自动打开仓库关联中有权项目，global 重新核验四 UUID 的本地项目偏好或选择有界默认项目，仅输出白名单快照。
3. 用可审计的 MCP Apps JSON-RPC client 适配共享 Vue。通过依赖注入选择 client，DSH / 独立工作台继续使用原 MessagePort client。
4. 预构建直接挂载的单文件 UI，校验 CSP、版本、摘要和文件集合；资源 URI 包含 HTML 摘要以隔离跨重启缓存。同一 Skills bundle 交付，不另起第二个 MCP。
5. 共用工作台项目菜单按工作区分页展示全部可访问项目，读取菜单不改变当前绑定，切换验证成功后原子替换并更新所属偏好。
6. 同步双语 MCP / 安装使用说明和导航；明确本地示例、源码验收、当前桌面验收与公开发行之间的边界。

## 隔离验证

- Node fixture：factory 明确绑定 expected Principal 和项目，所有测试使用临时私有目录或虚构 Service，不访问真实看板。
- MCP protocol：复制完整预构建目录到带空格临时路径，使用空 PATH 和独立 HOME；验证 initialize、摘要资源地址、tool metadata、空候选及重启后旧视图 ID 拒绝。
- 页面协议：fake parent 测试响应 ID、parent source、握手前结果、重复 / 替换视图 ID、失效、取消和 teardown；丢弃全部请求 metadata 后仍验证动作与原 receipt 路由，不通过测试打印原消息或私有状态。
- 仓库推荐：验证可信目录探测、worktree key、推荐与显式默认优先级、首个有权项目、跨仓库/全局偏好隔离、身份漂移拒绝和只读打开；菜单验证跨工作区、分页、失败保留与 pending 锁。
- 全局偏好：临时私有目录验证严格四 UUID、路径与权限漂移拒绝、原子保存，及全局重新核验、默认选择与 thread 独立。
- 业务安全：复用共享 runtime 原操作账本，补入口级 writer / reader、身份漂移、CAS、取消和未知结果恢复；一次写入对应一个原子操作。
- 渲染：在隔离 fixture 中检查 desktop / narrow、English / 简体中文、品牌主题、项目选择、看板 / 列表、详情、复制与允许写入，记录实际屏幕与交互证据。
- 构建：运行 typecheck、agents:test、docs:check 和根 validate。打包验证拒绝版本不符、摘要损坏、文件缺失或额外文件；不把本地 bundle 当正式发行。

## 官方桌面验收

使用固定候选工件及已核验 Node，在当前支持 Extensions 的桌面宿主检查：全局 / 聊天入口发现、空输入挂载、多个聊天与全局独立状态、关闭 / 重开、未知写入保留、资源缓存、MCP 重启、更新、停用和卸载。记录客户端、Node 和工件版本。

宿主无法被工具操作时，完成可执行的协议与渲染验证，将该具体限制和未验收项写入 Issue，保留进行中。不得改用生产业务操作充当隔离测试，不自动修改已安装插件或升级线上实例。

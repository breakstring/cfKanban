# 工作区与项目 UUID 寻址重构

- 状态：Frozen，修订 1
- 授权：2026-09-08 用户同意取消 Workspace/Project key 并要求实施；明确开发阶段不需要旧链接、API 或本地配置兼容。
- 覆盖范围：本文替代 Foundation、API/Schema、Web、Agent Skills 中关于容器 key 的合同。身份、授权、并发、幂等、归档及永久删除的其余边界不变。

## 1. 唯一身份与用户体验

Workspace 和 Project 只使用服务端生成的现有 UUID `id` 作为稳定身份，不再保存或接受 `key`。Project 保留 `workspace_id` 外键。创建仅要求显示名称（Project 可选 context），名称非空但不唯一，改名不改变身份；同名重建获得不同 UUID。名称不得用于认证、权限、幂等或不经消歧的写入寻址。

常规与归档列表在工作区名称前使用楼宇线性图标，项目名称前使用文件夹线性图标，图标仅作辅助且不替代文字。普通 UI 仅展示名称和所属工作区，不要求填写或记忆 UUID，不把 UUID 替代 key 显示为副标题。URL、API 与 Agent 工具中可以携带 UUID。需要区分同名项时使用所属工作区和按需详情；在选择控件或归档列表中名称发生碰撞时，增加 UUID 末 8 位后缀并提供完整 ID 提示，普通名称不显示 ID。归档对象另提供按需详情，展示完整 UUID、所属工作区和可用的项目说明或时间信息；永久删除预览保留同一目标的识别信息，确认输入仍使用原始完整名称。此消歧提示不把名称当作唯一标识。`CFK-<正整数>` 事项编号、workflow/status key、priority key、Idempotency-Key、凭据及其他领域标识保持不变。

## 2. REST、过滤与投影

- 保留现有嵌套资源结构，路径中的 `{workspace_key}` / `{project_key}` 改为 `{workspace_id}` / `{project_id}`，均校验 UUID。对嵌套读取或写入必须验证 Project 的真实 Workspace 归属。
- Workspace 创建 body 删除 key；Project 创建在显式 Workspace UUID scope 下进行，body 删除 key。创建幂等 scope 绑定资源集合/父 Workspace，不能绑定每次执行随机生成的 ID 或显示名称。
- Workspace resource 返回 `id`、`display_name` 等既有字段。Project resource 返回 `id`、`workspace_id`、`workspace_display_name`、`display_name` 等既有字段，不再返回 key。
- 嵌套 Workspace/Project 摘要包含 `id` 和 `display_name`；需要父信息的 Project 摘要增加 `workspace_id`、`workspace_display_name`。扁平 scope/授权投影使用 `project_id`、`project_display_name`、`workspace_id`、`workspace_display_name`。Invitation grant 的既有 Project `display_name` 可保留，增加父 Workspace ID/name。
- Issue 聚合、candidate 等重复 `project` 查询参数的每个值为单个 Project UUID，不再是 key pair；过滤继续受实时权限校验，resolved scope 返回 UUID 和显示名称。
- 旧 key 请求不提供别名或自动转换；未知创建字段继续拒绝。API 仍使用 `/api/v1`，本次作为开发阶段明确授权的不兼容合同修订。

## 3. Web、Launch 与本地 scope

Web Project URL 为 `/app/w/{workspace_id}/p/{project_id}`；Issue URL 仍使用事项 identifier。Project Browser Launch 请求 target 为 `{kind: "project", workspace_id, project_id}`。服务端验证真实归属和权限，再返回准确 `entry_path`。Issue target 的 identifier 输入保持不变，解析结果包含 `issue_id`、`project_id`、`workspace_id`，不再包含 keys。最小 target 不保存显示名称，展示从当前授权资源读取。Owner admin scope、一次性 capability、Session 时效、同源/CSRF 与响应精确 target/path 校验不变。

`.cfkanban-scope.json` schema_version 升为 2，target 为 `instance_id + workspace_id + project_id`。旧 key 结构明确拒绝，不自动回退无过滤。按 UUID 去重，即使显示名称相同也不合并。explicit → Repo → 警告后的无过滤建议顺序不变。Agent 创建只询问名称，从创建响应获取 UUID；调用前通过授权读取确定目标，同名时由上下文或用户消歧，不能猜 UUID。

## 4. 持久化与删除

新增 `0003_container_uuid.sql`，schema_version 升为 3。不改写已发行 migration SQL 和 checksum；重建含 key UNIQUE/CHECK 的表以及受 target JSON CHECK 影响的表，保留现有容器 UUID、所属关系、业务内容、身份、Grants 和事项序列。移除 key 列与其索引，Public Join 冗余排序改用 Project UUID。迁移内将已有 Launch/Session 的目标改为相同 Project/Workspace UUID，旧 key 不再存入目标。既有业务数据不会因本次重构被清库。

永久删除仍使用最小 UUID tombstone 支持当前原子门控与精简审计；它不再保留 key 或原名称，也不存在名称/简称占用规则。保留 tombstone 不代表内容可以恢复。

旧幂等快照、历史 payload、cursor 和缓存可能含旧合同；开发阶段不提供兼容重放。迁移清除旧幂等快照和 operation snapshot 数据（保留业务审计/内容），客户端旧 cursor 要重新开始。不重新签发 Credential，不扩大 Session scope。迁移标记为不兼容的 schema 变更，后续远端应用须在独立发布计划中明确列出。机器分类为 `breaking_non_destructive`；新部署账本 DDL 接受该分类，0003 同时重建既有 checksum 账本的分类约束并原样保留历史记录，未知分类仍拒绝。普通升级默认拒绝；只有显式 `allow_breaking_change` 绑定计划 digest 后才能进入授权执行。计划声明旧合同/快照失效、迁移至兼容 Worker 发布之间的服务中断与禁止回滚旧 Worker，仍要求 restore point 且不自动 D1 restore。schema 读回以三个旧 key 列缺失作为迁移完成证据，列证据缺失或部分移除必须停止；本次实现不执行线上迁移、部署、commit 或 push。

## 5. 验证

覆盖同名创建获得不同 UUID、重复幂等创建返回同一对象、旧 key 字段拒绝、错误 Workspace/Project 组合拒绝、cookie 单 Project scope 和跨 Project 权限、邀请及公开加入、archive/restore/purge、UUID scope 配置和安全 launch 校验。迁移使用有实际数据的旧 schema 本地夹具验证 ID/FK/内容/序列保留，确认 key 列消失。Web 验证只输入名称创建、名称展示、UUID 导航、归档分组、删除原地更新和复制反馈不跳动。运行完整项目验证，不使用线上破坏性测试。

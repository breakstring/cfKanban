# Principal 唯一显示名称

- 状态：Frozen
- 冻结日期：2026-09-20
- 授权依据：用户确认实例内禁止重名、收紧字符与保留词规则，并授权将现有测试名称的空格替换为下划线。
- 覆盖 Foundation/API/Web/Skills 中 Principal 显示名非唯一的旧表述；不改变 Workspace、Project、Status、Label 名称合同。

## 名称与身份

Principal display_name 在部署实例内唯一；ID 继续作为认证、授权、历史引用和恢复的唯一稳定身份。名称可改变，不能用旧名称缓存恢复或复用身份；改名后原名称可被重新使用，Agent 必须按当前项目重新解析，不能把历史名称当作稳定身份。

创建和改名先执行 JavaScript `trim().normalize("NFKC")`，保存规范化结果并保留大小写。唯一 key 为该结果的 locale-independent `toLowerCase()`；采用 Unicode 小写映射，不承诺视觉同形字符识别或完整 case folding（例如 ß 与 ss 不合并）。显示结果和 key 均限制为 1–128 Unicode 码点。

允许 Unicode Letter、Mark、Number 和 `_`、`-`、`·`；另拒绝 Default_Ignorable_Code_Point，禁止内部空白、控制字符、零宽/方向控制符、Emoji 与其他标点。精确 key 保留词为 `admin / administrator / owner / system / 管理员 / 所有者 / 系统`，不做子串匹配，不引入 LLM。Owner 与普通参与者规则相同。

## 写入与错误

Owner bootstrap、普通 Invite 新身份、Public Join 新身份、`PATCH /api/v1/me` 均使用同一规则；恢复既有身份不重命名。数据库 `principals.display_name_key` 唯一索引保证并发创建/改名至多一方成功。失败不得消耗 Invite、建立 Credential/Grant 或部分更新资料。

- 无效名称：HTTP 400 `VALIDATION_ERROR`，`details.reason=principal_display_name_invalid`、`details.name_reason=length|invalid_characters|reserved`。
- 名称已占用：HTTP 409 `PRINCIPAL_DISPLAY_NAME_CONFLICT`，`recovery=choose_another_display_name`；不返回占用者身份或权限信息。
- 资料修改继续要求 expected_version，保留原鉴权、CAS、审计与读回合同。

## Agent 名称解析

新增 `GET /api/v1/workspaces/{workspace_id}/projects/{project_id}/assignees?display_name=<name>`。参数必填，按相同规范化 key 精确匹配，仅允许当前有权读取目标 Project 的调用者访问，并遵循 Browser Session scope。

返回 `{items:[{principal_id,display_name}],has_more:false,next_cursor:null}`，items 为零或一项，只包含该项目当前可分配的 Owner/有效 writer；不存在、无资格或无权候选不做区分。Skill 可以在用户已授权的指派任务内直接用唯一匹配的 ID 更新 Issue，不为名字消歧重复确认；零匹配时不模糊猜测。服务端执行指派时仍重新校验资格。

## schema 8 与已有名称

追加不可覆盖 migration 0008；不修改旧 migration。已部署 cfkanban.dev 的只读检查发现 6 个名称，4 个测试名称含 ASCII 空格，无转换冲突。迁移将 ASCII 首尾空格去掉、内部每个空格替换为 `_`，无变化名称保持原样；转换冲突、保留词或不支持的旧字符使整个 migration 失败，不自动加后缀或删除身份。改变显示名时递增 Principal version 并更新时间，ID、Credential、Grant、assignment 和历史引用不变。

SQLite 原生 lower 不提供 Unicode 规范化，因此旧数据自动回填明确限定为 ASCII 字母数字、基本汉字 U+4E00–U+9FFF 和 `_ - ·`（及待替换 ASCII 空格）；其他旧名称停止并需要单独核查，不使用错误的 Unicode key。新建与改名支持上文完整 Unicode 范围，由 Worker/Skill 计算 key。

部署需先读回完整名称列表和转换结果、确认唯一性及可验证 restore point，再按固定 manifest 单次 query 应用 migration 并部署配套 Worker；schema 8 不兼容旧 Worker 写入/回滚。迁移 SQL 不执行网络请求，不调用 LLM，不更新其他资源名称；远端发布沿用部署授权与 journal 边界。本次源码实现不等于线上已迁移。

## 验证

覆盖 Unicode/空白/不可见字符/保留词/长度、大小写与 NFKC 冲突、自身改名、并发写入与失败回滚、Invite/Public Join 重试、候选权限与资格，以及迁移空格转换、碰撞全回滚和关系保留。

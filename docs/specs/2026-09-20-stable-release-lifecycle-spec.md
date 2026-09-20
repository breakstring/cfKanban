# 正式发行发现、版本展示与开发使用合同

- 状态：Frozen
- 日期：2026-09-20
- 执行任务：[CFK-425](https://cfkanban.dev/app/issues/CFK-425)
- 授权依据：用户确认普通用户入口应版本无关、默认最新正式发行，并要求基于该方案优化及发布。
- 本增量覆盖 Bootstrap/Web 合同中的固定测试发行入口；其余信任、权限、凭据与部署恢复边界保持不变。

## 用户入口与发现

README、同实例双语 deploy-guide/join、bootstrap install 和 Skill 使用指南不绑定某次产品版本。首次安装及新部署默认发现最新正式发行；已有可信且兼容的技能可以复用，加入项目不隐含技能更新或实例升级。测试版、历史版与源码试验必须显式选择。

canonical stable pointer 固定为 `https://github.com/breakstring/cfKanban/releases/latest/download/stable.json`。GitHub Latest 仅由正式发布推进，RC 不推进。该可变入口只用于只读发现；Agent 在准备计划时解析并固定准确版本、不可变 manifest URL/SHA-256、两个工件及兼容矩阵。后续安装和部署沿用同一快照，不在执行途中重新解析 Latest。不存在 stable 或校验失败时明确停止，不回退 main、RC 或本地 cache。

当前实现保持 GitHub tag 等于发行版本（如 `1.0.0`），不额外添加 `v`。用户无需编写版本参数；Codex 安装计划由 Agent 从已验证发行解析准确 tag，再使用 `--ref <resolved-version>`。不通过删掉 `--ref` 获得普通用户更新，也不新增可变 stable Git 分支。检查更新与执行更新分离；已固定旧 tag 的 marketplace 需要明确切换来源，刷新旧 tag 不等于发现下一 tag。

## 安装、兼容与宿主

安装完整 Skill bundle，保留共享 `packages/skill-runtime` 和相对目录；不能仅复制一个 Skill 目录。宿主投影只是已验证 bundle 的副本。更新报告分别说明 canonical active receipt、宿主安装投影、当前任务加载状态；无法验证新任务加载时保留未验证说明。

首次安装、已安装兼容技能、固定旧 RC 检查更新、显式升级、历史版回退、旧实例兼容和源码开发均有明确路径。Skill update 与 Instance upgrade 独立；同一套兼容 Skill 可访问多个实例。来源连续性、秘密保存、digest 校验与所有已有授权边界不变。

## 发行版本与运行时版本

新增 `release/version.json` 作为源码当前产品发行版本的单一声明；正式构建、plugin metadata 和对应 release config 必须一致。打包拒绝声明版本与构建版本不一致，避免只更换 zip 文件名得到新版本。

`/healthz`、`/.well-known/cfkanban-instance.json`、`/api/v1/meta` 增量返回 `release_version`，来自正在执行的 Worker 构建；第一方 Web 使用该值展示实际发行版本。旧实例无字段时不把旧 `service_version` 冒充产品发行版本。保留 `service_version` 的既有兼容语义、OpenAPI `info.version` 和 API 路径；schema 仍由 migration manifest 决定。不为了产品发行编号更新 D1 或重写历史 migration。

## 源码开发与环境

普通用户默认 stable；源码调试使用明确 checkout/commit 和 dirty 状态，不能声称 canonical release。功能开发使用下一个预发行版本，已发布 tag、manifest 与工件不可覆盖。日常使用与发行验收使用已发布、可校验工件。

建议本地开发、独立远端测试实例和正式实例分工；测试实例使用独立 Worker/D1/instance ID/凭据，附件存储也隔离。已有开发管理项目仍可保存在正式实例。操作目标通过准确实例和项目解析，Repo scope 只作推荐过滤；切换实例不需要切换 Skills。此次实现不创建新测试实例、不改变宿主安装来源。

## 发行顺序与验证

1. 修订合同、指南、版本声明和实现，完成根 validate 与发行定向测试。
2. 在准确 commit 构建确定性工件，发布不可变 tag 和六份 release 资产；正式发布维护并核对 Latest。
3. 匿名下载 stable pointer、manifest 和工件，重新校验摘要；验证从固定 stable 入口能够发现该正式版本。
4. 既有实例只按独立 preflight/plan 升级，保留资源、Owner、数据和兼容性；版本读回同时核对产品发行和 API/schema。
5. 线上任务只记录实际完成的验证。CFK-149 的真实跨任务宿主加载与回退不由脚本测试冒充。

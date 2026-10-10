# CLI 部署计划与恢复

CLI 与部署 Skill 使用同一不可变工件及精确计划授权。读取帮助或准备源码不授权 Cloudflare 修改。

```text
cfkanban deploy capabilities --json
cfkanban deploy release discover --json
cfkanban deploy plan --help
cfkanban deploy apply --help
cfkanban deploy resume --help
cfkanban deploy upgrade --help
cfkanban deploy attach --help
cfkanban deploy recovery --help
cfkanban deploy trends inspect --help
cfkanban deploy trends plan --help
cfkanban deploy trends run --help
```

准备时核对 Node/Wrangler 兼容、准确 Cloudflare 账户、可信发行及工件摘要。计划固定资源、迁移、可选能力与费用。Apply 需要与准确计划匹配的授权材料，通用 yes 不授权漂移；多步部署不是单个原子事务。

schema 30/31 首次部署时，`deploy plan` 使用已验证 Service manifest 的准确 `release.schema_version`，并传入从 1 连续覆盖该 schema 的 `initialMigrations: {manifest_sha256, ordered: [{sequence, name, sha256}]}`。计划固定迁移源摘要和执行摘要，私有 config 生成该 operation 的已验证 migration 投影。apply/resume 需要匹配且已验证的 `serviceBundleRoot`。缺失这些证据的旧计划或超过 schema 31 的目标均在云端写入前停止；已发行 migration 文件及 canonical ledger checksum 保持不变。

续跑保留同一 plan、operation 和 journal。来源不明资源、身份变化、部分迁移或 schema/读回不一致使新写入停止。同计划无漂移恢复在原授权覆盖时不重复请求批准。成功要求 Worker、D1、Owner、版本的实际读回与 receipt，不能只看子进程退出码。

部署保留必要的显式实例、Cloudflare 账户与资源目标。Apply/resume 使用已冻结的获批计划；切换目录或修改 CLI 保存上下文不会改选该计划目标，也不能代替确认。

首次部署核验准确的 Cloudflare `workers.dev` 地址。已有实例升级使用当前可信地址，包括自定义域名，并在云端写入前确认它与冻结计划一致。域名变更沿独立的可信 origin rebind 流程处理；在升级计划中填写另一个 URL 不建立信任。最终读回核对同一实例与 Owner，并拒绝较旧的 origin version。

Cloudflare 登录、GUI/UAC 和浏览器步骤可能需要人完成，WebUI 不持有 Cloudflare 凭据。本地 Skills/CLI 更新不隐式升级实例。Worker rollback 不回退 D1，Time Travel restore 不自动执行。外部实测需要单独获准的隔离环境。

设备认证的验证 URL 和代码只交付到真实专用终端。无终端进程在启动登录前失败；人工完成获准的官方 Wrangler 登录后，核对准确 profile 和账户。中断的认证动作不自动重复执行。人工登录后的接续要求原计划绑定的证据、显式 profile/账户和实时读回；记录外部核验结果，同时保留原动作提交未证实的事实。

## 首次趋势历史回填

schema 30 将首次历史回填与小时 Cron 分开。`deploy trends inspect` 读取已验证的部署、队列和检查的实际用量，`deploy trends plan` 固定有界计划，`deploy trends run` 只执行这份已授权计划。这项固定用途的部署维护更新派生统计，不修改 Issue/Event 事实或权限；Web/API/MCP 继续只读覆盖信息。

用文件或 stdin 提供非秘密结构化输入：

```sh
cfkanban deploy trends inspect --input-file trends-inspect.json --json --no-interactive
cfkanban deploy trends plan --input-file trends-plan.json --json --no-interactive
cfkanban deploy trends run --input-file trends-run.json --json --no-interactive
```

检查需要 `instanceId`、`currentReceiptPath`、`serviceBundleRoot` 和绝对路径 `wranglerExecutable`；使用当前部署的私有 receipt 及匹配的已验证 canonical Service 缓存。计划增加 `taskId`、可选 `operationId` 和 `budget`，返回 `{plan, plan_digest, inspection}`。执行包括相同准确路径、`instanceId`、`taskId`、`operationId`、未改动的 `plan`，以及 `authorization: {task_id, operation_id, instance_id, plan_digest}`。凭据由安全模块加载，不得写入这些文件。目标和算法来自已验证 receipt 与不可变 Service，不接受命令覆盖或任意 SQL。

先核对当前账户剩余额度。默认每批 8 个 Issue 页、每页 100 个 Event，单次最多 1000 页、30 分钟、3000 次 provider 请求，请求至少间隔 500ms，D1 读取 250000 行、写入 50000 行。预算只允许减少工作量或放慢请求；启动下一页前预留读取 4000 行、写入 1000 行及控制请求。这些限制只针对本次运行，账户其他流量也会消耗额度。

执行使用本地 lock、跨机 120 秒 D1 lease/fence 和逐页单条 CAS SQL。私有 journal 记录实际 D1 读写、SQL 耗时、请求数、队列进度及本地 Node CPU，后者不是 Worker CPU。预算用尽、429、用量缺失、无进展或目标漂移即停止。结果不确定时保留原 plan、operation 和 batch ID，先核对提交证据再判断后续写入，不盲目重跑或换键。结束后读回队列与图表覆盖；空队列仍可能保留不可恢复历史的 `partial` 标记。

将已有 preferred 自定义域名登记为 schema 27+ WAF 管理目标，是独立的非秘密流程。`deploy waf-target inspect` 核对准确 Worker/域名/D1 与当前 Owner；`deploy waf-target plan` 冻结目标、实时版本及可选的准确旧规则迁移。核对后，`apply` 或 `resume` 使用同一计划授权。它仅向 D1 写有原子保护的目标/归属元数据，不创建域名或规则，Cloudflare 凭据留在本机。Web/API 随后按共享 Service plan/apply 合同启停 WAF。既有 `deploy public-access` 域名切换/回退仍单独处理 origin 和 Passkey 影响。

```text
cfkanban deploy waf-target inspect --help
cfkanban deploy waf-target plan --help
cfkanban deploy waf-target apply --help
cfkanban deploy waf-target resume --help
```

回填因结果不确定而停止时，保留原 operation ID，运行 `cfkanban operation recover --instance-id <instance-uuid> --operation-id <operation-uuid> --json --no-interactive`。恢复只读核对原批次，不重放回填写入。缺失用量仍标为未知并保守预留额度；核对账号用量后，再为剩余队列创建新的有限计划。恢复期间的部署须仍与原 receipt 一致。

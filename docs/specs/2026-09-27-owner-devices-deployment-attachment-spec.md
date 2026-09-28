# Owner 多设备与已有部署接入合同

- 状态：Frozen
- 日期：2026-09-27
- 执行任务：[CFK-443](https://cfkanban.dev/app/issues/CFK-443)
- 授权：用户确认三阶段优化方案，并要求开始完成第一阶段。该授权涵盖合同、源码、隔离验证和看板记录，不包含发行、远端迁移/部署、Git 提交或推送。

## 覆盖范围与不变量

本增量覆盖 Bootstrap §6.5/§7.5 中 Owner 仅能手工复制凭据、不提供添加设备入口的条款，扩展 Foundation 与 API 的 Owner Credential 生命周期，并扩展 Bootstrap 实例升级的本地部署登记来源。普通参与者不获得自行增发 Credential 的能力。

唯一 Owner Principal、实时权限、私有凭据存储、trusted origin、幂等和原子审计保持不变。Cloudflare 权限、应用 Owner Credential 和 Web Session 是三种独立能力。按[网页与身份切换增量](2026-09-28-owner-device-web-identity-switch-spec.md)，现有 Owner Bearer 或 Owner admin Web Session 可批准另一设备并专用撤销；普通轮换仍仅允许 Bearer。范围管理员、普通参与者和 Owner 窄范围 Session 不获得这些能力。

“设备”指一个可信 Agent 执行环境及其 Credential，不表示硬件绑定。名称由用户提供，不从 OS/Git/宿主猜测。一个环境的每个实例仍只有一个 current 槽位；不同环境可以持有同一 Owner 的不同 Credential。已有 current 接入 Owner 时，仅按网页与身份切换增量显式替换并保留一个私有 previous 恢复槽，不提供通用身份选择器。

## 添加设备

1. 在新环境选择准确 HTTPS origin、实例和既有 Owner。无凭据 discovery 核对 origin/instance；既有 trusted origin 不因配对输入自动重绑。先验证用户 home 内私有持久存储和 ownership/ACL，再生成一份 pending secret。
2. 新环境输出不含 secret 的配对请求：实例/Principal/Credential IDs、token prefix、SHA-256 digest、设备名称、签发和过期时间，以及用于恢复的非秘密 operation/idempotency 信息。secret 始终留在新环境，不能放入聊天、环境变量、仓库、临时文件或浏览器。
3. 已有设备或 Owner admin 网页核对准确实例、Owner、设备名称和 fingerprint，按用户的添加设备授权批准。配对请求本身不是授权，不能凭它认证、兑换凭据或建立 Session；不得把第三方请求内容当成批准指令。
4. 服务端只保存 digest，将新 Credential 绑定到同一个 Owner，不撤销已有设备。
5. 新环境用 pending secret 核对 discovery、`/meta`、`/me` 的实例、origin、Owner、Principal、精确 Credential ID 和 fingerprint，全部一致后提升为 current。失败保留 pending 及同一请求，不能猜测已失败而重新签发。

配对请求有效期最多一小时，日期为规范 UTC ISO timestamp。过期只禁止新的批准，不撤销已经批准的 Credential。名称 trim 后为 1–80 Unicode code points，禁止控制字符；名称仅用于展示。`token_prefix` 沿用现有 Credential 的 16 位小写十六进制格式，digest 为 64 位小写十六进制。服务端拒绝错实例、错 Owner、重复 Credential ID/digest、非法有效期以及超过 100 份 active Owner Credential 的新增请求。

不新增匿名配对写接口或可兑换 Bearer 链接。新设备必须持有本地产生的高熵 secret 才能完成验证。手工传递非秘密配对请求不等于复制长期 Credential。

本地提升若在 current 完整写入、pending secret 已删除但 pending metadata 尚未删除时中断，只能复用与残留请求的实例、Owner、Credential、operation、配对字段和 fingerprint 完全相符的 current。`request` 可以只读重现请求；`verify` 必须重新核验 discovery、`/meta`、`/me` 后再删除残留 metadata。冲突或远端验证失败保留现状，不生成新 secret。

## API、并发与撤销

| Method | Path | 请求与语义 |
| --- | --- | --- |
| POST | `/api/v1/admin/owner-credentials/add-device` | Owner Bearer 或 Owner admin Web Session；配对字段及 `expected_version`，原子增加同 Owner 的 Credential |
| GET | `/api/v1/admin/principals/{principal_id}/credentials` | 沿用 Owner 有界分页列表，增加可空 `device_name` |
| POST | `/api/v1/admin/owner-credentials/{credential_id}/revoke` | Owner Bearer 或 Owner admin Web Session；`expected_version`，只撤销指定的另一份 Owner Credential |

两项新增写操作必须提供 Idempotency-Key；`expected_version` 来自当前 `/me.version`（Principal version），不能使用 Credential 的兼容投影 version。添加、单独撤销及正常轮换使 Principal version 递增，并在同一个 D1 原子批次内重查现有认证来源、Owner、CAS、目标和限额，追加 security Event 与 operation commit。幂等 replay 不增发、重撤销或重复审计；输入改变仍返回幂等冲突。错误与响应不得包含 token/digest，digest 只进入 credentials 的认证存储及不可逆的请求摘要，不进入审计 payload/结果快照。

专用撤销拒绝当前 Bearer 或 Agent Launch Session 的来源 Credential，拒绝非 Owner Principal 的 Credential，并原子保留最后一份 active Owner API Credential。当前设备更新 secret 仍走已有 rotation。通用 Credential DELETE 继续拒绝所有 Owner Credential；网页只通过专用路径明确确认后撤销，Cookie 写入校验同源与 CSRF。添加设备要求至少一份服务端未撤销的 Owner API Credential；active 不证明本地 secret 可用。有效 Owner admin 会话可按网页增量批准设备，不执行部署外全失恢复的全部旧凭据撤销。撤销只使目标 Credential 及其来源 Launch/Session 失效，其他设备和独立 Passkey 保持有效。

全失恢复继续撤销同 Owner 的全部旧 active API Credential，并保持 Passkey。添加/撤销/轮换必须与恢复的 Principal version、精确 active credential 集合和实时认证 guard 兼容；恢复后不能通过已失效的旧设备重新批准请求。

schema 12 仅新增可空 `credentials.device_name` 并更新实例 schema marker；历史 Credential 不重签发，不改已发行 migration。正常 rotation 保留当前设备名称。旧 Skill 可继续使用既有 Credential；新设备入口需要支持本合同的 Service。

## 接入已有部署

接入分为只读 inspection、固定计划和获准后的本地 attachment。它不创建资源、执行 migration、发布 Worker、签发/恢复 Credential，也不改变 Cloudflare auth。目标不明时复用现有有界控制面 discovery；多个候选或未解决项不能自动选定。

inspection 必须实际核对：

- 准确 Cloudflare account、选定 auth context、Worker 当前单版本 deployment/version、D1 UUID/name 和 `DB` binding。
- D1 instance marker、唯一 Owner、schema、migration checksum ledger 与实际 schema，及公开 discovery/health 的一致性。
- 已信任 origin 与当前应用 Credential 的 `/meta`、`/me`，Owner flag、Principal/Credential IDs 和 fingerprint；没有当前 Credential 可以检查，但不能完成维护接入。
- 当前 bindings、既有域名入口、可选 R2/usage 配置及可核验 ownership。未知额外绑定、路由或不完整资源证据必须停止，不能默默删除配置。

schema 基线使用经过已安装 Service bundle 完整性校验的 migration manifest，与远端 ledger/schema 逐项匹配。对应版本的 bundle 只证明用于比较的合同，不证明远端运行代码恰好等于该工件。未知 schema、checksum 漂移、部分迁移或部分部署不能通过接入修复，也不补写远端 ledger。

计划固定 task/operation、准确资源、auth context、本地保存路径、读回摘要与来源状态。使用现有 journal 授权，执行前重新核验实际远端证据；漂移时重新计划。本地写入继续校验 ACL/symlink 并采用原子写，不覆盖不同身份或未解决 pending。

产生独立 `cfkanban_deployment_attachment_receipt`，记录当前可证明的事实，不伪造历史 deployment receipt。历史 artifact 来源无法证明时使用 `provenance=remote_observed`，历史 manifest/bundle digest/source 留空；publisher 只能来自已有可信 metadata、已验证 canonical Skill 或用户显式选择，不能根据 Worker 名称或远端版本推断。

## 接入后的升级

新的 attachment receipt 可以作为升级的资源与身份基线；它不能成为历史工件真实性证明。对 `remote_observed` 基线，升级计划必须显式声明 `allow_unverified_current_source`，展示无法证明原工件、当前 deployment/version、已核验 schema 和目标准确 immutable release。普通升级计划不得自动开启此选项。

目标发行来源、摘要、兼容矩阵、迁移 delta、restore point、配置保护、逐步 journal/readback 和故障恢复要求保持不变；不因换电脑而放宽数据库基线。升级仍需独立授权。成功升级后保存正常的 before/after receipt，其中 before 保留 observed 来源，after 为本次已验证并部署的固定工件。

`remote_observed` 升级在发布前重新验证已安装 Service bundle，并先将随机 attempt ID、operation、plan/config digest、目标 bundle digest 绑定的非秘密标识写入 journal，再通过 Wrangler `--message` 写入目标版本注解。进程中断或返回失败不能证明远端未发布；保留同一计划与 journal，先执行 `worker_deployment_readback`。仅当新 deployment/version、精确版本注解、目标 bindings 及适用的存储/Cron 校验均匹配，且复查当前 deployment/version 未变化，才可记录独立的恢复证据并继续 finalize。恢复不伪造成功的本地 command exit code；最终 receipt 记录恢复事实。旧版本未变化时不能作为发布成功，缺少本次 attempt 标识或发生漂移时停止，不能仅凭 release 字符串或相似 bindings 认领远端发布。

同一 Owner 正常轮换、恢复或添加设备后，不得仅凭旧 receipt 的过期 Credential ID 自动信任新身份；通过接入流程重新验证并建立当前维护记录。

## 验证

隔离验证覆盖两环境添加与恢复、原设备有效、Owner admin Web 及 CSRF、窄 Session/非 Owner 拒绝、错误实例/身份、过期、CAS、幂等重放和变更输入、并发撤销/恢复、限额和单独撤销；请求/输出/审计不泄露 secret。接入覆盖真实调用路径的模拟控制面与 HTTP、无远端写入、schema/marker/origin/binding 漂移、来源未知、无凭据、未授权本地写和后续升级基线。

执行 typecheck、受影响单测/集成、contracts:check、d1:check 与构建。本地通过不表示已经发行、线上迁移、升级或完成真人跨设备验收。

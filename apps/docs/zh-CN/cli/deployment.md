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
```

准备时核对 Node/Wrangler 兼容、准确 Cloudflare 账户、可信发行及工件摘要。计划固定资源、迁移、可选能力与费用。Apply 需要与准确计划匹配的授权材料，通用 yes 不授权漂移；多步部署不是单个原子事务。

续跑保留同一 plan、operation 和 journal。来源不明资源、身份变化、部分迁移或 schema/读回不一致使新写入停止。同计划无漂移恢复在原授权覆盖时不重复请求批准。成功要求 Worker、D1、Owner、版本的实际读回与 receipt，不能只看子进程退出码。

部署保留必要的显式实例、Cloudflare 账户与资源目标。Apply/resume 使用已冻结的获批计划；切换目录或修改 CLI 保存上下文不会改选该计划目标，也不能代替确认。

首次部署核验准确的 Cloudflare `workers.dev` 地址。已有实例升级使用当前可信地址，包括自定义域名，并在云端写入前确认它与冻结计划一致。域名变更沿独立的可信 origin rebind 流程处理；在升级计划中填写另一个 URL 不建立信任。最终读回核对同一实例与 Owner，并拒绝较旧的 origin version。

Cloudflare 登录、GUI/UAC 和浏览器步骤可能需要人完成，WebUI 不持有 Cloudflare 凭据。本地 Skills/CLI 更新不隐式升级实例。Worker rollback 不回退 D1，Time Travel restore 不自动执行。外部实测需要单独获准的隔离环境。

设备认证的验证 URL 和代码只交付到真实专用终端。无终端进程在启动登录前失败；人工完成获准的官方 Wrangler 登录后，核对准确 profile 和账户。中断的认证动作不自动重复执行。人工登录后的接续要求原计划绑定的证据、显式 profile/账户和实时读回；记录外部核验结果，同时保留原动作提交未证实的事实。

将已有 preferred 自定义域名登记为 schema 27+ WAF 管理目标，是独立的非秘密流程。`deploy waf-target inspect` 核对准确 Worker/域名/D1 与当前 Owner；`deploy waf-target plan` 冻结目标、实时版本及可选的准确旧规则迁移。核对后，`apply` 或 `resume` 使用同一计划授权。它仅向 D1 写有原子保护的目标/归属元数据，不创建域名或规则，Cloudflare 凭据留在本机。Web/API 随后按共享 Service plan/apply 合同启停 WAF。既有 `deploy public-access` 域名切换/回退仍单独处理 origin 和 Passkey 影响。

```text
cfkanban deploy waf-target inspect --help
cfkanban deploy waf-target plan --help
cfkanban deploy waf-target apply --help
cfkanban deploy waf-target resume --help
```

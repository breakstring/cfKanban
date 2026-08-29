# Web 认证与公开加入能力快照

- 快照日期：2026-08-29
- 性质：易漂移研究事实，不是产品合同或实现授权
- 来源：W3C 与 Cloudflare 官方文档

本文只为 SB-30/SB-31 的方案讨论提供事实依据。浏览器、Cloudflare 产品、免费额度和安全建议可能变化；进入实现前必须重新核对。

## WebAuthn / Passkey

W3C WebAuthn 定义了面向 Web Relying Party 的 scoped public-key credential。注册时 authenticator 创建密钥对，Relying Party 保存 public key；认证时 authenticator 对 challenge 产生签名 assertion。页面脚本不会获得 credential private key，只收到注册或认证结果对象。WebAuthn 只在 secure context 中可用，并由 origin/RP ID 限制可使用的 credential 范围。

### 浏览器能检测什么

- `window.PublicKeyCredential` 只能说明浏览器暴露了 WebAuthn API。
- `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` 只能说明当前客户端大概率有可执行用户验证的平台认证器。返回 `false` 不能排除外接安全密钥、手机或第三方 credential manager。
- `PublicKeyCredential.isConditionalMediationAvailable()` 只说明浏览器支持 conditional mediation/autofill 体验，不说明当前用户已经保存了可用于本站的 Passkey。
- 新增的 client capability 查询也只能表达客户端能力，不能成为“当前设备/当前域名已有凭据”的认证事实。

WebAuthn 出于隐私考虑不提供网页静默枚举本地 credential 的能力。`navigator.credentials.get()` 会启动浏览器控制的认证 ceremony；只有用户选择并成功完成后，页面才知道某个 credential 可用。取消、超时、没有匹配凭据、认证器不可用和策略拒绝等情况可能表现为相近失败，因此产品不能把失败解释成“当前设备没有本站 Passkey”。

服务端能列举的也只是曾为当前 Principal 登记、尚未撤销的 public-key 记录，例如 credential ID、公钥、RP ID 和时间 metadata。服务端无法证明私钥仍在当前设备、已同步到哪台设备，或现在一定可用。因此 UI 应称为“为你的 cfKanban 身份登记的 Passkeys”，不能称为“当前设备中的 Passkeys”。

### RP ID 与 origin

WebAuthn 标准允许在满足 RP ID 后缀关系与服务端 origin allowlist 等条件时，让相关子域共享 credential；Level 3 还定义了更复杂的 Related Origin Requests。这说明“换 hostname 必然重新登记”不是标准的一般结论。

cfKanban v0 主动选择更窄的合同：登记和认证时的 RP ID 固定为当前请求 hostname，服务端验证的 expected origin 固定为发起 ceremony 的规范化完整 HTTPS origin，不配置跨 hostname 共享或 Related Origin Requests。这样 `workers.dev`、Custom Domain 和第三方代理域名分别拥有自己的 Passkey 范围；切换 hostname 时需要通过 Agent Browser Launch 在新地址重新登记。该限制是为了减少 allowlist、域名接管与迁移状态，不应被描述为浏览器做不到跨子域共享。

Cloudflare Workers 提供 Web Crypto API 的完整接口面，但支持算法与浏览器可能存在差异。Worker 可以用标准密码学能力完成 digest 和签名验证；具体 WebAuthn COSE algorithm、attestation policy、counter 处理和兼容库仍需在实现 SPEC 中验证，不能仅凭“支持 Web Crypto”推断完整 Passkey 实现已经成立。

来源：

- [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
- [MDN：`isUserVerifyingPlatformAuthenticatorAvailable()`](https://developer.mozilla.org/en-US/docs/Web/API/PublicKeyCredential/isUserVerifyingPlatformAuthenticatorAvailable_static)
- [MDN：Web Authentication API 与 conditional mediation](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API)
- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

产品含义：Passkey 可以让 cfKanban 在不把长期 API Bearer Credential 放入浏览器的前提下，为同一 Principal 增加独立 Web authentication method。未认证首页可以按浏览器能力调整说明，但不能静默探测或断言 credential 是否存在；精确可用性只能通过用户主动发起认证来证明。它仍会新增 credential lifecycle、RP ID/domain 迁移和恢复合同，因此不是一个“只加登录按钮”的可逆 UI 细节。

## Cloudflare Access

Cloudflare Access 可以保护 self-hosted HTTP applications，并连接 Cloudflare identity、企业 IdP 或邮件 one-time PIN。它在应用之前完成外部身份认证，但需要 Zero Trust/Access 配置；IdP identity 也不会自动成为 cfKanban Principal 或 Project Grant。

来源：

- [Cloudflare Access HTTP applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
- [Cloudflare Access identity providers](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/)
- [Cloudflare Access one-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)

产品含义：Access 更适合作为组织部署的可选外层 profile，而不是 strict-zero v0 的默认登录系统。采用时仍需明确 external identity 到 immutable Principal 的绑定、撤销和审计。

## 公开加入的滥用防护

Workers Rate Limiting binding 可以按调用方或资源 key 做路径级保护，但计数按 Cloudflare location 本地维护，更新宽松且最终一致。官方明确指出它不适合精确 accounting，也不推荐只用 IP 作为用户 key，因为公司、移动网络和隐私代理可能共享地址。

Turnstile 可以在人类网页产生短期 challenge token，但必须由服务端调用 Siteverify 验证；token 固定短时且一次性。它要求浏览器交互与服务端 secret/config，不天然适配由 Agent 独立完成的 Public Join 兑换。

来源：

- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

产品含义：公开自助加入必须由 D1 transaction 原子强制 Project active quota 与幂等，Rate Limiting 只能降低突发滥用；Turnstile 可以后置为有人类浏览器参与的可选保护，不能成为 Agent-first 核心兑换的隐含依赖。

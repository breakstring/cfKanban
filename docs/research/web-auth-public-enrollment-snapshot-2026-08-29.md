# Web 认证与公开加入能力快照

- 快照日期：2026-08-29
- 性质：易漂移研究事实，不是产品合同或实现授权
- 来源：W3C 与 Cloudflare 官方文档

本文只为 SB-30/SB-31 的方案讨论提供事实依据。浏览器、Cloudflare 产品、免费额度和安全建议可能变化；进入实现前必须重新核对。

## WebAuthn / Passkey

W3C WebAuthn 定义了面向 Web Relying Party 的 scoped public-key credential。注册时 authenticator 创建密钥对，Relying Party 保存 public key；认证时 authenticator 对 challenge 产生签名 assertion。页面脚本不会获得 credential private key，只收到注册或认证结果对象。WebAuthn 只在 secure context 中可用，并由 origin/RP ID 限制可使用的 credential 范围。

Cloudflare Workers 提供 Web Crypto API 的完整接口面，但支持算法与浏览器可能存在差异。Worker 可以用标准密码学能力完成 digest 和签名验证；具体 WebAuthn COSE algorithm、attestation policy、counter 处理和兼容库仍需在实现 SPEC 中验证，不能仅凭“支持 Web Crypto”推断完整 Passkey 实现已经成立。

来源：

- [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)

产品含义：Passkey 可以让 cfKanban 在不把长期 API Bearer Credential 放入浏览器的前提下，为同一 Principal 增加独立 Web authentication method。它仍会新增 credential lifecycle、RP ID/domain 迁移和恢复合同，因此不是一个“只加登录按钮”的可逆 UI 细节。

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

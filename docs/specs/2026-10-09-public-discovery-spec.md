# 公开 API、Skills、页面发现与 Agent 阅读

- 状态：Frozen
- 日期：2026-10-09
- 授权依据：用户要求完成 CFK-720、CFK-721、CFK-725，并在检查通过后发布下一 RC、升级既有线上实例；随后授权实现固定 Content Signals、Markdown 内容协商，以及说明现有凭据鉴权和获取流程的 `/auth.md`，不增加 Owner 配置或 OAuth。
- 本文是 API / Schema、文档中心、Bootstrap 和发行生命周期的增量；新增标准发现资源，不改变业务权限、认证、API 兼容版本、D1 schema、安装来源或执行授权。

## 来源与 origin

所有资源由同 Worker / Service 工件交付，匿名读取不依赖 D1、身份或可选云服务。绝对 URL 以实际 `Request.url.origin` 生成；不信任 `X-Forwarded-Host` 等请求头，不硬编码演示域名，不自动迁移 origin。preferred origin 的发布、客户端探测和安全迁移继续遵循已有合同。

仅支持 GET / HEAD，HEAD 返回对应 GET 的响应头且无正文，不把正文长度改写为零。其他方法返回 405 和 `Allow: GET, HEAD`；未知、缺失或已退役资源返回真实 404，不回退应用 HTML。公开发现不向 Static Assets 转发 Bearer 或 Session，不列举私有项目、事项、身份、凭据、邀请或一次性链接。

发现文档采用 `no-store, no-transform`、`no-referrer`、`nosniff`；固定版本的归档可使用 immutable 缓存。现有 `/app` 深链、公开文档 404、OpenAPI 和实例发现不改变。标准发现文件与公开手册同属公共文档层，REST OpenAPI 继续描述业务与身份操作；API Catalog 的 `service-desc` 指向现有 OpenAPI。

## API Catalog 和首页 Link

`/.well-known/api-catalog` 返回 RFC 9727 / RFC 9264 Linkset，媒体类型为 `application/linkset+json`，附 RFC 9727 profile。目录沿 RFC 9727 Appendix A.1 的结构，使用真实 API 基址 `/api/v1` 为 link context（anchor）；`service-desc` 为 `/openapi.json`，`service-doc` 为当前实例的 English / 简体中文公开概览及双语 `/auth.md`，保留对应语言和媒体类型。context 不要求可直接 GET，不把没有 GET 资源的基址另作需要解引用的 href；实际描述目标均为现有公开资源。

GET / HEAD 均提供 `rel="api-catalog"` 的 Link。首页成功的 GET / HEAD HTML 与 Markdown 响应追加 API Catalog、锚定 API 的 OpenAPI、双语公开概览和 `/auth.md` Link，保留原有头部；不为其他应用页面或错误增加发现声明。不广告尚不存在的远程 MCP、A2A 或 OAuth 服务，不为评分虚构描述资源。

规范来源：[RFC 9727](https://www.rfc-editor.org/rfc/rfc9727)、[RFC 9264](https://www.rfc-editor.org/rfc/rfc9264)、[RFC 8288](https://www.rfc-editor.org/rfc/rfc8288)。首页 Link 是该标准提供的可选发现方式，本项目在用户授权下采用。

## Auth.md 鉴权指引

根 `/auth.md` 是面向 Agent 与 API 接入者的公开、自包含双语 Markdown，H1 包含 `auth.md`，媒体类型为 `text/markdown; charset=utf-8`。由同一 Worker / Service 工件生成，仅支持 GET / HEAD，使用上述安全缓存与响应头；HEAD 与 GET 保持头部一致且无正文，其他方法返回 405。读取不查询 D1、不核验身份、不经过业务请求限流、不签发凭据或触发兑换，且不把认证材料转发到 Static Assets。它是现有流程的发现说明，不是新的身份或授权入口。

正文说明现有 `cfk_v1_<prefix>_<secret>` opaque Credential 通过 `Authorization: Bearer <credential>` 发送到可信实例 API origin，并可用 `GET /api/v1/me` 核对当前身份、`GET /api/v1/meta` 核对版本和当前可见范围。Credential 认证 Principal，项目权限仍由服务端当前 Grant 等事实决定；不把持有凭据或读取公开手册等同于获得任意项目权限。

未持有凭据的参与者沿现有完整邀请或已开放项目的 Public Join 引导取得访问权。指引列出实际 `POST /api/v1/invitations/redeem` 与 `POST /api/v1/public-joins/{public_id}/redeem`，说明首次创建身份与明确项目授权在现有原子兑换中完成、已有身份应按合同复用；不让扫描器试探 POST，不新增“匿名注册但无项目权限”的签发机制。邀请、恢复邀请和一次性链接均通过专用安全流程处理，不能粘贴到日志或当作公开发现内容。

浏览器登录继续使用 Agent Browser Launch 或已登记 Passkey；网页不接受长期 Credential 粘贴，Passkey 不替代 Agent API Credential，也不授予项目权限。参与者凭据丢失使用 Owner 签发的既有身份恢复邀请；Owner 接入新设备和全失恢复沿已有管理 / 部署流程，保留原 Owner，不通过公开注册重新创建身份。首次部署的 Owner bootstrap 也不成为公开注册接口。

文档链接使用实际请求的同 origin 绝对 URL，指向现有双语接入、加入、Owner 设备及恢复手册、实例发现和 OpenAPI。Credential 只能发往已信任 origin；远端自报实例 ID、转发请求头、重定向或文档链接不能扩大信任。既有安全 runtime 负责私有凭据存储与发送，不在 URL、命令参数、环境变量、日志、聊天、浏览器存储或 Git 中放置长期 Credential。

本增量不引入 OAuth、OAuth Protected Resource / Authorization Server 元数据、`agent_auth` 注册广告、ID-JAG 或匿名无权限注册，不为扫描评分宣称未实现的协议。现有 REST 认证、权限、并发、幂等、API 兼容版本、schema 与恢复语义均保持不变。

## Skills Discovery

采用 [Cloudflare Agent Skills Discovery Draft v0.2.0](https://github.com/cloudflare/agent-skills-discovery-rfc) 作为可选发现格式。`/.well-known/agent-skills/index.json` 为 `application/json`，包含 `$schema` 和四个 Skill 的 `name`、`type`、`description`、`url`、`digest`。`$schema` 使用草案的版本标识，不依赖其 URL 在线可解析；结构和工件校验在构建及测试中完成。

四项均为 `archive`，每项指向本实例当前 Service 发行携带的独立 tar.gz：`/agent-skills/<准确发行版本>/<skill-name>.tar.gz`。每项 digest 为该归档原始下载字节的 SHA-256（`sha256:` 加小写十六进制），由真实归档生成，不手写、不复用完整多 Skill ZIP 的摘要。归档根直接包含 `SKILL.md`，以及该 Skill 的参考文件、宿主 metadata 和必要脚本；内置完整 canonical Skill runtime 树，保留原始依赖路径。外层脚本仅调用内置安全入口，文档链接定向投影到归档内真实位置，不另建安装器。

归档生成固定排序、时间与文件模式，拒绝符号链接、路径穿越和越界成员。重复打包必须字节一致，解压后验证引用与依赖完整、三个安全 helper 的 help 可执行。构建同时校验 index 与归档的名称、版本、URL、摘要和实际文件；不存在的归档不得返回 SPA 200。

索引描述当前实例工件，而非最新推荐安装目标。运行 stable 的实例描述该 stable，运行显式 RC 的实例描述该 RC；旧实例不会暗中发现新发行或改变宿主版本。安装、新部署的推荐目标仍由官方 stable pointer 解析，显式 RC 仍按准确版本选择不可变 manifest / 完整 ZIP 并校验来源与摘要。

这些 tar.gz 只增加发现和读取入口，不交给 canonical installer，不创建 active receipt，也不使任意实例 origin 成为 canonical publisher。发现或下载不授予执行、安装、升级、Cloudflare 写入或身份权限。既有两个 canonical ZIP、manifest、六份 GitHub 附件、plugin / CLI / MCP 安装与宿主投影合同继续有效；本地 Skill 更新与实例升级继续独立。

同一版本 URL 不得换内容。Service 更新后可以退役旧版本路径并返回 404；调用方应重新读取当前索引，不把旧路径失败变成浮动 main/latest 的执行回退。回滚到原公开工件可恢复原始相同字节。

## robots 与 sitemap

根 `/robots.txt` 返回 UTF-8 `text/plain`，默认 `User-agent: *` / `Disallow: /`，精确允许首页、`/auth.md` 和 `apps/docs/catalog.json` 中两种语言的 canonical HTML 路径，并链接同 origin 的 sitemap。未知文档、私有看板、Issue、管理、API、身份和兑换路径保持禁止爬取。robots 声明公开页面边界与下述内容使用偏好，不代替认证或访问控制。

`/sitemap.xml` 返回有效 UTF-8 XML，以相同公开 catalog 生成绝对 loc。只包含首页和真实公开 canonical HTML；隐藏但保留的兼容页面仍可列出，语言跳转入口、Markdown、SPA fallback、移除页和私有页面不列出。目录增删与文档构建、Worker 同步，不维护第二份手工页面列表。

代码不修改 Cloudflare Managed robots、Bot、Zone 设置、DNS 或 Transform Rules，不引入控制台操作步骤。已有 Cloudflare 层的策略保持独立；若平台改写 robots，应核对线上最终响应是否保留本合同，不把本地源文件当作线上政策证明。

规范来源：[RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)、[Sitemaps protocol](https://www.sitemaps.org/protocol.html)。

## 固定公开内容使用偏好

`robots.txt` 中公开爬取规则所在的 `User-agent: *` 组固定声明：

```text
Content-Signal: ai-train=no, search=yes, ai-input=yes
```

成功的公开首页、`/auth.md`、`/docs/` 目录中的公开 HTML / Markdown（包括显式 `.md`），以及 `/llms.txt`、`/docs/llms.txt` 使用相同的 `Content-Signal` 响应头。含义为允许搜索，以及 Agent 将公开内容作为回答、推理或检索增强生成的输入，不允许使用公开内容训练或微调模型。该声明是内容使用偏好，不授予登录、业务操作、读取私有内容或执行安装脚本的权限；缺失信号也不视为已授予这些权限。根路径既有 `join.md`、`join.zh-CN.md`、`deploy-guide.md`、`deploy-guide.zh-CN.md` 保留原路由、媒体类型与响应头合同，本增量不扩展其处理。

这些值随应用发行固定，不提供 Owner 设置、环境变量或新数据库字段。普通安装和升级交付同一政策，无需用户决定三类术语或另开 Cloudflare 功能。错误、私有应用和业务 API 不因本增量新增内容使用声明。

规范来源：[Content Signals](https://contentsignals.org/)、[Cloudflare Markdown for Agents 内容政策](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/#content-signals-policy)。

## Markdown 内容协商

同实例公开首页和文档 canonical HTML URL 支持 `Accept` 内容协商。浏览器和未明确请求 Markdown 的调用方继续获得 HTML；明确接受 `text/markdown` 且其质量值严格高于 HTML 时选择 Markdown，同质量值保留 HTML。特定媒体类型的 `q=0` 覆盖通配符许可，不能通过通配符重新选中禁用的表示。成功的两种表示均带 `Vary: Accept`，保留已有 Vary token，不能让共享缓存将一种表示误发给另一种请求。

文档 Markdown 表示复用该 canonical 页面构建产生的原始 `.md`，内容来自同一份双语源，不抓取 HTML、不调用模型或可选 Cloudflare 转换。返回 `text/markdown; charset=utf-8`，保留原文、语言和相对链接语义；同 canonical URL 下的链接须可正确解析。显式 `.md` URL 保持 `text/plain; charset=utf-8`，不因 Accept 改成另一页面或 SPA。未知、移除或缺失页面继续真实 404，不生成空成功响应。

首页提供随 Service 版本发布的静态双语 Markdown 概览，介绍 cfKanban 的用途并链接本站双语公开手册、`/auth.md`、API Catalog、OpenAPI、Skills 发现及官方 stable 安装入口。它描述固定公开产品能力，不抓取 Vue 的空 HTML 壳，不查询 D1，不嵌入私人身份、Owner 首页说明、项目列表或登录状态；不宣称代表动态首页的完整快照。文档保持 URL 指定的语言，首页概览同时提供两种语言。

GET / HEAD 的表示选择一致，HEAD 返回对应 GET 的媒体类型、安全头、Vary 与内容政策且无正文。协商过程不读取或创建 Session / Cookie / Credential，不向 Static Assets 转发身份材料。现有文档安全缓存与响应头继续有效；私有 `/app`、业务 API、静态脚本与样式、发现 JSON / XML、技能归档以及其他原始文本资源不套用 HTML 转 Markdown。

规范来源：[Cloudflare Markdown for Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/)、[RFC 9110 Accept](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.1)、[RFC 9110 Vary](https://www.rfc-editor.org/rfc/rfc9110#section-12.5.5)。

## 验收

- 覆盖 GET / HEAD / 405 / 404、真实媒体类型和正文、首页 Link 的作用范围与原头部保留。
- 用自部署 origin 和伪造转发头验证绝对链接，无 D1、身份、限流或私有数据依赖。
- 校验 RFC Linkset / Draft 索引字段、全部公开描述目标、catalog 对应的双语 sitemap、未知文档 404 和正常 SPA 深链。
- 校验四归档原始字节摘要、可复现打包、解压路径、完整依赖和 helper 入口；错误摘要、缺包、旧版本路径不能静默接受。
- 校验固定 Content-Signal 的 robots 与公开响应头一致，不新增 Owner 设置或私有读取许可；线上核对平台最终响应。
- 覆盖 Markdown / HTML 默认、质量值、禁用值、HEAD、Vary 合并、原始 `.md`、缺失资源和公开相对链接；验证首页概览无动态或私有数据读取。
- 校验 `/auth.md` 的 H1、双语受众、真实 Bearer 与凭据获取 / 恢复流程、同 origin 链接和公开内容政策；被动读取不创建身份或授权、不调用兑换端点，不广告未实现的 OAuth 或匿名注册。
- 执行相关路由 / 生成测试、docs:check、contracts:check、构建与完整发行验收；上线后匿名核对标准资源、链接、四份实际下载归档及当前发行，保留已验证 canonical 发行与部署读回证据。

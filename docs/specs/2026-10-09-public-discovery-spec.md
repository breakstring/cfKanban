# 公开 API、Skills 与页面发现

- 状态：Frozen
- 日期：2026-10-09
- 授权依据：用户要求完成 CFK-720、CFK-721、CFK-725，并在检查通过后发布下一 RC、升级既有线上实例。
- 本文是 API / Schema、文档中心、Bootstrap 和发行生命周期的增量；新增标准发现资源，不改变业务权限、认证、API 兼容版本、D1 schema、安装来源或执行授权。

## 来源与 origin

所有资源由同 Worker / Service 工件交付，匿名读取不依赖 D1、身份或可选云服务。绝对 URL 以实际 `Request.url.origin` 生成；不信任 `X-Forwarded-Host` 等请求头，不硬编码演示域名，不自动迁移 origin。preferred origin 的发布、客户端探测和安全迁移继续遵循已有合同。

仅支持 GET / HEAD，HEAD 返回对应 GET 的响应头且无正文，不把正文长度改写为零。其他方法返回 405 和 `Allow: GET, HEAD`；未知、缺失或已退役资源返回真实 404，不回退应用 HTML。公开发现不向 Static Assets 转发 Bearer 或 Session，不列举私有项目、事项、身份、凭据、邀请或一次性链接。

发现文档采用 `no-store, no-transform`、`no-referrer`、`nosniff`；固定版本的归档可使用 immutable 缓存。现有 `/app` 深链、公开文档 404、OpenAPI 和实例发现不改变。标准发现文件与公开手册同属公共文档层，REST OpenAPI 继续描述业务与身份操作；API Catalog 的 `service-desc` 指向现有 OpenAPI。

## API Catalog 和首页 Link

`/.well-known/api-catalog` 返回 RFC 9727 / RFC 9264 Linkset，媒体类型为 `application/linkset+json`，附 RFC 9727 profile。目录沿 RFC 9727 Appendix A.1 的结构，使用真实 API 基址 `/api/v1` 为 link context（anchor）；`service-desc` 为 `/openapi.json`，`service-doc` 为当前实例的 English / 简体中文公开概览，保留对应语言和媒体类型。context 不要求可直接 GET，不把没有 GET 资源的基址另作需要解引用的 href；实际描述目标均为现有公开资源。

GET / HEAD 均提供 `rel="api-catalog"` 的 Link。首页成功的 GET / HEAD HTML 响应追加 API Catalog、锚定 API 的 OpenAPI 和双语文档 Link，保留原有头部；不为其他应用页面、错误或非 HTML 响应增加发现声明。不广告尚不存在的远程 MCP、A2A 或 OAuth 服务，不为评分虚构描述资源。

规范来源：[RFC 9727](https://www.rfc-editor.org/rfc/rfc9727)、[RFC 9264](https://www.rfc-editor.org/rfc/rfc9264)、[RFC 8288](https://www.rfc-editor.org/rfc/rfc8288)。首页 Link 是该标准提供的可选发现方式，本项目在用户授权下采用。

## Skills Discovery

采用 [Cloudflare Agent Skills Discovery Draft v0.2.0](https://github.com/cloudflare/agent-skills-discovery-rfc) 作为可选发现格式。`/.well-known/agent-skills/index.json` 为 `application/json`，包含 `$schema` 和四个 Skill 的 `name`、`type`、`description`、`url`、`digest`。`$schema` 使用草案的版本标识，不依赖其 URL 在线可解析；结构和工件校验在构建及测试中完成。

四项均为 `archive`，每项指向本实例当前 Service 发行携带的独立 tar.gz：`/agent-skills/<准确发行版本>/<skill-name>.tar.gz`。每项 digest 为该归档原始下载字节的 SHA-256（`sha256:` 加小写十六进制），由真实归档生成，不手写、不复用完整多 Skill ZIP 的摘要。归档根直接包含 `SKILL.md`，以及该 Skill 的参考文件、宿主 metadata 和必要脚本；内置完整 canonical Skill runtime 树，保留原始依赖路径。外层脚本仅调用内置安全入口，文档链接定向投影到归档内真实位置，不另建安装器。

归档生成固定排序、时间与文件模式，拒绝符号链接、路径穿越和越界成员。重复打包必须字节一致，解压后验证引用与依赖完整、三个安全 helper 的 help 可执行。构建同时校验 index 与归档的名称、版本、URL、摘要和实际文件；不存在的归档不得返回 SPA 200。

索引描述当前实例工件，而非最新推荐安装目标。运行 stable 的实例描述该 stable，运行显式 RC 的实例描述该 RC；旧实例不会暗中发现新发行或改变宿主版本。安装、新部署的推荐目标仍由官方 stable pointer 解析，显式 RC 仍按准确版本选择不可变 manifest / 完整 ZIP 并校验来源与摘要。

这些 tar.gz 只增加发现和读取入口，不交给 canonical installer，不创建 active receipt，也不使任意实例 origin 成为 canonical publisher。发现或下载不授予执行、安装、升级、Cloudflare 写入或身份权限。既有两个 canonical ZIP、manifest、六份 GitHub 附件、plugin / CLI / MCP 安装与宿主投影合同继续有效；本地 Skill 更新与实例升级继续独立。

同一版本 URL 不得换内容。Service 更新后可以退役旧版本路径并返回 404；调用方应重新读取当前索引，不把旧路径失败变成浮动 main/latest 的执行回退。回滚到原公开工件可恢复原始相同字节。

## robots 与 sitemap

根 `/robots.txt` 返回 UTF-8 `text/plain`，默认 `User-agent: *` / `Disallow: /`，精确允许首页和 `apps/docs/catalog.json` 中两种语言的 canonical HTML 路径，并链接同 origin 的 sitemap。未知文档、私有看板、Issue、管理、API、身份和兑换路径保持禁止爬取。该默认值用于公开页面边界，不声明 AI 训练许可；robots 不是认证或访问控制。

`/sitemap.xml` 返回有效 UTF-8 XML，以相同公开 catalog 生成绝对 loc。只包含首页和真实公开 canonical HTML；隐藏但保留的兼容页面仍可列出，语言跳转入口、Markdown、SPA fallback、移除页和私有页面不列出。目录增删与文档构建、Worker 同步，不维护第二份手工页面列表。

Cloudflare Managed robots、Bot / 训练策略等由 Owner 按 CFK-724 独立选择；代码不修改 Zone 设置、开关、DNS 或 Transform Rules。若平台改写 robots，应核对最终实际响应与 Owner 选择，不把本地源文件当作线上政策证明。

规范来源：[RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)、[Sitemaps protocol](https://www.sitemaps.org/protocol.html)。

## 验收

- 覆盖 GET / HEAD / 405 / 404、真实媒体类型和正文、首页 Link 的作用范围与原头部保留。
- 用自部署 origin 和伪造转发头验证绝对链接，无 D1、身份、限流或私有数据依赖。
- 校验 RFC Linkset / Draft 索引字段、全部公开描述目标、catalog 对应的双语 sitemap、未知文档 404 和正常 SPA 深链。
- 校验四归档原始字节摘要、可复现打包、解压路径、完整依赖和 helper 入口；错误摘要、缺包、旧版本路径不能静默接受。
- 执行相关路由 / 生成测试、docs:check、contracts:check、构建与完整发行验收；上线后匿名核对标准资源、链接、四份实际下载归档及当前发行，保留已验证 canonical 发行与部署读回证据。

# 站内双语文档中心

- 状态：Frozen
- 日期：2026-09-29
- 授权依据：用户确认 CFK-496 的四栏目、VitePress、双语与 Agent 提示词优先方案，并要求实施。
- 本文是 Web UI、Agent Skills / Bootstrap 与发行生命周期合同的增量；只覆盖公开文档的内容、导航与打包。不改变业务权限、API、schema、凭据交付、stable 发现或部署授权。

## 阅读体验

文档公开挂载于同实例 `/docs/`，无需登录。首页页头和页脚提供“文档 / Documentation”入口，原部署阅读链接进入对应文档章节；部署和 Public Join 的 Agent 复制话术继续指向既有专用 Markdown 指南。

左侧一级导航固定为“概述、使用、管理、部署”，二级按用户任务组织；桌面可折叠，窄屏使用菜单。使用、管理、部署分别对应三个主要操作 Skill，不把 Skill 当成领域角色。正文提供目录、前后页、本地全文搜索、可复制提示词和原始 Markdown 链接。

正文使用 English 与简体中文，分别置于 `/docs/en/`、`/docs/zh-CN/`，同一功能使用相同 slug。显式 URL 语言优先；文档根入口沿用 `cfkanban_locale` 和浏览器首选语言，无有效偏好时 English。切换语言保留对应页面，缺失译文不得静默生成空页；首期目录要求两种语言完整对应。仅保存非秘密语言偏好，不读取或保存身份材料。

遵循 DESIGN.md 的浅色、暖色、系统字体与键盘可访问性。正文以清晰排版为主，不为每个功能制作截图；确需截图时使用演示数据。文档显示构建所对应的产品发行版本，避免将新功能说明提供给未升级的实例。

## 内容与维护

公开源内容位于 `apps/docs/{en,zh-CN}/`；`apps/docs/catalog.json` 固定双语菜单及公开页面集合。仓库 `docs/` 继续保存工程合同，不整目录公开。以现有 howto、三个技能及实际实现核对内容，技能操作规则仍由各自 Skill 和服务端合同负责。

功能说明顺序为简短用途、Agent 自然语言提示词、权限/前提与结果、真实 Web 入口和步骤、常见问题。不存在的 Web 能力明确说明，不能为了双端表述一致虚构入口。示例使用占位数据，不含真实 Credential、邀请或 Browser Launch capability。安装/新部署发现 stable；本地技能更新与实例升级分别说明。

公开 HTML 和同路径 `.md` 由同一份文档源生成，`/docs/llms.txt` 提供可读取目录。既有 `join.md`、`join.zh-CN.md`、`deploy-guide.md`、`deploy-guide.zh-CN.md` 保持路径、纯文本 UTF-8 与安全缓存合同，继续承担机器操作引导；文档引用其入口，不复制完整安全脚本流程。

## 构建与路由

VitePress 只在构建时生成静态文件，合入现有 `apps/web/dist/docs/`，随 Service bundle 发布。无运行时 SSR、额外 Worker、Pages、数据库或云资源。锁定稳定依赖；先构建 Web，再构建文档，避免 Web 清空输出目录时丢失文档。

文档路径由 Worker 优先处理并校验公开页面集合；GET/HEAD 只读，其他方法返回 405。未知文档返回文档 404，缺失资源不得返回主应用 SPA HTML 或进入登录流程；正常 `/app` 和 `/api` 路由不改变。文档 HTML/Markdown/索引采用 `no-store, no-transform`、`no-referrer`、`nosniff`，带指纹的资源可长期缓存。原始 Markdown 明确使用 `text/plain; charset=utf-8`。

构建检查覆盖双语页面对应、目录/内部链接、正文与提示词、文档产物和搜索索引；发行校验文档版本与工件摘要，防止漏包或修改后的工件混入。验证还包括深链刷新、404、Markdown、首页入口、语言切换、复制、本地搜索及桌面/窄屏布局。业务写操作不属于文档测试。

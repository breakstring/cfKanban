# 源码维护者的 GitHub Release 发布与恢复

本文对应 CFK-27，是源码工程工具说明，不是用户部署指南、独立 cfKanban CLI 或 Cloudflare 写入通道。安装 Skill 和升级 Instance 仍由各自独立计划执行。脚本不修改 tag、已发布 Release、现有附件或 Cloudflare 资源。

## 发布前准备

1. 对当前源码运行 `npm run validate`，审查 staged set，然后按当前授权提交并推送准确 tag。脚本要求远端 tag 已存在且指向完整的预期 commit；不会隐式创建 tag。
2. 用现有 `build-release-bundles.mjs` 与 `generate-release-metadata.mjs` 构建和生成元数据。GitHub 下载路径使用 `urlLayout=flat`。这一步仍需校验可重现构建和打包白名单。
3. 准备一个独立的平铺目录，只包含以下六个非秘密文件：`prerelease.json`（稳定版使用 `stable.json`）、`cfkanban-release-<version>.json`、`cfkanban-skills-<version>.zip`、`cfkanban-service-<version>.zip`、`install.md`、`install.zh-CN.md`。任何额外文件（包括 Repo scope）、目录或附件 symlink 都会拒绝。不要把源码仓根目录作为上传目录。
4. 使用已安装并完成 GitHub 登录的 `gh`。脚本复用 gh 身份，不读取或输出 Token，不执行 OAuth 登录，不把 Cloudflare Credential 传给 gh。网络失败、权限失败和读取超时都不是“Release 不存在”的证据。
5. 创建非秘密 config JSON，字段为 `repository`（固定 `breakstring/cfKanban`）、准确 `version`、40 位 `commit`、上传 `directory` 的绝对路径、完整 `notes` 字符串。配置不放进上传目录，不提交本机绝对路径。

## 三个独立动作

```text
node scripts/publish-github-release.mjs inspect <config.json>
node scripts/publish-github-release.mjs stage <config.json>
node scripts/publish-github-release.mjs publish <config.json>
```

`inspect` 是只读 preflight：本地先复用 `release verify` 的 pointer/manifest/bundle 校验实现，再核对完整版本、channel、publisher、准确 GitHub 下载 URL、六份 name/size/SHA-256 和远端 tag commit。它输出 `plan_digest`，以及 Release ID、draft 状态和缺少的附件。已发布版本还会进行匿名公网下载验证，不能只用本地文件自证成功。

只有确认准确 repository、tag/commit、notes、六份附件摘要与本次远端写入范围后，才把输出摘要放入 config 的 `approvedPlanDigest`。`stage` 与 `publish` 都要求准确匹配；任何文件、notes、版本或 commit 变化都需要重新 inspect。此字段只是工程工具的计划一致性门槛，不能替代用户/Agent 宿主授权。它不把本机路径写进远端 metadata。

`stage` 在不存在 Release 时只创建空 draft，之后逐个上传缺失附件。已经存在的 draft 必须具有相同 tag、标题、notes 和 prerelease 标记。每次上传前后都重新读取同一 Release ID 和完整分页附件清单，核对 name、size、`state=uploaded` 和 `digest=sha256:...`；stage 成功也不会公开 Release。

`publish` 不补传附件。仅当当前 draft 的六份附件全部匹配、tag 未漂移时才公开。随后重新读取公开状态，匿名下载六份文件，核对 size/SHA-256，并用**刚下载的** pointer、manifest 和两个 bundle 执行同一 `loadAndVerifyRelease`。bootstrap 两份 MD 的摘要也独立核对。GitHub signed redirect 仅在内存使用，不进入报告。

## 中断与恢复

- 创建、单附件上传或 publish 超时：保持相同输入，先重新 `inspect`。不把 CLI 非零当作远端未提交，不自动换版本、删除 draft 或重建 Release。
- 对已确认的同一 draft 重新 `stage`：已匹配的附件跳过，只补缺失项。即使进程在服务端提交后、收到响应前退出，下一次也以远端读回为准。
- publish 响应丢失或公网下载失败：再次 inspect/publish 已发布版本只读校验，不再次发布，不删除公开版本。公网验证失败不能报告完整发布成功。
- 同名附件摘要/size 不符、重复/额外附件、`starter` 等非 uploaded 状态、缺少 digest、draft metadata 漂移：停止，交由维护者检查；脚本没有 delete、clobber 或接管分支。
- 一次只允许一个维护者执行同一 tag 的发布。GitHub API 不提供覆盖整个“核对附件→公开”序列的事务；逐次读回不能替代上层串行约束。外部并发改动被发现时停止，不能声称拥有远端原子锁。
- 本地文件也必须保持不变。脚本在写入前反复检查；它不能防止另一进程恰在检查与 gh 读取文件之间改写内容。发布前的远端摘要核对会阻止这类内容被当作已验证附件公开。

## 验证范围

`node --test scripts/tests/release-publication.test.mjs` 使用隔离假 GitHub 后端覆盖创建/上传/发布提交前后中断、每个附件缺失恢复、读失败、tag 漂移、摘要/数量/状态冲突、本地漂移、重复执行，以及匿名下载的实际字节校验；它不会写 GitHub。

故障注入单测不是 GitHub 真实上传中断演练。首次实际使用时仍应记录 draft Release ID、每个附件读回和公开下载结果；CFK-27 在真实恢复证据补齐前保持进行中。此源码工具不包含在 Skill/Service bundle 白名单里，单独新增它不要求升级 Worker 或用户 Skill。

平台依据（2026-09-05）：[GitHub Release API](https://docs.github.com/en/rest/releases/releases)、[Release asset 的 state/size/digest 合同](https://docs.github.com/en/rest/releases/assets)、[gh release upload 的 clobber 删除语义](https://cli.github.com/manual/gh_release_upload)。工具使用 GitHub API 版本 `2022-11-28`，不依赖 gh 的人类错误文案判断提交结果。

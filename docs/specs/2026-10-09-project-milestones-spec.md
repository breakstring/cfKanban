# 项目里程碑与可选 Issue 归属

- 状态：Frozen
- 确认依据：2026-10-09 用户确认项目内里程碑、可选单一 Issue 归属，并授权在 `feat/v1.12` 先实现里程碑；追加要求同步技能与文档，并在本地工作台 Issue 详情提供加入和退出。
- 上游：Foundation、API / Schema、Web UI、公共 CLI、分级管理员和容器清理合同。
- 执行任务：[CFK-714](https://cfkanban.dev/app/issues/CFK-714)；趋势图单独保留为 [CFK-715](https://cfkanban.dev/app/issues/CFK-715)，不属于本次实现。

## 1. 领域语义

Milestone 表达单个 Project 的阶段交付目标。Project 可以没有或有多个里程碑；里程碑可以暂不包含任何 Issue。不存在 Workspace 级或跨 Project 的共同里程碑。

Issue 归属可空，同一时刻最多属于一个同 Project 的里程碑。可显式加入、移出或更换；父子关系不传播归属，也不自动递归纳入子孙 Issue。关闭的里程碑仍可显式调整归属，调整保留历史。

里程碑使用稳定 UUID，保存 `title`（去首尾空白后 1–200 Unicode 字符）、`description`（默认空、最大 8 KiB UTF-8）、可空 `due_date`（有效公历 `YYYY-MM-DD` 日期，不转换时区）、`status_key=open|closed`、version 和创建/更新时间。日期不是强制条件。状态由明确操作改变，不因 Issue 全部完成而自动关闭，也不自动修改 Issue。

首版提供创建、读取、编辑及通过编辑显式开放/关闭，不增加独立里程碑删除或新的物理删除操作。项目归档暂停内容访问，恢复后重新可见；既有 Project purge 原子清除里程碑、归属和相关业务历史。

## 2. 权限、原子性与历史

当前 Project reader 可读；writer、有效 Project/Workspace 管理员及 Owner 可写。每次请求重新核验 Principal、容器、数据权限与 Session scope，里程碑归属不扩大授权。跨项目或无权里程碑不能成为 Issue 归属，错误不暴露其内容。

创建里程碑带 `Idempotency-Key`；PATCH 带 `expected_version`，沿既有 CAS-only 合同，冲突刷新当前资源并保留草稿，响应未知不生成新请求掩盖原结果。Issue 归属沿既有单 Issue 创建/PATCH 的原子操作，不提供 batch。

里程碑创建与修改在同一原子单元追加领域 Event。Issue 创建事件包含初始 `status_key` 和 `milestone_id`；归属调整事件包含 `old_milestone_id` / `new_milestone_id`。事件记录旧新状态、归属及真实 actor，供后续独立统计功能使用，不宣称既有历史已补齐。

## 3. HTTP 与读取投影

| Method | Path | 语义 |
| --- | --- | --- |
| GET | `/api/v1/workspaces/{workspace_id}/projects/{project_id}/milestones` | 当前项目有界列表；可单值 `status=open|closed`，默认 20、最大 100、cursor 分页 |
| POST | 同上 | 创建一个里程碑；默认 description 空、due_date null、status_key open |
| GET | `/api/v1/milestones/{milestone_id}` | 读取一个当前可见里程碑 |
| PATCH | 同上 | 当前 version 下修改一个里程碑的普通字段或开放/关闭状态 |

里程碑读取包含 `allowed_actions` 与 `progress={total,done,unfinished,canceled}`。进度只统计本里程碑当前未软删除 Issue；`unfinished` 为 backlog、todo、in_progress 之和，done 与 canceled 独立。每个明确归属的 Issue 计一件，父子均明确加入时各计一件，不表示工时、估算或递归交付量。计数与 metadata version 独立，Issue 变化不造成里程碑编辑版本冲突。

Issue 创建/PATCH 支持 `milestone_id=UUID|null`，省略保留既有行为，PATCH null 明确移出。普通 Issue 读取返回可空 `milestone={id,title,status_key,due_date}`；旧 Service 可省略此增量投影。

Issue list、counts 与 candidates 支持单值 `milestone=UUID|none`，与其他筛选 AND，在分页前执行并绑定 cursor。`none` 只匹配未归属 Issue；省略包含两者。既有实时权限、稀疏筛选成本和恢复视图边界保持。

## 4. Web、Agent 与 CLI

项目工作面提供里程碑入口，展示有界列表、目标日期、四项进度及关联 Issue，沿用看板/列表的全宽项目标题和视图切换布局。宽屏项目工具栏由左侧视图切换、居中的搜索输入和按钮、右侧状态与其他筛选组成，三组保持明确间距；宽度不足时分行，避免控件重叠。里程碑选择器隐藏原生前置三角，采用与其他属性选择器一致的文字后置下拉箭头，并保留键盘及焦点操作。reader 只读，writer 可创建、编辑、开放/关闭。Issue 创建和详情提供可选归属、移出与更换，看板/列表提供里程碑筛选。列表选择器分页，不默默只展示首 20 项或抓全量。界面支持 English / 简体中文、键盘操作、空/加载/失败状态、项目切换与冲突草稿恢复。

完整 Web 事项详情在右侧属性区直接选择里程碑，单次选择即时保存，只提交归属变更与当前 version；同值不写入，reader 只读，确认后才更新归属。快捷修改不关闭或覆盖未保存的标题、正文及独立归属草稿，待确认操作继续核实原请求。

公共 CLI 提供 `milestone list/show/create/update`；开放/关闭通过 update 的 status_key 表达。Issue 命令支持归属字段和筛选；JSON null 清除归属。Skills/API 和 MCP 使用同一服务端合同，MCP 写入与固定项目面板继续核验 scope。CLI 新增能力沿既有可信来源、凭据、命令 catalog 与原操作恢复，不更改宿主安装或登录。

本地浏览器、DSH 和 Codex MCP App 共用的工作台在 Issue 详情属性区展示归属，writer 可加入、更换或移出，reader 只读。不增加独立里程碑管理页面或创建控件；管理沿完整版 Web、CLI 和业务 MCP。当前归属来自 Issue 摘要，即使尚未加载候选所在页也能显示。

工作台通过受控 `milestones:{next:boolean}` 动作读取候选，Bridge 从可信绑定注入 Workspace/Project 与固定 limit 20，不接受页面传入 scope、cursor、版本或幂等键。候选包含 open/closed，cursor 留在私有 Controller，分页有容量、停滞和失效范围防护。公共快照只增加可选 `milestones`、`milestones_has_more` 与最小 `{id,title,status_key,due_date}` DTO；不交付里程碑完整资源或 cursor。身份或项目切换丢弃候选及续页，迟到结果不能写回新范围。

加入/移出通过现有单 Issue update 的 `milestone_id=UUID|null` 执行，复用实时权限、CAS、幂等、私有 pending/checkpoint 与恢复合同。归属以确认快照为准，busy/pending 时暂停更改，不新增乐观归属状态。旧 Service 省略 Issue.milestone 表示未提供能力，工作台隐藏该控件并保留普通详情；null 表示能力存在且无归属。

## 5. D1 与验收

新增 versioned migration 保存里程碑与 Issue 可空外键，并用数据库原子增减维护必要当前进度。仅统计相关实际变更写派生计数；普通标题编辑不额外维护计数。里程碑列表不逐项扫描全部 Issue，Issue 索引同时考虑分页和写放大。查询计划与本地 rows_read/rows_written 是本地证据，不扩张为线上计费保证。

验收覆盖空项目/空里程碑/无归属、跨项目拒绝、reader 与固定 Session 越权、CAS 冲突、创建重放、合法日期、完成/取消/重开、软删除/恢复、父子无继承、归属变更历史、purge、迁移及 Web/CLI/MCP 等价语义。共用工作台覆盖受控 scope、私有分页、最小投影、只读/待恢复禁写、当前归属与关闭候选、旧 Service 回退和原写入恢复。全部测试使用隔离本地数据；本次实现不包含线上 migration、部署、发行或 Git commit/push。

# 参与者 Web 项目切换

- 状态：Frozen
- 日期：2026-09-19
- 决策：D-272
- 授权依据：用户明确同意让 Agent 打开的会话支持切换到本人其他已授权项目，并要求改善多项目参与者体验。
- 本文是 Foundation、Web UI、API/Schema 与 Agent Skills Bootstrap 的增量合同；优先于其中将所有 Agent Project/Issue Session 固定为单 Project 的旧描述。冻结和本次实现不表示已上线，不隐含提交、发布或部署。

## 会话范围与初始页面

Browser Launch 请求仍须携带准确 `project` 或 `issue` target；其创建、兑换都校验该目标的当前访问权限。target 决定初始页面，不由客户端提供任意 redirect URL。

新兑换的**非 Owner** Agent Launch 会话使用已有 `project_selection` scope，仍先进入请求指定的 Project 看板或 Issue。该 scope 只允许当前 Principal 按实时有效 Grants 访问 Projects；它不是实例管理权限，也不创建、恢复或扩大 Grant。已有固定 Project scope Session 保持原范围，不在请求过程中自动改写；需要新行为时重新通过 Agent Launch 登录。

Owner 明确指定 Project/Issue 的 Agent Launch 会话继续固定在该 Project；Owner `admin` 会话保持原有实例管理和数据面范围。Passkey 会话继续使用已有规则：参与者选择当前授权 Project，Owner 进入 Overview。本次不改变身份、凭据或 Passkey 授权模型。

## Web 体验

可切换项目的会话在顶部提供“切换项目”入口。选择界面显示当前仍有权且未归档的工作区、项目名称及该 Project 的 `reader` / `writer` 角色，当前项目可辨识；同名对象仍由 UUID 区分。项目选择只触发选定项目的页面读取，不自动聚合读取所有项目的 Issues。

首次 Agent Launch 仍打开指定目标。参与者可从看板或 Issue 页面进入选择页，再选择其他当前授权项目。无可访问项目时显示空状态和联系 Owner 的提示，不展示已撤权项目内容。窄屏下入口可用；文案支持 English 与简体中文。

## 权限与失效

每个请求继续校验 Session、Principal、来源 Credential/Authenticator 状态、目标资源、父容器和实时 Project Grant。reader 不能写，writer 只能在自己有 writer 权限的项目写；撤权、降权或容器归档后下一请求立即采用当前权限，不信任导航列表或页面缓存作为授权依据。无权项目、Issue 和关系端点继续遵守既有隐藏规则。

Browser Launch 仍为固定 5 分钟、一次性；Session 仍为固定 8 小时，不滑动、不 refresh。切换项目不创建会话、不延长到期时间、不改变 source 绑定。来源撤销或 Session 到期仍立即阻止访问。CSRF、凭据隔离和浏览器存储限制不变。

## API、存储与兼容

复用既有 `project_selection` scope 与授权项目读取接口，不新增 schema、migration、角色或公共批量 API。服务端在兑换时根据已验证 Principal 是否为 Owner 决定 Session scope，客户端不能自行把固定会话提升为选择范围。已存储固定 scope 会话按原记录鉴权；因此旧 Session 不会因部署而静默扩大。

Skill 继续要求明确初始 target（授权项目唯一时可解析，歧义时询问），并核对最终已认证页面。说明新版本支持参与者项目切换时，区分源码能力、部署版本与既有会话，不声称旧固定会话自动生效。

## 验证要求

- 非 Owner 新兑换 Project/Issue launch：初始目标正确，可读其他当前授权项目；无权项目被隐藏。
- 两项目角色分别为 reader/writer 时，写权限逐项目正确；撤权、降权、归档后立即失效。
- Owner Project/Issue launch 及旧固定 scope Session 不能越过固定项目；admin 与 Passkey 行为保持兼容。
- 切换不延长 expiry；源 Credential 撤销后不可访问；CSRF 保持有效。
- 顶部入口、当前项目/角色、零项目空状态、中英文和窄屏可用。

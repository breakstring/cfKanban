# 嵌入式 cfKanban 页面

这是现有 Vue Web 的窄屏工作台，共用 Nuxt UI、主题、Markdown 和完成记录展示。它不加载独立站的 App、路由、浏览器认证或 REST client。宿主负责身份、授权、读取、原子写入和原操作恢复，页面只展示白名单快照并提交明确动作。

运行 `npm run web:embedded:build`，得到 `apps/web/dist-embedded/embedded.html` 和 `embedded-build.json`。HTML 内联完整 JS、CSS 和标志图片，不依赖外部资源；元数据绑定协议、发行版本、字节数与 SHA256。`apps/web/scripts/build-embedded.mjs` 导出的 `assertEmbeddedHtml(html)` 可在其它宿主打包时校验实际字节。

宿主将该 HTML 放进独立 Document，例如只允许脚本和明确外部链接的 sandbox iframe。每个页面有自己的 Vue App、焦点、弹层与 MessagePort，不共用另一会话的状态。父层只对自己创建的 iframe 做一次连接：

```js
const channel = new MessageChannel();
iframe.contentWindow.postMessage({
  type: "cfkanban.embed.connect", protocol: 1, locale: "zh-CN",
}, "*", [channel.port2]);
// 不透明 origin 下的 * 只用于这条无业务数据的初始化；之后仅使用 port1。
channel.port1.postMessage({ type: "snapshot", state: publicSnapshot });
```

页面核对 `event.source === parent`、精确字段、协议与唯一 Port，只连接一次。后续动作是 `{type:"action",id,action,payload}`，结果是 `{type:"result",id,result}`。`protocol.ts` 导出类型和两端共享的精确字段、枚举、UUID、结构及大小校验；宿主仍须核对动作引用确实属于当前快照和实时授权。语言变化通过快照的可选 `locale` 更新。

宿主快照只包含显示身份、项目、事项、评论、范围候选、能力、预览与可核实的恢复摘要。Credential、真实绑定句柄、路径选择输入、RPC 名称、CAS/幂等键和来源会话覆盖参数不进入动作。关联导航也必须由宿主核实精确引用。页面超时不会重发写入；恢复动作由父层使用保留的原请求执行。

卸载时关闭 Port、销毁页面 App，并保留父层尚未确定的操作。iframe 后续导航不得重新连接或重新 bootstrap 身份。CSP 禁止网络、表单提交和外部脚本，唯一内联脚本使用构建哈希。测试入口是 `node --test apps/web/tests/embedded.test.mjs`，需先构建页面。

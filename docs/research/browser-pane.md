# 能不能把 tm_browser 显示进宿主侧边栏？（BrowserPane 取证）

日期 2026-09-25。取证对象是用户机器上的安装体，只读、未修改宿主：

| 证据 | 位置 |
|---|---|
| 桌面端（Electron main + renderer）| `C:\Users\34296\AppData\Local\Programs\@opencode-aidesktop\resources\app.asar`（118 MB，字节偏移见下） |
| 服务端（插件运行其中）| 同目录 `opencode-cli.exe`（205 496 872 B），`opencode-cli.version` = 2.0.16 |
| 官方 v2 插件文档 | `https://opencode.ai/v2/docs/build/plugins/migrate-v1`、`.../plugins/rpc`（用户提供的链接） |

## 结论

**不能。** 那个侧边栏（宿主自己叫它 `BrowserPane`）绑定的是**宿主浏览器自己的一个 CDP/代理端点**，
注册动作发生在桌面端进程内部，插件面没有任何登记缝。能进面板的只有两件事：
①模型直接使宿主原生的 `browser_*` 工具（面板显示的就是它们驱动的那个浏览器）；
②`browser_preview {path}`——它能把**服务端本地文件**（png/html/md/pdf/mermaid/csv…）渲染进面板，
所以 tm_browser 的截图可以借它露脸，但那是一张**静帧**，不是活的浏览器面板。

## 证据链

1. **面板的注册签名**（app.asar 偏移 78 280 813）：

   ```js
   async register(e, c, d) {
     if (s || !xb(d.endpoint.url)) throw Error(`browser.pane.registration.invalid`)
     if (d.endpoint.username && !d.endpoint.password) throw Error(`browser.pane.endpoint.invalid`)
     if (r.has(c)) throw Error(`browser.pane.owner.invalid`)
     if (e.isDestroyed() || e.webContents.isDestroyed()) throw Error(`browser.pane.owner.unavailable`)
     const m = z.make(d.sessionID), h = `${d.serverKey}\n${m}` // 标签页状态按 serverKey+sessionID 持久化
     ...
   }
   ```

   第一个参数是 **Electron `BrowserWindow`**，`d.endpoint` 是一个带可选 basic auth 的 URL（realm
   字面量 `OpenCode Browser Proxy`，同一文件里 `setProxy({mode:"fixed_servers", proxyRules:n.url,
   proxyBypassRules:"<-loopback>"})` + `login` 事件里回填凭据）。也就是说：**注册者必须先持有一个
   桌面窗口的句柄，并交出一个浏览器端点**。插件跑在服务端进程里，两者都没有。

2. **谁在调用它**（偏移 102 864 096，renderer 侧的 IPC 表）：

   ```js
   browserPane: {
     request: (e) => U(`BrowserPane`, { request: e }),
     send:    (e) => Ht(`BrowserPane`, { request: e }),
     onEvent: (e) => Ut(`BrowserPaneEvent`, (t) => e(t)),
   }
   ```

   `U/Ht/Ut` 是 `window.electron` 的 IPC 封装；`BrowserPaneEvent` 的定义在偏移 78 665 600：
   `class extends s("BrowserPaneEvent", { bindingID: o, event: ms })`，并且它出现在
   `DesktopEvents` 的联合里（与 `SshChanged`、`WslServersChanged`、`StorageChanged` 并列）。
   **通信两端都是桌面端（renderer ↔ main），不经过服务端，因此插件既发不出 `BrowserPane` 请求，
   也收不到 `BrowserPaneEvent`。**

3. **服务端根本没有面板 API**（在 205 MB 的 `opencode-cli.exe` 上做字面量统计）：
   `BrowserPane` / `browser.pane` / `browserPane` / `/experimental/browser` 命中数均为 **0**；
   `pane` 相关只有 `pane_id`（终端用的）。面板是桌面端独有实现，服务端不提供可被插件调用的注册面。

4. **官方文档口径一致**：migrate-v1 页列出的 v2 上下文域是
   `location / options / storage / event / tool / shell / session / permission / agent / provider /
   model / command / integration / mcp / reference / skill / catalog / vcs / websearch / worktree`
   ——**没有 browser、没有 panel、没有 webview**。rpc 页只给方法级 RPC
   （`ctx.rpc.register(Ns, {…})`、`ctx.rpc(Ns)`、`client.rpc(Ns)`、`registration.events.emit/on/subscribe`），
   且该页对 browser/preview/panel/webview 的提及次数为 0。
   注意：`ctx.rpc` 是**插件↔客户端/插件↔插件的过程调用**，不是渲染注册；桌面端不会因为一个插件
   注册了某个命名空间就为它开面板。

5. **代价已经量过**（本仓库 `docs/research/v2-builtin-tools.md` §5）：宿主 45 个 `browser_*` 工具共享
   `options.permission:"browser"` + `codemode:true`，而 `[L]` 那次活体观测里
   **`browser_*` 调用完全没有触发 `permission.evaluate`**。所以一旦把联网交给原生工具，我们的
   域名门禁 / 逐次同意 / 子资源策略 / 租约与空闲回收都管不到它——能管的只剩请求层可见性
   （我们已经会在 `tm_browser` 被拒时摘掉整个 `browser_*` 目录）与结果层 JIT 卸载
   （`browser_*` 走前缀匹配，已在治理名单里）。

## 三条可走的路（等拍板）

| 方案 | 侧边栏 | 治理 | 说明 |
|---|---|---|---|
| A 交给原生 `browser_*` | 有（真面板、活的） | **只剩请求层 + JIT**；逐次同意/域名门禁失效 | 最贴合"尽可能用原生"。v2 无确认框，本来也没有逐次同意可谈 |
| B 保持现状 | 无（独立有头 Edge 窗口） | 全部保留 | 用户看得到窗口，只是不在应用里 |
| C 混合（推荐） | 有（模型优先用原生；截图另走 `browser_preview`） | 原生走 A，需要门禁的动作走 tm_browser | 提示词里写死分工，两者都在面板里可见；`browser_preview` 露帧这一条**尚未活体验证**（需要用户在桌面端跑） |

## 还没证明的

- `browser_preview {path}` 是否真能把**我们 run store 里的 PNG** 渲染进面板（路径限制写的是
  "server-local、相对 workspace 或绝对"，我们的 payload 正好是服务端本地文件——但没在 GUI 里看过）。
- 桌面端会不会把插件会话的 `browser_*` 调用与 `sessionID` 绑到同一个面板（面板按
  `serverKey+sessionID` 存标签页，理论上应该跟会话走）。
- 原生 `browser_*` 在**有**桌面连接时是否会触发 `permission.evaluate`（`[L]` 那次是 standalone）。

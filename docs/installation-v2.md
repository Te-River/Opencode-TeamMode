# TeamMode on OpenCode 2.x — Installation / 安装指南（v2 专用）

> **Read this page instead of `installation.md` if your host is OpenCode 2.x.**
> The two generations are not variants of one install: a 2.x plugin **cannot create
> an agent**, so the six Team roles and the six `/team-*` commands reach the host as
> **config files** this package generates, and several v1 mechanisms have no v2
> equivalent at all. `installation.md` describes the 1.18.x path and stays correct
> there.
>
> 如果你的宿主是 OpenCode 2.x，请看本页而不是 `installation.md`：2.x 的插件**不能创建
> agent**，六个角色和六条 `/team-*` 命令是以**配置文件**的形式由本包生成出去的；v1 的几处
> 机制在 v2 上根本没有对应物。`installation.md` 讲的是 1.18.x，那份仍然是对的。

Find out which one you are on / 先确认你在哪一代：

```bash
opencode --version        # 1.18.x → installation.md ;  2.x → this page
```

---

## Part A — English

### One command, or the steps below

`scripts/install.sh` / `scripts\install.ps1` now detect the host major version and run
all three steps of this page on 2.x (plugin entry → generate roles and commands →
`default_agent` last, with a read-back from disk). Two things are said rather than
implied:

- the version probe also asks the **desktop app** (`resources/opencode-cli.version`,
  then the bundled `opencode-cli.exe --version`), because the desktop install does not
  put `opencode` on `PATH` — on such a machine a PATH-only probe answers "not found"
  while 2.0.16 is running;
- this branch has **not been exercised end-to-end on a live 2.x host yet** (both
  scripts parse clean and the probe is verified against the installed app's version
  file, which is not the same claim). So the manual steps below remain the verified
  path; if the installer's v2 branch misbehaves, follow them and report which step said
  what.

### What is different on 2.x (read this before the steps)

| | OpenCode 1.18.x | OpenCode 2.x |
|---|---|---|
| The six roles | injected by the plugin at boot | `~/.config/opencode/agents/*.md`, written by the generator below — a plugin cannot add an agent |
| The six `/team-*` commands | injected by the plugin | `~/.config/opencode/commands/*.md`, same generator |
| Default agent | filled only if the user left it alone | **Team is the default on every boot** (the API has no getter), plus `default_agent: "team"` in config, which is the checkable one. Opt out with `"team-mode": { "defaultAgent": false }` |
| Non-blocking commands | `tm_pty`, on the host's own terminal sessions | **not registered at all** — the v2 plugin context has no pty domain, so the tool could only ever report its own missing seam. Run a slow step as its own `shell` call (one per call, each with its own `timeout`) and tee the output to a log you can read back |
| File access | `tm_read` / `tm_grep` / `tm_bash` | the host's own `read` / `grep` / `glob` / `shell` — **governed anyway**: oversized results are offloaded through `tool.execute.after`, and out-of-project paths go through the host's own `external_directory` permission (a dialog, where v1 had a hard refusal) |
| Batch calls | `tm_ptc_run` | the host's own `execute` (Code Mode) |
| Interactive browsing | `tm_browser` (our own playwright/CDP browser) | **the host's own `browser_*` tools first** — they are the only browser the desktop renders in its side panel (`docs/research/browser-pane.md`). `tm_browser` stays registered as the fallback for a host with no desktop browser (CLI / standalone), and the host catalog is policed by `src/host/v2-browser-gate.ts` (URL / address red line / env-file path at `execute.before`, with a leak-detected fallback that replaces the page with the refusal). Snapshots are capped, not offloaded, so every `[ref=…]` the next click needs stays in context |
| Sub-agent settlement | the host `event` hook | `ctx.event.subscribe()` — zero-dependency async iterable, filtered by event-type name (`src/host/v2-events.ts`). Without it `tm_join` cannot tell a settled child from a running one; `tm_stats` reports what the feed forwarded and which type names went unrecognised (names only, never payloads) |
| The task ledger | the host's `todowrite` | **`tm_ledger`**, stored in the host's `ctx.storage` (v2 has no `todowrite`) |
| Asking the user | the host's official per-request dialog | **a plugin cannot open a dialog on v2.** Governed calls that would have asked instead **fail closed** with a refusal that says why. The dialogs you do see are raised by the host itself (permission rules, out-of-project access) |
| Web access | a 22-host allowlist + the confirm dialog | **the domain gate is off** (`TM_WEBFETCH_ALLOWED_DOMAINS` defaults to `"*"`): a 2.x plugin cannot raise a dialog, so "approve to proceed" was an instruction to wait for a window that never opens. Address classes are still policed — cloud-metadata / link-local / reserved ranges are refused under every setting, and private space (loopback, RFC1918, CGNAT, `.localhost`) is refused too, but the refusal now names both exits instead of promising a click: `TM_PRIVATE_SPACE=allow` (opens the class) or that one hostname in `TM_WEBFETCH_ALLOWED_DOMAINS` (opens exactly it) |
| Sub-agents | needs `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | native; the plugin forces `background: true` on every `subagent` call, so **do not set that env var for 2.x** (it is a v1 workaround and changes nothing here) |
| Effect on your other modes | the plugin's hooks are global | **none.** Every hook checks the session's owner first, so `build`, `plan` and any agent you installed yourself stay exactly as a fresh OpenCode leaves them — no tool is deleted from their requests, no temperature is set, nothing is offloaded, no permission is tightened, no dispatch is converted to background |

### Prerequisite

OpenCode 2.x (desktop or CLI) and Node.js on PATH (the plugin runs on the host's own
runtime; Node 20+ additionally enables the Playwright browser engine).

### Step 1 — Install the plugin

The key is **`plugins`** (plural), and one line in it is the whole plugin install: the
host resolves the entry and **installs the package itself at startup**. There is nothing
to `npm install` first, no plugin cache to purge, and `opencode plugin add` is not a
prerequisite — it is a convenience that writes this same key (into `opencode.json`, which
is why you may see the entry appear there).

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugins": ["@te-river/opencode-team-mode@latest"] }
```

Two facts about that file, both measured on 2.0.16 / 2.0.18 and both easy to get wrong
from 1.18.x habits (`docs/research/plugin-loader-contract.md` has the host's own code):

- `opencode.json` and `opencode.jsonc` are **both parsed and merged**. The 1.18.x rule
  "jsonc overrides json" is false on 2.x, and acting on it — copying the old file forward
  — puts the same plugin in both, which **loads it twice** (two personalities, the same
  tools and hooks bound twice) with no warning.
- The host's dedupe matches only an **identical string**. `@te-river/…@latest` in one file
  and `./vendor/team-mode` in the other is two entries, not one plugin.

A **local directory** is the other legal spelling, and the one a development tree needs:

```jsonc
{ "plugins": ["./vendor/team-mode"] }        // relative to this file, or an absolute dir
```

The directory **must contain a root `index.js`**. The host resolves a directory as
`<dir>/index` and nothing else — a `package.json#exports` map is honoured for an installed
package but not for a path — and a directory whose entrypoint does not resolve is skipped
**silently**: no error, no log line, no plugin. This package ships that `index.js` for
exactly that reason.

`opencode plugin add` cannot do this: it refuses a path with "Plugin target must be an npm
registry package or Git package specifier".

#### Doing this as an agent, on someone's machine

The installers (`scripts/install.sh`, `scripts/install.ps1`) encode the same procedure; if
you are an agent working for a user who prefers not to run them, follow these steps and do
not skip the last one. Never claim an install without the arrival check — a config write
returning cleanly is not evidence the plugin loaded.

1. Read both `~/.config/opencode/opencode.jsonc` and `opencode.json`. Count how many
   entries anywhere in them name this package (`opencode-team-mode`, case and hyphens
   vary). More than one → the plugin is loading twice; fix that before anything else.
2. Write **one** entry, into the file that already holds the user's other keys (prefer the
   `.jsonc`, since that is where previous installers wrote). Keep every entry that is not
   ours, keep the comments, and leave no comma dangling before `]` — the host tolerates it,
   the next hand edit may not.
3. Generate the roles and commands (Step 2). A plugin cannot create an agent on 2.x, so
   without these twelve files Team does not exist however well the plugin loaded.
4. Set `default_agent: "team"` **last** (Step 3) — a default naming agents that are not on
   disk makes the host fall back to `build` silently.
5. Verify, in this order, and report what you actually saw:
   - `opencode-cli … run --standalone --print-logs` (or restart the desktop and read the
     log) → exactly **one** line `msg="loading plugin" id=<our entry>
     entrypoint=file:///…/index.js`, and **no** `failed to load plugin` naming us.
   - a new Team session → `tm_stats`, section `启动与人格`: `tools_registered: 9`, and the
     `作用域` line. A row that says `agents_missing` named roles means Step 3 has not run.
   - If the log shows nothing at all about our id, the entry is under a key the host does
     not read (`plugin`, singular) or the directory has no root `index.js`. Both failures
     are silent by design; the absence of an error is not a success signal.
6. Say which of the two spellings you left installed, and whether the package came from
   npm or from a local path — the Extensions panel cannot tell them apart (a loader file
   named `team-mode.js` and a directory whose plugin id is `team-mode` print identically).

### Step 2 — Generate the six roles and the six commands

This is the step 2.x exists for and the v1 installer never needed. Run the generator
that ships **inside the installed package** — never copy the markdown by hand, or the
prompts drift away from what the plugin injects on v1:

```bash
# the installed copy of this package (global config's node_modules):
node ~/.config/opencode/node_modules/@te-river/opencode-team-mode/scripts/gen-v2-config.mjs

# preview without writing:
node …/scripts/gen-v2-config.mjs --print
# write somewhere else (a project's .opencode/, a temp dir for a check):
node …/scripts/gen-v2-config.mjs --dir ~/.config/opencode
```

Expected output: `共 12 个文件（角色 6 + 命令 6）`. It is idempotent — re-running writes
nothing and prints `已是最新`. A file it did not generate (no marker) is **refused**, not
overwritten, so your own `agents/team.md` survives; `--force` overrides that.

On Windows the installed path is
`%USERPROFILE%\.config\opencode\node_modules\@te-river\opencode-team-mode\scripts\gen-v2-config.mjs`.

The generated `agents/<role>.md` carries the role's `description` / `mode` / `color` /
permission triples in frontmatter and the **v2 variant** of the prompt in the body: the
generator rewrites every sentence that named a retired tool, and it **fails the run** if a
rewrite rule stops matching the source. That is deliberate — a v2 model told to call
`tm_read` costs the round the mandate exists to save.

### Step 3 — Make Team the default, in config

The plugin also calls `default("team")` on every boot, but a 2.x plugin cannot read the
value back, so the config key is the one you can verify:

```jsonc
{ "default_agent": "team" }
```

**Order matters:** set it only after Step 2 wrote the role files. A default naming a
missing agent makes the host fall back to `build` **silently** — you would see Team
working in a new session and nothing explaining why it stopped. Note also that
`default_agent` does not change the agent already stored on an existing conversation;
it applies to new sessions.

### Step 4 — Restart and verify

```bash
opencode reload      # or just restart the desktop app
```

Four checks, in this order:

1. `opencode agents` (or the picker) lists `team`, `architect`, `implementer`,
   `reviewer`, `tester`, `researcher`.
2. A new session starts as Team. Ask: `tm_stats` — the reply has a
   **启动与人格** section showing the v2 boot line: which tools were registered, whether
   `tool.execute.after` / `permission.evaluate` / `session.context` attached, the probe's
   counts, and `storage_probe` (the `ctx.storage` round-trip that `tm_ledger` depends on).
3. **JIT actually governs the host's tools**: ask Team to run a command that prints a lot
   (e.g. `dir /s` / `ls -R` on a large tree). The tool result should come back as a short
   preview with an offload handle, not the whole dump. If it comes back verbatim, the
   offload layer is not attached — `tm_stats` says so.
4. `tm_ledger { action:"add", text:"smoke test" }` answers with an id and
   `已写入 ctx.storage`. That is the v2 ledger being live.

### Updating / 更新

```bash
opencode plugin update @te-river/opencode-team-mode   # or plugin add …@latest again
node ~/.config/opencode/node_modules/@te-river/opencode-team-mode/scripts/gen-v2-config.mjs
opencode reload
```

The second command is not optional after an upgrade: the role files carry the prompts, and
a new release may have changed them. Re-running is cheap — unchanged files are skipped.

### Uninstalling

1. Remove the plugin entry (`opencode plugin remove @te-river/opencode-team-mode`).
2. Delete the generated files: `~/.config/opencode/agents/{team,architect,implementer,reviewer,tester,researcher}.md`
   and `~/.config/opencode/commands/team-*.md`. Only files carrying our marker were written
   by the generator — anything else you wrote yourself is yours.
3. Remove `"default_agent": "team"` if you set it.
4. The plugin's own data lives under `<repo>/.git/opencode-team/` (git workspaces) or the
   OS temp dir; deleting it costs nothing — the TTL sweeper does the same over time.

### Troubleshooting

| Symptom | Cause and move |
|---|---|
| Roles are not in the picker | Step 2 never ran, or ran against a different `--dir`. `ls ~/.config/opencode/agents` |
| The default silently became `build` | `default_agent` names an agent that does not exist — re-run Step 2, then Step 3 |
| A hand-written `agents/team.md` was not updated | By design: the generator refuses files it did not create. Move yours aside, or pass `--force` |
| `/team-plan` etc. run but not as the specialist | 2.x documents `mode: subagent` as "runs only in a child session"; if a command selecting a specialist does not behave, the fix is `mode: "all"` in the role definition (report it — this is the one item in this flow still unverified on a live host) |
| `tm_webfetch` on an odd site says it refused **without asking anyone** | Expected on 2.x: a plugin cannot raise a dialog. Use a source that works, or let the host's own permission rule allow it; the address red line (metadata / private) has no consent path at all, on either generation |
| `task`/`subagent` seems to block the lead | On 2.x the plugin forces `background: true`; if you also set the old `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`, unset it — it is a v1 flag and only confuses the picture |
| A tool's output arrives un-offloaded | `TM_NATIVE_OFFLOAD=off` (or a missing `tool.execute.after` seam on an older 2.x build) — `tm_stats` names which |
| The plugin behaves oddly — two dialogs, doubled hooks, tools registered twice | It is loaded twice. `opencode.json` and `opencode.jsonc` are merged, and the host's dedupe matches only an identical string, so the same package under two spellings (or in both files) is two personalities. Count the Team entries across BOTH files; `msg="loading plugin"` appearing twice for one id is the proof |
| You wrote the entry and the host says nothing at all about it | Two silent causes, both by design: the key is singular `plugin` (2.x reads `plugins`), or a directory entry without a root `index.js`. The loader resolves a directory as `<dir>/index` only and drops it with no message when that fails — absence of an error is not a success signal here |
| A background sub-agent's reply is huge | The child is now registered and collectable (`tm_join` lists it, marked 宿主 subagent 派发), but its BODY still arrives as the host's injected message, which v2 never hands a plugin before persisting — and we do not rewrite outgoing messages, because a wrong guess at that layer's shape deletes evidence silently. So the oversized deliverable goes to the blackboard file, its path rides the reply, and the lead reads the file |
| You want OUR browser visible in the side panel | Not possible — the panel attaches to the server's own browser service (`docs/research/browser-pane.md`). What IS reachable is a still frame: hand the screenshot to the host's `browser_preview { path }`, which renders a server-local png/html/md/pdf into that panel. Not yet confirmed in a real GUI session |
| You need to know what the host actually exposes | `TM_V2_PROBE=<path>.jsonl` records tool and action **names and counts only** — never a command, path, URL or value — and `tm_stats` renders the capability matrix |

---

## Part B — 中文

### 一条命令，或者按下面的步骤来

`scripts/install.sh` / `scripts\install.ps1` 现在会探测宿主主版本，并在 2.x 上把本页的三步全做完（插件条目 → 生成角色与命令 → 最后写 `default_agent`，并从磁盘读回校验）。两件事直说而不含糊：

- 版本探测也会去问**桌面端**（`resources/opencode-cli.version`，再试自带的 `opencode-cli.exe --version`），因为桌面安装不把 `opencode` 放进 `PATH`——在这种机器上，只探 PATH 会得到"没找到"，而 2.0.16 正在跑；
- 这条 v2 分支**还没在活体 2.x 宿主上端到端跑过**（两份脚本解析通过、探测对已安装应用的版本文件验证过——这不等于同一个结论）。所以下面的手动步骤仍是已验证路径；安装脚本的 v2 分支若表现不对，请按手动步骤做，并回报是哪一步说了什么。

### 2.x 上到底哪里不一样（先看这张表再动手）

| | OpenCode 1.18.x | OpenCode 2.x |
|---|---|---|
| 六个角色 | 插件启动时注入 | `~/.config/opencode/agents/*.md`，由下面的生成器写出——插件没有"造 agent"的接口 |
| 六条 `/team-*` 命令 | 插件注入 | 同一个生成器写 `commands/*.md` |
| 默认 agent | 只在用户没动过时补位 | **每次启动都把 Team 设成默认**（v2 没有读取接口），再加配置里的 `default_agent: "team"`（这一条才是你核对得动的）。退出方式：`"team-mode": { "defaultAgent": false }` |
| 读文件 / 搜代码 / 跑命令 | `tm_read` / `tm_grep` / `tm_bash` | 宿主的 `read` / `grep` / `glob` / `shell`，**治理照旧**：超大结果照样在 `tool.execute.after` 被卸载成预览 + 句柄，跨出项目的路径走宿主自己的 `external_directory` 权限（v1 是硬拒，v2 是弹窗） |
| 批量调用 | `tm_ptc_run` | 宿主自己的 `execute`（Code Mode） |
| 入口文件（v2 主机的硬要求） | — | 宿主把插件**目录**解析成 `<目录>/index.js`；只写 `package.json#exports` 的目录会被**静默忽略**（连错误都没有）。本包根目录的 `index.js` 就是为这条存在的——`plugins: ["./vendor/team-mode"]` 这类官方写法能加载，靠的是它 |
| 交互式浏览 | `tm_browser`（我们自己起的 playwright/CDP 浏览器） | **优先宿主的 `browser_*`**——只有它是桌面端侧边栏里那个浏览器（`docs/research/browser-pane.md`）。`tm_browser` 保留为"宿主没接桌面浏览器时"的退路（CLI / standalone）；原生目录由 `src/host/v2-browser-gate.ts` 管（`execute.before` 上判 URL / 地址红线 / 环境文件路径，并且有"漏过去就把页面换成拒绝语"的兜底）。快照是**截断**而不是卸载，所以下一次点击要的 `[ref=…]` 都留在上下文里 |
| 子代理结算检测 | 宿主的 `event` 钩子 | `ctx.event.subscribe()`——零依赖的 async iterable，按事件类型名过滤（`src/host/v2-events.ts`）。没有它 `tm_join` 分不清「已结算」和「仍在跑」；`tm_stats` 会给出转发了多少、哪些类型名没认出来（只记名字，绝不记负载） |
| 任务清单 | 宿主 `todowrite` | **`tm_ledger`**，存在宿主的 `ctx.storage` 里（v2 不给插件 `todowrite`） |
| 征求用户同意 | 宿主官方逐次弹窗 | **插件在 v2 弹不出对话框。** 原本该问的受治理调用一律**直接拒绝**，并说明是"没人可问"而不是"问了被拒"。你看到的弹窗都来自宿主自己（权限规则、越出项目目录） |
| 联网 | 22 个域名白名单 + 确认弹窗 | **域名门禁关掉**（`TM_WEBFETCH_ALLOWED_DOMAINS` 默认 `"*"`）：2.x 插件弹不出确认框，"批准后放行"等于让 agent 去等一个永远不会出现的窗口。地址类别照管——元数据 / 链路本地 / 保留网段在任何设置下都拒；私网（回环、RFC1918、CGNAT、`.localhost`）也拒，但拒绝语现在给出两条出口而不是承诺点击：`TM_PRIVATE_SPACE=allow`（放开整段），或把那一台主机名写进 `TM_WEBFETCH_ALLOWED_DOMAINS`（只放开它自己） |
| 非阻塞命令 | `tm_pty`（跑在宿主终端会话上）| **完全不注册**——v2 插件上下文没有 pty 域，这个工具只能报自己缺缝。慢步骤请一条一个 `shell` 调用（各自带 `timeout`），并把输出 tee 到日志好回读 |
| 子代理 | 需要 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` | 原生能力；插件对每次 `subagent` 强制 `background: true`，所以 **2.x 不要去设那个环境变量**（那是 v1 的补丁，在这里什么也不改变，只会让人误判） |
| 对你其它模式的影响 | 插件钩子是全局的 | **没有影响。** 每个钩子都先看会话归属，所以 `build`、`plan` 和你自己装的 agent 都保持刚装好 OpenCode 时的样子——不会从它们的请求里删工具、不会设温度、不会卸载结果、不会收紧权限、也不会把它们的派发改成后台 |

### 前置条件

OpenCode 2.x（桌面版或 CLI），以及 PATH 上可用的 Node.js（插件跑在宿主的运行时里；
Node 20+ 还会额外启用 Playwright 浏览器引擎）。

### 第 1 步 — 安装插件

键名是 **`plugins`（复数）**，而且里面一行就是完整的插件安装：宿主会在**启动时自己解析并安装**
这个条目指向的包。不需要先 `npm install`，没有缓存要清，`opencode plugin add` 也不是前置条件
——它只是顺手帮你写了这同一个键（写进 `opencode.json`，所以你会看到条目出现在那儿）。

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugins": ["@te-river/opencode-team-mode@latest"] }
```

关于这个文件有两件事是实测出来的（2.0.16 / 2.0.18），而且用 1.18.x 的直觉一定会搞错，
宿主的原始代码见 `docs/research/plugin-loader-contract.md`：

- `opencode.json` 与 `opencode.jsonc` 是**两份都读、合并生效**。1.18.x 那句"`.jsonc` 覆盖
  `.json`"在 2.x 上不成立；照它做（把旧文件向前复制一份）就等于把同一个插件写进两个文件，
  于是**加载两次**（两套人格、同样的工具和钩子绑两遍），而且没有任何警告。
- 宿主自己的去重只认**完全相同的字符串**。一个文件里写 `@te-river/…@latest`、另一个里写
  `./vendor/team-mode`，是两个条目，不是一个插件。

**本地目录**是另一种合法写法，开发时必须要用它：

```jsonc
{ "plugins": ["./vendor/team-mode"] }        // 相对本文件，或者绝对路径的目录
```

这个目录**必须有根 `index.js`**。宿主解析目录只试 `<dir>/index`，别的不试 ——
`package.json#exports` 只对已安装的包生效，对路径不生效 —— 而解析不出入口的目录会被
**静默跳过**：没有报错、没有日志、也没有插件。本包发布时带上那个 `index.js` 就是为了这件事。

`opencode plugin add` 干不了这件事：给它路径会被拒绝
（"Plugin target must be an npm registry package or Git package specifier"）。

#### 由 Agent 代用户在机器上执行

两个安装脚本（`scripts/install.sh`、`scripts/install.ps1`）走的就是下面这套；如果你是被派来
装机器的 Agent 而用户不想跑脚本，就按顺序做完，**尤其不要跳过最后一步**——配置写成功了不等于
插件加载了，没有到达性检查就没有资格说"装好了"。

1. 同时读 `~/.config/opencode/opencode.jsonc` 和 `opencode.json`，数一下两个文件里指向本包的
   条目一共有几条（`opencode-team-mode`，大小写和连字符都可能不一样）。多于一条 → 插件正在
   被加载两次，先修这件事再谈其他。
2. 只写**一条**条目，写进已经装着用户其他配置的那个文件（优先 `.jsonc`，因为以前的安装器
   就写在那里）。别人家的条目一条都不许动，注释保留，`)`/`]` 前不要留悬挂逗号——宿主容忍它，
   下一个手工编辑的人未必容忍。
3. 生成角色与命令（第 2 步）。2.x 上插件不能创建 agent，所以这十二个文件不在，Team 就不存在，
   插件加载得再好也没用。
4. 最后一步才写 `default_agent: "team"`（第 3 步）——默认值指向不存在的 agent 会让宿主
   静默退回 `build`。
5. 验证，按顺序，并且把你真正看到的说出来：
   - `opencode-cli … run --standalone --print-logs`（或重启桌面端后读日志）→
     **恰好一条** `msg="loading plugin" id=<我们的条目> entrypoint=file:///…/index.js`，
     并且**没有**指名我们的 `failed to load plugin`。
   - 新建一个 Team 会话 → `tm_stats` 的 `启动与人格`：`tools_registered: 9`，以及 `作用域`
     那一行。如果 `agents_missing` 列出了角色名，说明第 3 步没做。
   - 日志里关于我们的 id 一个字都没有 → 条目写在了宿主不读的键下（单数 `plugin`），或者那个
     目录没有根 `index.js`。这两种失败都是设计上静默的，所以"没报错"不是成功信号。
6. 明确说清你留下的是哪种写法、包来自 npm 还是本地路径 —— 扩展面板分不出来：一个叫
   `team-mode.js` 的 loader 文件，和一个插件 id 恰好是 `team-mode` 的目录条目，显示出来一模一样。

### 第 2 步 — 生成六个角色和六条命令

这一步就是 2.x 存在、而 v1 安装脚本从不需要的那件事。请运行**已安装包里**自带的那个生成器
——不要手抄 markdown，否则 v1 注入的提示词和 v2 配置文件里的会悄悄分叉：

```bash
node ~/.config/opencode/node_modules/@te-river/opencode-team-mode/scripts/gen-v2-config.mjs

# 只预览不写盘：
node …/scripts/gen-v2-config.mjs --print
# 写到别处（某个项目的 .opencode/，或者先写到临时目录做检查）：
node …/scripts/gen-v2-config.mjs --dir ~/.config/opencode
```

期望输出 `共 12 个文件（角色 6 + 命令 6）`。它是幂等的：再跑一次什么都不写，只报
`已是最新`。不是它生成的文件（没有标记）会被**拒绝覆盖**，所以你自己手写的
`agents/team.md` 安全；要强行覆盖才用 `--force`。

Windows 上的路径是
`%USERPROFILE%\.config\opencode\node_modules\@te-river\opencode-team-mode\scripts\gen-v2-config.mjs`。

生成的 `agents/<角色>.md` 里，frontmatter 放 `description` / `mode` / `color` 和权限三元组，
正文是提示词的 **v2 变体**：所有点名了已退役工具的句子都会被改写，而且**只要某条改写规则
在源文里找不到，生成就会失败**。这是刻意的——告诉一个 v2 模型"用 `tm_read`"，代价就是那条
规则本来要省下的那一轮。

### 第 3 步 — 在配置里把 Team 设为默认

插件每次启动也会调 `default("team")`，但 v2 插件读不回这个值，所以能核对的是配置键：

```jsonc
{ "default_agent": "team" }
```

**顺序不能颠倒**：必须在第 2 步已经把角色文件写出去之后再设。默认值指向一个不存在的 agent
时，宿主会**静默回落到 `build`**——你会看到新会话不是 Team，而现场没有任何解释。另外
`default_agent` 不会改动已经存在的会话所用过的 agent，它只作用于新会话。

### 第 4 步 — 重启并核对

```bash
opencode reload      # 或者直接重启桌面端
```

按顺序做四项核对：

1. `opencode agents`（或选择器里）能看到 `team`、`architect`、`implementer`、`reviewer`、
   `tester`、`researcher`。
2. 新会话默认是 Team。在里面跑 `tm_stats` —— 回复里应有**启动与人格**一段，展示 v2 的启动
   快照：注册了哪些工具、`tool.execute.after` / `permission.evaluate` / `session.context`
   有没有挂上、探针计到的东西，以及 `storage_probe`（`tm_ledger` 依赖的那次
   `ctx.storage` 写读回环）。
3. **JIT 真的在治理宿主工具**：让 Team 跑一条输出很多的命令（大目录树的 `ls -R` /
   `dir /s`）。结果应该以"短预览 + 卸载句柄"回来，而不是整坨灌进上下文。若原样回来了，
   说明卸载层没挂上——`tm_stats` 会直说。
4. `tm_ledger { action:"add", text:"冒烟测试" }` 应该回你一个编号，并写明
   `已写入 ctx.storage`。这就是 v2 清单活着的样子。

### 更新

```bash
opencode plugin update @te-river/opencode-team-mode   # 或者再跑一次 plugin add …@latest
node ~/.config/opencode/node_modules/@te-river/opencode-team-mode/scripts/gen-v2-config.mjs
opencode reload
```

第二条命令在升级之后不是可选项：角色文件里装的是提示词，新版本可能改过。重跑很便宜——没变
的文件会被跳过。

### 卸载

1. 去掉插件条目（`opencode plugin remove @te-river/opencode-team-mode`）。
2. 删掉生成的文件：`~/.config/opencode/agents/{team,architect,implementer,reviewer,tester,researcher}.md`
   和 `~/.config/opencode/commands/team-*.md`。只有带我们标记的文件是生成器写的，你自己写的
   东西它从不碰。
3. 如果设过 `"default_agent": "team"`，一并删掉。
4. 插件自己的数据在 `<repo>/.git/opencode-team/`（git 工作区）或系统临时目录下；删掉没有代价
   ——TTL 清理器本来就会定期做同样的事。

### 故障排查

| 现象 | 原因与处置 |
|---|---|
| 选择器里没有那六个角色 | 第 2 步没跑，或者 `--dir` 指到了别处。`ls ~/.config/opencode/agents` |
| 默认 agent 悄悄变成 `build` | `default_agent` 指向了一个不存在的角色——重跑第 2 步，再做第 3 步 |
| 手写的 `agents/team.md` 没被更新 | 这是设计：生成器拒绝覆盖不是它生成的文件。把你的文件挪开，或显式加 `--force` |
| `/team-plan` 能跑但不是以那个专家身份跑 | 2.x 把 `mode: subagent` 文档化为"只在子会话里运行"。如果选定专家的命令行为不对，改法是角色定义里用 `mode: "all"`（请回报——这是本流程里唯一还没在活体宿主上验证过的一项） |
| `tm_webfetch` 说它"没问任何人就直接拒绝" | v2 的预期行为：插件弹不出对话框。换一个不需要这次访问的源，或让宿主自己的权限规则放行；地址红线（元数据 / 私网）在两代宿主上都没有授权路径 |
| `subagent` 好像把领队挡住了 | v2 上插件会强制 `background: true`；如果你顺手设了老的 `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`，请取消它——那是 v1 的开关，在这里只会误导判断 |
| 某个工具的输出没被卸载 | `TM_NATIVE_OFFLOAD=off`（或者那个 2.x 构建没有 `tool.execute.after` 缝）——`tm_stats` 会告诉你是哪一种 |
| 插件行为怪：两次弹窗、钩子重复、工具像注册了两遍 | 它被加载了两次。`opencode.json` 与 `opencode.jsonc` 是合并读取的，而宿主去重只认完全相同的字符串，所以同一个包换两种写法（或者同时躺在两个文件里）就是两套人格。把两个文件里指向 Team 的条目一起数一遍；`msg="loading plugin"` 对同一个 id 出现两条就是证据 |
| 写了条目，但宿主日志里关于它一个字都没有 | 两个"设计上静默"的原因：键名写成了单数 `plugin`（2.x 读 `plugins`），或者目录条目缺根 `index.js`。宿主解析目录只试 `<dir>/index`，试不出来就直接丢掉、不留任何消息 —— 在这里"没报错"不是成功信号 |
| 后台子代理的回复太长 | 子会话现在会被登记、可被收集（`tm_join` 会列出它，行上标着「宿主 subagent 派发」），但它的**正文**仍然是宿主的注入消息，v2 不会在落盘前把这条消息交给插件；我们也不改写发出的消息（猜错那一层的形状等于静默删证据）。所以超限交付走黑板文件：正文进文件、回复里带路径，领队读那个文件 |
| `tm_join` 说"没有匹配的派发"，可孩子明明跑完了 | 活体在 2.0.16 上复现过：领队用的是**宿主的** `subagent{background:true}`，插件不创建子会话所以登记里没有它，而收养/按 id 认领原本走 `client.session.children` / `client.session.get`——v2 的插件上下文里根本没有 client。所以回复是通过宿主自己的完成注入到达领队的，不是通过我们的收集通道。这条待补的桥是 `ctx.session.get` 做父子校验（事件流已经能给出候选 sessionID） |
| 想在侧边栏看到我们 `tm_browser` 的页面 | 做不到（面板挂的是服务端自己的浏览器服务；见 `docs/research/browser-pane.md`）。能看到的是**静帧**：让 agent 把截图交给宿主的 `browser_preview { path }`，它会把服务端本地文件（png/html/md/pdf/mermaid）渲染进面板——这条尚未在你的 GUI 里验证过 |
| 想知道宿主到底给了什么 | `TM_V2_PROBE=<路径>.jsonl` 只记工具名与权限动作名**以及计数**，绝不记命令行、路径、URL 或环境变量值；`tm_stats` 会把能力矩阵渲染出来 |

### v2 专属的开关

| 变量 / 配置 | 默认 | 作用 |
|---|---|---|
| `TM_WEBFETCH_ALLOWED_DOMAINS` | `*`（**仅 v2**） | 域名门禁默认关掉，只留地址红线；显式给了值就以它为准（v1 仍是 24 个种子域名） |
| `TM_NATIVE_OFFLOAD` | on | 用 `tool.execute.after` 治理宿主原生工具的结果；off 就退回宿主原样 |
| `TM_R6_FINE_ASK` | on（v2） | 由按命令分类器决定哪条 shell 要问；`off` 回到"每条 shell 都问"，宿主没有 `permission.hook` 时也自动回到这一档 |
| `TM_V2_PROBE` | 未设 | 把宿主真实工具面/动作名记成 JSONL（只有名字和计数） |
| `"team-mode": { "defaultAgent": false }` | 不设置 = Team 永远默认 | 退出默认位抢占（只影响插件的每次启动行为，配置里的 `default_agent` 请自己改回来） |

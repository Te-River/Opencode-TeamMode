# computer use — the optional desktop-control MCP / 可选的桌面控制 MCP

> This page is deliberately **separate** from [`installation-v2.md`](./installation-v2.md).
> A Team agent installing the plugin must not pick desktop-control instructions up in
> passing; read this page only when the user asked for the feature, or when the install
> guide's Step 0 found `mcp.computeruse` already configured.
>
> 这一页**刻意**不写进 [`installation-v2.md`](./installation-v2.md)。正在安装插件的
> Team agent 不该顺手读到桌面控制的操作规程；只有用户要这个功能，或安装手册第 0 步
> 发现 `mcp.computeruse` 已存在时，才读这里。

| | |
|---|---|
| Package | `computeruse-mcp` (Python), released as a **GitHub Release asset**, never on npm |
| Tag / asset | `computeruse-v<ver>` / `computeruse_mcp-<ver>-py3-none-any.whl` |
| Current | **0.0.7** —— 已发布（tag `computeruse-v0.0.7`）。下面 **Budgets / 预算与回收旋钮** 那节的两个环境变量自 0.0.7 起随包发布；装在 0.0.6 上的进程读不到它们——0.0.6 里没有（历史） |
| MCP server name | `computeruse` (one lowercase token — the host's action prefix stays stable) |
| Tools | `screenshot` `click` `type_text` `key` `scroll` `drag` `control_status` |
| Allowed roles | `Team` (lead) · `ComputerUser` — the dedicated specialist. `researcher` and `tester` are **not** allowed |
| Runtime | Python 3.12 + `uv` (`mss`, `Pillow`, `ctypes.SendInput`) |

---

## Install / 安装

```powershell
.\scripts\install.ps1 -ComputerUse          # Windows
```
```bash
bash scripts/install.sh --computer-use      # POSIX
```

The installer downloads the pinned wheel, **verifies its sha256 before installing**, runs
`--selftest`, and only then writes `mcp.computeruse`:

```jsonc
"mcp": { "computeruse": { "type": "local",
  "command": ["<releases>/<版本>/computeruse-mcp/Scripts/computeruse.exe", "--budget", "200"],
  "environment": {}, "enabled": true, "timeout": 60000 } }
```

A hash that does not match installs nothing and writes zero config bytes. The entry path is
VERSIONED, and that is the whole upgrade mechanism — see the **Upgrade / 升级** section below
(the versioned layout ships with the **1.9.8** installer; an entry left by 1.9.7 or earlier still
points into uv's own tool dir until its next upgrade).

安装器会先校验 sha256，再 `uv tool install`（写进 `<releases>/<版本>/` 这个独立目录），再跑
`--selftest`，最后才写配置 —— 哈希不符、或 `--selftest` 不是 0，就什么都不装、一个配置字节都不写，
并说出「仍是旧版本在跑」。

---

## Window scope — `window:` on every tool / 窗口作用域

Pass `window: "<substring of the title>"` and the call is about **that window**:

| tool | behaviour with `window:` |
|---|---|
| `screenshot` | crops to the window's rect and **never changes focus**; the returned `rect` is absolute, so a local coordinate is `absolute − rect origin` |
| `click` `scroll` `drag` `type_text` `key` | focuses the window, runs the action, then **restores the previous foreground window** |

Zero matches is an answer, not a crash: `window-not-found` names the pattern and
tells the caller to screenshot and read `active_window` first. Ambiguity resolves
to the largest title match — an app window beats its own dialog.

不传 `window:` 就还是在「最上面那个窗口」上动手，这正是这个角色不打扰用户的关键。
没有匹配不是崩溃：`window-not-found` 会点名你给的那个子串，并让你先截图看 `active_window`。

---

## Upgrade / 升级 —— 一次重启（不是一步都不需要，也不是两次）

> **发版状态 / release status:** 这一节（每版本一个 `<releases>/<version>/` 目录、一次重启是下限、
> `-ComputerUseReclaim` 两趟回收）自 **1.9.8** 起是发布安装器的行为（`b3393a3`）。1.9.7 及更早的安装器
> 是原地 `uv tool install --force`——Windows 上它换不掉宿主正占着的 exe（`os error 32/5`），
> 所以那些版本要走下面"为什么以前非要两次重启"描述的那两趟（历史）。
> This section describes the installer **as shipped since 1.9.8** (`b3393a3`); 1.9.7 and earlier
> installed in place and needed the two-pass procedure explained further down (history).

Every version gets its OWN directory, and the upgrade is the single edit that moves the
config entry onto it:

```
%LOCALAPPDATA%\te-river\computeruse\releases\<version>\computeruse-mcp\Scripts\computeruse.exe
```

`uv tool install` writes into `<UV_TOOL_DIR>/<dist name>/`, and that `<dist name>` directory
is not ours to name — it comes from the wheel's metadata (measured: `computeruse-mcp`, while
the console script is `computeruse`), and uv itself reads name/version/tag out of the wheel
**filename**. So the version rides on the directory one level UP: the installer sets
`UV_TOOL_DIR=<releases>/<version>` (and `UV_TOOL_BIN_DIR` inside it, so no shim lands in
uv's shared bin dir), the new version lands where nothing has it open, and
`mcp.computeruse.command` is repointed through `scripts\lib\config-surgery.cjs mcp-set` —
which writes nothing when the bytes already match and reads the entry back off the disk.

```powershell
.\scripts\install.ps1 -ComputerUse      # Windows — 一条命令装新版本
opencode service restart                # 一次，不是两次
```
```bash
bash scripts/install.sh --computer-use  # POSIX — 同一套布局、同一个顺序
opencode service restart
```

Verify with `tools.computeruse.control_status({})` over `execute`: `version` must equal the
release you just installed, and `panic_armed` must be `true` (it names the hotkey that
actually registered).

**为什么以前非要两次重启** — the old layout upgraded IN PLACE, so `uv tool install` had to
replace an executable the host was still running as its child process, and Windows refuses
that with `os error 32/5`. Renaming a loaded image was tried and measured refused (sharing
violation, 2026-10-30), so the only procedure that worked was: remove the entry → restart so
the host does not respawn the server → install → restart again. The first restart carried no
information; it only freed the file. With a directory per version nothing has to be freed, and
the procedure collapses to install → one restart.

旧的「两次重启」不是因为升级需要重启两次，而是因为**覆盖同一个文件**需要先让占着它的进程退出：
删条目 → 重启（旧进程退出、且不会被重新拉起）→ 安装 → 再重启（加载新进程）。第一次重启的唯一
作用就是释放文件。现在每个版本自己一个目录，新版本写进一个没人打开的路径，升级就退化成一次配置
编辑，于是只剩第二次重启那一次。

**零次重启做不到，而且原因在宿主身上**：正在跑的 server 进程是宿主在启动时按配置条目拉起来的，
插件不能在活进程底下换映像，本安装器也从不杀进程（kill 是被拒绝的 R2 面，不是被询问的）。一次
重启是下限。想让旧目录连同进程一起消失，可以先完全退出 OpenCode 再装 —— 但那只省磁盘，不省重启。

`TEAMMODE_CU_RELEASE_DIR` overrides the releases root (POSIX default:
`${XDG_DATA_HOME:-~/.local/share}/te-river/computeruse/releases`), which is what makes a
sandboxed test of this code path possible without touching uv's real tool dir.

### 回收旧目录 / reclaim（两趟，绝不当场强删）

The version you just left behind is NOT force-deleted — a live process may still be running
from it, and half-deleting a release is worse than keeping it. The reclaim pass is therefore
TWO phases, in TWO runs:

1. a release that nothing points at (`current.json`), that neither global config file still
   names in its text, and that no process is running from, is **renamed** into
   `releases/.pending-delete/<version>.<timestamp>` — a rename is all-or-nothing, so a
   directory something has open simply refuses to move and is kept with the reason printed;
2. the NEXT pass (the next install, or the next `-ComputerUseReclaim`) deletes what is
   already sitting in `.pending-delete`. What this pass moved aside it never deletes itself.

Every decision prints a line — `keep … — <reason>` / `move …` / `✔ reclaim …` — so a silent
keep is impossible. Run the pass on its own whenever you like; it writes zero config bytes:

```powershell
.\scripts\install.ps1 -ComputerUseReclaim
```
```bash
bash scripts/install.sh --computer-use-reclaim
```

`releases/current.json` is the do-not-touch marker ("the entry points here");
`releases/<version>/receipt.json` is the idempotence key — repeating an install of the same
wheel prints `OK already at <version>`, runs no `uv`, and writes no config byte (the helper
answers `已存在，未改动` for the entry). A `--selftest` that fails writes no entry at all and
says which version is still the one running, and drops that version's receipt so the next
run re-installs and re-verifies instead of trusting a claim this machine contradicted.

Installs made by the OLD layout still sit in uv's own tool dir (`uv tool dir` →
`computeruse-mcp`); `uv tool uninstall computeruse-mcp` clears that one, and the next install
writes a versioned directory in its place.

---

## Budgets / 预算与回收旋钮（**已随 computer-use 0.0.7 发布**）

两个环境变量，都在**生成侧**生效，都遵循"非法值回落默认而非关掉闸门"：

- `CU_AUDIT_MAX_BYTES`（默认 64 MiB；`0` = 不设上限）：审计轨的**总量**上限——TTL 只回答"多旧"，
  从不回答"多少"（本机实测过 27 MB 而时钟远未到点的 run 目录）。回收单位是**整个 run 目录**，
  最旧优先，**活跃 run 按身份豁免、不按位置**；TTL 先跑，两趟共用一次扫描。删不动时报**失败**
  （`usage()` 里 `over_cap=1` 挨着 `evicted_runs=0` 就是这个读数），绝不说"已回收"。
  已知边界：单个活跃 run 自身超限时本进程内无可驱逐对象，等下个进程回收。非法值（非整数）回落
  **默认**而不是 0 —— 一次拼写错不能把唯一的体量闸门悄悄关掉；`usage()` 另带 `cap_reason`，
  说清这一趟到底为什么没动。
- `CU_IMAGE_BUDGET_BYTES`（默认 4 MiB；`0`/负 = 不设上限）：**单进程**附图字节预算；同一 target 上
  与上一帧内容等价的画面不再重复附图（截图是非文本部件，JIT 卸载管不到，只能生成侧省）。
  **未附图 ≠ 屏幕空白 ≠ 屏幕没有变化**——PNG 路径、sha1、verdict 与预算无关，照常落盘照常被判定；
  `control_status` 报附图/去重/预算计数。被预算挡下的那一帧在返回里点名：`image_omitted` +
  `image_omitted_reason:"budget"`；去重记忆只在同一 target 内生效（memo 上限 64 个 target），
  换窗口不等于上一张没发过，这不是跨会话的图像缓存。默认 4 MiB ≈ 10 张全屏帧（按 400 KB/张算）
  或约 35 张典型小图；非法值同样回落默认，而不是回落成"不设上限"。

两个值都只在**进程启动时读一次**：改完要重启这个 MCP 服务器才生效，正在跑的进程不会自己重置预算。
实现事实源：`audit.py`（上限与 `usage()`）、`capture.py` + `server.py`（附图预算与去重）。
这两个旋钮已随 **0.0.7** 发布（审计上限的实现自 `c6d2285` 起）；0.0.6 及更早没有它们——别把它们写进给 0.0.6 的安装说明里。

---

## Undo / 撤销

```bash
node scripts/lib/config-surgery.cjs <cfg> mcp-remove computeruse # 1. remove the key
rm -rf <releases>                                   # 2. 全部版本目录（见上：LOCALAPPDATA / XDG_DATA_HOME）
rm -rf "%LOCALAPPDATA%/te-river/computeruse"        # 3. 整个 te-river 树（releases + audit 一起）
uv tool uninstall computeruse-mcp                   #    仅旧布局：清 uv 自己工具目录里的那份
rm -f <config dir>/team-mode.computeruse-declined   # 4. only if you declined
```

---

## Boundaries / 边界（it is a blast-radius limiter, not a security boundary）

- **Elevated (UAC) windows are unreachable.** Only a Windows process can touch the secure desktop.
- **Typed text bypasses the R2/R6 classifiers.** `type_text` sends keystrokes, not a shell
  string, so `shellGuard` / `pathGuard` never see it and the env-variable red line does not
  exist on that path. Never type credentials with it.
- **Screenshots are not JIT-governed.** They are non-text parts, so the offload layer passes
  them through. Prefer `include_image:false` unless the model can read pixels.
- **The role split is three layers, and only the first two are hard**: `permission.evaluate`
  (the host does fire it for MCP actions), the inner `execute` event, and a program-text scan
  that a dynamically assembled name can slip past — a bypass is recorded as
  `computeruse_bypass`, never silently allowed. It is **not** an isolation boundary.
- **Screen content is untrusted input.** `researcher` is the role that reads web pages, so a
  page saying "type X into the terminal" is aimed exactly at it.

---

## Runtime behaviour / 运行时

| | |
|---|---|
| Budget | 200 mutating actions per process; exhaustion refuses mutating calls and keeps read-only ones working |
| Audit | `%LOCALAPPDATA%\te-river\computeruse\audit\<date>\<sid8>\actions.jsonl`, one row per action incl. `screenshot`; window titles and `expect_title` stored as length + sha1 **fingerprint**, never text; `type_text` records `text_len` + `text_sha1_8`; 7-day TTL |
| Panic | a global hotkey toggles model ↔ human control; the ladder tries `Ctrl+Alt+Shift+F12`, then `F11`, then `F10` — `control_status` reports the one that **actually armed**, and `panic_armed:false` with an `error` means none did |
| Verdict | every mutating tool returns `{before_sha1, after_sha1, changed_pixels_pct, verdict}`; `no-observable-change` means the screen did not move — it is an answer, not a failure |
| DPI | the process is per-monitor-v2 aware; coordinates are capture pixels of the same space |

---

## Troubleshooting / 排错

| Symptom | Cause / next move |
|---|---|
| `uv tool install failed (exit …)` + `os error 5/32` | 只有一种情况还会撞它：**同一个版本号被重复构建**，而旧进程正是从那个版本目录跑起来的（新机制不会覆盖别的目录）。`opencode service restart` 释放它，或按新版本号重新构建，再重跑 |
| `--selftest exited N` + `仍是旧版本在跑` | 新目录装上了但在这台机器上跑不起来（多半是没有真实桌面的会话）。配置条目没动，旧版本继续工作；`keep`/`reclaim` 行会说出留下的目录是哪一个 |
| `panic_armed: false`, `RegisterHotKey failed err=1409` | every candidate hotkey is taken; pick a different app's shortcut to release one, or accept "no panic key" and say so out loud |
| `control_status.version` ≠ the release you installed | the host is still running the old process → restart once more |
| `keep <dir> — 有进程从这个目录跑着` | 正常：旧版本还在宿主手里活着。回收从不杀进程；重启之后再来一趟（或直接删 `<releases>` 整棵树） |
| `computeruse_absent: "declaration-unread"` | the config file could not be parsed; a UTF-8 BOM is handled, anything else is reported rather than guessed |
| Tools missing from the Code Mode catalog while `mcp connected … tools=7` appears in the log | the request surface and the catalog are different layers — `tm_stats` names which one is empty |

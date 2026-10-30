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
| Current | **0.0.4** |
| MCP server name | `computeruse` (one lowercase token — the host's action prefix stays stable) |
| Tools | `screenshot` `click` `type_text` `key` `scroll` `drag` `control_status` |
| Allowed roles | `Team` (lead) · `researcher` · `tester` |
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
  "command": ["<abs>/computeruse.exe", "--budget", "200"],
  "environment": {}, "enabled": true, "timeout": 60000 } }
```

A hash that does not match installs nothing and writes zero config bytes.

安装器会先校验 sha256，再 `uv tool install`，再跑 `--selftest`，最后才写配置。哈希不符
就什么都不装、一个配置字节都不写。

---

## Upgrade / 升级 —— 默认走这条路

**Windows cannot replace an executable that is running**, and the host keeps this server
alive as a child process, so a plain re-run of the installer fails with `os error 5/32`.
The default procedure is therefore **two restarts**:

```powershell
$cfg = "$env:USERPROFILE\.config\opencode\opencode.jsonc"
# 1. take the entry out — so the restart does NOT respawn the server
node scripts\lib\config-surgery.cjs $cfg mcp-remove computeruse
# 2. restart; the exe is now free
opencode service restart
# 3. install: verifies the new wheel, then writes the entry back
.\scripts\install.ps1 -ComputerUse
# 4. restart once more so the new server is loaded
opencode service restart
```

Verify with `tools.computeruse.control_status({})` over `execute`: `version` must equal the
release you just installed, and `panic_armed` must be `true` (it names the hotkey that
actually registered).

If you prefer one restart: **quit OpenCode entirely**, run `.\scripts\install.ps1
-ComputerUse`, then reopen. Closing only the window does not release the file.

---

## Undo / 撤销

```bash
uv tool uninstall computeruse-mcp                                # 1. remove the tool
node scripts/lib/config-surgery.cjs <cfg> mcp-remove computeruse # 2. remove the key
rm -rf "%LOCALAPPDATA%/te-river/computeruse"                     # 3. remove the audit trail
rm -f <config dir>/team-mode.computeruse-declined                # 4. only if you declined
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
| `uv tool install failed (exit 2)` + `os error 5/32` | the running server holds its exe → the two-restart procedure above |
| `panic_armed: false`, `RegisterHotKey failed err=1409` | every candidate hotkey is taken; pick a different app's shortcut to release one, or accept "no panic key" and say so out loud |
| `control_status.version` ≠ the release you installed | the host is still running the old process → restart once more |
| `computeruse_absent: "declaration-unread"` | the config file could not be parsed; a UTF-8 BOM is handled, anything else is reported rather than guessed |
| Tools missing from the Code Mode catalog while `mcp connected … tools=7` appears in the log | the request surface and the catalog are different layers — `tm_stats` names which one is empty |

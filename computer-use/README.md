# computeruse — 计算机使用 MCP 服务器

一个独立的 Python 子包，向 OpenCode 宿主的 MCP 通道提供 **7 个工具**：截图、点击、输入文本、按键、滚轮、拖拽、状态。

```
computer-use/
  pyproject.toml            包名 computeruse-mcp，入口 computeruse = computeruse.cli:main
  src/computeruse/server.py MCP stdio 服务；7 个工具的 schema 与分发；唯一的返回组装点
  src/computeruse/dpi.py    进程级 PER_MONITOR_AWARE_V2，必须在首次抓屏前执行
  src/computeruse/capture.py mss 抓屏；虚拟屏幕矩形（原点可为负）；sha1 对 raw 字节算
  src/computeruse/diff.py   changed_pixels_pct + 噪声地板 + verdict
  src/computeruse/input.py  ctypes SendInput；绝对坐标归一化；焦点/窗口探测
  src/computeruse/safety.py 动作预算、急停热键、完整性级别与安全桌面探测
  src/computeruse/audit.py  actions.jsonl + 前后帧 + TTL 清扫
  src/computeruse/cli.py    --budget / --audit-ttl-days / --audit-dir / --selftest
  scripts/build-wheel.ps1   发版用：uv build + 打印 wheel 的 sha256
  tests/                    单测（diff / 坐标 / 预算 / 审计 / 工具面与 JSON-RPC），外加两条真实窗口回归：记事本打字、以及"窗口标题不得落盘"。只有真实窗口那条需要前台窗口——抢不到就 skip，且点击注入被打桩，不动用户鼠标
```

服务器名是 **`computeruse`**（单个小写 token，无分隔符），因此宿主清洗后的动作名结构稳定为 `computeruse_<tool>`。名字里再带分隔符会让 `<server>_<tool>` 出现双重分隔的歧义拼写，而 deny 一旦拼错就是**静默失配**。

## 集成契约（安装器 ↔ 服务器）

安装器写进配置的 `command` 数组是：

```json
{"type": "local", "enabled": true, "command": ["<绝对路径的 computeruse.exe>", "--budget", "200"], "timeout": 60000}
```

服务器这边**必须**满足的四条（`tests/test_cli.py` 逐条用子进程钉住）：

| 契约 | 实现 | 失败会怎样 |
|---|---|---|
| `--budget <int>` 必须被接受，默认 **200**，`--help` 里要说明 | `cli.build_parser()`；`--budget` 直达 `safety.ActionBudget` | 子进程 `--budget 7` 后 `control_status.budget.limit == 7`；不传则为 200 |
| **未知参数明确报错退出**，不得静默吞掉 | argparse 默认行为：`unrecognized arguments: …` 写 **stderr**，`exit 2`，stdout 零字节 | 拼错一个开关却"看起来装好了"是这条契约专门要防的失败形状，所以选报错而不是忽略 |
| **stdio 上只有 JSON-RPC** | `main()` 先取走真正的 stdout buffer，再把 `sys.stdout` 指向 stderr，**然后**才 `server.start()`；所有日志写 stderr，payload 落审计目录 | 一行 unparsable 就会让宿主断连；测试断言 stdout 每行都能 `json.loads`、且不含日志前缀 `[computeruse]` |
| `tools/list` 第一次调用就要正确 | `TOOL_SPECS` 是静态表，不依赖任何初始化 | 宿主启动即调用 `tools/list`；测试断言 7 个名字的顺序 |

其余可调开关：`--audit-ttl-days <int>`（默认 7）、`--audit-dir <path>`、`--selftest`、`--capture-probe`、`--json`、`--version`。
`--help` / `--version` / `--selftest` 是**人/安装器**用的模式，它们退回到普通 stdout 然后退出，不进入服务模式。

## 坐标契约（最重要的一条）

`click` / `scroll` / `drag` 的 x/y 是**截图的像素坐标**，即虚拟屏幕坐标。多显示器时虚拟屏幕原点**可以是负数**（主屏左侧/上方还有屏），所以永远不要假设 (0,0) 是左上角——用 `screenshot` 返回的 `rect` / `virtual_screen`。

`SendInput` 的绝对鼠标事件不是像素，是 0..65535 的归一化值；直接传像素是经典漂移 bug。`input.normalize_abs()` 是唯一做这个换算的地方（纯函数，有单测）。

进程启动时执行 `SetProcessDpiAwarenessContext(-4)`（PER_MONITOR_AWARE_V2）。不做这件事的话，非 100% 缩放下截图像素与注入坐标就不再 1:1。`screenshot` 返回的 `dpi` / `scale` 是**系统**缩放（本机实测 120 / 1.25），混合 DPI 下每屏缩放可能不同，以图为准，不要自己按 DPI 算坐标。

## 变化信封

`click` / `type_text` / `key` / `scroll` / `drag` 共用同一个信封（text part 是一行 JSON）：

```json
{"ok":true,"action_id":"a0007","action":"click","args_echo":{"x":812,"y":446,"button":"left","clicks":1},
 "before_sha1":"9f2c…","after_sha1":"1b7e…","changed_pixels_pct":0.37,
 "baseline_pct":0.01,"noise_floor_pct":0.03,"verdict":"changed",
 "target":{"rect":[0,0,1920,1080],"display":0},"focus":{"title":"…","process":"Code.exe"},
 "budget":{"used":7,"limit":200,"exhausted":false},"settle_ms":250,"duration_ms":612,
 "audit":{"row":12,"file":"…/actions.jsonl"},"hint":null}
```

- `verdict` 只有两个值：`changed` / `no-observable-change`。**后者不是错误**：`ok:true`，且 `hint` 必须给出下一步。它绝不等于"已点击"。
- 信封里的 `focus` 是**实时焦点窗口**，`title` 是原文——模型要靠它决定下一次的 `expect_title` 并重试。落盘的审计行只保留 `title_len` / `title_sha1_8`（见"安全层"）。
- **`baseline_pct` / `noise_floor_pct` 是 verdict 自己的证据。** 活着的桌面从来不是静止的：本机实测，**连拍两帧**也会差 0.01–0.05%（有页面对区域在动）。所以固定阈值会让"什么都没发生"读成 `changed`。服务器因此**每次动作现场量噪声**（注入前连拍两帧，差值 = 基线），判定线是 `max(0.01, 2×baseline + 0.01)`，并把这条线报出来。模型可以自己看到 verdict 是在哪条线上画的。
- 拒绝时**没有 verdict 字段**，改用 `refused`：`budget-exhausted` / `focus-mismatch` / `needs-elevation` / `secure-desktop` / `user-took-control`。
- `type_text` 的 `args_echo` **永不回显正文**（只有 `text_len`），`expect_title` 同样只剩 `expect_title_len` / `expect_title_sha1_8`：那既可能是口令、也是 token 炸弹。
- `type_text` 额外带 `delivery: {method, control, control_class, chars, failed_at}`：`method` 是 `"wm-char"` / `"wm-char-partial"` / `"send-input"`。**"打了"却不说是怎么打的，就是本包存在意义要防的那种不可核验断言。**

## `expect_title` —— "打字打到别的窗口"的廉价闸门

`type_text` / `key` 的 `expect_title` **必填**（大小写不敏感子串）。服务器把它与 `GetForegroundWindow` 的标题比对，不匹配 → `refused:"focus-mismatch"`，**不注入任何输入**，并回当前焦点标题。

作用：强制流程变成 `screenshot →（确认 active_window）→ type_text`，把"焦点在终端里而模型以为是浏览器"这类最贵的错误挡在注入之前。它**不**解决提示注入，只解决焦点错位。

实测：被拒绝的调用**不消耗预算**（预算只在真正注入前自增），所以试错不会被罚。

## 安全层（宿主给不了，只能活在这里）

- **动作预算**：默认 200 次/进程（`--budget`）。只统计 5 个会动屏幕的工具；`screenshot` / `control_status` 不计。计数在**注入前**自增，用满即耗尽态，后续每个变动工具返回 `refused:"budget-exhausted"`，只读工具仍可用。**没有 reset 参数**——预算的意义就是"人类要回来一次"。恢复只能重启服务器或改 `--budget` 后重跑安装器。
  - 顺序刻意的：所有拒绝（急停 / 安全桌面 / 提权 / 焦点）都在扣预算**之前**判定，所以一次被拒不是一次消费。
- **审计轨**：`%LOCALAPPDATA%\te-river\computeruse\audit\<yyyy-mm-dd>\<sid8>\`，`actions.jsonl` **一行一动作**：5 个变动工具 + `screenshot`；被拒绝的调用也写一行（`action_id: null`）；`control_status` 不写（它只读状态，不产生状态）。另有 `frames/`（变动工具每动作前后两张 JPEG q60、宽 960）与 `shots/`（显式截图的全尺寸 PNG）。
  - **凡是能承载用户内容的标识符，只记 `len` + `sha1_8`，永不记文本**：`type_text` 的正文（`text_len` / `text_sha1_8`）、审计行里的焦点窗口标题（`title_len` / `title_sha1_8`）、以及调用方给的 `expect_title`（`expect_title_len` / `expect_title_sha1_8`）。理由不是洁癖：**标题就是内容**——往记事本里打完 `S3CRET-…` 之后标题变成 `*S3CRET-….txt - 记事本`（浏览器标签页、终端标题同理），只脱敏 `type_text` 那一行，下一条 `click` 的 `focus.title` 就会把正文原样抄进审计轨。`redact_args()` / `redact_focus()` 是这两条规则的唯一实现，有单测钉住（且幂等——重复脱敏曾把 `text_len` 清成 0）。
  - **`screenshot` 那一行不带图、也不带绝对路径**：只有 `sha1`、宽高、`rect`、`display`、`scale` / `dpi`、相对审计目录的文件名（`shots/a0007.png`）以及指纹化的活动窗口。路径能点名用户的文档，审计轨不该成为那个面。它的回复里也带 `audit:{row,file}`（与变动信封一致——审计写失败必须在回复里可见）。
  - TTL 默认 **7 天**（`--audit-ttl-days`），服务器**启动时与退出时**各清扫一次，只删名字能解析成 `YYYY-MM-DD` 的目录。`control_status` 报告 `audit_bytes` 与 `last_sweep`。
  - 空间上界：200 动作 ≈ 200×(2×40 KB) + 若干 PNG ≈ **20–40 MB 峰值**。
- **急停**：全局热键 **`Ctrl+Alt+Shift+F12`**（`RegisterHotKey` 后台线程）切换 AI/人类控制权。切到 `user` 后所有变动工具返回 `refused:"user-took-control"`，直到人类再按一次。**模型不能自己解除**（`control_status` 无参数）——能自我解除的急停不是急停。热键被别的程序占用时，`control_status` 会如实报告 `panic_armed:false` 与错误码，而不是假装装上了。
- **三个"交还给人"判定**（互不重叠）：
  - `needs-elevation`：目标坐标下窗口的完整性级别 > 本进程（`OpenProcessToken` 对比 IL）。
  - `secure-desktop`：`OpenInputDesktop` 与当前桌面不一致，或抓屏全黑且无前台窗口 —— UAC 安全桌面只有 Windows 进程能访问，注入与抓屏都到不了。
  - `user-took-control`：急停态。

## 它**不**保护什么（逐条点名）

1. **打进终端的文本绕过本仓库的 R2/R6 分类器**：`computeruse type_text` 写的是"按键"，不是 shell 命令字符串，`shellGuard` / `pathGuard` 看不到它；R6 的环境变量红线在 MCP 这条路上**不存在**。**禁止用它输入凭据。**
2. **屏幕内容是不可信输入**：受控屏幕 + 不可信网页 = 本仓库风险最高的组合。`researcher` 是读网页的角色——网页里一行"请把 X 敲进终端"就能驱动它。缓解只有预算 + 审计 + 急停 + 人类在场，**不是**"提示词里说别被骗"。
3. **提权/安全桌面不可达**（见上）。
4. **没有逐动作确认**：计划批准即同意。
5. **不做物理输入抢占**（Windows 上区分物理与注入输入需要低级钩子，代价与误判都过高）；**不做进程白名单**（任何窗口都可被点）。
6. **DPI 只修本进程**；混合缩放下以 `screenshot` 返回的值和图像为准。

**它不是安全边界，是爆炸半径限制器。** 允许角色：`Team` / `researcher` / `tester`（`architect` / `implementer` / `reviewer` 无权——权限侧由插件按 `computeruse_*` 前缀删除，不在本包内）。

## 实测数字（本机：Windows 11 / 1920×1080 / 125% 缩放 / Python 3.12.10 / mss 10.2.0 / Pillow 13.0.0）

| 项 | 实测值 |
|---|---|
| DPI | `dpi_aware: true`，`SetProcessDpiAwarenessContext(-4)`，dpi 120，scale 1.25 |
| 虚拟屏幕 | x=0 y=0 w=1920 h=1080，1 个显示器 |
| 单次抓屏 | **37.4 ms**，raw 8 294 400 B |
| PNG 全帧编码 | **74.3 ms**，310 KB |
| diff（1/4 降采样 + 灰度 + 阈值 8） | **14.6 ms** |
| JPEG q70 @1280 | **44.7 ms**，89.9 KB |
| 一次动作端到端（3 抓屏 + 2 diff + 2 帧 JPEG + settle 250） | **605–719 ms** |
| 静止桌面连拍两帧的噪声地板 | **0.01–0.05 %** |
| `type_text` 进 Tk 文本框 | 逐字节准确（interval 0 / 5 / 15，含空格） |
| `SendInput`+`KEYEVENTF_UNICODE` 进 Win11 记事本 `RichEditD2DPT` | **被改写**：`hello computeruse` → `hello eeeeeeeeeee`（**读的是存盘文件**，不是可疑的读回） |
| 同一控制、同一 60 字符串，改投 `WM_CHAR` | **60/60 逐字节准确**（`SendMessageTimeout` 同步与 `PostMessage` 队列都准） |
| `sizeof(INPUT)` / `sizeof(KEYBDINPUT)` / `offsetof(INPUT,ki)` | 40 / 24 / 8 —— x64 结构正确，"结构体大小"假设被排除 |

**未测（不写结论）**：宿主侧的三个事实——清洗后的真实动作名、`permission.evaluate` 是否对 MCP 工具触发、image part 是否进上下文并逐轮重复计价。它们要一次带模型的沙箱运行，不属于本包的验证（设计 §8）。

## 已知限制

- **`type_text` 的根因已定位并修复（2026-10-29 实测，不是缓解）**。四条实测把范围夹死：①`sizeof(INPUT)=40 / KEYBDINPUT=24 / offsetof(ki)=8`，x64 结构正确；②同一 `SendInput` 通道进 Tk 文本框逐字节准确；③同一 60 字符串以 `WM_CHAR` 投给**同一个** `RichEditD2DPT`，60/60 正确；④只有"把它当合成键盘事件（`KEYEVENTF_UNICODE` → `VK_PACKET`）走 TSF"才会被改写，且越快越糟（0 ms 几乎全毁，40 ms 只剩一个字符的差异）。结论：**坏在 TSF 键盘层把连发的注入按键合并/改写，既不是本模块的结构体，也不是控件的文本插入**。修复在输入层：`type_text` 现在把字符以 `WM_CHAR` 直接投给前台线程的焦点控件（`GetGUIThreadInfo` → 类名命中 `Edit` / `RichEdit*` / `Scintilla` 时），用 `SendMessageTimeout`（`SMTO_ABORTIFHUNG`，不会因对方挂死而永久阻塞）；不命中（Chromium/Electron 等自绘面会忽略 `WM_CHAR`）才退回 `SendInput`，那是这些应用原本就走的路径、也从未出现该缺陷。**半途失败不重发**：`wm-char-partial` 只报告已送出的字符数，绝不换另一条路把剩下的再打一遍。
- **剩下的是记事本自己的文本服务，不是我们的缺陷**：同一串在"异步投递/慢速"下会出现 `zz` → `ZZ`（一个字符的大小写），同步 `WM_CHAR` 不会。这是应用的输入后处理，本包不声称能控制它——所以打完仍然要看变化信封/截图。
- **Win11 记事本的 `WM_GETTEXT`/`WM_SETTEXT`/`WM_GETTEXTLENGTH` 不可用**：把字面串写进去再读回来，尾部会多出乱码（`豀刘Ĳ`），长度也对不上。唯一可靠的读回是 `EM_SETSEL`+`WM_COPY`+剪贴板（测试用的就是这个）或存盘文件。**任何拿 `WM_GETTEXT` 量这个控件的行为都会得到假结论**——本轮第一次测量就栽在这里。
- **噪声地板看不到慢周期动画**。基线是连拍两帧，周期约 530 ms 的光标闪烁采样不到；实测一次"什么都没干的 Shift 按键"读到 0.04–0.06 %，高于当次基线推出的判定线。`no-observable-change` 是**证据**而不是证明：还要配一张截图。窗口标题的"已修改"星号、悬停动画同理。
- **一次动作 3 次抓屏**（第一帧、基线帧、结果帧）是刻意的：两次抓屏量不出噪声，一次抓屏没法判断变化。

## 自检与安装（安装器调用）

```
uv build                                        # 产 wheel
python scripts/build-wheel.ps1                  # 同上 + 打印 sha256，供发版时贴进安装器常量
computeruse --selftest                          # 打印版本 / dpi_aware / 虚拟屏幕，dpi 未就绪则 exit 1
computeruse --selftest --capture-probe --json    # 再加一次抓屏的 sha1
computeruse --budget 200                        # MCP stdio 服务（宿主启动用）
```

`--selftest` 不碰鼠标键盘，不产生审计行。

## 撤销

1. `uv tool uninstall computeruse`
2. 删掉配置里 `mcp.servers.computeruse`（或 `mcp.computeruse`）那一段
3. 删掉 `%LOCALAPPDATA%\te-river\computeruse`

删掉 `uv` 本身会让 MCP 起不来，而宿主只会报超时——重跑安装器的 `-ComputerUse` 即可。

# OpenCode 2.x 上「agent 之间能不能自由交换数据」—— 活体取证 + 与黑板策略的对比

问题：**OpenCode 2.x 是否允许各个 agent 之间自由交换数据？** 允许的话，与我们现有的"黑板"策略相比哪个更优、优在哪几方面。

取证环境：桌面版 2.0.16（宿主自带 CLI `resources/opencode-cli.exe --version` = `opencode v2.0.16`），内嵌 Node 26.3.0。
取证纪律（全部遵守）：只用自建临时配置目录（`OPENCODE_CONFIG_DIR=<临时目录>/config`，实测被 `run --standalone` 采纳——把 provider 定义挪走后会报 `Model unavailable`），没有写用户的全局配置，没有跑 `scripts/install.*`，没有改 OpenCode 本体；探针插件放在临时目录里，导出 `{id, setup}` 双人格形状；`TM_STORE_RECLAIM=off`；临时 workspace 的 `TMPDIR/TEMP/TMP` 全部指向沙箱。记录里只出现名字/形状/计数/哈希，不出现用户路径、URL、命令行、环境变量值、会话正文。
残留清理已核验：探针期间产生的 18 条会话用 `opencode session delete --standalone` 全部删除（`session_v2 WHERE directory LIKE '%<沙箱>%'` = 0），探针写进宿主存储的 7 个键用 `ctx.storage.remove` 自己删干净（`kv` 表中探针键 = 0），探针文件与插件包随后删除。

---

## 一、直接答案

**允许，而且不止一条路 —— 2.x 官方就有跨会话的数据面，插件侧不需要任何越权动作。** 具体三条彼此独立的通路（都测到了）：

1. **`ctx.session.synthetic({sessionID, text})`** —— 往**任意一个别的会话**投一条 synthetic 消息。实测返回 `{id, sessionID, type:"synthetic", delivery:"steer", payload:{text}, time:{created}}`，随后目标会话的 `session.hook("context")` 里**我们的探针标记确实出现在它的消息中**（`msgsN:2, tokenInCtx:true`，agent 是 `general`），并且宿主发出 `session.inbox.enqueued` → `session.inbox.delivered` → `session.step.started`，也就是那条文本被当成一次真活跑了。**没有触发任何 `permission.evaluate`，没有弹窗。**
2. **`ctx.session.prompt({sessionID, text, files, agents, skills})`** —— 同一个队列的"派活"入口（我们的调用在 1.5 s 内没结算，但后续事件说明它入队并执行了）。底层就是宿主的 **`session_inbox`** 表：`{id, session_id, type, payload, delivery, enqueued_seq, time_created}`，REST 面还有 `session.inbox.list` = `GET /api/session/:sessionID/inbox`（"List durable enqueued session work not yet delivered, ordered by enqueue sequence"）和 `session.inbox.cancel`。**这是一个 durable、有序、按会话投递的官方消息队列 —— 就是"agent 之间交换数据"的官方答案。**
3. **`ctx.storage`（宿主 kv）** —— 键空间实测**跨会话、跨 agent、跨项目全部共享**，只有**插件 id** 是隔离边界：磁盘上 `kv.key` 的真实形状是 `plugin:<utf16be(插件id)>:<你的键>`，表里**没有任何 location/project/session 列**。同一个插件 id 在**不同进程**里读得到彼此写的值（跨 441 s、pid 25524 → 28492 读回成功）；换一个插件 id 就 `scan` 不到（xch2/xch3 的键对 probe-xch4 完全不可见）。

另外两条"半通路"：**`subagent` 工具**（父拿子的返回，信封形状见下表）和 **`ctx.event.subscribe()`**（实测是**全服务器**的事件流，一次订阅里看到了 ≥3 个不同 session 的事件，没有作用域过滤）。

**但"能自由交换"不等于"该拿它当交付信道"。** 这几条路在六个维度上各有硬伤（见第四节），而且第 1、3 条恰恰踩在产品目标 6 上：**注入进去的文本以 user 角色进目标会话的上下文，宿主既不评估权限也不告诉我们它是谁写的** —— 一个不评估、不留痕、不可核对的通道，不能当团队的正式信道。

---

## 二、信道表

图例：✅ 实测可用（本次活体）／◐ 部分可用或只测到表面／❓ 证据不足／✋ 不可用（未观测到该面）。
"谁能拒"= 这条通路上真正存在的拒绝点，不是"理论上应该有"。

| # | 信道 | 可用性 | 证据（调用点 → 返回形状） | 谁能拒 | 生命周期 / 回收 | 正文会不会灌进上下文 |
|---|---|---|---|---|---|---|
| 0 | **黑板文件（`tm_board_write`，现状基线）** | ✅（我们自己的实现，`src/tm/board.ts`） | 回复只含**绝对路径 + 字节数 + 作者角色 + 轮次**，正文不回传；`board_write` 轨迹行带 bytes | **只有我们的代码**：realpath 必须落在 board root 内、永远 `.md`、不覆盖（撞名回"同一轮的并发写入"）、`TM_BOARD_MAX_CHARS` 200 000 / 每会话 200 文件 / 40 任务；**宿主完全不参与**（`node:fs` 直写，`permission.evaluate` 一条都没评估到它） | `<repo>/.git/opencode-team/<session-key>/<task>/NN-<role>-<topic>[-rN].md`，不进工作树不进 commit；非 git 落 tmpdir **按 workspace 分片**；TTL 默认 **5 天**，启动 + 每小时扫；另有分片回收与升级遗留桶回收 | **不会**（这是它存在的全部理由；代价见 §三） |
| 1 | 父 ← 子：`subagent` 工具返回值 | ✅ 工具存在（实测在 `build` 的请求面上，`general` 面上没有）；信封 ◐ 今天未复测 | `session.hook("context").tools` 里 build 12 个（含 `subagent`/`question`），general 10 个（无 `subagent`）；信封形状沿用先前测量：2.0.16 是 `<subagent sessionID="…" state="completed">`，v1 的 `<task id=` 在该二进制里 **0 次出现** | 宿主 `subagent` 权限动作（先前实测 `permission.evaluate {action:"subagent"}`）+ 我们的矩阵（5 个专家 = deny） | 正文活在子会话历史里；`opencode session delete` 级联删子会话（帮助文本原话"Delete a session and its child sessions"） | **会**（宿主把子回复整段注入父会话）—— 所以我们用 `execute.after` 卸载它 |
| 2 | `ctx.session.create / synthetic / prompt / update / switchAgent / switchModel / interrupt / wait / command / move` | ✅ 除 `wait`/`command`/`move` 只测到入参契约外全部实测 | `create()` 裸调用就成功；`create({title,agent})` 返回体带 `agent:"general"`；返回体成员：`cost id location projectID time title tokens`（**没有 parent 字段**）；`synthetic({sessionID,text})` → `{delivery:"steer", id, payload:{text}, sessionID, time, type:"synthetic"}`；`interrupt({sessionID})` → `{interrupted}`；`update({sessionID,title})`、`switchAgent({agent,sessionID})` 均成功生效（后续读回 title/agent 已变）；`command` 需要 `{name}`；`move` 需要 `{directory}`；`wait({sessionID})` 4 s 未返回（会话在跑时会阻塞） | **什么都没拒**：整轮 `permission.hook("evaluate")` 挂着，对这些调用**一条都没触发**；也没有弹窗（v2 插件本来就抬不起官方对话框） | 写进 `session_inbox`（durable + `enqueued_seq` 有序），投递后消费；`session.inbox.cancel` 可撤；随会话生死 | **一定会** —— 这条通道的语义就是"把正文塞进别人上下文"，没有预算、没有预览、没有去重 |
| 3 | `ctx.session.get / context`（跨会话读） | ✅ get；❓ context 语义未定 | `get({sessionID})` → 只有 Session.Info（`cost id location projectID time title tokens`，**无消息**）；`context({sessionID})` 返回**数组**：空闲会话 = 0 项，注入之后 = 2 项、再到 6 项，项的成员不是 `{role,content}`（roles 读不出来），**没有 `messages`/`log`/`children`/`list`/`todo` 这些方法**（逐个试出来都是 absent） | 无评估（同上） | 读的是宿主存储，会话删了就没 | 读回来的东西进**我们自己工具**的上下文，不经宿主 —— 也就是说**只有我们 govern 它才不会灌**（v2 上 `tm_*` 之外没有第二道闸） |
| 4 | `ctx.storage`（kv） | ✅ | `get/set/remove` 全部工作；`scan` **必须带 `{prefix}`**（`{limit}`、裸对象、字符串参数一律回 0 项 —— 所以插件枚举不了宿主整个命名空间）；条目形状 `{key, value}` —— **scan 直接把值带回来**；跨进程持久（同一插件 id、不同 pid 读得回） | 无评估；隔离只有**插件 id**一层（磁盘键 `plugin:<hex(id)>:<key>`） | **没有任何 TTL/配额/回收**（观测 10 行，`time_updated` 只是记录不是过期）；卸载插件后行还留在 `opencode.db` 里（我们自己的 `team-mode/selfcheck` 就是这个状态） | 不会自动进 —— 但 `set/get` 的正文要经模型参数/返回值，等价于工具层；**`scan` 是一次性把所有 value 拉进来的批量危险面** |
| 5 | 宿主原生 `read`/`write`/`grep` 当共享面 | ✅ 面上存在（沙箱无 deny 时全给） | build 的请求面实测 12 个工具：`edit execute glob grep question read shell skill subagent webfetch websearch write`；general 10 个（少 `question`/`subagent`） | 宿主 `edit`（写+改）/`read,glob,grep`（本地发现）/`shell` 规则；**越出项目目录 = `external_directory`**，先前实测 `effect:"ask"` + 真 `permission.asked`（今天未复测） | 文件留在用户工作树里 —— 谁写谁负责删，**没有自动回收**，`git status` 看得见 | `read` 的结果**进上下文**（v2 上我们的 `execute.after` 才把它卸载）；`write` 的正文由模型自己吐出来，**写侧 token 一分不省** |
| 6 | 事件流 `ctx.event.subscribe()` | ✅ | 是 Promise 版插件 API 上的 **async iterable**（**不需要 Effect 运行时，不需要新增依赖** —— 本包 dependencies 仍为空）；观测到的类型：`session.inbox.enqueued/delivered`、`session.execution.started/succeeded/failed`、`session.step.started/failed`、`session.retry.scheduled`、`session.instructions.updated`、`integration/model/provider/agent/command/skill/websearch/reference/plugin.updated`、`project.updated`、`models-dev.refreshed` | 无评估，无过滤入参（我们没找到按会话订阅的方式） | 一次订阅只覆盖一个进程；磁盘上有 `event` 表（`id aggregate_id seq type data created`），但插件面**没有回放**入口 | 事件载荷成员：`inboxID item sessionID assistantMessageID error delta …` —— `item` 是否带正文 **未测**（本轮 logger 只记名字） |
| 7 | 官方共享对象：`reference` / `vcs` / `worktree` / `app` / `mcp` / `integration` / `skill` / `command` / `plugin` / `resource` / `experimental.terminal` / `generate` / `rpc` | ◐ 逐个探到面 | 成员实测：`reference{list,reload,transform}`、`vcs{base,branch,diff,get,reload,status,transform}`（`status` → `{data:[],location}`，`diff` 需要 `{mode}`）、`worktree{create,list,refresh,remove,reload,transform}`（`list` 需要 `{projectID}`）、`mcp{list}`、`integration{list,…}`（226 条）、`command{list}`(2)、`skill{list}`(2，条目含 `content description id name path`)、`plugin{list}`、`app{channel,name,version}` = 2.0.16、`location{directory,project{canonical,directory,id},workspaceID}`、`generate{text}`、`experimental.terminal{read}`（`read({sessionID})` → `null`）、`rpc`（函数 + `.register`）；**`ctx.resource` 不存在** | 这些都是**只读注册表 / 定义面**（reference、skill、command、mcp、integration 都是 `list + transform(editor)`）—— 没有任何一个是 KV；能当"共享对象"用的只有 **`worktree`**（`worktree{project_id,directory,strategy}` 表 = 官方多目录机制）和 **vcs/diff**（观察工作树变更，是读取而非传递） | 随配置/项目 | 注册表类**不会**（除非我们把内容读进上下文）；`worktree` 是**隔离**手段，不是交换手段 |
| 8 | `todo`（宿主表） | ❓ 表存在，面不存在 | `opencode.db` 里有 `todo(session_id content status priority position …)`；但 `ctx.session` **没有** todo/messages/children 方法，REST 操作清单（从二进制里读的 `ao("<operationId>","/api/…")` 全集）里**没有 todo 操作**，模型面上也没有 `todowrite` | —— | —— | 这就是 #16 的现状：宿主的账本存储在那里，**插件拿不到**，所以 `tm_ledger` 只能用 kv |

---

## 三、对照组：黑板策略的具体代价（要换就得先还这笔账）

| 项 | 实测/实测来源 | 数值 |
|---|---|---|
| 黑板说明（`blackboardNote`）每次请求进 **领队** 的 system | `dist/host/note.js` + 本包 `estimateTokens` | **1 184 字符 / 296 token**，且 `v2.ts:474` `noteAgents:["team"]` —— 只有领队拿，专家靠领队派发时把会话文件夹带下去 |
| `tm_board_write` 的定义体 | `dist/tm/board.js` + `estimateTokens` | **1 278 字符 / 320 token**（v2 目录模式只露名字，`TM_V2_CODEMODE=direct` 才整段进） |
| 写侧 token | 结构决定 | **省不掉**：正文必须由模型作为 `content` 参数产出一次 —— 黑板省的是**读侧**（路径回传 + 读取经 offload） |
| 交付物落盘 | `src/tm/board.ts:297-303` | 文件头带 `<!-- tm_board_write · ISO · role= · session= -->`，回复只给 `路径 + bytes + 轮次 + 作者角色` |
| 治理约束 | 同上 | realpath 必须在 root 内（符号链接目录**写入前**再核验一次）、永远 `.md`、绝不覆盖（修订是 `-rN` 新文件，轮次历史留在文件名里）、作者角色取宿主 `ctx.agent` 不取模型自报、原子 tmp+rename |
| 回收 | `src/blackboard.ts:176-188` + `sweepStale` | 唯一回收路径 = TTL（默认 5 天）+ 启动扫 + 每小时扫；`v2` 也补上了这个 sweeper（注释原话：note 承诺了清扫却不带机制就是本产品在拒绝的那种夸大） |
| 残留位置 | 同上 | git 工作区：`<repo>/.git/opencode-team/`（不进 commit）；非 git：`<tmpdir>/opencode-team/w-<sha256(path)>` 分片 + 分片回收 + 升级遗留桶回收；`TM_STORE_RECLAIM=off` 关掉 |
| 用户可核对性 | `src/tm/stats.ts`、桌面渲染层取证 | 插件工具在桌面里是**一行、点不开**（渲染器只注册 14 个内置名，`GenericTool` 从不读 `props.output`）—— 所以细节走盘：`tm_stats {recent:N}` 把 `tm_fetch` 句柄 **和 payload 绝对路径**一起打出来；黑板文件本身是用户能用编辑器直接打开的 `.md` |
| 团队正式信道 | `src/prompts/shared.ts`（REPLY_CONTRACT） | STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF 骨架是**主传输**，黑板只服务 >~50 行的超大交付 —— 也就是"混合"不是备选，是现状 |

---

## 四、对比结论：黑板 vs 每个可行信道（六维）

打分口径：**优 / 中 / 差**，只看这条信道相对"作为团队的交付信道"的表现。

| 维度 | 0 黑板（基线） | 2 session_inbox / synthetic | 4 ctx.storage | 5 原生 write/read | 1 subagent 信封 | 6 事件流 |
|---|---|---|---|---|---|---|
| **token 成本** | **优**：正文不进上下文；固定成本 = 领队 296 token/请求 + 目录按需 | **差**：正文按设计进目标上下文，无预算/无预览 | **中**：不进上下文，但读回时同样要靠我们自己卸载；`scan` 会把所有 value 一次拉进来 | **中**：写侧和黑板一样要模型产出；读侧 `read` 默认整段进（靠我们的 `execute.after` 才不外溢） | **差→中**：宿主整段注入（这是我们花两套 offload 去补的那个洞） | **中**：类型名便宜，载荷成员未知 |
| **可核对性（用户能否点开看到）** | **优**：回复里是绝对路径，`.md` 能用任何编辑器打开；轨迹有 bytes/role/session | 差：队列在宿主存储里，桌面没有"某会话待办箱"入口（未见，未证） | **最差**：`opencode.db` 的一个 blob，用户既打不开也不会去开 | **优**：工作树里的真文件，`git status`/侧栏都看得见 | **优**：task 卡片直连子会话，是**唯一**用户能点开的子代理形态 | 差：瞬时；`event` 表在盘上但没有 UI |
| **并发安全** | **优**：绝不覆盖 + `NN` 序数 + `-rN` 家族 + 原子 rename；撞名显式拒绝并说明是"同一轮的并发写入" | **优**：durable 队列 + `enqueued_seq` 有序 + `delivery` 语义 —— 这是全场最好的写并发模型（追加，不是覆盖） | **差**：`set` 是无条件覆盖，无 CAS/版本；键还全局共享 → 两个窗口互相盖章已经在我们的 `selfcheck` 键上真实发生 | **差**：last-writer-wins，无 ordinals | 中：一次派发一个子会话，天然不撞 | 中：只读不写 |
| **生命周期 / 卸载残留** | **优（唯一带机制的）**：TTL 清扫 + 分片回收 + 遗留桶回收，且落在 `.git` 下不污染 commit | **优**：随会话删除级联清理（`session delete` 的既有语义） | **差**：**零回收**（没有 TTL、没有配额、`scan` 都不给全量），卸载插件后键还在 | **差**：写在用户工作树里，删不删全看模型自觉（原则 8 就是为这个存在的） | 中：随会话；会话本身没人删就留着 | 中：磁盘 `event` 表由宿主管 |
| **权限与红线** | **中**：门禁全在我们代码里（realpath/.md/上限），**宿主一次都不评估** —— 好处是不依赖 v2 缺失的官方弹窗，坏处是"越出黑板"这件事没有第二道闸 | **差（要看清）**：**没有任何评估、没有弹窗、没有来源标注** —— 谁都能往任何会话注一条 user 角色文本；把它当正式信道 = 把团队的握手协议架在一个不可问责的入口上 | **中**：按插件 id 隔离（实测换 id 就读不到），但对 agent/session/project **零隔离** —— 我们必须在键里自己写作用域 | **优**：这是唯一一条有真宿主权限的信道（`edit`/`read` 规则 + `external_directory` 的 `effect:"ask"` + 宿主自己抬的 `permission.asked`） | **优**：`subagent` 有权限动作，宿主有 kill switch、有卡片 —— 这正是 v1 删掉 `tm_dispatch` 的理由 | 中：只读面，红线不在它身上 |
| **宿主升级脆弱度** | **低-中**：只依赖 `node:fs` + 我们的工具注册；唯一外部接缝是 `session.hook("context")` 推 note（v1→v2 已经换过一次写法） | **中**：类型化 API 调用（不是解析字符串），但 `synthetic/prompt/inbox` 都是 v2 新面，无稳定性承诺 | **低-中**：`get/set/remove/scan` 有文档；**"按插件 id 命名空间"和"全局共享"是从磁盘形状看出来的，没写在任何文档上** | **最低**：宿主自己的工具与权限动作 | **最高（我们已经吃过一次）**：信封字符串 1.18=`<task id=` ↔ 2.0.16=`<subagent sessionID=`，v1 的匹配器在 v2 上是**结构性死码**，而 `task_envelopes:0` 一度被当成"没有超大回复" | **中-高**：事件名在两代之间整批改过（v1 `session.idle/status/error` ↔ 实测 v2 `session.execution.*/step.*/inbox.*/retry.scheduled`；今天**没有看到一次 `session.idle`**） |

**判决：混合，不换基线。**

1. **超大交付物继续走黑板，不改。** 它是六维里唯一在"不进上下文 + 用户可点开 + 有自动回收 + 有写并发协议"四项同时拿优的信道；`ctx.storage` 在可核对性和回收上直接归零，原生 `write` 在并发与残留上归零，inbox/信封在 token 上归零。宿主没给我们一个能替代它的东西。
2. **`session_inbox` / `ctx.session.synthetic` 应该吸收，但只吸收"信号"，不吸收"正文"。** 它在我们最弱的一维（并发安全：追加 + `enqueued_seq` 有序 + `delivery` + `cancel`）严格优于现状 —— 现状是**解析文本信封 + 靠标题里的 ` ·tm` 标记认领子会话**（`src/tm/dispatch.ts` 的 `parseDispatchTitle` / `claimNamedChild` / `adoptFromHost`），那是全场最脆的东西（信封已经变过一次代）。把"谁结算了 / 下一棒是谁 / 这轮没等到全部结算"这类**短结构化信号**搬到官方队列上，能直接废掉一整套字符串匹配；而正文仍旧走路径。
3. **搬的时候必须自带三样东西**（因为宿主一样都没给）：**(a) 长度上限**（synthetic 载荷要过我们自己的 offload 阈值，超了改投路径 + 句柄）；**(b) 来源标注**（收到的一侧要在回复里写明"这段来自插件注入的 synthetic 消息，不是用户写的"——目标 6：一条注入进去的 `delivery:"steer"` 文本会以 user 角色被模型相信，这就是它不能当正式信道的全部理由）；**(c) 轨迹账**（每一次写都记 `session_inbox` id + 目标会话哈希，否则"我通知过他了"又变成一个不可核对的已确认关闭）。
4. **`ctx.storage` 保持"索引/账本"角色（`tm_ledger` 已经是），但两个必修**：键必须自带作用域（实测它是**全局**的：`plugin:<id>:<key>`，没有 location 列 —— 我们今天的 `team-mode/selfcheck` 已经在两个窗口之间互相覆盖），并且**要我们自己写配额 + 启动清扫**（宿主一条都没有）。`scan` 在任何面向模型的封装里都必须只回键名，绝不把 `value` 原样端出去。
5. **`ctx.event.subscribe()` 只当结算探测器**（替掉 `tm_join` 里的 `session.status` 轮询），类型名走**白名单 + "没见过这个类型就上报"的活扣** —— 事件名整代换过，这是数据不是猜想。它不需要 Effect、不需要依赖，成本可以接受。
6. **不要用原生 `write` 写交付物**（污染工作树 + 无回收），**不要把任何同意/红线搬到 synthetic 上**（它不评估权限，v2 插件也抬不起对话框 —— 与 AGENTS"Goal 5 在 v2 不存在"一致）。

若要实施（本报告不实施），要动的模块：
`src/host/v2-inbox.ts`（新增：带长度闸 + 来源标注 + 轨迹的 synthetic 写入）·
`src/tm/dispatch.ts`（`tm_join` 结算改吃 `session_inbox` + 事件；`parseDispatchTitle`/`adoptFromHost` 降级为 v1 路径）·
`src/task-offload.ts` + `src/host/v2-offload.ts`（信封匹配从"唯一机制"降为"兜底"）·
`src/tm/ledger.ts`（键作用域 + 配额 + 启动清扫；`scan` 输出剥 `value`）·
`src/host/v2.ts`（`team-mode/selfcheck` 键加会话/项目作用域）·
`src/host/note.ts`（note 增写信号信道 + "synthetic ≠ 用户"这一句）·
`src/capabilities.ts` + `src/host/v2-probe.ts`（把 `session.synthetic`、事件类型集、kv 往返加进能力账）·
`src/agents.ts`/`src/prompts/*` + `test-blackboard.mjs`（新提示词规则配新断言）·
`test-v2-adapter.mjs` + `scripts/lib/fake-ctx.mjs`（`ctx.session` 需要真实形状的宿主替身：现在这个域在 fake 里是空的）。

---

## 五、证据不足项（下次补，别再当已知）

1. **`subagent` 返回信封今天没复测**：模型层整天不通（`lxns-uni/zai-org/GLM-5.3#max` 与 `lxns-maiden/...` 都是 `Transport: socket closed`，第三个 provider 明确回 `Invalid API-key provided`）。表里那一行沿用先前对 2.0.16 二进制的只读测量，**不是今天的活体**。
2. **`ctx.session.context({sessionID})` 到底是不是"读全量历史"**：空闲会话回 `[]`、注入后回 2 项、再回 6 项，但项的形状不是 `{role,content}`（role 读不出来），我**没解开它的项结构**，所以既不能说它是全量历史也不能说它不是。父读子完整历史这个问题因此**仍未结**。
3. **事件载荷 `item` 里有没有正文**：本轮 logger 只记成员名（隐私口径要求），`session.inbox.enqueued{inboxID,item,sessionID}` 的 `item` 内容未看。
4. **`external_directory` 今天的实测行为**：只有先前一轮的 `effect:"ask"` + `permission.asked`，今天没有成功跑出一个原生读。
5. **kv 的"全局"是从磁盘形状（`kv` 无 location 列 + 键前缀只有 plugin id）推出来的**，不是从一个项目在另一个项目里显式读成功 —— 差一次"两个 workspace、同一插件 id、A 写 B 读"的正向确认。
6. **`experimental.terminal.read({sessionID})`** 只证明它接受 `{sessionID}` 并回 `null`（沙箱里没有终端）；它是否能读**别人的**终端输出（`/api/experimental/session/:sessionID/terminal/read` 的存在暗示可以）未证。
7. **`todo` 表有没有任何 agent/插件可达面**：表在，`ctx.session` 无 todo 方法，REST 操作全集（二进制里 `ao("…","/api/…")`）里没有 todo 操作 —— 所以 #16 的现状是"宿自有账本、插件拿不到"，但没有穷尽其它入口（比如 MCP 面）。
8. **真 `subagent` 子会话的 `session_v2.parent_id` 是否被写入**：我只看到自己 `create()` 出来的会话 `parent_id` 为空（且返回体根本不暴露该字段），没有一次成功的宿主派发去对照。
9. **`worktree.create/remove` 是否被权限评估**、以及它能不能当作"每 agent 一个目录"的隔离面 —— 只测到 `list` 需要 `{projectID}`。
10. **MCP resource**：`ctx.resource` 不存在；`mcp` 域只有 `list/reload/transform`。宿主是否有别的路径暴露 MCP 资源未查（REST 里有 `mcp.resource.catalog` = `GET /api/mcp/resource`，但插件面没对上它）。
11. **插件级项目自动发现**：把探针放进 `<workspace>/.opencode/plugins/*.mjs` **没有被加载**（跑了三轮没一条日志；最后是用 `plugins:["file:///<目录>"]` 装进临时配置目录才生效）—— 文档说的"自动发现目录"这条在 2.0.16 的这个布局下**没复现**，值得单独确认（可能要求目录里就是一个包）。

---

## 六、本次取证用到的原始形状（供复现，全部只含名字/计数）

- `ctx` 的域（实测成员）：`agent aisdk app command event experimental generate integration location mcp model options permission plugin provider reference rpc session shell skill storage tool vcs websearch worktree`（**无 `resource`**，无 `ask`）。
- `ctx.session` 方法：`command context create generate get hook interrupt move prompt switchAgent switchModel synthetic update wait`。
- `session.hook("context")` 的事件成员：`agent messages model options sessionID system tools`；其中 `messages[i]` = `{content, id, metadata, role}`，`content` 是**数组**（不是 v1 的 parts 数组）；`build` 面上 12 工具、`general` 面上 10 工具（`question`/`subagent` 只在 primary 上）。
- 宿主 `opencode.db` 表名（`PRAGMA table_info` 只读）：`kv(key,value,time_created,time_updated)`、`session_inbox(id,session_id,type,payload,delivery,enqueued_seq,time_created)`、`session_v2(id,project_id,workspace_id,parent_id,fork_session_id,fork_boundary,slug,directory,path,title,version,share_url,summary_*,metadata,cost,tokens_*,revert,permission,agent,model,time_*,idle_outcome)`、`message(id,session_id,…)`、`todo(session_id,content,status,priority,position,…)`、`instruction_entry(session_id,key,value,removed,…)`、`worktree(project_id,directory,strategy,…)`、`event(id,aggregate_id,seq,type,data,created)`。
- REST 操作全集里与本问题相关的读取面（从二进制 `ao("<op>","/api/…")` 表读出，操作名 + 路径，无内容）：`session.get /api/session/:sessionID`、`session.context /api/session/:sessionID/context`、`session.messages /api/session/:sessionID/message`、`session.message /api/session/:sessionID/message/:messageID`、`session.inbox.list /api/session/:sessionID/inbox`、`session.diff /api/session/:sessionID/diff`、`session.export /api/experimental/session/:sessionID/export`、`session.log /api/experimental/session/:sessionID/log`、`event.subscribe /api/event`、`fs.read /api/fs/read/*`、`fs.find fs.list`、`persistentPty.read /api/experimental/session/:sessionID/terminal/read`、`mcp.resource.catalog /api/mcp/resource`、`session.active session.list permission.request.list permission.saved.list`。**清单里没有 todo 操作。**

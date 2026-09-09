# PT-07 基线外跑交接包（执行方：GLM 5.3-Flash）

## 0. 环境前提（破坏任何一条，测出的数字就无效）

1. **环境一致性（2026-09-09 修订）**：基线与复测必须**同一配置**，两种有效模式：(a) 纯净环境（不装本插件）；(b) 装有插件的 team agent——tm_* 注册但**不得调用**（调用即作废）。首次 GLM 基线实际采用模式 (b)：零 tm_* 调用、R6 拦截 6 次全部被正确绕行，已采纳为 **v1 基线**；复测必须沿用模式 (b) + 同一模型。
2. **工作目录**：`D:\Github\Opencode-TeamMode\pt07\workspace`（agent 需有文件读写 + shell 能力，且能写该目录）。
3. **每题全新会话**：一道题一个干净上下文，不接续、不引用上一题。
4. **每题跑前重置夹具**（在仓库根执行）：`node pt07\generate.mjs`（幂等、字节级一致）——t05/t06 会改文件，t03/t04/t07 会写答案文件，不重置会串题。
5. 复测（tm_* 启用态）必须用**同一模型**（GLM 5.3-Flash）+ 同一套题，否则 A/B 不可比。

## 1. 单题协议

```
① 仓库根：node pt07\generate.mjs
② 开新会话 → 只粘贴第 2 节中该题代码块（别把本文件其他部分喂给 agent）
③ 跑完判分（仓库根）：
   依赖回复文本的题（t01/t02/t08）：把 agent 最终回复存成 txt，然后
     node pt07\judge.mjs --task <id> --reply-file <那个txt>
   看文件产物的题（t03~t07）：
     node pt07\judge.mjs --task <id>
④ 记录：PASS/FAIL + agent 自报步数/工具调用数（有 token 统计顺手记：in/out/cache）
```

判分器输出 PASS/FAIL + 逐条证据（FAIL 时打印期望值与实得值，不用人工对答案）。

## 2. 八个任务提示词（逐块粘贴，保持原文）

### t01-read-codeqa（read 主导）
```
Read these files in the workspace: src/config.js, src/pricing.js and src/inventory.js. Answer three questions. 1) What is the exact numeric value of the TAX_RATE constant in src/config.js? 2) What is the exact numeric value of the SHIPPING_FLAT_FEE constant in src/config.js? 3) Which file exports the round2 helper used by applyCoupon in src/pricing.js? Reply with exactly three lines and nothing else:
PT07_ANSWER_TAX: <value>
PT07_ANSWER_SHIPPING: <value>
PT07_ANSWER_ROUND2_FILE: <file path>
```

### t02-grep-locate（grep 主导）
```
Search the source code under src/ for every TODO(pt07) marker comment. Reply with one line per marker in exactly this format, using the path relative to the workspace root and the correct 1-based line number:
PT07_TODO <path>:<line>
List all markers. Nothing else in the reply.
```

### t03-bash-logagg（bash 主导·日志）
```
Use the shell to count how many lines in logs/app-2026-09-01.log contain the exact string 'ERROR [payment] timeout'. Compute the count with a shell command (grep, findstr or Select-String); do not count manually by reading the whole file. Then write exactly one integer - the count - into the file answers/t03.txt (no other text in the file). Do not modify anything under logs/.
```

### t04-bash-csvagg（bash 主导·CSV）
```
Use the shell to analyze data/orders.csv (columns: order_id,status,region,total). Count the rows whose status is delivered AND whose region is west. Compute the count with a shell command; do not count manually. Then write exactly one integer - the count - into the file answers/t04.txt (no other text in the file). Do not modify data/orders.csv.
```

### t05-write-feature（write/edit 主导）
```
Implement a new exported function applyBulkDiscount(cart, rules) in src/pricing.js. Contract: cart is an array of {price: number, qty: number}; rules is an array of {minQty: number, percentOff: number}. totalQty is the sum of qty. Eligible rules are those with minQty <= totalQty; among eligible rules pick the one with the largest minQty, breaking ties by the largest percentOff; if no rule is eligible the percent is 0. subtotal is the sum of price*qty. discount = subtotal * percent / 100. total = subtotal - discount. Return an object {subtotal, discount, total} with every value rounded to 2 decimals using Number(x.toFixed(2)). Do not modify any existing function or export. Add the function to the module.exports.
```

### t06-mixed-refactor（混合·多文件）
```
Rename the function normalizeRegionCode to canonicalRegion everywhere it is defined or used under src/ (definition, imports, call sites). The exported behavior must stay identical: same aliases, same 'unknown' fallback. Update src/utils/format.js, src/utils/validate.js and src/report.js as needed. After renaming, verify by running a quick node check that regionRevenue still returns correct sums, e.g. orders with regions 'NORTH', 'west', 'south' and totals 100, 250, 50 must give regionRevenue(orders, 'north') = 100 and regionRevenue(orders, 'west') = 250. When done, reply with one line:
PT07_RENAME_DONE <number of files changed>
```

### t07-task-orchestration（task 编排）
```
This is a two-step task. Step 1: analyze data/orders.csv (columns: order_id,status,region,total) to determine which region (north, south, east or west) has the highest total revenue from delivered orders only - that is, rows with status delivered, summed over the total column. Step 2: delegate the file creation to a subagent with the task tool. Instruct the subagent to create the file answers/t07.md containing exactly two lines: 'region: <winning region>' and 'revenue: <winning revenue>' where the revenue is the delivered total for that region rounded to 2 decimals. After the subagent finishes, read answers/t07.md yourself and fix the file if the subagent got it wrong. Finish by replying with one line:
PT07_ORCHESTRATION_DONE region=<region> revenue=<revenue>
```
注：若执行环境没有子代理/task 工具，t07 仍照判（答案文件正确即 PASS；"委派证据"在外部跑法下为非阻塞备注项）。

### t08-read-logqa（read 主导·日志问答）
```
Read logs/app-2026-09-02.log and determine which hour of the day (00-23, the two-digit hour from the timestamp) contains the most lines whose level is ERROR. Determine the answer from the log content itself; do not modify the file. Reply with exactly one line and nothing else:
PT07_ANSWER_PEAK: <hour as two digits>
```

## 3. 预期步数带（用于异常识别：过短可能抄了近路，过长可能绕了远路）

| 任务 | 预期步数 | 任务 | 预期步数 |
|---|---|---|---|
| t01 | 5–10 | t05 | 6–15 |
| t02 | 5–10 | t06 | 6–18 |
| t03 | 5–10 | t07 | 8–20 |
| t04 | 5–12 | t08 | 5–9 |

## 4. 结果回报格式（回填给 TeamMode 侧汇总）

每题一行：`<id> | PASS/FAIL | 步数 | 工具调用数 | tokens(in/out/cacheRead/cacheWrite，如可获得) | 备注`

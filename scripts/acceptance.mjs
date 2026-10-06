#!/usr/bin/env node
/**
 * scripts/acceptance.mjs — 真机验收固化脚本（清单 #59，2026-10-06）
 *
 * 过去两轮真机验证（清单 #34）抓出的两条"代码看着对、真机不对"的缺陷
 * （R6 默认 off、grep 绕过 env-FILE 红线）每次靠代理现场发现。这个脚本把它们
 * 固化成 1.7.0 发布前一键复跑的检查。
 *
 * 形态：
 *   - 把工作树复制到 <TEMP>/opencode/acceptance/vendor/team-mode（排除 .git / node_modules），
 *     用 opencode-cli.exe 对**副本**做零 token 的 boot 探针（--model nope/nope --print-logs）。
 *   - A 组（装载 / v2-boot / 插件选项形状 / 角色可见性 / 分层配置）与 C 组（R6 默认 armed、
 *     grep/glob 不绕 env-FILE）默认跑，零 token。
 *   - B 组（早压缩 / JIT 卸载 / usage 事件 / permission.evaluate 动作集）需要真回合，
 *     用 --turns 开启（默认跳过以省配额）。
 *
 * 用法：
 *   node scripts/acceptance.mjs            # A + C（零 token）
 *   node scripts/acceptance.mjs --turns    # 追加 B（真回合，消耗配额）
 *   node scripts/acceptance.mjs --keep     # 保留沙箱目录（调试）
 *
 * 退出码：任一 FAIL → 1；全 PASS/SKIP → 0。
 *
 * 沙箱隔离：OPENCODE_CONFIG_DIR / TMP / TEMP / TMPDIR / HOME / USERPROFILE 全部指向
 * <TEMP>/opencode/acceptance，TM_STORE_RECLAIM=off；绝不碰用户的 ~/.config/opencode。
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const TURNS = argv.includes("--turns")
const KEEP = argv.includes("--keep")
const MODEL = process.env.TM_ACCEPTANCE_MODEL || "lxns-uni/zai-org/GLM-5.3#max"

function findCli() {
  const cands = [
    process.env.OPENCODE_CLI,
    "C:\\Users\\34296\\AppData\\Local\\Programs\\@opencode-aidesktop\\resources\\opencode-cli.exe",
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "@opencode-aidesktop", "resources", "opencode-cli.exe")
      : null,
  ].filter(Boolean)
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      /* keep looking */
    }
  }
  return "opencode"
}
const CLI = findCli()

const BASE = path.join(os.tmpdir(), "opencode", "acceptance")
const COPY = path.join(BASE, "vendor", "team-mode")
const TMP = path.join(BASE, "tmp")
const HOME = path.join(BASE, "home")

const results = []
const record = (id, title, status, evidence) => results.push({ id, title, status, evidence })

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* best effort */
  }
}

function copyTree() {
  const EXCLUDE = new Set([".git", "node_modules"])
  fs.cpSync(REPO, COPY, { recursive: true, filter: (src) => !EXCLUDE.has(path.basename(src)) })
}

/** The sandbox env every CLI child gets.  `extra` overrides (e.g. a different trajectory dir). */
function sandboxEnv(extra = {}) {
  fs.mkdirSync(TMP, { recursive: true })
  fs.mkdirSync(HOME, { recursive: true })
  return {
    ...process.env,
    OPENCODE_CONFIG_DIR: BASE,
    TMP,
    TEMP: TMP,
    TMPDIR: TMP,
    HOME,
    USERPROFILE: HOME,
    TM_STORE_RECLAIM: "off",
    TM_TRAJECTORY_DIR: path.join(BASE, "trajectory"),
    TM_BLACKBOARD_DIR: path.join(BASE, "blackboard"),
    TM_MEMORY_GLOBAL_DIR: path.join(BASE, "memories"),
    ...extra,
  }
}

function runProc(exe, args, { cwd, env, logFile, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    // stdin MUST be ignored: with a piped stdin the CLI's `serve --stdio` child keeps the
    // pipe open and the process never exits (measured: 90s+ hang vs 5.5s with "ignore").
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (d) => (out += String(d)))
    child.stderr.on("data", (d) => (out += String(d)))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    const done = (code, signal) => {
      clearTimeout(timer)
      if (logFile) {
        try {
          fs.writeFileSync(logFile, out)
        } catch {
          /* log is a convenience */
        }
      }
      resolve({ code, signal, out })
    }
    child.on("close", (code, signal) => done(code, signal))
    child.on("error", (e) => done(1, null))
  })
}

const runCli = (args, opts) => runProc(CLI, args, opts)

/** Read every steps.jsonl under <dir>/runs/* and return the parsed rows. */
function readTrajectory(dir) {
  const rows = []
  const runsDir = path.join(dir, "runs")
  if (!fs.existsSync(runsDir)) return rows
  for (const run of fs.readdirSync(runsDir)) {
    const f = path.join(runsDir, run, "steps.jsonl")
    if (!fs.existsSync(f)) continue
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        /* torn tail line — skip */
      }
    }
  }
  return rows
}

const bootRow = (rows) => rows.find((r) => r.step_id === "v2-boot")
const agentsRow = (rows) => rows.find((r) => r.step_id === "v2-agents")
const configRow = (rows) => rows.find((r) => r.step_id === "config-layers")

/** Write the sandbox opencode.jsonc with the 2.x plugin-options object shape. */
function writeConfig(options) {
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    plugins: [{ package: "./vendor/team-mode", options }],
  }
  fs.writeFileSync(path.join(BASE, "opencode.jsonc"), JSON.stringify(cfg, null, 2))
}

// ─────────────────────────── A 组：零 token boot 探针 ───────────────────────────

async function groupA() {
  writeConfig({ ttlDays: 9 })
  const logFile = path.join(BASE, "boot.log")
  const r = await runCli(["run", "--standalone", "--model", "nope/nope", "--print-logs", "x"], {
    cwd: REPO,
    env: sandboxEnv(),
    logFile,
  })
  const log = r.out
  const rows = readTrajectory(path.join(BASE, "trajectory"))

  // A1 插件装载：loading plugin 的 entrypoint 指向副本；无 failed to load plugin
  const loadLine = log.split(/\r?\n/).find((l) => l.includes('msg="loading plugin"'))
  const entryOk = !!loadLine && loadLine.replace(/\\/g, "/").includes("vendor/team-mode")
  const failed = log.split(/\r?\n/).find((l) => l.includes("failed to load plugin"))
  record(
    "A1",
    "插件装载（entrypoint 指向副本，无 failed to load）",
    entryOk && !failed ? "PASS" : "FAIL",
    entryOk ? `entrypoint 命中副本${failed ? ` · 但出现 failed to load: ${failed.slice(0, 120)}` : ""}` : `未找到指向副本的 loading plugin 行（exit=${r.code}）`,
  )

  // A2 v2-boot：tools_registered 的值、tools_missing 为空
  const boot = bootRow(rows)
  record(
    "A2",
    "v2-boot 行（tools_registered / tools_missing 为空）",
    boot && !String(boot.tools_missing ?? "").trim() ? "PASS" : "FAIL",
    boot ? `tools_registered=${boot.tools_registered} tools_total=${boot.tools_total} tools_missing="${boot.tools_missing}"` : "轨迹里没有 v2-boot 行",
  )

  // A3 插件选项形状：{package, options:{ttlDays:9}} → board_ttl_days=9
  record(
    "A3",
    "插件选项形状（2.x 对象 {package,options} → board_ttl_days=9）",
    boot && Number(boot.board_ttl_days) === 9 ? "PASS" : "FAIL",
    boot ? `board_ttl_days=${boot.board_ttl_days}（期望 9）` : "无 v2-boot 行",
  )

  // A4 ctx.agent.list() 只见内置角色
  const ag = agentsRow(rows)
  const missing = String(ag?.agents_missing ?? "")
  const a4ok = !!ag && Number(ag.agents_in_editor) >= 7 && missing.includes("Team") && missing.includes("architect")
  record(
    "A4",
    "ctx.agent.list() 只见内置角色（agents_in_editor / agents_missing 口径）",
    a4ok ? "PASS" : "FAIL",
    ag ? `agents_in_editor=${ag.agents_in_editor} agents_missing="${missing}"` : "无 v2-agents 行",
  )

  // A5 分层配置：项目 team-mode.jsonc 改一个可观测值 → 运行时采用；TM_CONFIG_ENV_ONLY=1 忽略
  await groupA5()
}

async function groupA5() {
  const ws = path.join(BASE, "ws-a5")
  fs.mkdirSync(ws, { recursive: true })
  const projTraj = path.join(BASE, "a5-traj")
  // trajectoryDir 是"可观测值"：项目文件把它指到别处，运行时若采用，轨迹就落在那里。
  // envProtect 是红线键：文件写了也必须被忽略，env_protect 保持 strict。
  fs.writeFileSync(
    path.join(ws, "team-mode.jsonc"),
    JSON.stringify({ trajectoryDir: projTraj.replace(/\\/g, "/"), envProtect: "off" }, null, 2),
  )

  // A5a：项目文件被采用
  const r1 = await runCli(["run", "--standalone", "--model", "nope/nope", "--print-logs", "x"], {
    cwd: ws,
    env: sandboxEnv(),
    logFile: path.join(BASE, "a5a.log"),
  })
  const rows1 = readTrajectory(projTraj)
  const cfg1 = configRow(rows1)
  const boot1 = bootRow(rows1)
  const adopted = !!cfg1 && String(cfg1.config_layers).includes("project") && Number(cfg1.config_project_files) >= 1
  const redlineHeld = !!cfg1 && String(cfg1.config_redline_ignored).includes("envProtect") && boot1?.env_protect === "strict"
  record(
    "A5a",
    "分层配置：项目 team-mode.jsonc 被采用（trajectoryDir 生效 + 红线键被拒）",
    adopted && redlineHeld ? "PASS" : "FAIL",
    cfg1
      ? `config_layers="${cfg1.config_layers}" project_files=${cfg1.config_project_files} redline_ignored="${cfg1.config_redline_ignored}" env_protect=${boot1?.env_protect}`
      : `项目轨迹目录 ${projTraj} 下没有 config-layers 行（trajectoryDir 未被采用？exit=${r1.code}）`,
  )

  // A5b：TM_CONFIG_ENV_ONLY=1 时忽略文件层
  const envTraj = path.join(BASE, "trajectory")
  rmrf(envTraj)
  const r2 = await runCli(["run", "--standalone", "--model", "nope/nope", "--print-logs", "x"], {
    cwd: ws,
    env: sandboxEnv({ TM_CONFIG_ENV_ONLY: "1" }),
    logFile: path.join(BASE, "a5b.log"),
  })
  const rows2 = readTrajectory(envTraj)
  const cfg2 = configRow(rows2)
  const ignored = !!cfg2 && cfg2.config_layers === "env-only" && cfg2.config_env_only === true
  record(
    "A5b",
    "分层配置：TM_CONFIG_ENV_ONLY=1 忽略文件层",
    ignored ? "PASS" : "FAIL",
    cfg2
      ? `config_layers="${cfg2.config_layers}" config_env_only=${cfg2.config_env_only}`
      : `env 轨迹目录 ${envTraj} 下没有 config-layers 行（exit=${r2.code}）`,
  )
}

// ─────────────────────────── C 组：安全面（零 token，进程内驱动守卫） ───────────────────────────
//
// 宿主只在模型发起工具调用时才评估权限，零 token 的 boot 探针不会触发任何工具调用，
// 所以 C 组在进程内直接驱动**副本 dist** 的守卫钩子（与 test-v2-adapter 同一套 fake-ctx），
// 断言的是守卫返回的判定本身——比轨迹里的计数更强。

async function groupC() {
  const ws = path.join(BASE, "ws-c")
  fs.mkdirSync(ws, { recursive: true })
  process.env.TM_TRAJECTORY_DIR = path.join(BASE, "c-traj")
  process.env.TM_BLACKBOARD_DIR = path.join(BASE, "c-blackboard")
  process.env.TM_MEMORY_GLOBAL_DIR = path.join(BASE, "c-memories")
  process.env.TM_STORE_RECLAIM = "off"
  delete process.env.TM_ENV_PROTECT // 默认（未设）→ 必须 armed

  let fake
  try {
    const mod = await import(pathToFileURL(path.join(COPY, "dist", "index.js")).href)
    const setup = mod.default?.setup
    if (typeof setup !== "function") throw new Error("副本 dist/index.js 没有导出 setup")
    const { makeFakeCtx } = await import(pathToFileURL(path.join(REPO, "scripts", "lib", "fake-ctx.mjs")).href)
    fake = makeFakeCtx({ directory: ws, options: {} })
    // The plugin's boot notes go to console.warn/error; capture them so the result table stays clean.
    const origWarn = console.warn
    const origErr = console.error
    console.warn = () => {}
    console.error = () => {}
    try {
      await setup(fake.ctx)
    } finally {
      console.warn = origWarn
      console.error = origErr
    }
  } catch (e) {
    record("C10", "R6 默认 armed：read .env 被拒", "FAIL", `进程内 boot 失败：${String(e?.message ?? e)}`)
    record("C11", "grep/glob 不绕 env-FILE", "FAIL", `进程内 boot 失败：${String(e?.message ?? e)}`)
    return
  }

  // C10：默认配置下 read .env → permission.evaluate 判定 deny
  const ev = { action: "read", resources: [".env"], effect: "allow", agent: "team" }
  try {
    await fake.hook("permission.evaluate").fire(ev)
  } catch (e) {
    record("C10", "R6 默认 armed：read .env 被拒", "FAIL", `evaluate 钩子抛错：${String(e?.message ?? e)}`)
  }
  if (!results.some((r) => r.id === "C10")) {
    record(
      "C10",
      "R6 默认 armed：read .env 被 permission.evaluate 判 deny",
      ev.effect === "deny" ? "PASS" : "FAIL",
      `action=read resources=[.env] → effect=${ev.effect}（期望 deny）`,
    )
  }

  // C11：grep 的 path 指向 .env → execute.before 抛拒绝；glob 的 pattern 同理
  const fireBefore = async (tool, input) => {
    try {
      await fake.hook("tool.execute.before").fire({ tool, input, agent: "team" })
      return { threw: false, msg: "" }
    } catch (e) {
      return { threw: true, msg: String(e?.message ?? e) }
    }
  }
  const grep = await fireBefore("grep", { path: ".env", pattern: "SECRET" })
  const glob = await fireBefore("glob", { pattern: ".env" })
  record(
    "C11",
    "grep/glob 不绕 env-FILE（execute.before 抛拒绝）",
    grep.threw && glob.threw ? "PASS" : "FAIL",
    `grep(path=.env) threw=${grep.threw} · glob(pattern=.env) threw=${glob.threw}${grep.threw ? ` · ${grep.msg.slice(0, 60)}` : ""}`,
  )
}

// ─────────────────────────── B 组：极小回合（--turns） ───────────────────────────

async function groupB() {
  const ws = path.join(BASE, "ws-b")
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, "big.txt"), "line of filler text\n".repeat(4000) + "needle here\n")
  const bTraj = path.join(BASE, "b-traj")
  // A v2 plugin cannot create agents — the six roles are config files.  `--agent team`
  // resolves only after the generator writes them into the sandbox config dir.
  const gen = await runProc(process.execPath, [path.join(COPY, "scripts", "gen-v2-config.mjs"), "--dir", BASE], {
    cwd: COPY,
    env: sandboxEnv(),
    logFile: path.join(BASE, "gen.log"),
  })
  if (!fs.existsSync(path.join(BASE, "agents", "team.md"))) {
    record("B0", "生成 Team 角色配置（gen-v2-config）", "FAIL", `未生成 agents/team.md（exit=${gen.code}）`)
    return
  }
  const prompt =
    "请依次执行并简短汇报：1) 用 read 工具读取 big.txt 全文；2) 用 grep 在 big.txt 里搜索 needle；" +
    "3) 用 shell 运行 `echo hi`；4) 用 subagent 派一个后台子代理做一件小事。"
  // The lead role's file is `Team.md` (the generator keeps the id's case), and the host's
  // `--agent` lookup is exact — `team` is NOT found, `Team` is.
  const r = await runCli(
    ["run", "--standalone", "--agent", "Team", "--model", MODEL, "--auto", prompt],
    {
      cwd: ws,
      env: sandboxEnv({
        TM_COMPACT_AT_PERCENT: "5",
        TM_TRAJECTORY_DIR: bTraj,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
      }),
      logFile: path.join(BASE, "turns.log"),
      timeoutMs: 300000,
    },
  )
  const rows = readTrajectory(bTraj)
  const compactRows = rows.filter((x) => x.step_id === "v2-compact")
  const kinds = [...new Set(compactRows.map((x) => x.kind))]
  const eventSourced = compactRows.some((x) => x.source === "event")
  // The turn's own death cause (401/403/429/Model unavailable/…) — a SKIP must say WHY.
  const errLine = (r.out.split(/\r?\n/).filter((l) => /Error|error|unavailable|401|403|429|quota/i.test(l)).pop() || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .trim()
  const turnNote = `exit=${r.code}${errLine ? ` · ${errLine.slice(0, 120)}` : ""}`

  // B6 早压缩
  record(
    "B6",
    "早压缩：v2-compact 出现 measured/admit/confirmed 且 source=event",
    kinds.includes("measured") && eventSourced ? "PASS" : "SKIP",
    compactRows.length
      ? `v2-compact rows=${compactRows.length} kinds=[${kinds.join(",")}] source=event:${eventSourced}`
      : `无 v2-compact 行（${turnNote}）`,
  )

  // B7 JIT 卸载
  const offloaded = rows.find((x) => Number(x.native_offloaded) > 0)
  record(
    "B7",
    "JIT 卸载：原生大结果被卸载（native_offloaded>0）",
    offloaded ? "PASS" : "SKIP",
    offloaded ? `native_offloaded=${offloaded.native_offloaded} native_tokens_saved=${offloaded.native_tokens_saved}` : `轨迹里没有 native_offloaded>0 的行（${turnNote}）`,
  )

  // B8 session.usage.updated 仍在
  const usage = rows.some((x) => x.compact_source === "event") || rows.some((x) => String(x.event_unknown_types ?? "").includes("session.usage.updated"))
  record(
    "B8",
    "session.usage.updated 仍在（compact_source=event 或 event_unknown_types 命中）",
    usage ? "PASS" : "SKIP",
    usage ? "命中" : `轨迹里没有 compact_source=event，也没有 event_unknown_types 命中（${turnNote}）`,
  )

  // B9 permission.evaluate 动作集
  const actions = rows.map((x) => String(x.guard_actions ?? "")).join(" ")
  const hasRead = /\bread=/.test(actions)
  const hasGrep = /\bgrep=/.test(actions)
  const hasSub = /\bsubagent=/.test(actions)
  record(
    "B9",
    "permission.evaluate 动作集含 read/grep/subagent",
    hasRead && hasGrep ? "PASS" : "SKIP",
    `guard_actions="${actions.trim().slice(0, 160)}"（read:${hasRead} grep:${hasGrep} subagent:${hasSub} · ${turnNote}）`,
  )
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  console.log(`acceptance · CLI=${CLI} · sandbox=${BASE}${TURNS ? " · --turns" : ""}`)
  rmrf(BASE)
  fs.mkdirSync(path.join(BASE, "vendor"), { recursive: true })
  copyTree()
  if (!fs.existsSync(path.join(COPY, "dist", "index.js"))) {
    console.error(`副本缺少 dist/index.js（先 npm run build）：${COPY}`)
    process.exit(1)
  }

  await groupA()
  await groupC()
  if (TURNS) await groupB()

  console.log("\n## 真机验收结果\n")
  console.log("| 检查 | 结果 | 证据 |")
  console.log("|---|---|---|")
  for (const r of results) {
    const icon = r.status === "PASS" ? "✅ PASS" : r.status === "SKIP" ? "⏭️ SKIP" : "❌ FAIL"
    console.log(`| ${r.id} ${r.title} | ${icon} | ${String(r.evidence).replace(/\|/g, "\\|")} |`)
  }
  const pass = results.filter((r) => r.status === "PASS").length
  const fail = results.filter((r) => r.status === "FAIL").length
  const skip = results.filter((r) => r.status === "SKIP").length
  console.log(`\n${pass} pass / ${fail} fail / ${skip} skip`)

  if (!KEEP) rmrf(BASE)
  else console.log(`（--keep：沙箱保留在 ${BASE}）`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  if (!KEEP) rmrf(BASE)
  process.exit(1)
})

/**
 * tm_memory — three-tier (global / project / session) + near-duplicate dedup
 * + bloat guards + compact assertions (T1).
 *
 * Runs against the BUILT output (./dist/tm/memory.js + ./dist/tm/config.js),
 * like the other suites.  Every store path is a fresh mkdtemp under the OS
 * temp dir, so the user's real ~/.opencode-team and any repo .git are never
 * touched; nothing this file creates survives the run.
 *
 * Coverage:
 *   1. three-layer read/write + session transience (no disk) + per-session isolation
 *   2. session TTL expiry (clock seam) + PERSIST mirror + boot/lazy sweep
 *   3. near-duplicate merge on add (dedupKey + Jaccard), no second file
 *   4. memoryMaxEntries cap → args error pointing at compact/forget
 *   5. [stale Nd] tagging + memoryStaleDays=0 off
 *   6. compact: dry-run default vs apply:true, .compact-backup rollback path,
 *      backups never resurface as memories
 *   7. layered precedence retained (project > global shadowing + +2 weight)
 */

import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  buildTmMemoryTool,
  projectSlug,
  titleSlug,
  memoryDedupKey,
  memoryJaccard,
  memoryTokens,
  parseMemoryMarkdown,
  MEMORY_DEDUP_JACCARD,
} from "./dist/tm/memory.js"
import { resolveTmConfig } from "./dist/tm/config.js"

const MIN = 60_000
const DAY = 24 * 60 * 60 * 1000
const BASE = Date.UTC(2026, 8, 15, 12, 0, 0)

const made = []
function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tm-mem-${name}-`))
  made.push(dir)
  return dir
}
const fakePipelines = { store: { appendTrajectory: () => {} } }
const out = async (tool, args, ctx = {}) => (await tool.execute(args, ctx)).output ?? ""

let CLOCK = BASE
/** A tool over an isolated store: fresh globalRoot / storeBase / project dir. */
function makeTool(env = {}, extra = {}) {
  const storeBase = tmp("store")
  const globalRoot = tmp("global")
  const directory = tmp("proj")
  const cfg = resolveTmConfig({ TM_MEMORY_SESSION_TTL_MIN: "240", ...env })
  const tool = buildTmMemoryTool({
    storeBase,
    globalRoot,
    directory,
    cfg,
    pipelines: fakePipelines,
    now: () => CLOCK,
    ...extra,
  })
  return { tool, storeBase, globalRoot, directory, cfg, slug: projectSlug(directory) }
}
const projectFile = (t, category, title) =>
  path.join(t.storeBase, "memories", "projects", t.slug, category, `${titleSlug(title)}.md`)
const globalFile = (t, category, title) => path.join(t.globalRoot, category, `${titleSlug(title)}.md`)
const sessionFile = (t, sid, category, title) =>
  path.join(t.storeBase, "memories", "sessions", sid, category, `${titleSlug(title)}.md`)
const mdFile = (title, content, extraHead = "") =>
  `---\ntitle: ${JSON.stringify(title)}\n${extraHead}---\n\n${content}\n`
function seed(t, scope, category, title, content, head = "") {
  const file =
    scope === "global"
      ? globalFile(t, category, title)
      : scope === "session"
        ? path.join(t.storeBase, "memories", "sessions", "seed", category, `${titleSlug(title)}.md`)
        : projectFile(t, category, title)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, mdFile(title, content, head), "utf8")
  return file
}

// ---------------------------------------------------------------------------
// 1. three layers: project + global on disk, session in-process only
// ---------------------------------------------------------------------------
{
  const t = makeTool()
  const A = { directory: t.directory, sessionID: "ses_alpha" }
  const B = { directory: t.directory, sessionID: "ses_beta" }

  const p = await out(t.tool, { action: "add", title: "项目构建命令", content: "npm run build 产出 dist/", category: "project_build_configuration" })
  assert.ok(p.includes("记忆已保存（project）"), "project add saves")
  assert.ok(fs.existsSync(projectFile(t, "project_build_configuration", "项目构建命令")), "project file under the repo store")

  const g = await out(t.tool, { action: "add", title: "用户偏好提交风格", content: "conventional commits", scope: "global" })
  assert.ok(g.includes("记忆已保存（global）"), "global add saves")
  assert.ok(fs.existsSync(globalFile(t, "notes", "用户偏好提交风格")), "global file under the user-level root")

  const s = await out(t.tool, { action: "add", title: "本次调试端口", content: "本地服务跑在 18080", scope: "session" }, A)
  assert.ok(s.includes("记忆已保存（session") && s.includes("不落盘"), "session add reports the ephemeral tier")
  assert.ok(!fs.existsSync(path.join(t.storeBase, "memories", "sessions")), "DEFAULT: session tier writes nothing to disk")

  // every layer is searchable, and each names its scope
  const hitP = await out(t.tool, { action: "search", query: "构建", scope: "project" })
  const hitG = await out(t.tool, { action: "search", query: "conventional", scope: "global" })
  const hitS = await out(t.tool, { action: "search", query: "18080" }, A)
  assert.ok(hitP.includes("(project/project_build_configuration)"), "project hit labelled project")
  assert.ok(hitG.includes("(global/notes)"), "global hit labelled global")
  assert.ok(hitS.includes("(session/notes)") && hitS.includes("本次调试端口"), "scope-less search walks the session tier too")

  // session isolation: another ctx.sessionID never sees it
  const other = await out(t.tool, { action: "search", query: "18080" }, B)
  assert.ok(other.includes("无匹配"), "session memory is per-sessionID")
  // ...but project/global stay visible there
  const otherProj = await out(t.tool, { action: "search", query: "构建" }, B)
  assert.ok(otherProj.includes("项目构建命令"), "project tier is session-independent")

  // list groups all three layers
  const listed = await out(t.tool, { action: "list" }, A)
  assert.ok(listed.includes("session/notes") && listed.includes("global/notes") && listed.includes("project/project_build_configuration"), "list groups three layers")
  const listedSess = await out(t.tool, { action: "list", scope: "session" }, A)
  assert.ok(listedSess.includes("本次调试端口") && !listedSess.includes("项目构建命令"), "list scope=session is the session tier only")

  // forget scope=session removes exactly the session entry, disk layers intact
  const forgot = await out(t.tool, { action: "forget", title: "本次调试端口", scope: "session" }, A)
  assert.ok(forgot.includes("已删除 1"), "forget scope=session deletes the entry")
  assert.ok(fs.existsSync(projectFile(t, "project_build_configuration", "项目构建命令")), "forget scope=session leaves the project tier alone")
  const gone = await out(t.tool, { action: "search", query: "18080" }, A)
  assert.ok(gone.includes("无匹配"), "forgotten session entry is gone")

  // ephemerality: a fresh process (new tool instance, same dirs) loses it
  await out(t.tool, { action: "add", title: "重启后消失", content: "瞬态值", scope: "session" }, A)
  assert.ok((await out(t.tool, { action: "search", query: "瞬态值" }, A)).includes("重启后消失"), "session entry is live in this process")
  const t2 = makeTool({}, { storeBase: t.storeBase, globalRoot: t.globalRoot, directory: t.directory })
  const restart = await out(t2.tool, { action: "search", query: "瞬态值" }, A)
  assert.ok(restart.includes("无匹配"), "session tier does not survive a restart (PERSIST off)")
  const stillThere = await out(t2.tool, { action: "search", query: "构建" })
  assert.ok(stillThere.includes("项目构建命令"), "project tier survives the restart")
  console.log("1. three tiers: OK (project+global on disk, session per-sessionID in-process only, list/forget/search per-layer, restart loses the session tier)")
}

// ---------------------------------------------------------------------------
// 2. session TTL: lazy expiry in-process, and the PERSIST mirror + sweeps
// ---------------------------------------------------------------------------
{
  const t = makeTool({ TM_MEMORY_SESSION_TTL_MIN: "240" })
  const A = { directory: t.directory, sessionID: "ses_ttl" }
  await out(t.tool, { action: "add", title: "临时变量", content: "debug flag X=1", scope: "session" }, A)
  CLOCK = BASE + 239 * MIN
  assert.ok((await out(t.tool, { action: "search", query: "debug" }, A)).includes("临时变量"), "inside the TTL the entry is visible")
  CLOCK = BASE + 241 * MIN
  assert.ok((await out(t.tool, { action: "search", query: "debug" }, A)).includes("无匹配"), "past the TTL the entry is swept")
  assert.ok((await out(t.tool, { action: "list", scope: "session" }, A)).includes("没有任何记忆"), "expired session tier lists empty")
  CLOCK = BASE
  console.log("2. session TTL: OK (lazy sweep at TM_MEMORY_SESSION_TTL_MIN)")
}
{
  const t = makeTool({ TM_MEMORY_SESSION_PERSIST: "1", TM_MEMORY_SESSION_TTL_MIN: "60" })
  const A = { directory: t.directory, sessionID: "ses_persist" }
  const added = await out(t.tool, { action: "add", title: "落盘会话记忆", content: "镜像写盘", scope: "session" }, A)
  assert.ok(added.includes("记忆已保存（session）"), "PERSIST=1: session add reports a real path")
  const f = sessionFile(t, "ses_persist", "notes", "落盘会话记忆")
  assert.ok(fs.existsSync(f), "PERSIST=1: the session entry IS mirrored to memories/sessions/<sid>/")
  const raw = fs.readFileSync(f, "utf8")
  assert.ok(/^expires: "/m.test(raw), "persisted session frontmatter carries expires:")
  assert.ok(Date.parse(raw.match(/expires: "([^"]+)"/)[1]) > CLOCK, "expires is in the future")

  // a new process loads it back from disk
  const t2 = buildTmMemoryTool({
    storeBase: t.storeBase, globalRoot: t.globalRoot, directory: t.directory,
    cfg: resolveTmConfig({ TM_MEMORY_SESSION_PERSIST: "1", TM_MEMORY_SESSION_TTL_MIN: "60" }),
    pipelines: fakePipelines, now: () => CLOCK,
  })
  assert.ok((await out(t2, { action: "search", query: "镜像写盘" }, A)).includes("落盘会话记忆"), "persisted session tier reloads across instances")

  // expiry removes BOTH the map entry and the backing file
  CLOCK = BASE + 61 * MIN
  const search = await out(t2, { action: "search", query: "镜像写盘" }, A)
  assert.ok(search.includes("无匹配"), "persisted session entry expires")
  assert.ok(!fs.existsSync(f), "the expired backing file is swept (lazy sweep)")
  CLOCK = BASE

  // startup sweep: an already-expired file of an unseen session dies at build
  const staleFile = path.join(t.storeBase, "memories", "sessions", "ses_old", "notes", "old.md")
  fs.mkdirSync(path.dirname(staleFile), { recursive: true })
  fs.writeFileSync(
    staleFile,
    `---\ntitle: "旧会话"\nexpires: "${new Date(BASE - DAY).toISOString()}"\n---\n\n内容\n`,
    "utf8",
  )
  // plus an unreclaimable file with no expires line — also reclaimed
  const noExp = path.join(t.storeBase, "memories", "sessions", "ses_old", "notes", "noexp.md")
  fs.writeFileSync(noExp, mdFile("无期限", "内容"), "utf8")
  const t3 = buildTmMemoryTool({
    storeBase: t.storeBase, globalRoot: t.globalRoot, directory: t.directory,
    cfg: resolveTmConfig({ TM_MEMORY_SESSION_PERSIST: "1", TM_MEMORY_SESSION_TTL_MIN: "60" }),
    pipelines: fakePipelines, now: () => CLOCK,
  })
  assert.ok(!fs.existsSync(staleFile), "boot sweep deletes an expired persisted session file")
  assert.ok(!fs.existsSync(noExp), "a persisted session file with no expires line is unreclaimable — swept too")
  assert.ok(!fs.existsSync(path.join(t.storeBase, "memories", "sessions", "ses_old")), "the emptied session dir is pruned")
  assert.ok((await out(t3, { action: "search", query: "旧会话" })).includes("无匹配"), "swept entry is not searchable")
  console.log("2b. session PERSIST: OK (mirror + expires: + cross-instance reload + lazy/boot sweep + dir prune)")
}

// ---------------------------------------------------------------------------
// 3. near-duplicate merge on add — the anti-bloat fix
// ---------------------------------------------------------------------------
{
  assert.deepEqual(memoryDedupKey("task_summary_experience", "tm_browser 升级计划"), memoryDedupKey("task_summary_experience", "tm_browser升级计划"), "dedupKey ignores spacing: category + sorted stopword-stripped title tokens")
  assert.ok(memoryDedupKey("notes", "the build steps").startsWith("notes:build+steps"), "dedupKey strips stopwords and sorts tokens")
  const a = memoryTokens("approval gate 超时参数")
  const b = memoryTokens("approval gate 超时参数配置")
  assert.ok(memoryJaccard(a, b) >= MEMORY_DEDUP_JACCARD, `jaccard helper: ${memoryJaccard(a, b).toFixed(2)} ≥ ${MEMORY_DEDUP_JACCARD}`)

  const t = makeTool()
  const first = await out(t.tool, {
    action: "add", title: "tm_browser 升级计划", category: "task_summary_experience",
    content: "v1：换 playwright-core。", keywords: "browser,playwright",
  })
  assert.ok(first.includes("记忆已保存"), "first of the family saves normally")
  const file = projectFile(t, "task_summary_experience", "tm_browser 升级计划")

  // same identity, DIFFERENT slug (spacing) → dedupKey hit → merge, no new file
  const merged = await out(t.tool, {
    action: "add", title: "tm_browser升级计划", category: "task_summary_experience",
    content: "v2：playwright-core + cdp-legacy 双引擎。", keywords: "cdp-legacy",
  })
  assert.ok(merged.includes("已合并："), "near-duplicate add merges instead of saving")
  assert.ok(merged.includes(file), "the merge reply names the surviving file")
  const dir = path.dirname(file)
  assert.equal(fs.readdirSync(dir).length, 1, "NO second file was created")
  const raw = fs.readFileSync(file, "utf8")
  assert.ok(raw.includes("playwright-core + cdp-legacy"), "merged content takes the new value")
  assert.ok(/supersedes:/.test(raw) && raw.includes("tm-browser升级计划"), "frontmatter records the folded slug in supersedes")
  assert.ok(raw.includes("cdp-legacy") && raw.includes("playwright"), "merged keywords are the union")
  assert.ok(/updated_at: "/.test(raw), "merged entry refreshes updated_at")

  // Jaccard-only hit (token sets overlap enough without sharing a key)
  const j = await out(t.tool, { action: "add", title: "approval gate 超时参数", category: "notes", content: "v1", })
  assert.ok(j.includes("记忆已保存"), "first approval-gate note saves")
  const j2 = await out(t.tool, { action: "add", title: "approval gate 超时参数配置", category: "notes", content: "v2 定稿" })
  assert.ok(j2.includes("已合并：") && j2.includes("Jaccard"), "sub-threshold-name / above-threshold-set title merges via Jaccard")
  assert.equal(fs.readdirSync(path.dirname(projectFile(t, "notes", "approval gate 超时参数"))).length, 1, "Jaccard merge creates no second file")

  // unrelated memory in the same category still saves (no over-merge)
  const unrel = await out(t.tool, { action: "add", title: "R6 隐私红线", category: "notes", content: "审计只记类别与结论" })
  assert.ok(unrel.includes("记忆已保存"), "unrelated same-category memory still saves")
  // different CATEGORY is a different memory (identity stays scope+category+title)
  const cross = await out(t.tool, { action: "add", title: "tm_browser 升级计划", category: "development_code_specification", content: "另一层的记录" })
  assert.ok(cross.includes("记忆已保存"), "same title in another category saves (no cross-category merge)")
  console.log("3. near-dedup: OK (dedupKey + Jaccard merges into one file with supersedes; different category / unrelated title still saves)")
}

// ---------------------------------------------------------------------------
// 4. bloat guard: memoryMaxEntries per scope
// ---------------------------------------------------------------------------
{
  const t = makeTool({ TM_MEMORY_MAX_ENTRIES: "3" })
  const titles = ["记忆甲", "记忆乙", "记忆丙"]
  for (const title of titles) {
    assert.ok((await out(t.tool, { action: "add", title, category: "notes", content: `事实 ${title}` })).includes("记忆已保存"), `${title} saves under the cap`)
  }
  const over = await out(t.tool, { action: "add", title: "记忆丁", category: "notes", content: "第四条" })
  assert.ok(/上限|cap/i.test(over) && over.includes("3"), "over the cap → cap error naming the limit")
  assert.ok(over.includes("compact") && over.includes("forget"), "the cap error suggests compact/forget")
  assert.equal(fs.readdirSync(path.dirname(projectFile(t, "notes", "记忆甲"))).length, 3, "the cap blocks the fourth file")
  // an update of an existing entry is not growth — allowed at the cap
  const upd = await out(t.tool, { action: "add", title: "记忆甲", category: "notes", content: "更新后的事实" })
  assert.ok(upd.includes("记忆已更新"), "updating an existing memory is not blocked by the cap")
  // other scopes have their own budget
  assert.ok((await out(t.tool, { action: "add", title: "全局超额测试", scope: "global", content: "另一层" })).includes("记忆已保存"), "the cap is per-scope")
  assert.ok((await out(t.tool, { action: "add", title: "会话超额测试", scope: "session", content: "另一层" })).includes("记忆已保存"), "session tier has its own budget")
  console.log("4. MAX_ENTRIES: OK (per-scope cap, args error suggesting compact/forget, updates still allowed)")
}

// ---------------------------------------------------------------------------
// 5. staleness marker
// ---------------------------------------------------------------------------
{
  const t = makeTool({ TM_MEMORY_STALE_DAYS: "30" })
  const old = seed(t, "project", "notes", "过时构建笔记", "旧内容", "")
  const past = new Date(CLOCK - 60 * DAY)
  fs.utimesSync(old, past, past)
  const hit = await out(t.tool, { action: "search", query: "构建笔记" })
  assert.ok(/\[stale 60d\]/.test(hit), `[stale Nd] marks a 60-day-old entry: ${hit.split("\n")[2]}`)
  const fresh = await out(t.tool, { action: "add", title: "新鲜构建笔记", content: "新内容" })
  assert.ok(fresh.includes("记忆已保存"), "a distinct-but-similar title is not swallowed by dedup")
  const hitFresh = await out(t.tool, { action: "search", query: "新内容" })
  assert.ok(!hitFresh.includes("[stale"), "a fresh entry is never stale")

  const off = makeTool({ TM_MEMORY_STALE_DAYS: "0" })
  const offOld = seed(off, "project", "notes", "过时构建笔记", "旧内容", "")
  fs.utimesSync(offOld, past, past)
  const hitOff = await out(off.tool, { action: "search", query: "构建笔记" })
  assert.ok(!hitOff.includes("[stale"), "memoryStaleDays=0 disables the marker")
  console.log("5. stale tagging: OK ([stale Nd] past TM_MEMORY_STALE_DAYS, 0 = off)")
}

// ---------------------------------------------------------------------------
// 6. compact — dry-run by default, apply:true with a .compact-backup rollback
// ---------------------------------------------------------------------------
{
  const t = makeTool()
  // simulate the pre-T1 state: three near-identical files, distinct slugs
  const stamp = (iso) => `created_at: "${iso}"\nupdated_at: "${iso}"\n`
  const keep = seed(t, "project", "task_summary_experience", "记忆三层 schema 设计", "最早的骨架",
    stamp(new Date(BASE - 30 * DAY).toISOString()))
  const dupB = seed(t, "project", "task_summary_experience", "记忆三层 schema 设计 v2", "第二版细节",
    stamp(new Date(BASE - 20 * DAY).toISOString()))
  const dupC = seed(t, "project", "task_summary_experience", "记忆三层 schema 设计草案", "最新的收敛结论",
    stamp(new Date(BASE - 1 * DAY).toISOString()))
  const before = [keep, dupB, dupC].map((f) => fs.readFileSync(f, "utf8"))

  const dry = await out(t.tool, { action: "compact", scope: "project" })
  assert.ok(dry.includes("compact dry-run"), "compact defaults to a dry-run report")
  assert.ok(dry.includes("保留") && dry.includes("并入"), "the dry-run names the keeper and the folded entries")
  assert.ok(dry.includes("apply:true"), "the dry-run tells you how to make it real")
  assert.equal(fs.readdirSync(path.dirname(keep)).length, 3, "dry-run changes NOTHING")
  assert.deepEqual([keep, dupB, dupC].map((f) => fs.readFileSync(f, "utf8")), before, "dry-run leaves every file byte-identical")

  const applied = await out(t.tool, { action: "compact", scope: "project", apply: true })
  assert.ok(applied.includes("compact 已执行"), "apply:true performs the merge")
  const left = fs.readdirSync(path.dirname(keep))
  assert.equal(left.length, 1, "the three duplicates collapse into one file")
  assert.equal(left[0], path.basename(keep), "the survivor is the EARLIEST entry (the original slug)")
  const raw = fs.readFileSync(keep, "utf8")
  assert.ok(raw.includes("最新的收敛结论"), "merged content takes the newest value")
  const superseded = raw.match(/supersedes:\n((?:    - .*\n)+)/)[1]
  assert.ok(superseded.includes(titleSlug("记忆三层 schema 设计 v2")), "supersedes lists folded slug B")
  assert.ok(superseded.includes(titleSlug("记忆三层 schema 设计草案")), "supersedes lists folded slug C")
  assert.ok(/created_at: "2026-08-16/.test(raw), "the keeper keeps the earliest created_at")
  const dupFile = path.join(path.dirname(keep), `${titleSlug("记忆三层 schema 设计 v2")}.md`)
  assert.ok(!fs.existsSync(dupFile), "the folded file is removed (rmForceSafe)")

  // backups = the rollback path, mirrored under .compact-backup/<UTC ts>/<scope>/
  const m = applied.match(/备份（回滚路径）：(.+?)（内部按/)
  assert.ok(m, "the apply report names the backup dir")
  const backupRoot = m[1].trim()
  const backedUp = fs.readdirSync(backupRoot, { recursive: true }).filter((f) => String(f).endsWith(".md")).map(String)
  assert.equal(backedUp.length, 3, "all three originals are backed up")
  assert.ok(backedUp.every((f) => f.startsWith(`project${path.sep}`) || f.startsWith("project/")), "backups are namespaced per scope")
  const bRaw = fs.readFileSync(path.join(backupRoot, backedUp.find((f) => f.includes(titleSlug("记忆三层 schema 设计草案")))), "utf8")
  assert.equal(bRaw, before[2], "the backup is the pre-compact original, byte-identical")

  // rollback = copy the originals back
  for (const f of backedUp) {
    const dest = path.join(path.dirname(keep), path.basename(f))
    fs.copyFileSync(path.join(backupRoot, f), dest)
  }
  assert.equal(fs.readdirSync(path.dirname(keep)).length, 3, "copy-back restores the pre-compact store")
  assert.deepEqual([keep, dupB, dupC].map((f) => fs.readFileSync(f, "utf8")), before, "restored content matches the originals")

  // re-apply, then prove the backup tree never resurfaces in search
  await out(t.tool, { action: "compact", scope: "project", apply: true })
  const hit = await out(t.tool, { action: "search", query: "记忆三层" })
  assert.ok(/命中 1\/1/.test(hit), "compact result is a single memory; the .compact-backup tree is not walked")
  // a foreign dot-dir inside a scope root is skipped as well
  const dot = path.join(t.globalRoot, ".compact-backup", "ghost")
  fs.mkdirSync(path.dirname(dot), { recursive: true })
  fs.writeFileSync(`${dot}.md`, mdFile("幽灵记忆", "不应出现"), "utf8")
  const hitDot = await out(t.tool, { action: "search", query: "幽灵记忆" })
  assert.ok(hitDot.includes("无匹配"), "dot-names under a memory root are never searchable")
  // "all" walks every layer
  await out(t.tool, { action: "add", title: "会话内的临时事实", content: "只有本会话", scope: "session" })
  const all = await out(t.tool, { action: "compact", scope: "all" })
  assert.ok(all.includes("compact dry-run") || all.includes("未发现近似重复"), "compact scope=all runs over all three layers")
  const noDup = await out(makeTool().tool, { action: "compact" })
  assert.ok(noDup.includes("未发现近似重复"), "compact on a clean store reports nothing to do")
  console.log("6. compact: OK (dry-run default, apply:true merges to one keeper, .compact-backup copy = rollback, backups never searched)")
}

// ---------------------------------------------------------------------------
// 7. layered precedence must not regress (project > global)
// ---------------------------------------------------------------------------
{
  const t = makeTool()
  await out(t.tool, { action: "add", title: "分层记忆测试", scope: "project", content: "构建命令事实：npm run build" })
  await out(t.tool, { action: "add", title: "分层记忆测试", scope: "global", content: "构建命令事实：npm run build" })
  const layered = await out(t.tool, { action: "search", query: "构建命令" })
  assert.ok(layered.includes("分层记忆测试") && layered.includes("(project/"), "project layer surfaces")
  assert.equal(layered.split("\n\n").find((b) => b.includes("(global/") && b.includes("分层记忆测试")), undefined, "same-title global entry stays shadowed")
  assert.ok(layered.includes("已被项目层优先遮蔽"), "the shadow note keeps its pinned wording")
  await out(t.tool, { action: "add", title: "Near Tie Project", scope: "project", content: "kafka bootstrap servers fact" })
  await out(t.tool, { action: "add", title: "Near Tie Global", scope: "global", content: "kafka bootstrap servers fact" })
  const near = await out(t.tool, { action: "search", query: "kafka" })
  assert.ok(near.indexOf("Near Tie Project") < near.indexOf("Near Tie Global"), "project +2 still wins the near tie")
  await out(t.tool, { action: "add", title: "会话层优先测试", scope: "session", content: "kafka bootstrap servers fact" })
  const ses = await out(t.tool, { action: "search", query: "kafka" })
  assert.ok(ses.indexOf("会话层优先测试") < ses.indexOf("Near Tie Project"), "session outranks project in the near tie")
  // session shadows the SAME title in a lower layer
  await out(t.tool, { action: "add", title: "分层记忆测试", scope: "session", content: "构建命令事实：会话层版本" })
  const shadowSes = await out(t.tool, { action: "search", query: "构建命令" }, { directory: t.directory, sessionID: "ses_new" })
  assert.ok(shadowSes.includes("(project/"), "other sessions still see the project layer")
  const shadowSesA = await out(t.tool, { action: "search", query: "构建命令" })
  assert.ok(shadowSesA.includes("已被会话层优先遮蔽"), "the session layer shadows same-title lower layers with its own note")
  // description + args advertise the new tier and action
  assert.ok(t.tool.description.includes("global — user-level conventions"), "the pinned description phrase survives")
  assert.ok(t.tool.description.includes("session") && t.tool.description.includes("compact"), "description advertises the session tier and compact")
  assert.ok(String(t.tool.args.apply.descriptor).includes("dry-run"), "the descriptor fallback advertises apply")
  console.log("7. precedence: OK (session > project > global weighting + shadowing notes; project>global semantics unchanged)")
}

// ---------------------------------------------------------------------------
// 8. frontmatter backward / forward compatibility (new keys never break parse)
// ---------------------------------------------------------------------------
{
  const t = makeTool()
  const legacy = seed(t, "project", "notes", "旧版格式甲", "旧格式内容",
    'usage_scenario:\n    - "构建前"\nkeywords:\n    - "legacy"\n')
  const parsed = parseMemoryMarkdown(fs.readFileSync(legacy, "utf8"), legacy)
  assert.ok(parsed && parsed.title === "旧版格式甲", "an old-format (T1-free) file still parses")
  assert.deepEqual(parsed.usageScenario, ["构建前"], "old usage_scenario list parses")
  assert.equal(parsed.supersedes.length, 0, "a missing supersedes key reads as empty, not null")
  assert.equal(parsed.expiresAt, null, "a missing expires key reads as null")
  assert.equal(parsed.createdAt, null, "a missing created_at reads as null (the reader falls back to mtime)")
  assert.equal(parsed.updatedAt, null, "a missing updated_at reads as null (the reader falls back to mtime)")
  const seen = await out(t.tool, { action: "search", query: "旧版格式甲" })
  assert.ok(seen.includes("旧版格式甲"), "an old-format file stays readable through the tool (mtime fallback for staleness)")

  const future = seed(t, "project", "notes", "未来格式乙", "内容",
    'keywords:\n    - "k1"\nembedding: "vec-xyz"\nrelated:\n    - "别的东西"\n')
  const p2 = parseMemoryMarkdown(fs.readFileSync(future, "utf8"), future)
  assert.deepEqual(p2.keywords, ["k1"], "keywords still parse with unknown keys around them")
  assert.equal(p2.supersedes.length, 0, "a foreign list section (related:) is never read as supersedes")
  assert.equal(p2.expiresAt, null, "an unknown scalar (embedding) is not mistaken for expires")

  await out(t.tool, { action: "add", title: "新增记忆丙", content: "新格式内容" })
  const raw = fs.readFileSync(projectFile(t, "notes", "新增记忆丙"), "utf8")
  assert.ok(/^---\ntitle: /m.test(raw), "the writer still opens frontmatter with title (old reader order)")
  assert.ok(!raw.includes("supersedes"), "a clean new entry carries no supersedes list")
  assert.ok(/updated_at: "/.test(raw), "a new entry records updated_at")
  console.log("8. frontmatter compat: OK (old files parse, unknown keys ignored, new keys optional)")
}

// ---------------------------------------------------------------------------
// 9. args-schema — model-visible param surface carries the T1 additions
//    (buildMemoryArgsSchema is what tm/index passes as deps.args; a key
//    missing THERE is unreachable for the model no matter what execute()
//    accepts — round-2.5 gap: apply / compact / session were execute-only)
// ---------------------------------------------------------------------------
{
  const { buildMemoryArgsSchema } = await import("./dist/tm/args-schema.js")
  const shape = await buildMemoryArgsSchema()
  // works on both branches: zod schema (.description) or { descriptor }
  const text = (v) => String(v?.description ?? v?.descriptor ?? "")
  assert.ok("apply" in shape, "memory args shape DECLARES apply (execute reads args.apply for compact)")
  assert.ok(text(shape.action).includes("compact"), "action description advertises compact")
  assert.ok(text(shape.scope).includes("session"), "scope description advertises the session tier")
  assert.ok(/dry-run/i.test(text(shape.apply)), "apply description states the dry-run default")
  console.log("9. args-schema: OK (apply + compact + session live in the model-visible param surface)")
}

for (const dir of made) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ }
}
console.log(`\ntest-memory.mjs: ALL PASS (9 groups)`)

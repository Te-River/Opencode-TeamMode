/**
 * JIT layer-2 tool verification (run with node after `npm run build`).
 *
 * Pins the T1.2 + T1.3 + T1.4 contract:
 *   1. env config resolution (typed defaults, invalid guards) + token口径
 *   2. run identity + HMAC handles + ref grammar + expiry (fail-closed)
 *   3. run store layout (index.jsonl fields) + trajectory append-only +
 *      TTL sweep with tree-activity idleness (M2/E1 regression-pinned)
 *   4. five-branch content-aware previews, hard-capped at 80 tokens
 *   5. P3 read-only allowlist (incl. command-substitution escapes) + P2 path
 *      scope with realpath fail-closed (junction escape)
 *   6. tool pipelines: ToolResult contract ({output}, BUG#1), threshold
 *      boundary (== threshold offloads), handle visible in output, real-host
 *      client shapes (BUG#2), client error envelope, R6 reuse (same source —
 *      tm_* is NOT an R6 bypass), P3 matrix, tm_fetch auth/paging/structure,
 *      degraded path
 *   7. loader integration: `tool` segment next to config + R6 hook +
 *      ZodRawShape args (BUG#3)
 *   8. hook-level alias: tm_read/tm_bash pass through R6's own interception
 */
import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const tm = await import("./dist/tm/index.js")
const plugin = (await import("./dist/index.js")).default
const ep = await import("./dist/envprotect.js")

/* ---------- env hygiene (restore whatever the host had) ---------- */
const ENV_KEYS = [
  "TM_OFFLOAD_THRESHOLD", "TM_PREVIEW_LINES", "TM_PREVIEW_MAX_TOKENS",
  "TM_FETCH_MAX_LINES", "TM_BLACKBOARD_DIR", "TM_TRAJECTORY_DIR",
  "TM_BLACKBOARD_TTL", "TM_BASH_READONLY_ALLOWED",
  "TM_ENV_PROTECT", "TM_ENV_PROTECT_EXTRA_DENY",
  "TM_PTC_MAX_PROGRAM_CHARS", "TM_PTC_MAX_CALLS", "TM_PTC_MAX_ERRORS",
  "TM_PTC_TIMEOUT_MS", "TM_PTC_ENGINE", "TM_WEBFETCH_ALLOWED_DOMAINS", "TM_MEMORY_GLOBAL_DIR",
  // T4 tiering + search knobs — must be cleared so the ambient shell can
  // never flip the DEFAULTS these tests pin (4000 text / 2000 data / auto).
  "TM_SEARCH_DEFAULT_ENGINE", "TM_OFFLOAD_THRESHOLD_TEXT", "TM_OFFLOAD_THRESHOLD_DATA",
  "TM_WEB_CACHE_TTL_SEC",
]
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
// The shared runtimes below INSPECT THE WIRE (which URL did the engine leg
// actually request?).  A cached leg never issues a request, so those
// assertions would depend on test order and on whatever a previous process
// left in the tmpdir store — the cache is OFF for them and is tested on its
// own in §6m-c with explicit instances.  It lives INSIDE clearTmEnv because
// several blocks call it, and a one-time set at the top got wiped.
const CACHE_OFF = () => { process.env.TM_WEB_CACHE_TTL_SEC = "0" }
const clearTmEnv = () => { for (const k of ENV_KEYS) delete process.env[k]; CACHE_OFF() }
const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
}
const tmpDirs = []
const mktmp = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmt-" + label + "-"))
  tmpDirs.push(dir)
  return dir
}

try {
  clearTmEnv()
  // The shared runtimes below INSPECT THE WIRE (which URL did the engine leg
  // actually request?).  A cached leg never issues a request, so those
  // assertions would depend on test order — the cache is OFF for them and is
  // tested on its own in §6m-c with explicit instances.
  process.env.TM_WEB_CACHE_TTL_SEC = "0"

  /* ---------- 1. config + token口径 ---------- */
  {
    const cfg = tm.resolveTmConfig({})
    assert.equal(cfg.offloadThreshold, 2000, "default offload threshold")
    assert.equal(cfg.previewLines, 20, "default preview lines")
    assert.equal(cfg.previewMaxTokens, 80, "default preview max tokens")
    assert.equal(cfg.fetchMaxLines, 2000, "default fetch max lines")
    assert.equal(cfg.blackboardDir, "", "default blackboard dir = AUTO (git-aware, resolved in createTmTools)")
    assert.equal(cfg.trajectoryDir, "", "default trajectory dir = AUTO (git-aware, resolved in createTmTools)")
    assert.equal(cfg.blackboardTtlDays, 7, "default blackboard ttl days")
    assert.ok(cfg.bashReadonlyAllowed.includes("Get-Content"), "default allowlist ships PS cmdlets")
    // invalid values fail soft to defaults (typed defaults, type guard)
    const bad = tm.resolveTmConfig({
      TM_OFFLOAD_THRESHOLD: "abc", TM_PREVIEW_MAX_TOKENS: "-5",
      TM_FETCH_MAX_LINES: "0", TM_BLACKBOARD_TTL: "9999",
      TM_PREVIEW_LINES: "NaN",
    })
    assert.equal(bad.offloadThreshold, 2000, "NaN threshold -> default")
    assert.equal(bad.previewMaxTokens, 80, "negative preview cap -> default")
    assert.equal(bad.fetchMaxLines, 2000, "0 fetch lines -> default")
    assert.equal(bad.blackboardTtlDays, 7, "over-cap ttl -> default")
    assert.equal(bad.previewLines, 20, "NaN preview lines -> default")
    // env overrides parse
    const custom = tm.resolveTmConfig({
      TM_OFFLOAD_THRESHOLD: "500", TM_BLACKBOARD_DIR: "D:/data/.bb",
      TM_BASH_READONLY_ALLOWED: "ls, python; rg",
    })
    assert.equal(custom.offloadThreshold, 500, "threshold override")
    assert.equal(custom.blackboardDir, "D:/data/.bb", "absolute blackboard dir override")
    assert.deepEqual(custom.bashReadonlyAllowed, ["ls", "python", "rg"], "allowlist override")
    // Wave B M1 — threshold TIER INHERITANCE from the global.  The global
    // TM_OFFLOAD_THRESHOLD must reach prose/data too when a tier env is not
    // explicitly set (the old bug: a user who raised the global to 8000 to
    // save tokens still got 4000 text / 2000 json — the global was ignored
    // for every KNOWN class).  An explicit tier env always wins.
    assert.equal(tm.resolveTmConfig({}).offloadThresholdText, 4000, "no env: text tier = 4000 default")
    assert.equal(tm.resolveTmConfig({}).offloadThresholdData, 2000, "no env: data tier = 2000 default")
    const inh = tm.resolveTmConfig({ TM_OFFLOAD_THRESHOLD: "8000" })
    assert.equal(inh.offloadThreshold, 8000, "global set: global honored")
    assert.equal(inh.offloadThresholdText, 8000, "global set: prose tier INHERITS the global")
    assert.equal(inh.offloadThresholdData, 8000, "global set: data tier INHERITS the global")
    const mix = tm.resolveTmConfig({ TM_OFFLOAD_THRESHOLD: "8000", TM_OFFLOAD_THRESHOLD_TEXT: "4000" })
    assert.equal(mix.offloadThresholdText, 4000, "explicit text tier WINS over the global")
    assert.equal(mix.offloadThresholdData, 8000, "unset data tier still INHERITS the global")
    const onlyData = tm.resolveTmConfig({ TM_OFFLOAD_THRESHOLD: "8000", TM_OFFLOAD_THRESHOLD_DATA: "1000" })
    assert.equal(onlyData.offloadThresholdText, 8000, "only data set: text inherits global")
    assert.equal(onlyData.offloadThresholdData, 1000, "only data set: explicit data wins")
    const textNoGlobal = tm.resolveTmConfig({ TM_OFFLOAD_THRESHOLD_TEXT: "6000" })
    assert.equal(textNoGlobal.offloadThreshold, 2000, "global unset: global = default 2000")
    assert.equal(textNoGlobal.offloadThresholdText, 6000, "global unset + text set: text honored")
    assert.equal(textNoGlobal.offloadThresholdData, 2000, "global unset: data keeps 2000 default (no phantom inherit)")
    // webfetch allowlist: seeded hosts (engines + data sources), env
    // override, explicit empty
    assert.deepEqual(
      cfg.webfetchAllowedDomains,
      [
        "baidu.com",
        "bdimg.com",
        "moegirl.org.cn",
        "bilibili.com",
        "www.sogou.com",
        "www.so.com",
        "cn.bing.com",
        "www.bing.com",
        "zhihu.com",
        "juejin.cn",
        "csdn.net",
        "cnblogs.com",
        "gitee.com",
        "github.com",
        "api.github.com",
        "raw.githubusercontent.com",
        "gist.githubusercontent.com",
        "ghproxy.net",
        "stackoverflow.com",
        "npmjs.org",
        "pypi.org",
        "learn.microsoft.com",
      ],
      "default webfetch allowlist = 22 CN-reachable research hosts (parent domains cover siblings + Baidu's own script CDN)",
    )
    assert.deepEqual(
      tm.resolveTmConfig({ TM_WEBFETCH_ALLOWED_DOMAINS: "docs.example.com, *" }).webfetchAllowedDomains,
      ["docs.example.com", "*"],
      "webfetch allowlist env override ('*' opens all)",
    )
    assert.deepEqual(
      tm.resolveTmConfig({ TM_WEBFETCH_ALLOWED_DOMAINS: "" }).webfetchAllowedDomains,
      [], "explicit empty webfetch allowlist = deny-all",
    )
    // memory global dir: empty = auto (~/.opencode-team/memories/global)
    assert.equal(tm.resolveTmConfig({}).memoryGlobalDir, "", "memory global dir default = auto (user home)")
    assert.equal(
      tm.resolveTmConfig({ TM_MEMORY_GLOBAL_DIR: "D:/mem/global" }).memoryGlobalDir,
      "D:/mem/global", "memory global dir override",
    )
    // explicit empty allowlist = deny-all (explicit user choice)
    assert.deepEqual(tm.resolveTmConfig({ TM_BASH_READONLY_ALLOWED: "," }).bashReadonlyAllowed, [], "empty allowlist honored")
    // token口径: CJK ≈ 1 token each (≥U+2E80), other chars/4 ceil;
    // equal-threshold offloads (conservative boundary)
    assert.equal(tm.estimateTokens(""), 0, "empty = 0 tokens")
    assert.equal(tm.estimateTokens("abcd"), 1, "4 chars = 1 token")
    assert.equal(tm.estimateTokens("abc"), 1, "3 chars ceil = 1 token")
    assert.equal(tm.estimateTokens("四个汉字"), 4, "CJK chars = 1 token each (was chars/4 = 1)")
    assert.equal(tm.estimateTokens("ab汉"), 2, "mixed: ceil(2 ascii/4 + 1 CJK) = ceil(1.5) = 2")
    assert.equal(tm.shouldOffload(2000, 2000), true, "boundary: == threshold offloads")
    assert.equal(tm.shouldOffload(1999, 2000), false, "below threshold stays inline")
  }
  console.log("1. resolveTmConfig + estimateTokens/shouldOffload: OK (typed defaults, fail-soft, ==threshold offloads)")

  /* ---------- 2. run identity + HMAC handles + refs ---------- */
  {
    const runId = tm.newRunId()
    assert.match(runId, /^r-\d{8}-\d{6}-[0-9a-f]{6}$/, "run id format r-<ts>-<rand>")
    const key = Buffer.from("k".repeat(32))
    const token = tm.hmacToken(key, runId)
    assert.match(token, /^[0-9a-f]{64}$/, "token is hex sha256 hmac")
    assert.equal(tm.verifyToken(key, runId, token), true, "verify ok")
    assert.equal(tm.verifyToken(key, runId, token.slice(0, -1) + (token.endsWith("0") ? "1" : "0")), false, "tampered token rejected")
    assert.equal(tm.verifyToken(key, "r-other", token), false, "foreign run rejected")
    assert.equal(tm.verifyToken(key, runId, undefined), false, "missing token rejected")
    // ref grammar
    const ref = tm.buildRef(runId, "s0001")
    assert.equal(ref, `tm://runs/${runId}/steps/s0001/result`, "ref format")
    assert.deepEqual(tm.parseRef(ref), { runId, stepId: "s0001" }, "parse plain ref")
    assert.deepEqual(tm.parseRef(ref + "#" + token), { runId, stepId: "s0001", token }, "parse ref with token fragment")
    assert.equal(tm.parseRef("file:///etc/passwd"), null, "wrong scheme rejected")
    assert.equal(tm.parseRef("tm://runs/x/steps/y/other"), null, "wrong tail rejected")
    assert.equal(tm.parseRef("tm://runs/x/steps/y/result/extra"), null, "extra segments rejected")
    assert.equal(tm.parseRef(undefined), null, "non-string rejected")
    // expiry
    assert.equal(tm.isExpired(1000, 2000), true, "past expire_at is expired")
    assert.equal(tm.isExpired(3000, 2000), false, "future expire_at is live")
    assert.equal(tm.isExpired("junk", 2000), true, "non-numeric expire_at fails CLOSED (treated as expired)")
  }
  console.log("2. newRunId + hmac/verify + parseRef + isExpired: OK (sign, tamper, cross-run, grammar)")

  /* ---------- 2b. persisted handle key (cross-process handle survival) ---------- */
  {
    const dir = mktmp("key")
    const first = tm.loadOrCreateHandleKey(dir)
    assert.equal(first.source, "persisted", "first boot creates the key at the store root")
    assert.equal(first.key.length, 32, "key = 32 random bytes")
    const second = tm.loadOrCreateHandleKey(dir)
    assert.equal(second.source, "persisted", "second boot reads the key back")
    assert.ok(first.key.equals(second.key), "same key across boots (never overwritten)")
    // a pre-seeded key wins — the wx path must not clobber an existing key
    const dir2 = mktmp("key2")
    const seeded = Buffer.from("s".repeat(32))
    fs.writeFileSync(path.join(dir2, tm.HANDLE_KEY_FILE), seeded)
    const readBack = tm.loadOrCreateHandleKey(dir2)
    assert.ok(readBack.key.equals(seeded), "existing key read back byte-exact")
    // corrupt file -> ephemeral fallback WITH a reason (never silent)
    const dir3 = mktmp("key3")
    fs.writeFileSync(path.join(dir3, tm.HANDLE_KEY_FILE), "short")
    const corrupt = tm.loadOrCreateHandleKey(dir3)
    assert.equal(corrupt.source, "ephemeral", "corrupt key file -> ephemeral fallback")
    assert.ok(corrupt.reason, "fallback carries a reason")
    assert.equal(corrupt.key.length, 32, "fallback key still 32 bytes")
    assert.equal(fs.readFileSync(path.join(dir3, tm.HANDLE_KEY_FILE), "utf8"), "short", "corrupt file left untouched (no clobber)")
  }
  console.log("2b. persisted handle key: OK (create-once wx, read-back, corrupt -> ephemeral + reason)")

  /* ---------- 3. run store: layout, index.jsonl, append-only trajectory, sweep ---------- */
  {
    const root = mktmp("store")
    const store = new tm.RunStore({
      projectRoot: root, blackboardDir: ".bb/", trajectoryDir: ".tj/",
      runId: "r-store", ttlDays: 7,
    })
    // 3a. writeResult layout + index entry fields
    const stored = store.writeResult("s0001", {
      tool: "tm_read", content: "line1\nline2", tokens: 2,
      contentType: "text", preview: "p", expireAt: 123456,
    })
    assert.equal(stored.ref, "tm://runs/r-store/steps/s0001/result", "ref from store")
    assert.equal(stored.seq, 1, "first seq is 1")
    const file1 = path.join(root, ".bb", "runs", "r-store", "steps", "s0001", "001-tm_read.md")
    assert.ok(fs.existsSync(file1), "step file at {seq:03d}-{tool}.md")
    assert.equal(fs.readFileSync(file1, "utf8"), "line1\nline2", "full content stored")
    const idxLines = fs.readFileSync(path.join(root, ".bb", "runs", "r-store", "index.jsonl"), "utf8").trim().split("\n")
    assert.equal(idxLines.length, 1, "one index line per result")
    const entry = JSON.parse(idxLines[0])
    assert.equal(entry.seq, 1, "index seq")
    assert.equal(entry.tool, "tm_read", "index tool")
    assert.equal(entry.ref, stored.ref, "index ref")
    assert.equal(entry.tokens, 2, "index tokens")
    assert.equal(entry.preview, "p", "index preview")
    assert.equal(entry.expire_at, 123456, "index expire_at")
    assert.ok(entry.ts, "index ts present")
    assert.equal(entry.content_type, "text", "index content_type")
    // readStepFile hit right after the first (single-file) write
    assert.deepEqual(store.readStepFile("s0001"), { content: "line1\nline2" }, "readStepFile hit")
    // re-entry in the same step: seq increments, ref stays step-scoped, and
    // the latest append wins on BOTH sides (index lookup AND payload file)
    const stored1b = store.writeResult("s0001", {
      tool: "tm_read", content: "lineA", tokens: 3,
      contentType: "text", preview: "p2", expireAt: 123456,
    })
    assert.equal(stored1b.ref, stored.ref, "ref is step-scoped, not seq-scoped")
    assert.equal(stored1b.seq, 2, "seq increments within a step")
    assert.equal(fs.readFileSync(file1, "utf8"), "line1\nline2", "first file untouched")
    assert.equal(store.findIndexEntry(stored.ref).tokens, 3, "index last-append-wins")
    assert.equal(store.readStepFile("s0001").content, "lineA", "payload latest-seq-wins (consistent pair)")
    // fresh step (the real per-call flow) -> fresh ref, fresh file
    const stored2 = store.writeResult("s0002", {
      tool: "tm_grep", content: "x", tokens: 1, contentType: "text", preview: "q", expireAt: 1,
    })
    assert.equal(stored2.ref, "tm://runs/r-store/steps/s0002/result", "fresh step -> fresh ref")
    assert.ok(fs.existsSync(path.join(root, ".bb", "runs", "r-store", "steps", "s0002", "001-tm_grep.md")), "second step file")
    // 3b. readStepFile miss + findIndexEntry miss
    assert.equal(store.readStepFile("s9999"), null, "readStepFile miss -> null")
    assert.equal(store.findIndexEntry("tm://runs/x/steps/y/result"), null, "findIndexEntry miss")
    // 3c. trajectory append-only: earlier lines stay a byte-prefix forever
    store.appendTrajectory({ tool: "tm_read", step_id: "s0001", event: "call" })
    store.appendTrajectory({ tool: "tm_read", step_id: "s0001", event: "result", offloaded: true })
    const tjFile = store.trajectoryFile()
    assert.ok(tjFile.endsWith(path.join(".tj", "runs", "r-store", "steps.jsonl")), "trajectory path layout")
    const snap1 = fs.readFileSync(tjFile, "utf8")
    assert.equal(snap1.trim().split("\n").length, 2, "two trajectory lines")
    store.appendTrajectory({ tool: "tm_fetch", step_id: "s0001", event: "fetch" })
    store.appendTrajectory({ tool: "tm_bash", step_id: "s0002", event: "call" })
    const snap2 = fs.readFileSync(tjFile, "utf8")
    assert.ok(snap2.startsWith(snap1), "trajectory grows append-only (byte prefix intact)")
    for (const line of snap2.trim().split("\n")) JSON.parse(line) // every line valid JSON
    const first = JSON.parse(snap2.split("\n")[0])
    assert.equal(first.run_id, "r-store", "trajectory carries run id")
    assert.equal(first.event, "call", "first event intact after later appends")
    // 3d. no destructive API on the store surface (besides the TTL sweep)
    const methods = Object.getOwnPropertyNames(tm.RunStore.prototype)
    assert.equal(methods.filter((m) => /rewrite|truncat|delete|clear|rm/i.test(m)).length, 0, "no rewrite/truncate/delete methods")
    // 3e. usage.jsonl reserved for T2.2 (path constant only)
    assert.equal(tm.USAGE_JSONL_RELPATH, "usage.jsonl", "usage.jsonl path constant reserved")
    // 3f. sweepExpired removes idle runs, keeps fresh ones
    const root2 = mktmp("sweep")
    const store2 = new tm.RunStore({
      projectRoot: root2, blackboardDir: ".bb", trajectoryDir: ".tj",
      runId: "r-live", ttlDays: 7,
    })
    for (const sub of [path.join(root2, ".bb", "runs"), path.join(root2, ".tj", "runs")]) {
      fs.mkdirSync(sub, { recursive: true })
      const old = path.join(sub, "r-old")
      fs.mkdirSync(old)
      fs.writeFileSync(path.join(old, "marker.txt"), "x")
      const t = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) // 8 days idle
      fs.utimesSync(old, t, t)
      // M2: idleness is measured across the TREE — the file must be idle too
      fs.utimesSync(path.join(old, "marker.txt"), t, t)
      fs.mkdirSync(path.join(sub, "r-live"))
    }
    const removed = store2.sweepExpired()
    assert.equal(removed, 2, "old run dirs removed from both stores")
    assert.ok(!fs.existsSync(path.join(root2, ".bb", "runs", "r-old")), "blackboard old run gone")
    assert.ok(!fs.existsSync(path.join(root2, ".tj", "runs", "r-old")), "trajectory old run gone")
    assert.ok(fs.existsSync(path.join(root2, ".bb", "runs", "r-live")), "live run kept")
    // 3g. M2 regression (review probe E1): appending to a file does NOT touch
    // the parent dir's mtime — a fresh file under an old-mtime run dir must
    // keep the WHOLE run alive (trajectory + payloads).  The old dir-mtime
    // sweep deleted live runs whose files had just been appended to.
    const tOld = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    for (const sub of [path.join(root2, ".bb", "runs"), path.join(root2, ".tj", "runs")]) {
      const mixed = path.join(sub, "r-mixed")
      fs.mkdirSync(mixed)
      fs.utimesSync(mixed, tOld, tOld) // run dir mtime 8 days old
      fs.writeFileSync(path.join(mixed, "steps.jsonl"), "fresh append\n") // file mtime: now
      fs.mkdirSync(path.join(mixed, "steps", "s0001"), { recursive: true })
      fs.utimesSync(path.join(mixed, "steps"), tOld, tOld) // intermediate dir stale too
      fs.writeFileSync(path.join(mixed, "steps", "s0001", "001-tm_read.md"), "payload\n")
    }
    const removed2 = store2.sweepExpired()
    assert.equal(removed2, 0, "E1: fresh file under old-mtime run dir -> nothing swept")
    assert.ok(fs.existsSync(path.join(root2, ".bb", "runs", "r-mixed")), "E1: live blackboard run kept")
    assert.ok(fs.existsSync(path.join(root2, ".tj", "runs", "r-mixed")), "E1: live trajectory run kept")
  }
  console.log("3. RunStore: OK (layout, index fields, append-only trajectory, no destructive API, TTL sweep incl. E1 regression)")

  /* ---------- 4. five-branch previews, hard-capped ---------- */
  {
    const cap = 80
    const check = (preview, label) =>
      assert.ok(tm.estimateTokens(preview) <= cap, `${label} preview <= ${cap} tokens`)
    // json: first 3 keys with type + magnitude (padding lives INSIDE a key —
    // trailing junk would legitimately fall back to the text branch)
    const jsonContent = JSON.stringify({
      user: "x".repeat(3000),
      items: Array.from({ length: 500 }, (_, i) => i),
      total: 42,
      extra: "pad".repeat(2000),
    })
    const jsonPreview = tm.buildPreview(jsonContent, "json", { clue: "path=/x/data.json", maxTokens: cap })
    check(jsonPreview, "json")
    assert.match(jsonPreview, /user: string\(len=3000\)/, "json key type+magnitude")
    assert.match(jsonPreview, /items: array\[len=500\]/, "json array magnitude")
    assert.match(jsonPreview, /total: number=42/, "json scalar")
    assert.ok(jsonPreview.includes("path=/x/data.json"), "json clue embedded")
    assert.ok(jsonPreview.includes("tm_fetch"), "json one-line hint embedded")
    // csv: header + 2 rows + dims
    const csvContent = ["id,name,value",
      ...Array.from({ length: 800 }, (_, i) => `${i},alice,${i * 2}`)].join("\n")
    const csvPreview = tm.buildPreview(csvContent, "csv", { maxTokens: cap })
    check(csvPreview, "csv")
    assert.ok(csvPreview.includes("id,name,value"), "csv header")
    assert.match(csvPreview, /共 801 行 × 3 列/, "csv dims")
    // log/text: head + stats + path:line refs
    const logLines = ["2026-09-07 boot ok"]
    for (let i = 0; i < 34; i++) logLines.push("2026-09-07 ERROR disk slow")
    for (let i = 0; i < 210; i++) logLines.push("2026-09-07 WARN retry")
    logLines.push("at src/app.ts:120 in handler")
    const logContent = logLines.join("\n")
    const logPreview = tm.buildPreview(logContent, "log", { maxTokens: cap })
    check(logPreview, "log")
    assert.match(logPreview, /ERROR×34/, "log error stats")
    assert.match(logPreview, /WARN×210/, "log warn stats")
    assert.match(logPreview, /共 246 行/, "log line count")
    assert.ok(logPreview.includes("src/app.ts:120"), "log path:line retrieval clue")
    // code: signature list
    const codeContent = Array.from({ length: 300 }, (_, i) =>
      `export function fn${i}(a, b) {\n  return a + b\n}`).join("\n")
    const codePreview = tm.buildPreview(codeContent, "code", { maxTokens: cap })
    check(codePreview, "code")
    assert.match(codePreview, /L1: function fn0/, "code signature with line number")
    assert.ok(codePreview.includes("更多签名省略"), "code signature overflow marker")
    // binary: type + size + 不可预览
    const binContent = "\u0000\u0001\u0002" + "a".repeat(5000)
    const binPreview = tm.buildPreview(binContent, "binary", { clue: "path=/x/img.png", maxTokens: cap })
    check(binPreview, "binary")
    assert.ok(binPreview.includes("不可预览"), "binary not previewable")
    assert.match(binPreview, /bytes/, "binary size")
    // sniffing fallback
    assert.equal(tm.sniffContentType('{"a":1}'), "json", "sniff json")
    assert.equal(tm.sniffContentType("a,b,c\n1,2,3\n4,5,6"), "csv", "sniff csv")
    assert.equal(tm.sniffContentType("function f(){}\nclass C{}"), "code", "sniff code")
    assert.equal(tm.sniffContentType("\u0000\u0001\u0002binary"), "binary", "sniff binary")
    assert.equal(tm.sniffContentType("just plain text"), "text", "sniff text")
    assert.equal(tm.contentTypeForPath("a/b/c.ts"), "code", "ext code")
    assert.equal(tm.contentTypeForPath("data.json"), "json", "ext json")
    assert.equal(tm.contentTypeForPath("x.LOG"), "log", "ext log case-insensitive")
    assert.equal(tm.contentTypeForPath("img.PNG"), "binary", "ext binary")
    // hard cap mechanics
    const capped = tm.capTokens("x".repeat(1000), 10)
    assert.ok(tm.estimateTokens(capped) <= 10, "capTokens enforces the token budget")
    assert.ok(capped.includes("截断"), "capTokens marks the cut")
    // L1 structure summaries <= 100 tokens
    const sJson = tm.buildStructureSummary(jsonContent, "json")
    assert.ok(tm.estimateTokens(sJson) <= 100, "structure json <= 100 tokens")
    assert.ok(sJson.includes("user:"), "structure json key tree")
    const sLog = tm.buildStructureSummary(logContent, "log")
    assert.ok(tm.estimateTokens(sLog) <= 100, "structure log <= 100 tokens")
    assert.match(sLog, /ERROR 行: /, "structure error line numbers")
    const sCode = tm.buildStructureSummary(codeContent, "code")
    assert.ok(tm.estimateTokens(sCode) <= 100, "structure code <= 100 tokens")
    assert.match(sCode, /共 \d+ 行/, "structure code line count")
  }
  console.log("4. previews: OK (5 branches, <=80 tokens each, clues+hint embedded, structure <=100)")

  /* ---------- 5. P3 allowlist + P2 path scope ---------- */
  {
    const allow = tm.DEFAULT_BASH_READONLY_ALLOWED
    for (const cmd of [
      "ls -la", "Get-Content foo.txt", "rg pattern src", "cat a | sort | uniq -c | head",
      "ls 2>&1", "tail -n 5 app.log", "(ls)", "dir /b", "wc -l < f.txt",
      // nit fixes: quoted `>` is literal text; --pre-glob is usable
      'grep "a>b" file.txt', "rg --pre-glob '*.md' pattern src",
      // round-3 major #3: quoted |;/ are literal text — segmentation must
      // not split on them (rg "err|warn" src is the #1 tm_bash use case)
      'rg "err|warn" src', 'grep -E "a;b" f',
      // round-3 minor #4: single-quoted awk field ref is NOT substitution
      "awk '{print $(NF)}' f",
      // nit: -WarningAction must not trip the -Wait guard
      "dir -WarningAction SilentlyContinue",
    ]) {
      assert.equal(tm.classifyReadonlyCommand(cmd, allow).ok, true, `allowlisted: ${cmd}`)
    }
    for (const cmd of [
      "rm -rf x", "node -e 'x'", "curl http://x", "echo hi", "cd /x && ls",
      "cat a > out.txt", "ls >> log", "ls &> log", "find . -delete",
      "find . -name '*.ts' -exec rm {} \\;", "tail -f app.log", "tail --follow app.log",
      "awk '{system(\"rm -rf /\")}' f.txt", "rg --pre ./pre pattern", "ls | xargs rm",
      "", "env", "printenv",
      // M1: command substitution escapes (review probes A1/A2/A3 + backtick + process-sub);
      // quoted substitution is STILL substitution (the shell expands it in double quotes)
      "ls $(rm -rf x)", "ls `rm -rf x`", "cat <(rm -rf x)", "ls >(rm -rf x)",
      'grep "$(x)" f.txt', "FOO=$(env) ls",
      // #7: PowerShell hang escapes
      "Get-Content app.log -Wait", "Get-ChildItem -Wait -Recurse", "dir -Wait",
    ]) {
      const v = tm.classifyReadonlyCommand(cmd, allow)
      assert.equal(v.ok, false, `rejected: ${cmd || "(empty)"}`)
      assert.ok(v.reason && v.suggestion, `structured verdict for: ${cmd || "(empty)"}`)
    }
    // round-3 major #2: assignment prefixes fail closed — they used to be
    // peeled away so BASH_ENV/LD_PRELOAD/PATH could borrow an allowlisted
    // head (non-interactive bash sources BASH_ENV before running `ls`)
    for (const cmd of [
      "BASH_ENV=x.sh ls", "PATH=/tmp/evil ls", "LD_PRELOAD=x.so cat f",
      "IFS=x cat", "FOO=1 ls", "FOO=1",
    ]) {
      const v = tm.classifyReadonlyCommand(cmd, allow)
      assert.equal(v.ok, false, `assignment prefix rejected: ${cmd}`)
      assert.ok(v.reason?.includes("赋值"), `assignment reason for: ${cmd}`)
    }
    // nit: bare -Wait is still rejected, with the hang reason (not -WarningAction collateral)
    const waitV = tm.classifyReadonlyCommand("dir -Wait", allow)
    assert.equal(waitV.ok, false, "-Wait still rejected")
    assert.ok(waitV.reason?.includes("挂起"), "-Wait reason names the hang guard")
    // round-4 major: quote/escape-prefixed flag escapes — the shell dequotes
    // argv, so `find . "-delete"` really IS `-delete` at exec time; guards
    // must trip on the quote-char-stripped view, not raw/blanked text
    for (const cmd of [
      'find . "-delete"', 'find . -"delete"', 'rg "--pre" ./x p',
      'tail "-f" x', 'dir "-Wait" x',
      // dual-view regression guard: deq segmentation must not strand -Wait
      // behind a quoted pipe (documented blanked-view behavior)
      'dir "a|b" -Wait',
    ]) {
      const v = tm.classifyReadonlyCommand(cmd, allow)
      assert.equal(v.ok, false, `deq escape rejected: ${cmd}`)
      assert.ok(v.reason && v.suggestion, `structured verdict for: ${cmd}`)
    }
    // same round: the deq fix must not break legitimate quoted usage
    for (const cmd of [
      "ls -la", 'rg "err|warn" src', "awk '{print $(NF)}' f",
      "grep --include=*.ts pat src",
    ]) {
      assert.equal(
        tm.classifyReadonlyCommand(cmd, allow).ok, true,
        `deq fix keeps allowlisted: ${cmd}`,
      )
    }
    // R6 side untouched by the P3 assignment fix: a real env launcher stays allowed
    assert.equal(
      ep.classifyBashCommand("env FOO=bar node app.js", "standard"), null,
      "R6: env real launcher stays allowed",
    )
    // #62 (from a real session): an agent verifying that a process really exited
    // had NO allowed way to double-check leftover trees — `tasklist` was refused
    // by this very allowlist, so a "已确认关闭" claim was unverifiable by the one
    // party who cared. Read-only process LISTING is now allowed; nothing that can
    // act is.
    for (const cmd of ['tasklist /FI "IMAGENAME eq msedge.exe"', "ps -eo pid,ppid,comm"]) {
      assert.equal(tm.classifyReadonlyCommand(cmd, allow).ok, true, `process listing is read-only: ${cmd}`)
    }
    // #84: the same self-check spelled the Windows way. `tasklist | findstr /i
    // msedge` was refused and the agent spent a second call on Select-String —
    // friction that buys nothing, since findstr only reads the pipe it is given.
    assert.equal(
      tm.classifyReadonlyCommand("tasklist | findstr /i msedge", allow).ok,
      true,
      "findstr is Windows grep and is read-only on its input",
    )
    assert.equal(tm.classifyReadonlyCommand("taskkill /PID 1234", allow).ok, false, "listing the table did not license signalling it")
    assert.ok(
      tm.classifyReadonlyCommand("uptime", allow).suggestion.includes("tasklist"),
      "the refusal hint now names the commands that ARE allowed",
    )
    // custom allowlist via config
    assert.equal(tm.classifyReadonlyCommand("python x", ["python"]).ok, true, "custom allowlist member")
    assert.equal(tm.classifyReadonlyCommand("ls", ["python"]).ok, false, "default heads not implied")
    // P2 path scope (#6 realpath fail-closed: targets must exist on disk)
    const root = mktmp("p2")
    const outside = mktmp("outside")
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.writeFileSync(path.join(root, "src", "a.ts"), "x")
    fs.writeFileSync(path.join(root, "x.txt"), "x")
    fs.writeFileSync(path.join(outside, "f.txt"), "x")
    assert.equal(tm.assertReadablePath(root, "src/a.ts").ok, true, "relative inside")
    assert.equal(tm.assertReadablePath(root, path.join(root, "x.txt")).ok, true, "absolute inside")
    assert.equal(tm.assertReadablePath(root, "../outside.txt").ok, false, ".. escape rejected")
    assert.equal(tm.assertReadablePath(root, path.join(outside, "f.txt")).ok, false, "absolute outside rejected")
    assert.equal(tm.assertReadablePath(root, "").ok, false, "empty path rejected")
    // #6 fail-closed: a nonexistent target cannot be scope-checked -> rejected
    assert.equal(tm.assertReadablePath(root, "nope/missing.txt").ok, false, "nonexistent target rejected (realpath fail-closed)")
    // extra scopes (blackboard / trajectory) widen the read scope
    assert.equal(tm.assertReadablePath(root, path.join(outside, "f.txt"), [outside]).ok, true, "extra scope allowed")
    assert.equal(tm.isInsideDir(root, root), true, "root itself is inside")
    // #6 junction/symlink escape: link inside root -> dir outside root.
    // Purely lexical resolve/relative passes this; realpath must reject.
    const linkDir = path.join(root, "link-out")
    let linkOk = true
    try {
      fs.symlinkSync(outside, linkDir, process.platform === "win32" ? "junction" : "dir")
    } catch {
      linkOk = false // env lacks symlink privilege
    }
    if (linkOk) {
      const escaped = tm.assertReadablePath(root, path.join(linkDir, "f.txt"))
      assert.equal(escaped.ok, false, "junction pointing outside scope rejected (realpath)")
      // sanity: a link pointing INSIDE the scope still reads fine
      const inLink = path.join(root, "link-in")
      try { fs.symlinkSync(path.join(root, "src"), inLink, process.platform === "win32" ? "junction" : "dir") } catch {}
      if (fs.existsSync(inLink)) {
        assert.equal(tm.assertReadablePath(root, path.join(inLink, "a.ts")).ok, true, "junction inside scope still allowed")
      }
    }
  }
  console.log("5. guard: OK (P3 matrix incl. assignment-prefix fail-closed, quoted |/;/pipe literals, awk field refs, substitution escapes, PS hangs, --pre-glob; P2 containment + realpath/junction)")

  /* ---------- 6. tool pipelines (createTmTools + fake client/$) ---------- */
  const fakeClient = (payloadMap) => ({
    file: {
      read: async ({ query }) => {
        const base = path.basename(String(query.path))
        if (!(base in payloadMap)) {
          return { ok: true, data: { error: { name: "NotFoundError", data: { message: `no ${base}`, ref: "x" } } } }
        }
        return { ok: true, data: payloadMap[base] }
      },
    },
    find: { text: async ({ query }) => ({ ok: true, data: payloadMap.__grep ?? "" }) },
    app: { log: async () => {} },
  })
  const fake$Ok = (stdout) => {
    const $ = () => ({ text: async () => stdout })
    return $
  }
  // BUG#1 helpers — pull the machine-needed handle fields back out of the
  // model-visible output text.  Their presence there is exactly what BUG#1
  // fixed: the model must SEE ref/token/preview to be able to tm_fetch.
  const grab = (text, re, label) => {
    const m = re.exec(text)
    assert.ok(m, label || `pattern ${re} found in output text`)
    return m[1]
  }
  const refOf = (t) => grab(t, /ref: (tm:\/\/runs\/\S+)/, "ref line visible in handle output")
  const tokOf = (t) => grab(t, /access_token: ([0-9a-f]{64})/, "access_token visible in handle output")

  clearTmEnv()
  const root6 = mktmp("run")
  // P2 #6: realpath fail-closed — every read target must exist on disk now
  for (const name of ["small.txt", "small1999.txt", "big2000.txt", "big.json", "absent.txt"]) {
    fs.writeFileSync(path.join(root6, name), "")
  }
  fs.mkdirSync(path.join(root6, "src"), { recursive: true })
  const smallPayload = "hello tm world\n"
  const bigLines = Array.from({ length: 2500 }, (_, i) => `L${i}: ${"x".repeat(40)}`)
  const bigPayload = bigLines.join("\n") // ~115k chars ≈ 28.8k tokens
  const jsonBig = JSON.stringify({
    user: "u".repeat(6000), items: Array.from({ length: 1000 }, (_, i) => i), total: 7,
  }) // ≈10k chars ≈ 2.5k tokens -> offloads
  // T4 tiering: this runtime pins the TEXT class to the historical 2000
  // baseline so the boundary matrix below keeps its ==threshold meaning;
  // the 4000/2000 SPLIT itself is a separate §6m-t assertion set.
  process.env.TM_OFFLOAD_THRESHOLD_TEXT = "2000"
  const runtime = await tm.createTmTools({
    directory: root6,
    client: fakeClient({
      "small.txt": smallPayload,
      "small1999.txt": "a".repeat(7996),   // ceil(7996/4)=1999 tokens -> inline
      "big2000.txt": "b".repeat(8000),     // 2000 tokens == threshold -> offload
      "big.json": jsonBig,
      "missing.txt": "",
      "x.md": "stored notes",              // blackboard-scope read fixture
      __grep: bigPayload,                  // tm_grep fixture (2500 lines)
    }),
    $: fake$Ok(bigPayload),
  })
  delete process.env.TM_OFFLOAD_THRESHOLD_TEXT
  const ctx = { directory: root6 }
  const fetchTool = runtime.tools.tm_fetch
  // v1 retired the tm_read / tm_grep / tm_bash governed passthroughs.  The
  // SHARED machinery they exercised (govern threshold offload + tm_fetch
  // paging/auth + store degradation) stays under test, so these helpers drive
  // the exact pipelines.govern seam those tools wrapped and return the identical
  // handle text (ref / access_token / preview) that refOf/tokOf read back.
  const READ_FIXTURES = {
    "small.txt": smallPayload,
    "small1999.txt": "a".repeat(7996),
    "big2000.txt": "b".repeat(8000),
    "big.json": jsonBig,
  }
  const offRead = (rt, content, contentType = "text", clue = "path=fixture") =>
    tm.toToolResult(rt.pipelines.govern(rt.pipelines.nextStepId(), "tm_read", content, { contentType, clue }))
  const offGrep = (rt, content, clue = "pattern=x") =>
    tm.toToolResult(rt.pipelines.govern(rt.pipelines.nextStepId(), "tm_grep", content, { contentType: "text", clue }))
  const readTool = {
    execute: async (a) =>
      offRead(runtime, READ_FIXTURES[String(a.path)] ?? "", String(a.path).endsWith(".json") ? "json" : "text", `path=${a.path}`),
  }
  const grepTool = {
    execute: async (a) =>
      offGrep(runtime, bigPayload, `pattern=${a.pattern}, 命中 2500 行, dir=${a.path ?? root6}`),
  }

  // 6a. threshold boundary: 1999 tokens inline, == 2000 offloads — ALL
  // results ride the ToolResult contract {output: string} now (BUG#1)
  {
    const inline = await readTool.execute({ path: "small1999.txt" }, ctx)
    assert.ok(
      inline && typeof inline === "object" && typeof inline.output === "string",
      "BUG#1: execute returns {output: string}, never a bare object (host c.split crash)",
    )
    assert.equal(inline.output, "a".repeat(7996), "below threshold returns content inline in output")
    const t = (await readTool.execute({ path: "big2000.txt" }, ctx)).output
    assert.ok(t.includes("已卸载"), "boundary: == threshold offloads")
    assert.match(t, new RegExp(`ref: tm://runs/${runtime.runId}/steps/s\\d+/result`), "handle ref scope visible in output")
    const token = tokOf(t)
    assert.match(token, /^[0-9a-f]{64}$/, "handle carries HMAC token in output")
    assert.ok(Number(grab(t, /expire_at: (\d+)/, "expire_at line visible")) > Date.now(), "handle expire_at in future")
    assert.ok(t.includes("tokens: 2000"), "handle tokens (chars/4口径) visible")
    assert.ok(t.includes("content_type: text"), "handle content type visible")
    assert.ok(t.includes("preview"), "handle preview present in output")
    assert.ok(t.includes("tm_fetch"), "fetch instruction embedded in output")
  }
  console.log("6a. threshold boundary: OK (1999 inline, ==2000 offload, handle visible in ToolResult output)")

  // 6b. offloaded fetchable payload + R6-clue preview + paging hints
  {
    const grepOut = (await grepTool.execute({ pattern: "bigpattern", path: "src" }, ctx)).output
    assert.ok(grepOut.includes("已卸载"), "big grep result offloads")
    assert.ok(grepOut.includes("bigpattern"), "grep preview clue carries pattern")
    assert.ok(/命中 \d+ 行/.test(grepOut), "grep preview clue carries match count")
    const grepRef = refOf(grepOut)
    const grepTok = tokOf(grepOut)
    const page1 = (await fetchTool.execute({ ref: grepRef, access_token: grepTok }, ctx)).output
    assert.ok(page1.includes("共 2500 行"), "total lines in hint")
    assert.ok(page1.includes("已返回 2000 行"), "first page = TM_FETCH_MAX_LINES")
    assert.ok(page1.includes("剩余 500 行"), "remaining hint")
    assert.ok(page1.includes("offset=2000"), "next offset in hint")
    assert.ok(page1.startsWith(`ref: ${grepRef}`), "page output carries its ref")
    assert.ok(page1.includes(bigLines[0]), "page content present")
    const page2 = (await fetchTool.execute({ ref: grepRef, access_token: grepTok, offset: 2000 }, ctx)).output
    assert.ok(page2.includes("已返回 500 行"), "second page rest")
    assert.ok(page2.includes("已到末尾"), "end hint")
    assert.ok(page2.endsWith(bigLines.slice(2000).join("\n")), "paged content exact")
    // token fragment auth path (no separate access_token arg)
    const page3 = (await fetchTool.execute({ ref: grepRef + "#" + grepTok }, ctx)).output
    assert.ok(page3.includes("已返回 2000 行"), "ref-fragment token accepted")
    // #9: offset past EOF — remaining must never go negative
    const over = (await fetchTool.execute({ ref: grepRef, access_token: grepTok, offset: 99999 }, ctx)).output
    assert.ok(over.includes("已到末尾"), "offset past EOF -> end hint")
    assert.ok(!/剩余 -\d+/.test(over), "no negative remaining (#9)")
  }
  console.log("6b. offload + tm_fetch paging: OK (pages, hints incl. next offset, fragment auth, no negative remaining)")

  // 6c. fetch auth: cross-process survival, foreign store, tampered, missing,
  // malformed, expired, path-escape + structure
  {
    const handleOut = (await readTool.execute({ path: "big2000.txt" }, ctx)).output
    const hRef = refOf(handleOut)
    const hTok = tokOf(handleOut)
    const res = (await fetchTool.execute({ ref: hRef, access_token: hTok }, ctx)).output
    assert.ok(res.includes("已返回 1 行"), "sanity: single-line payload fetches")
    // CORE (this fix): cross-process handle survival.  Two runtimes over the
    // SAME workspace = two plugin processes (same store root + persisted key,
    // different run ids).  A handle issued by the first must fetch in the
    // second — the payload is on disk and the key outlives the process.
    const xproc = mktmp("xproc")
    fs.mkdirSync(path.join(xproc, ".git"), { recursive: true }) // deterministic store root
    const xPayload = "b".repeat(20000) // 5000 tokens > 4000 text threshold -> offloads
    fs.writeFileSync(path.join(xproc, "x.txt"), xPayload)
    const runtimeA = await tm.createTmTools({
      directory: xproc,
      client: fakeClient({ "x.txt": xPayload }),
      $: fake$Ok(""),
    })
    const aOut = offRead(runtimeA, xPayload, "text", "path=x.txt").output
    assert.ok(aOut.includes("已卸载"), "process A offloads the payload")
    const aRef = refOf(aOut)
    const aTok = tokOf(aOut)
    const runtimeB = await tm.createTmTools({ directory: xproc, client: fakeClient({}), $: fake$Ok("") })
    assert.notEqual(runtimeB.runId, runtimeA.runId, "second runtime = a different run id (simulated restart)")
    const crossProc = (await runtimeB.tools.tm_fetch.execute({ ref: aRef, access_token: aTok }, { directory: xproc })).output
    assert.ok(crossProc.includes("已返回 1 行"), "cross-process: pre-restart handle fetches")
    assert.ok(crossProc.includes(xPayload), "cross-process: FULL payload content returned")
    // the key file lives at the store root, is 32 bytes, both boots recorded
    // source=persisted, and the key itself never reaches the trajectory/reply
    const keyFile = path.join(xproc, ".git", "opencode-team", tm.HANDLE_KEY_FILE)
    assert.ok(fs.existsSync(keyFile), "handle key persisted at the store root")
    const keyBytes = fs.readFileSync(keyFile)
    assert.equal(keyBytes.length, 32, "persisted key = 32 bytes")
    const keyHex = keyBytes.toString("hex")
    for (const rt of [runtimeA, runtimeB]) {
      const tj = fs.readFileSync(rt.store.trajectoryFile(), "utf8")
      assert.ok(tj.includes('"event":"handle_key"') && tj.includes('"source":"persisted"'), "key source recorded as persisted")
      assert.ok(!tj.includes(keyHex), "R6: key material never in the trajectory")
    }
    assert.ok(!crossProc.includes(keyHex), "R6: key material never in a tool reply")
    // foreign WORKSPACE (different store root -> different key): refused
    const run2 = mktmp("run2")
    fs.mkdirSync(path.join(run2, ".git"), { recursive: true }) // deterministic store root
    const runtime2 = await tm.createTmTools({ directory: run2, client: fakeClient({}), $: fake$Ok("") })
    const cross = (await runtime2.tools.tm_fetch.execute({ ref: hRef, access_token: hTok }, { directory: root6 })).output
    assert.ok(cross.includes("[tm_fetch 失败 · phase=permission]"), "foreign store: structured error rendered as text (BUG#1)")
    assert.ok(cross.includes("token 校验失败"), "foreign store: token signed by another store's key is refused")
    assert.ok(!cross.includes("run 不匹配"), "the removed run-mismatch reason is gone")
    assert.ok(cross.includes(tm.HANDLE_INVALID_MESSAGE), "foreign store: spec message")
    // tampered token
    const tampered = hTok.slice(0, -1) + (hTok.endsWith("0") ? "1" : "0")
    const bad = (await fetchTool.execute({ ref: hRef, access_token: tampered }, ctx)).output
    assert.ok(bad.includes("token 校验失败"), "tampered token rejected")
    assert.ok(!bad.includes("找不到载荷文件"), "tampered does not borrow the other reason")
    // omitted token = THIS run's token (a real session re-typed the same 64
    // hex chars into every call; it is a run constant, not a per-handle secret)
    const omitted = (await fetchTool.execute({ ref: hRef }, ctx)).output
    assert.ok(!omitted.includes("phase=args") && !omitted.includes("phase=permission"), "omitted access_token resolves against the current run")
    assert.ok(omitted.includes("已返回"), "and the payload is served")
    const crossNoTok = (await runtime2.tools.tm_fetch.execute({ ref: hRef }, { directory: root6 })).output
    assert.ok(crossNoTok.includes("token 校验失败"), "the SAME omission on a foreign store is still refused — the default never widens authority")
    // malformed ref
    const malformed = (await fetchTool.execute({ ref: "file:///etc/passwd", access_token: hTok }, ctx)).output
    assert.ok(malformed.includes("ref 格式无效"), "malformed ref rejected")
    // the three refusal reasons stay mutually distinguishable
    // (a) missing payload: valid token, nonexistent step in a real run
    const missingRef = `tm://runs/${runtime.runId}/steps/s9999/result`
    const missing = (await fetchTool.execute({ ref: missingRef, access_token: hTok }, ctx)).output
    assert.ok(missing.includes("找不到载荷文件"), "missing payload -> 找不到载荷文件")
    assert.ok(missing.includes(tm.HANDLE_INVALID_MESSAGE), "missing payload carries the spec message (which now names the TTL sweep as the only reaper)")
    assert.ok(!missing.includes("token 校验失败"), "missing payload does not borrow the other reason")
    // (b) nonexistent RUN: a token signed for that run verifies (it proves
    // key-holder issuance), then the payload check refuses
    const ghostRun = "r-19700101-000000-abcdef"
    const ghostTok = tm.hmacToken(keyBytes, ghostRun)
    const ghost = (await runtimeB.tools.tm_fetch.execute({ ref: `tm://runs/${ghostRun}/steps/s0001/result`, access_token: ghostTok }, { directory: xproc })).output
    assert.ok(ghost.includes("找不到载荷文件"), "nonexistent run -> 载荷已清理")
    // (c) path-escape ref: `..` segments must resolve to nothing, not escape
    const escTok = tm.hmacToken(keyBytes, "..")
    const esc = (await runtimeB.tools.tm_fetch.execute({ ref: "tm://runs/../steps/../result", access_token: escTok }, { directory: xproc })).output
    assert.ok(esc.includes("找不到载荷文件"), "path-escape ref resolves to nothing (no traversal)")
    // (d) past its TTL but the FILE is still there: SERVED, with the note.
    // User's semantic call (2026-10-05): a handle lives exactly as long as its
    // payload file does — `expire_at` is information, never a refusal.  Refusing
    // bytes that are sitting right there is the "offloaded it and cannot get it
    // back" failure this whole pipeline exists to prevent.
    const idxFile = path.join(runtime.store.blackboardRoot, "runs", runtime.runId, "index.jsonl")
    const idxLines = fs.readFileSync(idxFile, "utf8").trim().split("\n")
    const last = JSON.parse(idxLines[idxLines.length - 1])
    last.expire_at = 1 // 1970
    fs.writeFileSync(idxFile, [...idxLines.slice(0, -1), JSON.stringify(last)].join("\n") + "\n")
    const expired = (await fetchTool.execute({ ref: last.ref, access_token: hTok }, ctx)).output
    assert.ok(!expired.includes("phase=permission"), "a past-TTL handle is NOT refused while its payload exists")
    assert.ok(expired.includes("已返回") || expired.includes("已到末尾"), "…it is served like any other handle")
    assert.ok(expired.includes("已过 TTL 时点"), "…and the reply says the payload is past its TTL window")
    assert.ok(expired.includes("ttl_expired"), "…with the machine-readable flag, so a caller can act on it")
    assert.ok(!expired.includes("token 校验失败") && !expired.includes("找不到载荷文件"), "…and it borrows neither refusal reason")
    // structure mode on a JSON payload (~100-token key tree)
    const jsonOut = (await readTool.execute({ path: "big.json" }, ctx)).output
    assert.ok(jsonOut.includes("content_type: json"), "json content type from extension")
    const struct = (await fetchTool.execute({ ref: refOf(jsonOut), access_token: tokOf(jsonOut), mode: "structure" }, ctx)).output
    assert.ok(struct.includes("mode: structure"), "structure mode")
    assert.ok(struct.includes("user:"), "structure key tree in output")
    // limit cap
    const gOut = (await grepTool.execute({ pattern: "bigpattern" }, ctx)).output
    const capped = (await fetchTool.execute({ ref: refOf(gOut), access_token: tokOf(gOut), limit: 999999 }, ctx)).output
    assert.ok(capped.includes("已返回 2000 行"), "limit capped at TM_FETCH_MAX_LINES")
  }
  console.log("6c. tm_fetch auth + structure: OK (cross-process survival, foreign store, tamper, missing, malformed, expired, escape, cap)")

  // 6d. P2 scope through tm_read — RETIRED with the v1 personality (1.7.0 cut).
  //  This group asserted tm_read's P2 path containment and the client error
  //  envelope; the tool is gone (v2 governs the host's native read through
  //  src/host/v2-offload.ts). The shared P2 containment helper (guard.ts
  //  assertReadablePath) is still pinned by group 5; the v2 native-result
  //  offload path is pinned by test-v2-adapter.
  console.log("6d. P2 scope through tm_read: SKIPPED — tm_read retired with v1; P2 helper pinned by group 5, v2 offload by test-v2-adapter")


  // 6e. R6 reuse in-tool (tm_read/tm_grep/tm_bash) — RETIRED with the v1
  //  personality.  Those three passthroughs were the in-tool R6 layer this
  //  group exercised; they are gone.  R6 itself is unchanged and its matcher
  //  source is pinned by test-envprotect, and the v2 native shell/read keep the
  //  same R6 face through src/host/v2-guard.ts.
  console.log("6e. R6 reuse in-tool: SKIPPED — tm_read/tm_grep/tm_bash retired with v1; R6 matchers pinned by test-envprotect")


  // 6f. P3 allowlist through tm_bash — RETIRED with the v1 personality.  tm_bash
  //  is gone; the P3 read-only matrix itself is unchanged and stays pinned by
  //  group 5 (classifyReadonlyCommand directly).  The Test-Path existence-probe
  //  allowlisting below is kept because classifyReadonlyCommand is still a live
  //  shared function (src/host/v2-guard.ts resolves the probe ceiling through it).
  assert.equal(
    tm.classifyReadonlyCommand("Test-Path \"x\"", tm.DEFAULT_BASH_READONLY_ALLOWED).ok,
    true,
    "Test-Path allowlisted (read-only existence probe)",
  )
  console.log("6f. P3 matrix through tm_bash: SKIPPED — tm_bash retired with v1; P3 matrix pinned by group 5, Test-Path kept above")


  // 6g. tm_bash execution (offload round-trip, clue, structured shell error) —
  //  RETIRED with the v1 personality.  tm_bash is gone.  The offload round-trip
  //  through tm_fetch it exercised is still covered by 6b/6c (which now drive
  //  the shared govern seam directly), and the shell-error structuring lives in
  //  shell-bridge.ts, not in a v2-registered tool.
  console.log("6g. tm_bash execution: SKIPPED — tm_bash retired with v1; offload round-trip covered by 6b/6c")


  // 6g2. EMPTY result self-report (tm_bash / tm_grep) — RETIRED with the v1
  //  personality.  The "stdout 为空 = 0 行输出" / "（0 命中）" self-reporting was
  //  built into tm_bash/tm_grep, which are gone.  On v2 the host's native
  //  shell/grep results are governed by src/host/v2-offload.ts, and the empty-
  //  result contract is a property of those tools, not of the shared pipeline.
  console.log("6g2. empty-result self-report: SKIPPED — tm_bash/tm_grep retired with v1")


  // 6k. shell-bridge fallback shared by main + PTC pipelines — RETIRED with the
  //  v1 personality.  This P0 regression proved the Bun-global `$` fallback
  //  reached BOTH the main tm_bash pipeline and the PTC pipeline; tm_bash and
  //  tm_ptc_run are both gone, so there is no second pipeline instance to keep
  //  in sync.  shell-bridge.ts itself (runShellCommand / cleanShellError) stays
  //  in the tree and is exercised by the shared govern helpers above.
  console.log("6k. shell-bridge main+PTC fallback: SKIPPED — tm_bash + tm_ptc_run retired with v1, no second pipeline")


  // 6m. tm_webfetch — governed web fallback channel (granted ONLY to team +
  // researcher; see the whitelist matrix in test-default-agent §6).  Pure
  // red lines: http(s)-only, host allowlist (subdomains included), remote
  // env-file spellings refused, HTML stripped; the fetch itself is stubbed.
  {
    const A = tm.DEFAULT_WEBFETCH_DOMAINS
    assert.deepEqual(
      A,
      [
        "baidu.com",
        "bdimg.com",
        "moegirl.org.cn",
        "bilibili.com",
        "www.sogou.com",
        "www.so.com",
        "cn.bing.com",
        "www.bing.com",
        "zhihu.com",
        "juejin.cn",
        "csdn.net",
        "cnblogs.com",
        "gitee.com",
        "github.com",
        "api.github.com",
        "raw.githubusercontent.com",
        "gist.githubusercontent.com",
        "ghproxy.net",
        "stackoverflow.com",
        "npmjs.org",
        "pypi.org",
        "learn.microsoft.com",
      ],
      "seeded allowlist = 22 CN-reachable research hosts (engines + dev sources + github + mirror)",
    )
    assert.equal(tm.hostAllowed("cn.bing.com", A), true, "exact host allowed")
    assert.equal(tm.hostAllowed("a.mobile.moegirl.org.cn", A), true, "subdomain of a listed host allowed")
    assert.equal(tm.hostAllowed("evil.example.com", A), false, "foreign host rejected")
    assert.equal(tm.checkWebUrl("https://cn.bing.com/search?q=x", A).ok, true, "bing search url allowed")
    for (const bad of ["ftp://cn.bing.com/x", "file:///etc/passwd", "https://evil.example.com/x"]) {
      assert.equal(tm.checkWebUrl(bad, A).ok, false, "blocked: " + bad)
    }
    assert.equal(
      tm.checkWebUrl("https://mobile.moegirl.org.cn/.env", A).ok, false,
      "remote .env spelling refused (R6 red line applies to URLs)",
    )
    assert.equal(tm.checkWebUrl("https://any.example.com/x", ["*"]).ok, true, '"*" opens every host')
    // #new (v2): "*" is the value the v2 personality defaults to, because a 2.x
    // plugin cannot raise the dialog that an off-allowlist host used to route to.
    // hostAllowed() used to answer false for it — the wildcard branch lived only in
    // checkWebUrl — so tm_search dropped ALL FOUR legs of its own fan-out on every
    // v2 call and then reported "没有返回可提取的结果".  The predicate must agree with
    // the verdict function, or the two consumers drift into two different policies.
    assert.equal(tm.hostAllowed("any.example.com", ["*"]), true, "the predicate itself honours the operator's wildcard")
    assert.equal(tm.hostAllowed("evil.test", ["example.com"]), false, "a narrowed list still refuses (and suffix matching is still dot-anchored)")
    assert.equal(tm.hostAllowed("notexample.com", ["example.com"]), false, "a suffix without the dot never passes")
    assert.equal(tm.hostAllowed("sub.example.com", ["*", "other.tld"]), true, "one "*" entry opens the list regardless of order")
    assert.equal(tm.checkWebUrl("https://169.254.169.254/latest/meta-data/", ["*"]).ok, false, "and the wildcard still cannot open the metadata endpoint")
    assert.equal(tm.checkWebUrl("https://169.254.169.254/latest/meta-data/", ["*"]).askable, undefined, "the address red line has no consent path, wildcard or not")
    // HTML → text
    const stripped = tm.htmlToText(
      "<html><script>evil()</script><style>x{}</style><body><h1>Title</h1><p>Hello <b>world</b></p><!-- c --></body></html>",
    )
    assert.ok(!stripped.includes("evil()") && !stripped.includes("<"), "script/style/tags stripped")
    assert.ok(stripped.includes("Title") && stripped.includes("Hello world"), "text preserved")

    // end-to-end through the registered tool (globalThis.fetch stubbed)
    const realFetch = globalThis.fetch
    const htmlRes = (body, ctype = "text/html; charset=utf-8") => {
      const enc = new TextEncoder().encode(body)
      return {
        status: 200,
        headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? ctype : null) },
        body: {
          getReader: () => {
            let done = false
            return {
              read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: enc })),
              cancel: async () => {},
            }
          },
        },
      }
    }
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes("bing.com/short")) {
        return {
          status: 302,
          headers: { get: (n) => (String(n).toLowerCase() === "location" ? "https://evil.example.com/next" : null) },
          body: null,
        }
      }
      if (url.includes("bing.com/big")) return htmlRes("w".repeat(200000))
      if (url.includes("baike.baidu.com")) {
        return { status: 403, headers: { get: () => null }, body: null }
      }
      if (url.includes("baidu.com")) return htmlRes("<html><head></head><body></body></html>")
      if (url.includes("moegirl.org.cn/nobody")) {
        return {
          status: 200,
          headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "text/plain" : null) },
          text: async () => "x".repeat(2_500_000) + "TAIL-MARKER",
        }
      }
      return htmlRes("<h1>Page</h1>content-here")
    }
    try {
      const wf = runtime.tools.tm_webfetch
      assert.ok(wf && typeof wf.execute === "function", "tm_webfetch registered on the runtime tool surface")
      const small = await wf.execute({ url: "https://mobile.moegirl.org.cn/term" }, ctx)
      assert.ok(
        typeof small.output === "string" && small.output.includes("Page") && small.output.includes("content-here"),
        "small page inlines as stripped text",
      )
      const bounced = await wf.execute({ url: "https://cn.bing.com/short" }, ctx)
      assert.ok(
        bounced.output.includes("不在") && bounced.output.includes("白名单"),
        "redirect hop re-checked against the allowlist (allowlisted page cannot bounce off-site)",
      )
      const foreign = await wf.execute({ url: "https://evil.example.com/x" }, ctx)
      assert.ok(foreign.output.includes("phase=permission"), "foreign host → structured permission error")
      // out-of-allowlist + a RESOLVING ctx.ask → the OFFICIAL dialog approves
      // and the fetch proceeds (user decides, the plugin never self-allows)
      const ctxAsk = { ...ctx, ask: async () => "once" }
      const asked = await wf.execute({ url: "https://evil.example.com/x" }, ctxAsk)
      assert.ok(asked.output.includes("Page") && asked.output.includes("content-here"), "approved out-of-allowlist fetch proceeds via the official dialog")
      // ctx.ask rejecting → structured permission error naming the refusal
      const ctxDeny = { ...ctx, ask: async () => { throw new Error("rejected by user") } }
      const denied = await wf.execute({ url: "https://evil.example.com/x" }, ctxDeny)
      assert.ok(denied.output.includes("phase=permission") && denied.output.includes("用户未批准"), "rejected dialog → permission error (user's verdict)")
      // A dialog NOBODY answers has to come back as an answer.  The live
      // failure: an out-of-allowlist fetch spun until the user interrupted the
      // turn ("Tool execution aborted"), because the approval gate's
      // auto-reject is only armed when R6 is on AND the client can reply —
      // with neither in play, only a tool-side deadline ends the wait.
      {
        const pa = await import("./dist/tm/perm-ask.js")
        pa.setAskWaitMs(5_000)
        try {
          const t0 = Date.now()
          const hung = await wf.execute(
            { url: "https://evil.example.com/x" },
            { ...ctx, ask: () => new Promise(() => {}) },
          )
          assert.ok(hung.output.includes("无人应答") && hung.output.includes("等满"), "an unanswered dialog is reported as a MEASURED wait, not a refusal")
          assert.ok(!hung.output.includes("用户未批准"), "…and is NOT conflated with a refusal (a refusal means stop asking)")
          assert.ok(Date.now() - t0 < 30_000, "the call ends on its own instead of hanging the session")
        } finally {
          pa.setAskWaitMs(75_000)
        }
      }
      // #81: an approval that arrives in milliseconds cannot have been clicked,
      // and the agent has to be told which of the two it got.  Live evidence: a
      // researcher whose session was let through by a saved "always" reported
      // "免弹窗直接成功" and then INFERRED that the host was allowlisted — a
      // correct observation, exported as a wrong conclusion, into a deliverable.
      {
        const pa = await import("./dist/tm/perm-ask.js")
        const req = { permission: "tm_webfetch", patterns: ["https://x.test/"] }
        const instant = await pa.askUserForTargetDetailed({ ask: async () => "once" }, req, 5_000, 1_500)
        assert.equal(instant.outcome, "approved", "an answered ask is approved")
        assert.equal(instant.autoGranted, true, "answered in ~0ms ⇒ nobody clicked; that is a saved rule")
        assert.ok(pa.askGrantNote(instant).includes("始终允许"), "and the note names the mechanism the user actually used")
        assert.ok(pa.askGrantNote(instant).includes("对所有 agent 会话"), "…including that it is project-wide, not per-agent")
        const slow = await pa.askUserForTargetDetailed(
          { ask: async () => { await new Promise((r) => setTimeout(r, 30)); return "once" } },
          req,
          5_000,
          20,
        )
        assert.equal(slow.autoGranted, false, "answered slower than the threshold ⇒ a real click")
        assert.ok(pa.askGrantNote(slow).includes("刚刚在确认窗里批准"), "and that reads as the user's own verdict")
        const refused = await pa.askUserForTargetDetailed({ ask: async () => { throw new Error("no") } }, req, 5_000, 1_500)
        assert.equal(pa.askGrantNote(refused), "", "a refusal appends nothing")
      }
      // 403 after header disguise → DIRECTIVE: use the host's native browser (not "try again")
      const forbidden = await wf.execute({ url: "https://baike.baidu.com/item/x" }, ctx)
      assert.ok(
        forbidden.output.includes("宿主原生浏览器") && forbidden.output.includes("browser_navigate"),
        "403 → directive to use the host's native browser with the exact action chain",
      )
      assert.ok(forbidden.output.includes("真实浏览器会话"), "403 explains WHY (JS/TLS gate, fetch cannot pass)")
      // R6 red lines NEVER ask: env-file URL hard-blocks even with a resolver
      const envAsk = await wf.execute({ url: "https://evil.example.com/.env" }, ctxAsk)
      assert.ok(envAsk.output.includes("R6 红线") && envAsk.output.includes("phase=permission"), "env-file URL hard-blocks without any dialog")
      // empty anti-bot page (baidu in the real transcript) → actionable hint
      // instead of a silently empty success
      const empty = await wf.execute({ url: "https://www.baidu.com/s?wd=x" }, ctx)
      assert.ok(empty.output.includes("页面内容为空"), "empty anti-bot page → hint to switch engine/site")
      const big = await wf.execute({ url: "https://cn.bing.com/big" }, ctx)
      assert.ok(big.output.includes("已卸载") && big.output.includes("ref: tm://runs/"), "oversized page offloads to a handle")
      const stepId = /steps\/([^/]+)\/result/.exec(big.output)[1]
      assert.ok(runtime.store.readStepFile(stepId) !== null, "offloaded page retrievable from the shared run store")
      // text()-only fallback response (no body reader) still honors the cap
      const nobody = await wf.execute({ url: "https://mobile.moegirl.org.cn/nobody" }, ctx)
      assert.ok(nobody.output.includes("已卸载"), "no-body response still governed")
      const nbStep = /steps\/([^/]+)\/result/.exec(refOf(nobody.output))[1]
      const nbFile = runtime.store.readStepFile(nbStep)
      assert.ok(nbFile !== null && nbFile.content.includes("已截断"), "text()-only response truncated at the byte cap")
      assert.ok(!nbFile.content.includes("TAIL-MARKER"), "truncation actually dropped the over-cap tail")
    } finally {
      globalThis.fetch = realFetch
    }
  }
  console.log("6m. tm_webfetch: OK (allowlist matrix, scheme/env-file red lines, HTML strip, redirect re-check, threshold offload, structured errors, SERP auto-extraction)")

  // 6m-t. T4 threshold tiering + json field projection (pipelines.ts) +
  // T4 seed-domain merge (webfetch.ts).  The §6a runtime pinned the text
  // class back to 2000; here the DEFAULTS are on: TEXT=4000, DATA=2000.
  {
    const wfMod = await import("./dist/tm/webfetch.js")

    // (a) content-class thresholds: 3000-token text INLINE (old code would
    //     have offloaded), 4000-token text offloads (== boundary), and the
    //     ~2.5k-token json STILL offloads on the data tier.
    // P2 fail-closed: read targets must EXIST on disk (the fake client
    // supplies the body) — drop empty stubs in root6 first.
    for (const name of ["t3000.txt", "t4000.txt", "j2500.json"]) {
      fs.writeFileSync(path.join(root6, name), "")
    }
    const runtimeT = await tm.createTmTools({
      directory: root6,
      client: fakeClient({
        "t3000.txt": "a".repeat(12000), // 3000 tokens, TEXT tier 4000 -> inline
        "t4000.txt": "a".repeat(16000), // 4000 tokens == TEXT tier -> offload
        "j2500.json": jsonBig,          // ~2.5k tokens >= DATA tier 2000 -> offload
      }),
      $: fake$Ok(""),
    })
    const inline3 = offRead(runtimeT, "a".repeat(12000), "text", "path=t3000.txt").output
    assert.ok(inline3.startsWith("aaaa") && !inline3.includes("已卸载"), "TEXT tier: 3000 tokens rides inline (4000 boundary)")
    const off4 = offRead(runtimeT, "a".repeat(16000), "text", "path=t4000.txt").output
    assert.ok(off4.includes("已卸载") && off4.includes("tokens: 4000"), "TEXT tier: == 4000 offloads (conservative boundary)")
    const jsonOff = offRead(runtimeT, jsonBig, "json", "path=j2500.json").output
    assert.ok(jsonOff.includes("已卸载") && jsonOff.includes("content_type: json"), "DATA tier: json >= 2000 still offloads")

    // (b) fields projection on the json handle
    const jRef = refOf(jsonOff)
    const jTok = tokOf(jsonOff)
    const projItems = (await runtimeT.tools.tm_fetch.execute({ ref: jRef, access_token: jTok, fields: "items[]" }, ctx)).output
    assert.ok(projItems.includes("mode: fields") && projItems.includes("fields: items[]"), "fields mode reported")
    assert.ok(projItems.includes("matched: 1000"), "items[] projects all 1000 array values")
    assert.ok(/--- 投影 ---\n0\n1\n2\n/.test(projItems), "projected values in order, one per line")
    const projUser = (await runtimeT.tools.tm_fetch.execute({ ref: jRef, access_token: jTok, fields: "user" }, ctx)).output
    assert.ok(projUser.includes("matched: 1") && projUser.includes("uuuu"), "scalar path projects one value")
    const projMiss = (await runtimeT.tools.tm_fetch.execute({ ref: jRef, access_token: jTok, fields: "items[].name" }, ctx)).output
    assert.ok(projMiss.includes("matched: 0") && projMiss.includes("无匹配值"), "path with no matches -> matched 0 + structure hint (not an error)")
    const projBad = (await runtimeT.tools.tm_fetch.execute({ ref: jRef, access_token: jTok, fields: "items[]]x" }, ctx)).output
    assert.ok(projBad.includes("mode: fields") && projBad.includes("matched: 0"), "malformed path -> empty projection, no crash")
    // projection REPLACES paging — only the projected values come back
    assert.ok(!projItems.includes("uuuu"), "raw json body stays behind the handle (projection only)")

    // (c) non-json handle: fields IGNORED, classic paged mode serves
    const textOff = offRead(runtimeT, "a".repeat(16000), "text", "path=t4000.txt").output
    const tRef = refOf(textOff)
    const tTok = tokOf(textOff)
    const stillLines = (await runtimeT.tools.tm_fetch.execute({ ref: tRef, access_token: tTok, fields: "items[]" }, ctx)).output
    assert.ok(stillLines.includes("aaaa") && stillLines.includes("--- 内容 ---"), "text handle + fields -> classic lines mode (arg ignored)")
    assert.ok(!stillLines.includes("mode: fields"), "no projection shape on a non-json handle")

    // (d) T4 seed domains: merged into the DEFAULT list, never into a
    //     user-narrowed one (config.ts itself stays the single source).
    assert.deepEqual(wfMod.T4_SEEDED_DOMAINS.slice().sort(), ["api.stackexchange.com", "hn.algolia.com"], "T4 seeds = SO api + HN algolia")
    const merged = wfMod.seedWebfetchDomains(tm.DEFAULT_WEBFETCH_DOMAINS)
    assert.ok(merged.includes("api.stackexchange.com") && merged.includes("hn.algolia.com"), "default seed list gains both hosts")
    assert.equal(tm.checkWebUrl("https://api.stackexchange.com/2.3/search/advanced?q=x", merged).ok, true, "SO api passes checkWebUrl on merged seeds")
    assert.equal(tm.checkWebUrl("https://hn.algolia.com/api/v1/search?query=x", merged).ok, true, "HN api passes checkWebUrl on merged seeds")
    const narrowed = wfMod.seedWebfetchDomains(["cn.bing.com"])
    assert.deepEqual(narrowed, ["cn.bing.com"], "a narrowed allowlist is NEVER widened by the seed merge")
    assert.equal(tm.checkWebUrl("https://api.stackexchange.com/x", ["cn.bing.com"]).askable, true, "narrowed list -> SO api routes to the dialog (askable)")

    // (e) Wave B M2 — tm_webfetch HONORS `fields` on a JSON body (the PTC
    //     bridge advertises tm.webfetch({url, fields?}); projection used to
    //     live only in the tm_fetch handle path).  Reuses projectJsonFields.
    {
      const fetchJson = async () => ({
        status: 200,
        headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
        text: async () => jsonBig,
      })
      const fetchHtml = async () => ({
        status: 200,
        headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
        text: async () => "<html><body><p>plain prose page body for the ignore test</p></body></html>",
      })
      const wfJsonTool = wfMod.buildTmWebfetchTool({
        pipelines: runtimeT.pipelines, cfg: runtimeT.config, fetchImpl: fetchJson,
      })
      const wfUrl = "https://registry.npmjs.org/left-pad/latest"
      const projScalar = (await wfJsonTool.execute({ url: wfUrl, fields: "user" }, ctx)).output
      assert.ok(projScalar.includes("webfetch fields") && projScalar.includes("matched: 1") && projScalar.includes("uuuu"), "webfetch fields: scalar path projects one value")
      assert.ok(!projScalar.includes("--- 内容 ---"), "webfetch fields: projection REPLACES the raw JSON body")
      const projArr = (await wfJsonTool.execute({ url: wfUrl, fields: "items[]" }, ctx)).output
      assert.ok(projArr.includes("fields: items[]") && projArr.includes("matched: 1000"), "webfetch fields: array path projects every element")
      const projEmpty = (await wfJsonTool.execute({ url: wfUrl, fields: "no.such.path" }, ctx)).output
      assert.ok(projEmpty.includes("matched: 0"), "webfetch fields: missing path -> matched 0, not an error")
      // non-JSON body: fields IGNORED, the stripped text path serves normally
      const wfHtmlTool = wfMod.buildTmWebfetchTool({
        pipelines: runtimeT.pipelines, cfg: runtimeT.config, fetchImpl: fetchHtml,
      })
      const htmlWithFields = (await wfHtmlTool.execute({ url: wfUrl, fields: "items[]" }, ctx)).output
      assert.ok(htmlWithFields.includes("plain prose page body"), "webfetch fields: non-JSON ignores fields, serves page text")
      assert.ok(!htmlWithFields.includes("webfetch fields"), "webfetch fields: no projection shape on a non-JSON body")
    }
    assert.ok(merged.length === tm.DEFAULT_WEBFETCH_DOMAINS.length + 2, "merge adds exactly two hosts")
  }
  console.log("6m-t. T4 tiering + projection: OK (4000/2000 split boundaries, json fields projection incl. miss/malformed, non-json ignores fields, tm_webfetch honors fields on a JSON body + ignores it on non-JSON, seed merge default-only)")

  // ---------- 6m-c. URL TTL cache (item 6 of 2026-09-19) ----------
  // The web channel is the slowest thing the team does and the most
  // duplicated; the cache lives at the ONE choke point both tools share.
  // The pins that matter are the GOVERNANCE ones: a hit may never bypass the
  // static allowlist, and a dialog approval is per-request, not a licence to
  // cache.
  {
    const cm = await import("./dist/tm/cache.js")
    const wf = await import("./dist/tm/webfetch.js")
    const sm = await import("./dist/tm/search.js")
    const cacheRoot = mktmp("cache-root")
    const wctx = { directory: cacheRoot }

    // (a) key + freshness rules
    assert.equal(cm.cacheKeyFor("https://a.test/x"), cm.cacheKeyFor("https://a.test/x"), "the key is deterministic")
    assert.match(cm.cacheKeyFor("https://a.test/x"), /^[0-9a-f]{40}$/, "the file name is a HASH, never the URL — a query string can carry the token we are guarding")
    assert.notEqual(cm.cacheKeyFor("https://a.test/x"), cm.cacheKeyFor("https://a.test/y"), "a different URL is a different entry")
    const entry = (at, body) => ({ status: 200, contentType: "text/html", body, at })
    assert.equal(cm.cacheEntryFresh(entry(1000, "x"), 1000 + 300_000, 300), true, "exactly at the TTL is still fresh")
    assert.equal(cm.cacheEntryFresh(entry(1000, "x"), 1000 + 300_001, 300), false, "one ms past it is gone")
    assert.equal(cm.cacheEntryFresh(entry(1000, "x"), 1000, 0), false, "TTL 0 never serves")
    assert.equal(cm.cacheEntryFresh(null, 1, 300), false, "a miss is not fresh, trivially")
    assert.equal(cm.cacheEntryFresh({ status: 200, contentType: "t", at: 1 }, 1, 300), false, "a malformed entry is a miss, never a crash")

    // (b) the store on a real dir
    let clock = 1_000
    const cdir = mktmp("cache-dir")
    const c1 = cm.createWebCache({ dir: cdir, ttlSec: 300, now: () => clock })
    assert.equal(c1.enabled(), true, "a positive TTL enables the cache")
    assert.equal(c1.get("https://x.test/a"), null, "cold cache = miss")
    c1.put("https://x.test/a", { status: 200, contentType: "text/html", body: "PAGE-A" })
    assert.equal(c1.get("https://x.test/a").body, "PAGE-A", "put -> get round-trips the body")
    const aFile = cm.cacheFileFor(cdir, "https://x.test/a")
    assert.equal(fs.existsSync(aFile), true, "one file per URL")
    assert.ok(!fs.readFileSync(aFile, "utf8").includes("x.test"), "the URL itself is NEVER written to disk")
    clock = 1_000 + 301_000
    assert.equal(c1.get("https://x.test/a"), null, "expired -> miss")
    assert.equal(fs.existsSync(aFile), false, "the read that finds it dead deletes it (no separate sweeper)")
    assert.deepEqual(c1.counts(), { hits: 1, misses: 1, sets: 1, stale: 1 }, "hit/miss/stale counts are the observability surface tm_stats reads (the cold read counted once as a miss, the expired one as stale — not both)")
    fs.writeFileSync(cm.cacheFileFor(cdir, "https://x.test/b"), "{torn", "utf8")
    assert.equal(c1.get("https://x.test/b"), null, "a torn write reads as a miss, not an exception")
    const cdir2 = mktmp("cache-cap")
    const capped = cm.createWebCache({ dir: cdir2, ttlSec: 300, maxEntries: 8, now: () => clock })
    for (let i = 0; i < 12; i++) {
      clock += 1000
      capped.put(`https://p.test/${i}`, { status: 200, contentType: "text/plain", body: `B${i}` })
    }
    assert.equal(fs.readdirSync(cdir2).filter((f) => f.endsWith(".json")).length, 8, "the entry cap is enforced at write time")
    assert.equal(capped.get("https://p.test/0"), null, "the oldest goes first")
    assert.ok(capped.get("https://p.test/11"), "the newest survives")
    const cdir3 = path.join(mktmp("cache-off"), "never")
    const offCache = cm.createWebCache({ dir: cdir3, ttlSec: 0 })
    assert.equal(offCache.enabled(), false, "TM_WEB_CACHE_TTL_SEC=0 means OFF")
    offCache.put("https://x.test/z", { status: 200, contentType: "text/plain", body: "z" })
    assert.equal(fs.existsSync(cdir3), false, "a disabled cache creates NO files and NO directories")

    // (c) governance through the real tool
    const res200 = (body, ct) => ({ status: 200, headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? ct : null) }, text: async () => body })
    // A pipelines stand-in that keeps the real contract: govern() is SYNC and
    // returns the content verbatim inline (a cache note appended to a short
    // page must survive it).
    const fakePipes = () => ({
      store: { appendTrajectory: () => {} },
      nextStepId: () => "sC01",
      govern: (_s, _t, content) => content,
    })
    const shared = cm.createWebCache({ dir: mktmp("cache-gov"), ttlSec: 300 })
    let govFetches = 0
    const govTool = wf.buildTmWebfetchTool({
      pipelines: fakePipes(),
      cfg: { ...tm.resolveTmConfig({}), webfetchAllowedDomains: ["cn.bing.com"] },
      fetchImpl: async () => (govFetches++, res200("OUTSIDE-PAGE", "text/plain")),
      cache: shared,
    })
    const ctxOnce = { directory: cacheRoot, ask: async () => "once" }
    await govTool.execute({ url: "https://not-allowed.test/page" }, ctxOnce)
    await govTool.execute({ url: "https://not-allowed.test/page" }, ctxOnce)
    assert.equal(govFetches, 2, "a dialog-approved host is fetched EVERY time — consent is per-request and never becomes a cached licence")

    let inside = 0
    const insideTool = wf.buildTmWebfetchTool({
      pipelines: fakePipes(),
      cfg: tm.resolveTmConfig({}),
      fetchImpl: async () => (inside++, res200("npm registry payload for left-pad", "application/json")),
      cache: shared,
    })
    const npmUrl = "https://registry.npmjs.org/left-pad/latest"
    const first = await insideTool.execute({ url: npmUrl }, wctx)
    const second = await insideTool.execute({ url: npmUrl }, wctx)
    assert.equal(inside, 1, "the second identical fetch is served from disk (one network round per TTL window)")
    assert.ok(!String(first.output).includes("缓存命中"), "the first call is a real fetch and says nothing about cache")
    assert.ok(String(second.output).includes("缓存命中"), "a re-served page SAYS SO — a stale read must not read as a fresh observation")
    // `fresh: true` is the model-visible escape hatch on that trade
    const forced = await insideTool.execute({ url: npmUrl, fresh: true }, wctx)
    assert.equal(inside, 2, "fresh:true bypasses the cache and hits the network again")
    assert.ok(!String(forced.output).includes("缓存命中"), "and the fresh reply makes no cache claim")
    // #82: what it must NOT do is forfeit the WRITE.  "Don't hand me a past
    // observation" is not "throw away the observation you just made" — the live
    // export showed two calls, both full network fetches, because the fresh one
    // cached nothing.
    const afterFresh = await insideTool.execute({ url: npmUrl }, wctx)
    assert.equal(inside, 2, "the fresh fetch stored what it fetched — the next caller is served from disk")
    assert.ok(String(afterFresh.output).includes("缓存命中"), "and says so")

    let never = 0
    const narrowedTool = wf.buildTmWebfetchTool({
      pipelines: fakePipes(),
      cfg: { ...tm.resolveTmConfig({}), webfetchAllowedDomains: ["cn.bing.com"] },
      fetchImpl: async () => (never++, res200("should never be fetched", "text/plain")),
      cache: shared,
    })
    const blocked = await narrowedTool.execute({ url: npmUrl }, wctx)
    assert.equal(never, 0, "a body sitting in the cache is NEVER served to a host the CURRENT allowlist rejects")
    assert.ok(String(blocked.output).includes("phase="), "and the refusal is the normal governance error")

    // search legs share the SAME cache as tm_webfetch (URL-keyed = exact)
    let legs = 0
    const searchCache = cm.createWebCache({ dir: mktmp("cache-share"), ttlSec: 300 })
    const npmJson = JSON.stringify({ objects: [{ package: { name: "left-pad", description: "tiny", version: "1.3.0" } }] })
    const legUrls = []
    const legFetch = async (u) => (legs++, legUrls.push(String(u)), res200(npmJson, "application/json"))
    const searchTool = sm.buildTmSearchTool({ pipelines: fakePipes(), cfg: tm.resolveTmConfig({}), fetchImpl: legFetch, cache: searchCache })
    await searchTool.execute({ query: "left-pad", engine: "npm" }, wctx)
    const searched = await searchTool.execute({ query: "left-pad", engine: "npm" }, wctx)
    assert.equal(legs, 1, "the same query twice costs one engine round")
    assert.ok(String(searched.output).includes("left-pad"), "and the second call still returns real hits, not an empty result")
    // #new — the v2 wildcard shape, end to end.  The v2 personality defaults
    // TM_WEBFETCH_ALLOWED_DOMAINS to "*" (a 2.x plugin cannot raise the dialog an
    // off-allowlist host used to route to), and hostAllowed() answered false for that
    // value, so EVERY auto leg was dropped before the request left the process and the
    // user saw three queries all answered "没有返回可提取的结果".  The fix is one
    // predicate; this pins both the repair and the honest sentence for a narrowed list.
    {
      const starCfg = { ...tm.resolveTmConfig({ TM_WEBFETCH_ALLOWED_DOMAINS: "*" }) }
      assert.deepEqual(starCfg.webfetchAllowedDomains, ["*"], "the env really does resolve to the wildcard")
      let starLegs = 0
      const starTool = sm.buildTmSearchTool({
        pipelines: fakePipes(),
        cfg: starCfg,
        cache: cm.createWebCache({ dir: mktmp("cache-star"), ttlSec: 300 }),
        fetchImpl: async (u) => (starLegs++, legUrls.push(String(u)), res200(npmJson, "application/json")),
      })
      const starOut = String((await starTool.execute({ query: "left-pad", engine: "npm" }, wctx)).output)
      assert.equal(starLegs, 1, "under "*" the engine leg is actually fetched")
      assert.ok(starOut.includes("left-pad"), "and the answer carries hits instead of an allowlist excuse")
      let starAuto = 0
      const starAutoTool = sm.buildTmSearchTool({
        pipelines: fakePipes(),
        cfg: starCfg,
        cache: cm.createWebCache({ dir: mktmp("cache-star-auto"), ttlSec: 300 }),
        fetchImpl: async () => (starAuto++, res200("{\"hits\":[]}", "application/json")),
      })
      const autoOut = String((await starAutoTool.execute({ query: "初音未来演唱会" }, wctx)).output)
      assert.ok(starAuto >= 3, `auto fans out under "*" instead of skipping every leg (asked ${starAuto})`)
      assert.ok(!autoOut.includes("不在白名单，已跳过"), "no leg is dropped for an allowlist reason under the wildcard")
      // A narrowed list still refuses — and when nothing was asked, the reply says so
      // instead of blaming the engines for results we never requested.
      let narrowed = 0
      const narrowedSearch = sm.buildTmSearchTool({
        pipelines: fakePipes(),
        cfg: { ...tm.resolveTmConfig({}), webfetchAllowedDomains: ["example.invalid"] },
        cache: cm.createWebCache({ dir: mktmp("cache-narrow"), ttlSec: 300 }),
        fetchImpl: async () => (narrowed++, res200("{\"hits\":[]}", "application/json")),
      })
      const narrowOut = String((await narrowedSearch.execute({ query: "初音未来演唱会" }, wctx)).output)
      assert.equal(narrowed, 0, "a narrowed list still keeps the engines un-fetched")
      assert.match(narrowOut, /一条都没请求出去/, "and the refusal names our gate as the cause, not the engine")
      assert.match(narrowOut, /TM_WEBFETCH_ALLOWED_DOMAINS/, "naming the operator's remedy")
    }
    const wfOnEngineUrl = wf.buildTmWebfetchTool({
      pipelines: fakePipes(),
      cfg: tm.resolveTmConfig({}),
      fetchImpl: async () => (legs++, res200(npmJson, "application/json")),
      cache: searchCache,
    })
    await wfOnEngineUrl.execute({ url: legUrls[0] }, wctx)
    assert.equal(legs, 1, "tm_webfetch of the exact URL tm_search already pulled hits the SAME cache (one store, not two)")

    // (d) the runtime wires ONE cache from the knob
    const bbDir = mktmp("cache-runtime-bb")
    process.env.TM_BLACKBOARD_DIR = bbDir
    process.env.TM_WEB_CACHE_TTL_SEC = "300"
    const rtW = await tm.createTmTools({ directory: mktmp("cache-rt"), client: {}, $: () => ({}) }, {})
    delete process.env.TM_BLACKBOARD_DIR
    delete process.env.TM_WEB_CACHE_TTL_SEC
    assert.equal(rtW.config.webCacheTtlSec, 300, "TM_WEB_CACHE_TTL_SEC resolves through the config layer")
    assert.equal(rtW.config.joinMaxWaitMs, 60_000, "the default bounded wait is 60 s — long enough for a real child, short enough that the lead notices")
    assert.ok(!("tm_dispatch" in rtW.tools), "the runtime never registers a plugin-side dispatcher: the user cannot close a child we created")
    assert.ok("tm_join" in rtW.tools, "tm_join stays, because collecting a HOST task child is what makes it safe")
    let hits = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = async () => (hits++, res200("runtime cached page", "text/plain"))
    try {
      await rtW.tools.tm_webfetch.execute({ url: "https://registry.npmjs.org/left-pad/latest" }, wctx)
      const again = await rtW.tools.tm_webfetch.execute({ url: "https://registry.npmjs.org/left-pad/latest" }, wctx)
      assert.equal(hits, 1, "two calls, one fetch — the wiring is live, not just unit-testable")
      assert.ok(String(again.output).includes("缓存命中"), "through the real tool surface too")
      assert.ok(fs.existsSync(path.join(bbDir, "webcache")), "it sits beside the run store (under .git in AUTO mode), never in the working tree")
      assert.equal(path.join(rtW.store.blackboardRoot, "webcache"), path.join(bbDir, "webcache"), "the cache is a SIBLING of runs/ — sweepExpired() only ever deletes runs/*, so it cannot eat the cache (and the cache never lands in a run dir)")
    } finally {
      globalThis.fetch = realFetch
      await rtW.dispose()
    }
  }
  console.log("6m-c. URL TTL cache: OK (hash-named entries that never store the URL, TTL + prune + corrupt-file miss, dialog approvals never cached, narrowed allowlist cannot read a stale hit, search/webfetch share one store, runtime wiring from TM_WEB_CACHE_TTL_SEC)")

  // 6m-s. tm_search — the governed search FRONT (T4 upgrade): the engine
  // roster is bing + stackoverflow + hn + github + npm + moegirl + bilibili
  // (dead CN SERPs sogou/so/baidu/bing-int REMOVED, not even manually
  // selectable), engine:"auto" (the new default) classifies + fans out +
  // RRF-fuses, hits keep engine-provided snippets (never fabricated), CJK
  // multi-word queries get phrase protection, github qualifiers pass
  // through whitelisted, every engine host rides the merged seed allowlist.
  {
    const sm = await import("./dist/tm/search.js")
    const searchModResetQuota = sm.resetSoQuota
    searchModResetQuota() // quota state must not leak from earlier blocks
    const reg = runtime.tools.tm_search
    assert.ok(reg && typeof reg.execute === "function", "tm_search registered on the runtime tool surface")

    // unit: classification + routes + guards (no network)
    assert.deepEqual(
      sm.SEARCH_ENGINE_NAMES.slice().sort(),
      ["bilibili", "bing", "bing-int", "github", "hn", "moegirl", "npm", "stackoverflow"],
      "engine roster = 8 (bing-int RE-ADDED 2026-09-19: the 2026-09-14 'dead' verdict was our extractor dropping bing's /ck/a wrapper, not the engine)",
    )
    for (const dead of ["sogou", "so", "baidu"]) {
      assert.equal(sm.SEARCH_ENGINES[dead], undefined, `dead engine ${dead} fully removed (not manually selectable)`)
    }
    assert.equal(
      sm.SEARCH_ENGINES["bing-int"].buildUrl("x"),
      "https://cn.bing.com/search?q=x&ensearch=1",
      "bing-int is the INTERNATIONAL layout of the same index (ensearch=1)",
    )
    assert.ok(
      !JSON.stringify(sm.AUTO_ROUTES ?? {}).includes("bing-int"),
      "bing-int stays OUT of the auto routes — two layouts of one index would double bing's vote",
    )
    assert.equal(sm.SEARCH_ENGINES["auto"], undefined, "auto is a routing selector, not a table entry")
    // Wave B M1 anti-drift: the MODEL-VISIBLE tm_search args schema (built in
    // args-schema.ts, injected as deps.args so search.ts's fallback never
    // fires in production) must name EXACTLY the live engine table — a
    // hand-written copy once went stale (kept dead bing-int/sogou/so/baidu,
    // dropped stackoverflow/hn/auto, lied "default bing").
    {
      const asMod = await import("./dist/tm/args-schema.js")
      const sArgs = await asMod.buildSearchArgsSchema()
      const engDesc = sArgs.engine?.description ?? sArgs.engine?.descriptor ?? ""
      for (const live of [...sm.SEARCH_ENGINE_NAMES, "auto"]) {
        assert.ok(
          new RegExp(`(^|[|(,\\s])${live}([|,\\s)]|$)`).test(engDesc),
          `args descriptor names the live engine "${live}"`,
        )
      }
      for (const dead of ["sogou", "baidu"]) {
        assert.ok(!engDesc.toLowerCase().includes(dead.toLowerCase()), `args descriptor no longer names dead engine "${dead}"`)
      }
      assert.match(engDesc, /default auto/, "args descriptor states the real default (auto)")
    }
    assert.equal(sm.classifyQuery("ERR_MODULE_NOT_FOUND 加载失败"), "error-code", "ERR_ token -> error-code (wins over CJK)")
    assert.equal(sm.classifyQuery("useEffect cleanup runs twice"), "error-code", "camelCase API name -> error-code")
    assert.equal(sm.classifyQuery("new framework release notes"), "dev-ecosystem", "ecosystem vocab -> dev-ecosystem")
    assert.equal(sm.classifyQuery("初音未来演唱会"), "cjk", "CJK natural language -> cjk")
    assert.equal(sm.classifyQuery("best coffee in Paris"), "general", "plain query -> general")
    assert.deepEqual(
      sm.resolveAutoRoutes("new framework release"),
      { routes: ["hn", "github", "npm"], queryClass: "dev-ecosystem", notes: [] },
      "dev-ecosystem fan-out set",
    )
    // 2026-09-18: cjk/general used to route to bing ALONE (no consensus, no
    // fusion, a raw bing mirror).  Every route now has >=2 legs.
    assert.deepEqual(
      sm.resolveAutoRoutes("初音未来").routes,
      ["bing", "moegirl", "stackoverflow", "hn"],
      "cjk fans out to bing + a CN wiki + two dev legs",
    )
    assert.deepEqual(
      sm.resolveAutoRoutes("best coffee in Paris").routes,
      ["bing", "stackoverflow", "hn", "github"],
      "general fans out to bing + three JSON legs",
    )
    assert.deepEqual(
      sm.resolveAutoRoutes("初音未来", ["moegirl", "hn", "stackoverflow"]).routes,
      ["bing"],
      "TM_SEARCH_DISABLED_ENGINES removes legs from a route",
    )
    assert.match(
      sm.resolveAutoRoutes("初音未来", ["moegirl", "hn", "stackoverflow"]).notes.join(" "),
      /单引擎路由/,
      "a degenerate single-engine route says so (no consensus available)",
    )
    assert.deepEqual(
      sm.resolveAutoRoutes("初音未来", ["bing", "moegirl", "stackoverflow", "hn"]).routes,
      ["bing"],
      "disabling EVERY leg of a route still answers (falls back to bing, never errors)",
    )
    assert.deepEqual(
      sm.resolveAutoRoutes("ERR_MODULE_NOT_FOUND").routes,
      ["stackoverflow", "github", "bing"],
      "error-code fan-out set unchanged",
    )
    // CJK phrase protection: core = the most-CJK token, quoted; passthrough
    // cases stay byte-exact (single word / already quoted / <2 CJK chars).
    assert.equal(sm.protectCjkPhrase("开源 大模型 推理框架"), '开源 大模型 "推理框架"', "core CJK phrase auto-quoted")
    assert.equal(sm.protectCjkPhrase("大模型"), "大模型", "single token untouched")
    assert.equal(sm.protectCjkPhrase('已加 "引号" 的查询'), '已加 "引号" 的查询', "user quoting respected")
    assert.equal(sm.protectCjkPhrase("a 大 b"), "a 大 b", "1-char CJK token not phrase-able")
    // github qualifier folding: whitelisted qualifiers move into q= after the
    // free text; non-whitelisted (owner:) stays plain free text.
    const folded = sm.foldGithubQualifiers("stars:>1 v org:x db language:go owner:me")
    assert.deepEqual(folded.qualifiers, ["stars:>1", "org:x", "language:go"], "whitelisted qualifiers extracted")
    assert.equal(folded.q, "v db owner:me stars:>1 org:x language:go", "free text first, qualifiers folded")
    assert.equal(sm.dedupeKey("https://WWW.Example.com/a/b/?x=1#frag"), "example.com/a/b", "dedupe key = host+path, query/frag/www/slash stripped")
    const fusedUnit = sm.fuseRrf([
      { engine: "bing", hits: [{ title: "A", url: "https://example.com/a" }, { title: "B", url: "https://example.com/b" }] },
      { engine: "stackoverflow", hits: [{ title: "C", url: "https://example.com/c" }, { title: "A dup", url: "https://www.example.com/a/" }] },
    ])
    assert.deepEqual(fusedUnit.map((h) => h.title), ["A", "C", "B"], "weighted RRF: deduped A (bing r0 + SO r1) tops, then SO r0 C, then bing r1 B")
    assert.equal(fusedUnit[0].source, "bing+stackoverflow", "deduped hit carries merged sources")
    assert.deepEqual(fusedUnit.map((h) => h.rank), [1, 2, 3], "fused ranks are 1-based")

    // 2026-09-18 relevance floor: bing's 0.4 trust weight used to beat ANY
    // other engine's best hit no matter how off-topic it was (0.4/70 >
    // 0.2/61).  A hit sharing no query token now keeps only the floor
    // fraction of its weight, so a relevant low-trust hit can win.
    {
      const bingLeg = {
        engine: "bing",
        hits: [
          { title: "完全无关的娱乐新闻", url: "https://junk.example/1" },
          { title: "另一条无关结果", url: "https://junk.example/2" },
        ],
      }
      const hnLeg = { engine: "hn", hits: [{ title: "Redis pipeline 性能", url: "https://news.ycombinator.com/item?id=9" }] }
      const before = sm.fuseRrf([bingLeg, hnLeg])
      assert.equal(before[0].url, "https://junk.example/1", "no query passed = pure rank fusion (legacy behavior preserved)")
      const after = sm.fuseRrf([bingLeg, hnLeg], { query: "redis pipeline 性能" })
      assert.equal(after[0].url, "https://news.ycombinator.com/item?id=9", "a relevant hn hit outranks two zero-overlap bing hits")
      assert.equal(
        sm.fuseRrf([bingLeg, hnLeg], { query: "redis pipeline 性能", floor: 1, weights: { bing: 0.4 } })[0].url,
        "https://junk.example/1",
        "the old regime is still reachable by config (floor=1 + bing 0.4 = trust owns the list)",
      )
      assert.equal(after.find((h) => h.url.endsWith("/1")).fetchable, undefined, "fetchable unset when no predicate supplied")
      const tagged = sm.fuseRrf([bingLeg, hnLeg], { query: "redis", fetchable: (u) => u.includes("junk.example") })
      assert.equal(tagged.find((h) => h.url.includes("news.ycombinator")).fetchable, false, "unfetchable hit tagged for the renderer")
    }
    assert.deepEqual(
      sm.queryTerms("Redis Pipeline 性能").sort(),
      ["pipeline", "性能", "redis"].sort(),
      "latin tokens lowercased + a 2-char CJK run indexed as its own bigram",
    )
    assert.equal(sm.queryTerms("  ").length, 0, "blank query = no terms (relevance stays 1, nothing to demote)")
    assert.ok(sm.queryTerms("Redis Pipeline").includes("pipeline"), "latin token lowercased into the term set")
    assert.ok(sm.queryTerms("键词").includes("键词"), "CJK bigram indexed for segmenter-free overlap")
    assert.equal(sm.relevanceOf(["redis"], { title: "Redis vs KeyDB", url: "https://x/1", snippet: undefined }), 1, "full overlap = 1")
    assert.equal(sm.relevanceOf(["redis"], { title: "无关", url: "https://x/1" }), 0, "zero overlap = 0")
    assert.equal(sm.weightFor("bing", { bing: 0.9 }), 0.9, "TM_SEARCH_WEIGHTS override wins")
    assert.equal(sm.weightFor("bing"), sm.RRF_DEFAULT_WEIGHT, "bing lost its 0.4 trust weight")
    assert.equal(sm.weightFor("stackoverflow"), 0.4, "stackoverflow keeps the trust weight")

    // engine table sanity: every buildUrl host is allowlisted by the
    // T4-MERGED seeds (api.stackexchange.com + hn.algolia.com included)
    const wfSeeds = (await import("./dist/tm/webfetch.js")).seedWebfetchDomains(tm.DEFAULT_WEBFETCH_DOMAINS)
    const seeds = wfSeeds
    for (const key of tm.SEARCH_ENGINE_NAMES) {
      const eng = tm.SEARCH_ENGINES[key]
      assert.ok(eng && typeof eng.buildUrl === "function", `engine ${key} defined`)
      const u = new URL(eng.buildUrl(encodeURIComponent("测试 q")))
      assert.equal(tm.hostAllowed(u.hostname, seeds), true, `engine ${key} host ${u.hostname} allowlisted`)
      assert.ok(tm.checkWebUrl(u.toString(), seeds).ok, `engine ${key} url passes checkWebUrl`)
    }
    assert.deepEqual(
      tm.SEARCH_ENGINE_NAMES.slice().sort(),
      ["bilibili", "bing", "bing-int", "github", "hn", "moegirl", "npm", "stackoverflow"],
      "engine roster via the index re-export",
    )

    // ---- 2026-09-19 trace findings: the engine that IGNORED the query ----
    {
      const dg = await import("./dist/tm/dupe-guard.js")
      const h = (u, title = "t", snippet = "") => ({ url: u, title, snippet })
      const sigA = dg.hitSignature([h("https://a.test/x"), h("https://b.test/y")])
      assert.equal(sigA, dg.hitSignature([h("https://www.b.test/y"), h("https://a.test/x")]), "the signature is order-free and www-insensitive (a re-rank is the same answer)")
      assert.notEqual(sigA, dg.hitSignature([h("https://a.test/x"), h("https://c.test/z")]), "a different set is a different signature")
      assert.equal(dg.hitsShareAnyQueryTerm([h("https://x.test/a", "舞的解释", "跳舞")], ["舞萌", "maimai"]), false, "a page about the single character 舞 does NOT match the term 舞萌 (bigram口径)")
      assert.equal(dg.hitsShareAnyQueryTerm([h("https://x.test/a", "舞萌DX 介绍")], ["舞萌"]), true, "a real hit matches")
      assert.equal(dg.hitsShareAnyQueryTerm([], ["x"]), true, "no hits is not 'irrelevant', it is empty (the caller handles that separately)")

      const g = dg.createDupeGuard()
      const junk = [h("https://baike.baidu.com/item/舞"), h("https://zidian.test/zi-33310")]
      const v1 = g.observe("bing", '"舞萌DX" "你好世界"', junk, ["舞萌", "你好世界"])
      assert.equal(v1.collapse, false, "the first answer cannot be judged a collapse")
      assert.equal(v1.irrelevant, true, "…but it IS flagged as unrelated to what was asked")
      assert.ok(v1.note.includes("没有任何一条提到查询词"), "and the note says so plainly")
      const v2 = g.observe("bing", '"舞萌DX" "我的世界"', junk, ["舞萌", "我的世界"])
      assert.equal(v2.collapse, true, "the SAME set for a DIFFERENT query = the engine ignored the qualifiers")
      assert.ok(v2.note.includes("完全相同"), "the directive names the failure")
      assert.ok(v2.note.includes("拆成一次查询"), "and gives a next step, not a shrug")
      const v3 = g.observe("bing", "第三个问题", junk, ["第三个", "问题"])
      assert.equal(v3.repeats, 3, "the repeat count climbs so the escalation can trigger")
      assert.equal(g.stalled("bing").blocked, false, "two collapses is still a warning — the block counts COLLAPSES, not repeats")
      const v4 = g.observe("bing", "第四个问题", junk, ["第四个", "问题"])
      assert.ok(
        v4.note.includes("v1 是 task") && v4.note.includes("v2 是 subagent") && v4.note.includes("background:true"),
        "at the limit the escalation names the host's sub-agent tool for BOTH personalities — a rule naming a tool v2 has never heard of is advice nobody can take",
      )
      // #15: the advisory version was tried in a live session and ignored — the
      // collapse counter climbed 2→3→4→5→6 across ~50 tm_search calls. At the
      // limit the engine is refused, which is the one escalation that cannot be
      // skipped, because the call is simply not made.
      assert.equal(g.stalled("bing").blocked, true, "the engine is now BLOCKED, not merely warned")
      assert.ok(v4.note.includes("它已被封锁"), "and the note says so in the same words the refusal will use")
      g.observe("bing", "第五个问题", [h("https://different.example/", "别的答复")], ["第五个", "问题"])
      assert.equal(g.stalled("bing").blocked, false, "a genuinely different result set resets the stall — one bad stretch must not mute an engine for the process")
      assert.equal(g.stalled("never-asked").blocked, false, "an engine with no history is never blocked")
      const g2 = dg.createDupeGuard()
      const good = [h("https://maimai.sega.com/", "maimai DX"), h("https://zhuanlan.zhihu.com/p/1", "舞萌DX 是什么")]
      assert.equal(g2.observe("bing", "舞萌DX", good, ["舞萌"]).note, "", "a normal, on-topic result set gets NO warning text")
      assert.equal(g2.stalled("bing").blocked, false, "…and does not stall the engine")
    }

    // bing's international layout wraps EVERY hit in /ck/a?…u=a1<base64> —
    // dropping those is what made the engine look "100% dead" in 2026-09-14.
    {
      const wfx = await import("./dist/tm/webfetch.js")
      const target = "https://jinyan.baidu.com/see/12345"
      const wrapped = "https://www.bing.com/ck/a?!&&p=159463ac&ptn=3&u=a1" + Buffer.from(target).toString("base64")
      assert.equal(wfx.decodeEngineWrapperUrl(wrapped), target, "the /ck/a wrapper decodes to the real destination")
      assert.equal(wfx.decodeEngineWrapperUrl("https://www.bing.com/ck/a?!u=notbase64%24%24"), null, "an undecodable wrapper returns null (and is then skipped as before)")
      assert.equal(wfx.decodeEngineWrapperUrl("https://example.com/ck/a?u=a1aGVsbG8"), null, "only bing's wrapper is decoded — no general unwrapping")
      const intlHtml = `<ol><li class="b_algo"><h2><a target="_blank" href="${wrapped.replace(/&/g, "&amp;")}">maimai DX 官网</a></h2><p>SEGA 音乐游戏</p></li></ol>`
      const extracted = wfx.extractSearchHits(intlHtml)
      assert.equal(extracted.length, 1, "extractSearchHits now keeps a wrapped hit instead of discarding it")
      assert.equal(extracted[0].url, target, "with the tracker URL replaced by the destination")
    }

    // HTML SERP extraction through the registered tool (bing b_algo shape;
    // the THIRD hit carries a b_caption -> snippet, the first two do NOT)
    const realFetch = globalThis.fetch
    const res200 = (body, ctype = "text/html; charset=utf-8") => {
      const enc = new TextEncoder().encode(body)
      return {
        status: 200,
        headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? ctype : null) },
        body: {
          getReader: () => {
            let done = false
            return {
              read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: enc })),
              cancel: async () => {},
            }
          },
        },
      }
    }
    const bingSerp = `<html><body>
      <li class="b_algo"><h2><a href="https://example.org/great-result">Great result about 测试</a></h2><p>snippet one</p></li>
      <li class="b_algo"><h2><a href="https://cn.bing.com/ck/a?u=aHR0">tracked ad</a></h2><p>ad</p></li>
      <li class="b_algo"><h2><a href="https://example.net/second">Second hit</a></h2><p>snippet two</p></li>
      <li class="b_algo"><h2><a href="https://example.org/captioned">Captioned hit 测试</a></h2><div class="b_caption"><p class="b_lineclamp2">This caption rides along &amp; decodes</p></div></li>
      <a href="https://cn.bing.com/search?q=x&amp;first=2">下一页</a>
      <a href="/images">Images</a>
    </body></html>`
    const npmJson = JSON.stringify({
      total: 2,
      objects: [
        { package: { name: "left-pad", version: "1.3.0", description: "String left pad" } },
        { package: { name: "right-pad", version: "2.1.0", description: "String right pad" } },
      ],
    })
    const ghJson = JSON.stringify({
      total_count: 1,
      items: [{ full_name: "owner/repo", stargazers_count: 4321, description: "A repo", html_url: "https://github.com/owner/repo" }],
    })
    const mwJson = JSON.stringify({
      query: {
        searchinfo: { totalhits: 42 },
        search: [
          { title: "初音未来", snippet: '虚拟歌手 <span class="searchmatch">Hatsune</span> Miku' },
          { title: "VOCALOID", snippet: "语音合成引擎" },
        ],
      },
    })
    // stackoverflow api.search/advanced shape — the FIRST item deliberately
    // collides with bing's great-result URL (fusion dedupe pin); quota
    // fields ride every response.
    const soHealthy = JSON.stringify({
      items: [
        { title: "SO great question 测试", link: "https://example.org/great-result", score: 42, answer_count: 3, is_answered: true, tags: ["javascript", "react", "hooks", "extra"] },
        { title: "SO only question", link: "https://example.io/so-only", score: 1, answer_count: 0, is_answered: false, tags: ["css"] },
      ],
      total: 2,
      quota_remaining: 298,
      quota_max: 300,
    })
    let soBody = soHealthy
    const soZero = JSON.stringify({
      items: [{ title: "SO listing after exhaustion", link: "https://example.io/so-zero", score: 0, answer_count: 0, is_answered: false, tags: [] }],
      total: 1,
      quota_remaining: 0,
      quota_max: 300,
    })
    const hnJson = JSON.stringify({
      hits: [
        { title: "Show HN: Vector db in Rust", url: "https://example.org/hn-post", points: 120, num_comments: 45, objectID: "41", created_at: "2026-01-02T03:04:05Z" },
        { title: "Ask HN: Hiring thread", url: null, points: 30, num_comments: 20, objectID: "42", created_at: "2026-02-01T00:00:00Z" },
      ],
      nbHits: 2,
    })
    const reqUrls = []
    globalThis.fetch = async (input) => {
      const url = String(input)
      reqUrls.push(url)
      if (url.includes("bing.com/search")) return res200(bingSerp)
      if (url.includes("registry.npmjs.org/-/v1/search")) return res200(npmJson, "application/json")
      if (url.includes("api.github.com/search")) return res200(ghJson, "application/json")
      if (url.includes("mobile.moegirl.org.cn/api.php")) return res200(mwJson, "application/json")
      if (url.includes("api.stackexchange.com")) return res200(soBody, "application/json")
      if (url.includes("hn.algolia.com")) return res200(hnJson, "application/json")
      return res200("<html></html>")
    }
    try {
      // engine:"auto" is the DEFAULT (cfg.searchDefaultEngine="auto"):
      // a CJK query now fans out over bing + a CN wiki + two dev legs, and
      // the relevant bing hit still tops the fused list.
      const autoCjk = await reg.execute({ query: "测试 q" }, ctx)
      assert.ok(autoCjk.output.includes('auto × "测试 q"'), "auto default: multi-leg route, header names auto (not auto→bing)")
      assert.ok(autoCjk.output.includes("路由 bing+moegirl+stackoverflow+hn"), "cjk route table drives the fan-out")
      assert.ok(autoCjk.output.includes("RRF 融合"), "multi-engine route fuses rather than dumping one SERP")
      assert.ok(
        autoCjk.output.includes("[bing+stackoverflow] Great result about 测试"),
        "auto hits are source-tagged — and a multi-leg route can actually report cross-engine agreement",
      )
      {
        const iConsensus = autoCjk.output.indexOf("[bing+stackoverflow] Great result")
        const iWiki = autoCjk.output.indexOf("[moegirl] 初音未来")
        assert.ok(iConsensus >= 0 && iWiki >= 0 && iConsensus < iWiki, "the relevant consensus hit outranks a zero-overlap wiki hit")
      }

      // explicit bing — plain title+URL list (no auto labeling)
      const bing = await reg.execute({ query: "测试 q", engine: "bing" }, ctx)
      assert.ok(bing.output.includes("[search] bing × \"测试 q\""), "search header carries engine + raw query")
      assert.ok(bing.output.includes("Great result about 测试") && bing.output.includes("https://example.org/great-result"), "hit title+url extracted")
      assert.ok(!bing.output.includes("cn.bing.com/ck"), "click-tracker anchor excluded")
      assert.ok(!bing.output.includes("下一页") && !bing.output.includes("/images"), "engine chrome anchors excluded")
      assert.ok(bing.output.includes("2. Second hit"), "hits are numbered")
      assert.ok(!bing.output.includes("snippet one"), "plain <p> chrome NOT fabricated as a snippet")
      assert.ok(bing.output.includes("3. Captioned hit 测试") && bing.output.includes("This caption rides along & decodes"), "bing b_caption kept as the hit snippet (entities decoded)")

      // CJK phrase protection on the wire: the core phrase reaches bing quoted
      reqUrls.length = 0
      const cjkRes = await reg.execute({ query: "开源 大模型 推理框架", engine: "bing" }, ctx)
      const cjkUrl = reqUrls.find((u) => u.includes("bing.com/search"))
      // a missing request is the finding — report it as one instead of
      // crashing inside new URL(undefined)
      assert.ok(cjkUrl, `the bing leg must hit the wire; reqUrls=${JSON.stringify(reqUrls)} output=${String(cjkRes.output).slice(0, 200)}`)
      const cjkQ = new URL(cjkUrl).searchParams.get("q")
      assert.equal(cjkQ, '开源 大模型 "推理框架"', "multi-word CJK query hits bing with its core phrase quoted")

      // github qualifier pass-through on the wire (whitelisted only, reordered
      // after the free text which stays free text)
      reqUrls.length = 0
      const gh = await reg.execute({ query: "repo stars:>500 language:rust org:redis", engine: "github" }, ctx)
      const ghUrl = reqUrls.find((u) => u.includes("api.github.com/search"))
      assert.ok(ghUrl, `the github leg must hit the wire; reqUrls=${JSON.stringify(reqUrls)} output=${String(gh.output).slice(0, 200)}`)
      const ghQ = new URL(ghUrl).searchParams.get("q")
      assert.equal(ghQ, "repo stars:>500 language:rust org:redis", "github q= = free text + folded qualifiers")
      assert.ok(gh.output.includes("owner/repo ★4321 — A repo"), "github JSON → owner/repo ★stars — desc")
      assert.ok(gh.output.includes("https://github.com/owner/repo"), "github hit links to the repo page")

      const npm = await reg.execute({ query: "left pad", engine: "npm" }, ctx)
      assert.ok(npm.output.includes("left-pad@1.3.0 — String left pad"), "npm JSON → name@version + description")
      assert.ok(npm.output.includes("https://registry.npmjs.org/left-pad/latest"), "npm hit links to the registry metadata URL")

      const mw = await reg.execute({ query: "初音", engine: "moegirl" }, ctx)
      assert.ok(mw.output.includes('[search] moegirl × "初音" → 42 条词条'), "moegirl MediaWiki API → header with totalhits")
      assert.ok(mw.output.includes("1. 初音未来 — 虚拟歌手 Hatsune Miku"), "moegirl hit: title + tag-stripped snippet")
      assert.ok(mw.output.includes(`https://mobile.moegirl.org.cn/${encodeURIComponent("初音未来")}`), "moegirl hit links to the article URL")

      // stackoverflow explicit: metadata composite snippet + quota tracking
      const so = await reg.execute({ query: "react hook cleanup", engine: "stackoverflow" }, ctx)
      assert.ok(so.output.includes('[search] stackoverflow × "react hook cleanup"'), "SO header with raw query")
      assert.ok(so.output.includes("score 42 · 3 回答 · 已采纳 · tags: javascript, react, hooks"), "SO snippet synthesized from score/answers/tags (engine metadata)")
      assert.ok(so.output.includes("298/300"), "SO quota footer reflects quota_remaining")
      assert.equal(sm.SO_QUOTA.remaining, 298, "quota tracked from the response")
      assert.equal(sm.SO_QUOTA.exhausted, false, "remaining>0 keeps SO routable")

      // HN explicit: points/comments snippet, URL-less story falls to the
      // item page (engine-provided objectID, not fabricated)
      const hn = await reg.execute({ query: "vector db", engine: "hn" }, ctx)
      assert.ok(hn.output.includes("1. Show HN: Vector db in Rust — 120 分 · 45 评论 · 2026-01-02"), "HN metadata snippet from engine fields")
      assert.ok(hn.output.includes("https://example.org/hn-post"), "HN hit keeps the story URL")
      assert.ok(hn.output.includes("https://news.ycombinator.com/item?id=42"), "Ask HN (null url) links to its comment page via objectID")

      // SO quota exhaustion -> auto degrades the SO leg to bing
      soBody = soZero
      const so0 = await reg.execute({ query: "boom", engine: "stackoverflow" }, ctx)
      assert.ok(so0.output.includes("已耗尽"), "quota_remaining=0 surfaces the exhausted notice (explicit call still served)")
      assert.equal(sm.SO_QUOTA.exhausted, true, "exhaustion latched")
      soBody = JSON.stringify({ items: [], total: 0 }) // SO 空转，降级路径不再取它
      const autoErr = await reg.execute({ query: "ERR_CONNECTION_REFUSED 连接失败" }, ctx)
      assert.ok(autoErr.output.includes("配额耗尽"), "auto notes the stackoverflow→bing degrade")
      assert.ok(!autoErr.output.includes("[stackoverflow]"), "degraded auto carries no SO hits")
      assert.ok(autoErr.output.includes("[bing]"), "auto degrade still lands bing hits")
      searchModResetQuota()
      soBody = soHealthy

      // auto RRF fusion e2e: error-code query -> SO+github+bing fan-out,
      // the SO/bing URL collision dedupes to ONE merged-source hit on top.
      const fused = await reg.execute({ query: "TypeError fetch failed ERR_TYPE", engine: "auto" }, ctx)
      assert.ok(fused.output.includes("RRF 融合"), "multi-route fusion header")
      assert.ok(fused.output.includes("路由 stackoverflow+github+bing"), "routes named in the header")
      assert.equal((fused.output.match(/example\.org\/great-result/g) || []).length, 1, "host+path collision deduped across engines")
      assert.ok(fused.output.includes("[stackoverflow+bing]"), "deduped hit tags BOTH contributing sources")
      assert.ok(fused.output.indexOf("stackoverflow+bing") < fused.output.indexOf("[stackoverflow]"), "merged top hit outranks single-source hits")
      assert.ok(fused.output.includes("[github] owner/repo"), "github leg fused in with its source tag")

      const unknown = await reg.execute({ query: "x", engine: "yahoo" }, ctx)
      assert.ok(unknown.output.includes("phase=args") && unknown.output.includes("未知引擎") && unknown.output.includes("auto") && unknown.output.includes("bing"), "unknown engine → args error naming auto + roster")
      const noq = await reg.execute({}, ctx)
      assert.ok(noq.output.includes("phase=args") && noq.output.includes("缺少 query"), "missing query → args error")
      const empty = await reg.execute({ query: "whatever", engine: "bilibili" }, ctx)
      assert.ok(
        empty.output.includes("没有返回可提取的结果") && empty.output.includes("bing"),
        "thin SERP → switch-engine hint with alternatives",
      )
    } finally {
      globalThis.fetch = realFetch
    }

    // narrowed allowlist + ctx.ask → out-of-allowlist ENGINE asks the user
    {
      const narrowCfg = { ...runtime.config, webfetchAllowedDomains: ["cn.bing.com"] }
      const narrow = tm.buildTmSearchTool({ pipelines: runtime.pipelines, cfg: narrowCfg })
      let askedPatterns = null
      const ctxA = { directory: root6, ask: async (req) => { askedPatterns = req.patterns; return "once" } }
      const ctxD = { directory: root6, ask: async () => { throw new Error("no") } }
      const realFetch2 = globalThis.fetch
      globalThis.fetch = async () => res200(npmJson, "application/json")
      try {
        const okNpm = await narrow.execute({ query: "left pad", engine: "npm" }, ctxA)
        assert.ok(okNpm.output.includes("left-pad@1.3.0"), "approved out-of-allowlist engine proceeds via the official dialog")
        assert.ok(Array.isArray(askedPatterns) && String(askedPatterns[0]).includes("registry.npmjs.org"), "dialog patterns carry the engine URL")
        const noNpm = await narrow.execute({ query: "x", engine: "npm" }, ctxD)
        assert.ok(noNpm.output.includes("phase=permission") && noNpm.output.includes("用户未批准"), "rejected engine dialog → permission error")
      } finally {
        globalThis.fetch = realFetch2
      }
    }

    // tracker + hit-blacklist pins (real-session regressions):
    //  - so.com wraps hits through so.com/link?m=… and surfaces ai.so.com
    //    (its own AI tab) — both are engine-internal, never "results"
    //  - maimai.cn is 脉脉 (professional networking), NOT the maimai DX game
    //    — bing returned 10/10 maimai.cn hits for every maimai DX query
    {
      const noisy = [
        '<a href="https://www.so.com/link?m=abc123def">舞萌DX 入坑教程</a>',
        '<a href="https://ai.so.com/search/?q=x">AI问答结果标题</a>',
        '<a href="https://maimai.cn/jobs">脉脉招聘页标题</a>',
        '<a href="https://maimai-net.cn/songs">maimai DX 曲库</a>',
        '<a href="https://zhuanlan.zhihu.com/p/1">知乎专栏文章</a>',
      ].join("\n")
      const hits = tm.extractSearchHits(noisy)
      const urls = hits.map((h) => h.url)
      assert.ok(!urls.some((u) => u.includes("so.com/link?")), "so.com/link? tracker excluded")
      assert.ok(!urls.some((u) => u.includes("ai.so.com")), "ai.so.com engine-internal page excluded")
      assert.ok(!urls.some((u) => u.includes("maimai.cn/")), "maimai.cn (脉脉) excluded by the default blacklist")
      assert.ok(urls.some((u) => u.includes("maimai-net.cn")), "legit maimai-net.cn hit kept")
      assert.ok(urls.some((u) => u.includes("zhihu.com")), "legit zhihu hit kept")
      // custom blacklist param (caller-level)
      const custom = tm.extractSearchHits(noisy, 10, ["zhihu.com"])
      assert.ok(!custom.some((h) => h.url.includes("zhihu.com")), "injected blacklist respected")
      // env extension (lazy read)
      process.env.TM_HIT_BLACKLIST = "maimai-net.cn"
      try {
        const envHits = tm.extractSearchHits(noisy)
        assert.ok(!envHits.some((h) => h.url.includes("maimai-net.cn")), "TM_HIT_BLACKLIST env extension respected")
      } finally {
        delete process.env.TM_HIT_BLACKLIST
      }
      assert.ok(tm.HIT_DOMAIN_BLACKLIST_DEFAULT.includes("maimai.cn"), "default blacklist pins maimai.cn")
    }

    // unit-level: extractor handles single-quoted hrefs + entity titles
    const unit = tm.extractSearchHits(`<a href='https://example.com/a&amp;b'>A &amp; B research</a>`)
    assert.ok(unit.length === 1 && unit[0].url === "https://example.com/a&b" && unit[0].title === "A & B research", "extractor: single-quote href + entity decode")
  }
  console.log("6m-s. tm_search: OK (T4 roster: dead engines gone, SO+HN in, auto default w/ RRF fusion + dedupe + SO-quota degrade, args-schema descriptor derived from the live engine table (anti-drift), snippets engine-kept never fabricated, CJK phrase guard, github qualifier pass-through, trackers/chrome + hit-domain blacklist (maimai.cn, so.com/link?, ai.so.com, env-extensible), npm/github/moegirl structured, switch-engine hint, args-phase validation)")

  // 6p. PARALLEL SAFETY — the host may Promise.all a batch of tool calls;
  // tm_search / tm_webfetch / tm_fetch executes must never cross-
  // contaminate.  Mechanism: the step counter advances synchronously
  // (unique step ids even when executes interleave at await points) and
  // every store write is keyed by step id.  Proven with 4 concurrent
  // searches (each SERP tagged per engine → isolated hit lists) + 2
  // concurrent offloading webfetches (distinct handles, isolated payloads)
  // + concurrent tm_fetch page-ins of those handles.
  {
    const realFetch = globalThis.fetch
    const bigTag = (tag) => `payload-${tag} ` + "x".repeat(12000) + ` end-${tag}`
    const encRes = (body, ctype = "text/html; charset=utf-8") => {
      const enc = new TextEncoder().encode(body)
      return {
        status: 200,
        headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? ctype : null) },
        body: {
          getReader: () => {
            let done = false
            return {
              read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: enc })),
              cancel: async () => {},
            }
          },
        },
      }
    }
    globalThis.fetch = async (input) => {
      const url = String(input)
      const m = /tag-([a-z0-9-]+)/.exec(url)
      const tag = m ? m[1] : "untagged"
      if (url.includes("moegirl.org.cn")) return encRes(`<html><body>${bigTag(tag)}</body></html>`)
      if (url.includes("api.stackexchange.com")) {
        return encRes(
          JSON.stringify({
            items: [
              { title: `First hit for ${tag}`, link: `https://example.org/${tag}-r1`, score: 5, answer_count: 2, is_answered: true, tags: ["js"] },
              { title: `Second hit for ${tag}`, link: `https://example.net/${tag}-r2`, score: 1, answer_count: 0, is_answered: false, tags: [] },
            ],
            total: 2,
            quota_remaining: 250,
            quota_max: 300,
          }),
          "application/json",
        )
      }
      if (url.includes("hn.algolia.com")) {
        return encRes(
          JSON.stringify({
            hits: [
              { title: `First hit for ${tag}`, url: `https://example.org/${tag}-r1`, points: 9, num_comments: 2, objectID: "1", created_at: "2026-03-04T00:00:00Z" },
              { title: `Second hit for ${tag}`, url: `https://example.net/${tag}-r2`, points: 1, num_comments: 0, objectID: "2", created_at: "2026-03-05T00:00:00Z" },
            ],
            nbHits: 2,
          }),
          "application/json",
        )
      }
      return encRes(
        `<html><body><li><h2><a href="https://example.org/${tag}-r1">First hit for ${tag}</a></h2></li>` +
          `<li><h2><a href="https://example.net/${tag}-r2">Second hit for ${tag}</a></h2></li></body></html>`,
      )
    }
    try {
      // T4 roster: bing + bilibili (html) and stackoverflow + hn (json) —
      // the parallel-safety proof survives the engine-table rework.
      const engines = ["bing", "bilibili", "stackoverflow", "hn"]
      const calls = [
        ...engines.map((e) => runtime.tools.tm_search.execute({ query: `probe tag-${e}`, engine: e }, ctx)),
        runtime.tools.tm_webfetch.execute({ url: "https://mobile.moegirl.org.cn/tag-wf-a?tag=wf-a" }, ctx),
        runtime.tools.tm_webfetch.execute({ url: "https://mobile.moegirl.org.cn/tag-wf-b?tag=wf-b" }, ctx),
      ]
      const outs = (await Promise.all(calls)).map((r) => r.output)
      // searches: each hit list is its own — no engine sees another's hits
      for (const [i, engine] of engines.entries()) {
        const o = outs[i]
        assert.ok(!o.includes("phase="), `parallel search ${engine} succeeded`)
        assert.ok(o.includes(`https://example.org/${engine}-r1`), `search ${engine} carries its own hits`)
        assert.ok(
          !engines.some((other) => other !== engine && o.includes(`example.org/${other}-r1`)),
          `search ${engine} carries NO other engine's hits`,
        )
      }
      // webfetches: both offloaded, DISTINCT step ids, isolated payloads
      const wfOuts = outs.slice(4)
      for (const o of wfOuts) {
        assert.ok(o.includes("已卸载") && o.includes("ref: tm://runs/"), "parallel webfetch offloaded to its own handle")
      }
      const refs = wfOuts.map(refOf)
      assert.equal(new Set(refs).size, refs.length, "parallel offloads got DISTINCT step ids (no counter race)")
      for (const [i, ref] of refs.entries()) {
        const stepId = /steps\/([^/]+)\/result/.exec(ref)[1]
        const file = runtime.store.readStepFile(stepId)
        const want = `payload-wf-${i === 0 ? "a" : "b"}`
        assert.ok(file !== null && file.content.includes(want), `payload ${stepId} holds its own tag (${want})`)
      }
      // both handles page back CONCURRENTLY through tm_fetch, each intact
      const toks = wfOuts.map(tokOf)
      const pages = (await Promise.all(refs.map((ref, i) => runtime.tools.tm_fetch.execute({ ref, access_token: toks[i] }, ctx)))).map((r) => r.output)
      for (const [i, p] of pages.entries()) {
        const want = `payload-wf-${i === 0 ? "a" : "b"}`
        assert.ok(p.includes(want), "concurrent tm_fetch returns its own payload start marker")
        assert.ok(p.includes(`end-wf-${i === 0 ? "a" : "b"}`), "payload intact end-to-end (no clobbering)")
      }
    } finally {
      globalThis.fetch = realFetch
    }
  }
  console.log("6p. parallel safety: OK (4 concurrent searches → isolated hit lists; 2 concurrent offloads → distinct step ids + isolated payloads; concurrent tm_fetch page-ins)")

  // 6q. AUTO store isolation.  The tmpdir fallback used to be ONE global
  // bucket, so a non-git workspace's tm_stats reported every other non-git
  // workspace's traffic — measured live: a user's read-only self-check printed
  // "窗口 10 个 run · 墙钟 81370s" of events belonging to neither their session
  // nor their project (it was this repo's own test runs).
  {
    const dirA = mktmp("iso-a")
    const dirB = mktmp("iso-b")
    const rA = await tm.createTmTools({ directory: dirA, client: {}, $: () => ({}) }, {})
    const rB = await tm.createTmTools({ directory: dirB, client: {}, $: () => ({}) }, {})
    assert.notEqual(rA.store.trajectoryRoot, rB.store.trajectoryRoot, "two non-git workspaces get DIFFERENT trajectory roots")
    assert.notEqual(rA.store.blackboardRoot, rB.store.blackboardRoot, "…and different run stores, so no payload can be read across them")
    assert.ok(rA.store.trajectoryRoot.includes(path.join("opencode-team", "w-")), "the shard sits under the tmpdir fallback as opencode-team/w-<hash>")
    assert.equal(tm.workspaceStoreKey(dirA), tm.workspaceStoreKey(dirA + path.sep), "a trailing separator is the same workspace, not a second shard")
    assert.equal(tm.workspaceStoreKey("D:\\project\\docs"), tm.workspaceStoreKey("D:/project/docs"), "slash style never forks a shard")
    assert.notEqual(tm.workspaceStoreKey("D:\\扒取数据"), tm.workspaceStoreKey("D:\\文档"), "CJK paths do not collide — the old slug rules stripped both to one letter")
    // memories deliberately stay on the SHARED base: their project tier is
    // already keyed by project slug, and relocating it would strand what the
    // user already wrote.
    assert.ok(!rA.store.trajectoryRoot.includes(path.join("opencode-team", "memories")), "the run store moved; the memory tree did not")
    assert.ok(rA.store.trajectoryRoot.startsWith(path.join(os.tmpdir(), "opencode-team")), "…and the run store still lives under the same tmpdir base, just sharded")
    // …and the shards get reclaimed.  Without this every throwaway temp
    // workspace (i.e. every test runtime) leaves a permanent w-* directory —
    // 64 of them appeared in the user's Temp after a single dev session.
    {
      const base = path.join(mktmp("shardbase"), "opencode-team")
      const stale = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      for (const d of ["w-0000000001", "w-0000000002"]) {
        const p = path.join(base, d)
        fs.mkdirSync(path.join(p, "trajectory", "runs"), { recursive: true })
        fs.utimesSync(path.join(p, "trajectory", "runs"), stale, stale)
        fs.utimesSync(p, stale, stale)
      }
      fs.mkdirSync(path.join(base, "memories"), { recursive: true })
      const gone = tm.pruneStaleStoreShards(base, path.join(base, "w-0000000002"), 5 * 24 * 3600 * 1000)
      assert.deepEqual(gone, ["w-0000000001"], "only the inactive shard is reclaimed, and it says what it removed")
      assert.ok(fs.existsSync(path.join(base, "w-0000000002")), "the LIVE shard survives even when its mtimes are old")
      assert.ok(fs.existsSync(path.join(base, "memories")), "non-shard siblings (the memory tree) are none of its business")
      assert.deepEqual(tm.pruneStaleStoreShards(path.join(base, "nope"), path.join(base, "w-0000000002"), 1), [], "a missing base is a no-op, never a throw")
    // …and the pass is not gated on the CURRENT workspace being non-git.  It was,
    // which is how one machine accumulated 2,067 orphaned shards: someone who works
    // mostly in repositories never once booted the non-git branch that prunes them,
    // because a git workspace's own store IS the shared base and looks nothing like
    // a shard.  `keep: null` = "this workspace has no live shard to protect".
    {
      const b2 = path.join(mktmp("shardbase2"), "opencode-team")
      const stale = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      for (const d of ["w-00000000aa", "w-00000000bb"]) {
        const p = path.join(b2, d)
        fs.mkdirSync(p, { recursive: true })
        fs.utimesSync(p, stale, stale)
      }
      const gone2 = tm.pruneStaleStoreShards(b2, null, 5 * 24 * 3600 * 1000)
      assert.deepEqual(gone2.sort(), ["w-00000000aa", "w-00000000bb"], "with no live shard to protect, BOTH stale shards are reclaimed")
      // the live-shard-protecting form still works, so the fix is a gate change, not a semantic one
      fs.mkdirSync(path.join(b2, "w-00000000cc"), { recursive: true })
      fs.utimesSync(path.join(b2, "w-00000000cc"), stale, stale)
      assert.deepEqual(tm.pruneStaleStoreShards(b2, path.join(b2, "w-00000000cc"), 5 * 24 * 3600 * 1000), [], "and a named live shard is still spared")
    }
    {
      // End to end, in a SANDBOXED git workspace: boot with reclaim on and prove a
      // stale sibling in the tmpdir base disappears.  The workspace gets its own .git
      // directory rather than borrowing this repo's, so the test never writes into
      // the developer's real store, and TMPDIR already points at the runner's
      // throwaway root (see scripts/run-tests.mjs).
      const gitWs = mktmp("gitws")
      fs.mkdirSync(path.join(gitWs, ".git"), { recursive: true })
      const bucket = path.join(os.tmpdir(), "opencode-team")
      const staleShard = path.join(bucket, "w-000000dead")
      const freshShard = path.join(bucket, "w-100000dead")
      fs.mkdirSync(staleShard, { recursive: true })
      fs.mkdirSync(freshShard, { recursive: true })
      const old = new Date(Date.now() - 40 * 24 * 3600 * 1000)
      fs.utimesSync(staleShard, old, old)
      const prevReclaim = process.env.TM_STORE_RECLAIM
      process.env.TM_STORE_RECLAIM = "on"
      try {
        const rGit = await tm.createTmTools({ directory: gitWs, client: {}, $: () => ({}) }, {})
        assert.ok(rGit.store.trajectoryRoot.startsWith(path.join(gitWs, ".git")), "a git workspace keeps its store inside its own .git")
        assert.ok(!fs.existsSync(staleShard), "…and a git boot STILL reclaims the stale non-git shards (this is the wiring that used to be missing)")
        assert.ok(fs.existsSync(freshShard), "while a fresh sibling — possibly another window's live session — survives the TTL gate")
        await rGit.dispose?.()
      } finally {
        if (prevReclaim === undefined) delete process.env.TM_STORE_RECLAIM
        else process.env.TM_STORE_RECLAIM = prevReclaim
        for (const d of [staleShard, freshShard]) {
          try {
            fs.rmSync(d, { recursive: true, force: true })
          } catch {
            /* sandbox */
          }
        }
      }
    }
    }
    // …and the UPGRADE orphan: sharding left the pre-shard blackboard/ (runs +
    // webcache) and trajectory/ at the shared base with no sweeper pointed at
    // them — 503 MB and 2654 run dirs on one real machine.
    {
      const base = path.join(mktmp("legacy"), "opencode-team")
      const stale = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      const mk = (rel, when) => {
        const p = path.join(base, rel)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, "x")
        fs.utimesSync(p, when, when)
        fs.utimesSync(path.dirname(p), when, when)
      }
      mk(path.join("trajectory", "runs", "r-old", "steps.jsonl"), stale)
      mk(path.join("blackboard", "runs", "r-old2", "steps.jsonl"), stale)
      mk(path.join("blackboard", "webcache", "deadbeef"), stale)
      mk(path.join("blackboard", "runs", "r-fresh", "steps.jsonl"), new Date())
      mk(path.join("memories", "projects", "keep.md"), stale)
      fs.mkdirSync(path.join(base, "20260916-211828", "career-report-rewrite"), { recursive: true })
      const gone = tm.reclaimLegacyStoreBuckets(base, 5 * 24 * 3600 * 1000)
      assert.ok(!fs.existsSync(path.join(base, "trajectory", "runs", "r-old")), "the expired legacy trajectory run is gone")
      assert.ok(!fs.existsSync(path.join(base, "blackboard", "runs", "r-old2")), "…and the expired legacy blackboard run")
      assert.ok(!fs.existsSync(path.join(base, "blackboard", "webcache", "deadbeef")), "…and the unreachable web cache")
      assert.ok(!fs.existsSync(path.join(base, "trajectory")), "an emptied shell is removed, not left as a tombstone")
      assert.ok(fs.existsSync(path.join(base, "blackboard", "runs", "r-fresh")), "a run that has not aged out survives — a pre-upgrade session may still be writing")
      assert.ok(fs.existsSync(path.join(base, "memories", "projects", "keep.md")), "memories are none of its business, expired or not")
      assert.ok(fs.existsSync(path.join(base, "20260916-211828")), "the team blackboard's date dirs are none of its business either")
      assert.ok(gone.some((x) => x.startsWith("trajectory/runs/")), "it reports what it removed")
      assert.deepEqual(tm.reclaimLegacyStoreBuckets(path.join(base, "nope"), 1), [], "a missing base is a no-op, never a throw")
      assert.deepEqual(tm.reclaimLegacyStoreBuckets(base, 5 * 24 * 3600 * 1000), [], "a second pass finds nothing left to do (idempotent)")
    }
    await rA.dispose()
    await rB.dispose()
  }
  console.log("6q. AUTO store isolation: OK (per-workspace tmpdir shard, CJK-safe key, memories left on the shared base)")

  // 6n. tm_memory — project (repo .git) + GLOBAL (user profile) memory
  // mirror (Markdown + frontmatter, Qoder-style: write side = files,
  // retrieval = deterministic scoring).  Standalone build with an isolated
  // globalRoot so the user's real ~/.opencode-team is never touched; the
  // per-mkdtemp project slug isolates each test run under the shared
  // tmpdir store base.
  {
    const memReg = runtime.tools.tm_memory
    assert.ok(memReg && typeof memReg.execute === "function", "tm_memory registered on the runtime tool surface")
    const globalRoot = path.join(mktmp("memglobal"), "global")
    const mem = tm.buildTmMemoryTool({
      storeBase: path.join(os.tmpdir(), "opencode-team"),
      globalRoot,
      directory: root6,
      cfg: runtime.config,
      pipelines: runtime.pipelines,
    })
    const slug = tm.projectSlug(root6)
    const cleanup = () => fs.rmSync(path.join(os.tmpdir(), "opencode-team", "memories", "projects", slug), { recursive: true, force: true })
    try {
      // add: project scope with frontmatter
      const add = await mem.execute({
        action: "add", title: "Go 测试运行命令", scope: "project",
        category: "project_build_configuration",
        content: "运行测试必须先 cd 到项目根目录，然后执行 go test ./Processor/ -v。",
        keywords: "go test, Processor",
        usage_scenario: "本地运行测试前;CI 配置时",
      }, ctx)
      assert.ok(add.output.includes("已保存"), "add saves the memory")
      const projectDir = path.join(os.tmpdir(), "opencode-team", "memories", "projects", slug, "project_build_configuration")
      const files = fs.readdirSync(projectDir)
      assert.equal(files.length, 1, "one md file per title")
      const raw = fs.readFileSync(path.join(projectDir, files[0]), "utf8")
      assert.ok(raw.includes('"Go 测试运行命令"') && raw.includes("usage_scenario:") && raw.includes("go test"), "frontmatter + body round-trip")
      // add: same title + same category = update (not duplicate)
      await mem.execute({ action: "add", title: "Go 测试运行命令", scope: "project", category: "project_build_configuration", content: "更新后的内容。" }, ctx)
      assert.equal(fs.readdirSync(projectDir).length, 1, "same title+category updates in place")
      // add: same title WITHOUT category lands in the default slot — a
      // different memory (identity = scope + category + title slug)
      await mem.execute({ action: "add", title: "Go 测试运行命令", content: "更新后的内容。" }, ctx)
      assert.equal(fs.readdirSync(projectDir).length, 1, "default-category add does not touch the original")
      // add: global scope — lands in the USER-LEVEL dir (outside any repo),
      // which is what makes "global" actually follow the user across projects
      await mem.execute({ action: "add", title: "全局记忆样例", content: "全局事实。", scope: "global" }, ctx)
      const globalDirFiles = fs.readdirSync(globalRoot, { recursive: true }).filter((f) => String(f).endsWith(".md"))
      assert.equal(globalDirFiles.length, 1, "global memory written under the user-level globalRoot, not the repo .git")
      // content cap
      const tooBig = await mem.execute({ action: "add", title: "big", content: "x".repeat(4001) }, ctx)
      assert.ok(tooBig.output.includes("4000"), "content over cap → args error")
      // search: title/keyword scoring, excerpt
      const search = await mem.execute({ action: "search", query: "go test" }, ctx)
      assert.ok(search.output.includes("Go 测试运行命令") && search.output.includes("score"), "search hits by keyword/title with score")
      assert.ok(search.output.includes("更新后的内容"), "search returns the updated body")
      // search: scope filter
      const globalOnly = await mem.execute({ action: "search", query: "全局", scope: "global" }, ctx)
      assert.ok(globalOnly.output.includes("全局记忆样例"), "scope=global filter works")
      const projectOnly = await mem.execute({ action: "search", query: "全局", scope: "project" }, ctx)
      assert.ok(projectOnly.output.includes("无匹配"), "scope=project excludes global memories")
      // list: grouped
      const list = await mem.execute({ action: "list" }, ctx)
      assert.ok(list.output.includes("project/project_build_configuration") && list.output.includes("global/notes"), "list groups by scope/category")
      // forget: removes EVERY title match across scopes/categories
      const forget = await mem.execute({ action: "forget", title: "Go 测试运行命令" }, ctx)
      assert.ok(forget.output.includes("已删除 2"), "forget deletes all title matches (build-config + notes slots)")
      const after = await mem.execute({ action: "search", query: "go test" }, ctx)
      assert.ok(after.output.includes("无匹配"), "forgotten memory is gone")
      // slug-collision guard: two DIFFERENT titles sharing one slug — forget
      // must delete only the one whose frontmatter title actually matches
      await mem.execute({ action: "add", title: "API Rate Limits", content: "a fact", category: "project_build_configuration" }, ctx)
      await mem.execute({ action: "add", title: "API rate-limits", content: "another fact", category: "project_notes" }, ctx)
      const collide = await mem.execute({ action: "forget", title: "API Rate Limits" }, ctx)
      assert.ok(collide.output.includes("已删除 1"), "slug collision: only the exact frontmatter-title file is deleted")
      const collideSearch = await mem.execute({ action: "search", query: "another fact" }, ctx)
      assert.ok(collideSearch.output.includes("API rate-limits"), "the same-slug sibling SURVIVES the forget")
      // foreign md files are ignored by parse (project dir untouched otherwise)
      assert.equal(fs.readdirSync(projectDir).length, 0, "project memory dir empty after forget")
      // fs-safe regression: fs.rmSync silently no-ops on non-ASCII paths on
      // some Node/win32 builds — rmForceSafe must actually delete.
      const cjkFile = path.join(projectDir, "中文文件名.md")
      fs.writeFileSync(cjkFile, "x")
      tm.rmForceSafe(cjkFile)
      assert.ok(!fs.existsSync(cjkFile), "rmForceSafe deletes non-ASCII paths (win32 rmSync no-op regression)")
      // layered precedence (a): same-title global entry is SHADOWED by the
      // project one — search walks both layers but the global duplicate
      // never surfaces, and the shadow note says so
      await mem.execute({ action: "add", title: "分层记忆测试", scope: "project", content: "构建命令事实：npm run build" }, ctx)
      await mem.execute({ action: "add", title: "分层记忆测试", scope: "global", content: "构建命令事实：npm run build" }, ctx)
      const layered = await mem.execute({ action: "search", query: "构建命令" }, ctx)
      assert.ok(layered.output.includes("分层记忆测试") && layered.output.includes("(project/"), "shadowing: the project-layer hit is present")
      const shadowBlock = layered.output.split("\n\n").find((b) => b.includes("(global/") && b.includes("分层记忆测试"))
      assert.equal(shadowBlock, undefined, "shadowing: the same-title global entry never surfaces")
      assert.ok(layered.output.includes("已被项目层优先遮蔽"), "shadowing: the shadow note names the hidden global duplicate")
      // layered precedence (b): +2 project scope weight wins the near tie —
      // two DIFFERENT titles, one per scope, equivalent keyword relevance
      await mem.execute({ action: "add", title: "Near Tie Project", scope: "project", content: "kafka bootstrap servers fact" }, ctx)
      await mem.execute({ action: "add", title: "Near Tie Global", scope: "global", content: "kafka bootstrap servers fact" }, ctx)
      const nearTie = await mem.execute({ action: "search", query: "kafka" }, ctx)
      const projIdx = nearTie.output.indexOf("Near Tie Project")
      const globIdx = nearTie.output.indexOf("Near Tie Global")
      assert.ok(projIdx !== -1 && globIdx !== -1, "near-tie: both scope hits surface (different titles, no shadowing)")
      assert.ok(projIdx < globIdx, "near-tie: project block ranks BEFORE the global block (+2 project scope weight)")
      // layer guidance ships to agents via the tool description
      assert.ok(mem.description.includes("global — user-level conventions"), "tm_memory description documents the global layer")
    } finally {
      cleanup()
      fs.rmSync(path.join(os.tmpdir(), "opencode-team", "memories", "global"), { recursive: true, force: true })
    }
  }
  console.log("6n. tm_memory: OK (add/update/search scoring/list/forget, slug-collision guard, scope filter, content cap, frontmatter round-trip, layered project>global precedence (same-title shadowing + +2 weight))")

  // 6h. degraded path: store failure -> truncated + warning, task NOT failed
  {
    const blocker = path.join(mktmp("degraded"), "blocker.txt")
    fs.writeFileSync(blocker, "x") // a FILE where the blackboard dir should be
    process.env.TM_BLACKBOARD_DIR = blocker
    const runtimeD = await tm.createTmTools({
      directory: root6,
      client: fakeClient({ "big2000.txt": "c".repeat(80000) }), // 20k tokens
      $: fake$Ok(""),
    })
    delete process.env.TM_BLACKBOARD_DIR
    const degraded = offRead(runtimeD, "c".repeat(80000), "text", "path=big2000.txt").output
    assert.ok(degraded.includes("[警告]"), "degraded: warning banner present")
    assert.ok(degraded.includes("降级"), "degraded: warning text present")
    assert.ok(degraded.includes("--- 内容（截断）"), "degraded: truncation marker")
    assert.ok(degraded.includes("c".repeat(8000)), "degraded: truncated to threshold*4 chars in output")
  }
  console.log("6h. degraded path: OK (store failure -> truncated + warning in output, no throw)")

  // 6j. BUG#2 real-host client shapes (tm_read / tm_grep unwrap) — RETIRED with
  //  the v1 personality.  The ok-less file.read / find.text envelope unwrapping
  //  this group pinned lived inside tm_read/tm_grep, which are gone.  On v2 the
  //  host's native read/grep results are governed by src/host/v2-offload.ts
  //  through the SAME pipelines.govern, and its shape handling is pinned by
  //  test-v2-adapter (the native-offload group).
  console.log("6j. real-host client shapes: SKIPPED — tm_read/tm_grep retired with v1; v2 native unwrap pinned by test-v2-adapter")


  // 6i. trajectory append-only across real tool calls
  {
    const tjFile = runtime.store.trajectoryFile()
    const before = fs.readFileSync(tjFile, "utf8")
    await readTool.execute({ path: "small.txt" }, ctx)
    await fetchTool.execute({ ref: "tm://runs/other/steps/s1/result", access_token: "x".repeat(64) }, ctx)
    const after = fs.readFileSync(tjFile, "utf8")
    assert.ok(after.startsWith(before), "trajectory stays append-only across calls")
    assert.ok(after.length > before.length, "trajectory grows with calls")
    assert.ok(after.includes('"event":"fetch"'), "fetch events recorded")
  }
  console.log("6i. trajectory across calls: OK (byte-prefix growth, fetch events)")

  /* ---------- 7. loader integration (v1) — RETIRED with the v1 personality (1.7.0 cut) ----------
   *  This group asserted plugin.server() returned hooks.config / hooks['tool.execute.before'] / hooks.tool with
   *  tm_read/tm_grep/tm_bash registered. v2 never registers those three, and v1 is gone, so keeping the
   *  body would mean resurrecting the v1 loader. The v2 equivalents (ToolResult shape, args raw-shape,
   *  description surface) are pinned by test-v2-adapter groups 1 and 3. The NUMBER stays so 7b-7d2 and
   *  8-16 do not renumber and break every historical reference to them. */
  console.log("7. loader integration: SKIPPED — v1 personality removed; v2 surface pinned by test-v2-adapter 1/3")


  /* ---------- 8. hook-level alias (tm_* pass through R6's own interception) —
   *  RETIRED with the v1 personality (1.7.0 cut).  This group drove the v1
   *  plugin.server() tool.execute.before hook to prove tm_read/tm_grep/tm_bash
   *  were covered by R6 at the hook layer.  Those three tools are gone and v1's
   *  loader is gone; the v2 R6 face over the host's native shell/read is pinned
   *  by test-v2-adapter (guard) and test-envprotect (matchers). ---------- */
  console.log("8. hook alias: SKIPPED — v1 loader + tm_read/tm_grep/tm_bash removed; v2 R6 face pinned by test-v2-adapter/test-envprotect")



  /* ---------- 9. tm_ptc_run (M1-M3 contract) - RETIRED with the v1 personality (1.7.0 cut).
   *  tm_ptc_run was the v1-only batch-orchestration tool (src/tm/ptc/ is deleted,
   *  and it was never registered on v2 - the host native Code Mode execute program
   *  runs one program over N governed calls).  This group 9a-9l asserted the PTC
   *  config knobs, budget clamp, arg schema, staticPscan, the five/six engine
   *  statuses, composite step numbering, trajectory shapes, the rendered summary,
   *  the tool registration, the real WorkerEngine/InlineVmEngine runs, the T6 web
   *  bridge, and the C1 escape containment - all against code that no longer
   *  exists.  The shared governance the bridge rode (pipelines.govern + offload
   *  handles) stays pinned by groups 1-6; the v2 Code-Mode surface is the host own,
   *  not ours.  The NUMBER stays so 10-16 do not renumber. ---------- */
  clearTmEnv()
  console.log("9. tm_ptc_run (9a-9l): SKIPPED - PTC removed with the v1 personality (src/tm/ptc/ deleted); shared governance pinned by groups 1-6")


  // ---------- 10. tm_dispatch / tm_join — async sub-agent dispatch ----------
  // Issue #7: the host's `task` tool blocks the calling session, so the lead
  // could not overlap its own work with the team's.  These tools ride the
  // official client.session API (create + promptAsync = start and return
  // immediately); a fake session API is what a real host answers with.
  {
    const dmod = await import("./dist/tm/dispatch.js")
    assert.equal(
      dmod.lastAssistantText([
        { info: { role: "user" }, parts: [{ type: "text", text: "the brief" }] },
        { info: { role: "assistant" }, parts: [{ type: "tool", callID: "c1" }, { type: "text", text: "STATUS: done" }] },
      ]),
      "STATUS: done",
      "lastAssistantText skips the user turn and non-text parts",
    )
    assert.equal(dmod.lastAssistantText([]), "", "no messages = empty reply, never a crash")
    assert.equal(
      dmod.lastAssistantText([{ info: { role: "assistant" }, parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]),
      "a\nb",
      "multiple text parts of the final message join",
    )
    assert.equal(dmod.sessionApiOf({}), null, "a client with no session namespace degrades (no throw)")
    assert.equal(dmod.sessionApiOf({ session: { create: () => {} } }), null, "create alone is not enough — promptAsync must exist too")
    assert.deepEqual(dmod.summarizeStates([{ state: "idle" }, { state: "running" }, { state: "error" }]), { running: 1, idle: 1, error: 1 }, "state summary counts")

    const sessionFake = (over = {}) => {
      const calls = { create: [], promptAsync: [], messages: [], status: [], abort: [], children: [], get: [], todo: [] }
      const ids = over.ids ?? ["ses_child_1"]
      // THE BINDING PIN: the real SDK's endpoints read their receiver, so a
      // captured reference (`const f = api.create`) throws
      // "Cannot read properties of undefined (reading 'client')" — which is
      // exactly how tm_dispatch died on the live host (2026-09-19).  Every
      // method below REQUIRES `this`, so the bug class cannot come back.
      const ns = {
        __sdkNamespace: "session",
        create: async function (o) {
          assert.equal(this?.__sdkNamespace, "session", "client.session.create must be called as a METHOD")
          calls.create.push(o)
          return { ok: true, data: { id: ids.shift() ?? "ses_x" } }
        },
        promptAsync: async function (o) {
          assert.equal(this?.__sdkNamespace, "session", "client.session.promptAsync must be called as a METHOD")
          calls.promptAsync.push(o)
          return { data: undefined }
        },
        messages: async function (o) {
          assert.equal(this?.__sdkNamespace, "session", "client.session.messages must be called as a METHOD")
          calls.messages.push(o)
          // the LEAD's own transcript carries the model tm_dispatch must
          // inherit (a child session has none of its own)
          if (o.path.id === "ses_lead") {
            return {
              ok: true,
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                {
                  info: { role: "assistant", providerID: "opencode", modelID: "deepseek-v4.1-flash", time: { created: 1, completed: 2 } },
                  parts: [{ type: "text", text: "ok" }],
                },
              ],
            }
          }
          const text = (over.replies ?? {})[o.path.id] ?? "STATUS: done\nEVIDENCE: tsc clean"
          const completed = (over.completedFor ?? []).includes(o.path.id) ? over.completedAt ?? 9000 : undefined
          const errInfo = (over.childErrors ?? {})[o.path.id]
          return {
            ok: true,
            data: [
              { info: { role: "user" }, parts: [{ type: "text", text: "brief" }] },
              {
                info: { role: "assistant", time: { created: over.createdAt ?? 1000, completed }, ...(errInfo ? { error: errInfo } : {}) },
                parts: errInfo ? [] : [{ type: "text", text }],
              },
            ],
          }
        },
        status: async function () {
          assert.equal(this?.__sdkNamespace, "session", "client.session.status must be called as a METHOD")
          calls.status.push(1)
          return { ok: true, data: over.statusMap ?? { ses_child_1: { type: "busy" } } }
        },
        // the parentID chain tm_dispatch walks for its subagent_depth check
        get: async function (o) {
          assert.equal(this?.__sdkNamespace, "session", "client.session.get must be called as a METHOD")
          calls.get.push(o.path.id)
          return { ok: true, data: { id: o.path.id, parentID: (over.parents ?? {})[o.path.id] } }
        },
        // GET /session/{id}/todo — read-only, and the goal tripwire's source
        todo: over.todos === undefined
          ? undefined
          : async function (o) {
              calls.todo.push(o.path.id)
              // "THROW" stands for a host whose todo endpoint fails — distinct from
              // having no endpoint, which is the other thing tm_join must not blur.
              if (over.todos === "THROW") throw new Error("ECONNRESET")
              return { ok: true, data: over.todos }
            },
        abort: async function (o) {
          assert.equal(this?.__sdkNamespace, "session", "client.session.abort must be called as a METHOD")
          calls.abort.push(o)
          return { ok: true, data: {} }
        },
        // GET /session/{id}/children — what a RESTARTED plugin instance
        // still can ask, and therefore the recovery source for tm_join.
        children: over.noChildren
          ? undefined
          : async function (o) {
              assert.equal(this?.__sdkNamespace, "session", "client.session.children must be called as a METHOD")
              calls.children.push(o)
              return { ok: true, data: over.children ?? [] }
            },
      }
      const client = { ...fakeClient({}), session: over.noApi ? undefined : ns }
      return { client, calls }
    }
    // the real host hands tool ctx an ask() bridge, and tm_dispatch now uses
    // it for spawn consent (parity with the built-in task tool's ctx.ask)
    const LEAD = { agent: "team", sessionID: "ses_lead", directory: ".", ask: async () => "once" }
    const BRIEF = "重构 tm_join 的收集路径：目标是后台子代理的回复必须真的被取回，涉及 src/tm/dispatch.ts，完成判据是 npm test 全绿。"

    // ── 10. tm_dispatch is GONE; tm_join is the collect side ────────────────
    // A plugin-spawned child is a session the user can neither open from a card
    // nor stop from the UI, so nothing here creates one any more — delegation
    // belongs to the host's `task`. What stays under test: the tool is not
    // registered and nobody holds it, and children that ALREADY EXIST in the
    // host's tree (leftovers of the old dispatcher, plus host `task` children
    // named explicitly) are still collectable, cancellable and governed.
    // Seeding through `session.children` is not a shortcut — it is literally
    // how a restarted plugin discovers work it never saw.
    {
      const seeded = async (name, over = {}, opts = {}) => {
        const f = sessionFake(over)
        const rt = await tm.createTmTools({ directory: mktmp(name), client: f.client, $: fake$Ok("") }, opts)
        return { rt, calls: f.calls }
      }
      const leftover = (id, title) => ({ id, title, time: { created: 1000, updated: 9000 } })

      const { rt: surface } = await seeded("disp-surface", {})
      assert.ok(!("tm_dispatch" in surface.tools), "tm_dispatch is NOT registered — the model cannot call what does not exist")
      assert.ok("tm_join" in surface.tools, "tm_join stays: host background results are pulled back through it")
      const denied = await surface.tools.tm_join.execute({}, { agent: "implementer", sessionID: "s", ask: async () => "once" })
      assert.ok(denied.output.includes("只有 Team"), "tm_join keeps the lead-only runtime lock (the second lock is agents.ts denying it)")
      await surface.dispose()

      // tm_stats counts calls from `event:"call"`, and tm_join only ever wrote
      // its governed result — so a live session's table read "0 调用 / 2 结果",
      // which looks like a broken counter rather than a tool that ran.
      {
        const { rt } = await seeded("disp-calls", {})
        await rt.tools.tm_join.execute({}, { agent: "team", sessionID: "ses_no_children_here" })
        const evs = fs
          .readFileSync(rt.store.trajectoryFile(), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
        assert.equal(evs.filter((e) => e.tool === "tm_join" && e.event === "call").length, 1, "a tm_join call writes its call event")
        const refused = await seeded("disp-calls2", {})
        await refused.rt.tools.tm_join.execute({}, { agent: "reviewer", sessionID: "s" })
        const evs2 = fs.existsSync(refused.rt.store.trajectoryFile())
          ? fs
              .readFileSync(refused.rt.store.trajectoryFile(), "utf8")
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : []
        assert.equal(evs2.filter((e) => e.tool === "tm_join" && e.event === "call").length, 0, "a governance-refused call is never counted")
        await rt.dispose()
        await refused.rt.dispose()
      }

      {
        const registered = []
        const { rt, calls } = await seeded(
          "disp-adopt",
          {
            children: [
              leftover("ses_orphan", "auth-bug (@researcher subagent ·tm)"),
              leftover("ses_legacy", "tm:researcher:auth-bug-legacy"),
              leftover("ses_taskchild", "Explore the repo (@tester subagent)"),
            ],
            completedFor: ["ses_orphan"],
            statusMap: {},
          },
          { onChildSession: (sid, a) => registered.push([sid, a]) },
        )
        const joined = await rt.tools.tm_join.execute({}, LEAD)
        assert.equal(calls.children.length, 1, "tm_join asks the host for its children when its own memory is empty")
        assert.equal(calls.children[0].path.id, "ses_lead", "…under the CALLING lead session")
        assert.ok(joined.output.includes("ses_orphan"), "a leftover dispatch is adopted and collected")
        assert.ok(joined.output.includes("ses_legacy"), "…and so is one titled in the PRE-1.5.15 shape (an upgrade must not orphan live work)")
        assert.ok(!joined.output.includes("ses_taskchild"), "a host task child is NOT ours to claim on speculation")
        assert.ok(joined.output.includes("接管"), "an adopted row says out loud that it was rebuilt from the host")
        assert.ok(joined.output.includes("1 完成"), "answered-while-nobody-was-listening reports 完成, not 运行中")
        assert.ok(joined.output.includes("已完成 8s"), "elapsed comes from the HOST's timestamps (9000-1000), not from this process")
        assert.ok(joined.output.includes("STATUS: done"), "the adopted child's reply text is still collected")
        assert.deepEqual(registered, [["ses_orphan", "researcher"], ["ses_legacy", "researcher"]], "an adopted child is handed to the approval gate too")
        await rt.dispose()
      }

      {
        const { rt } = await seeded("disp-claim", {
          parents: { ses_hosttask: "ses_lead", ses_foreign: "ses_somebody_else" },
          replies: { ses_hosttask: "STATUS: done\nFINDINGS: 后台任务的结论" },
          completedFor: ["ses_hosttask"],
          children: [],
          statusMap: {},
        })
        const got = await rt.tools.tm_join.execute({ ids: ["ses_hosttask"] }, LEAD)
        assert.ok(got.output.includes("STATUS: done"), "a named host task child is collected — how an offloaded background result comes back")
        assert.ok(got.output.includes("接管"), "…and the row says it was rebuilt from the host, not created here")
        const foreign = await rt.tools.tm_join.execute({ ids: ["ses_foreign"] }, LEAD)
        assert.ok(foreign.output.includes("没有待收集的派发"), "a session the host does not parent to us stays a miss — parentage is read, never assumed")
        await rt.dispose()

        const { rt: noKids } = await seeded("disp-nochildren", { noChildren: true })
        const noEndpoint = await noKids.tools.tm_join.execute({}, LEAD)
        assert.ok(noEndpoint.output.includes("没有待收集的派发"), "no children endpoint -> an answer, no crash")
        // …but the answer may not claim it LOOKED.  Three outcomes used to collapse
        // into one sentence ("宿主会话树里也没有可认领的子会话"), which on the v2 client
        // shim — no session domain at all — asserted a negative nobody measured.  A
        // lead that believes it stops waiting for a report that exists, which is the
        // silent loss this adoption path was added to prevent.
        assert.ok(!/会话树里也没有可认领/.test(noEndpoint.output), "an unavailable seam may not report 'confirmed nothing there'")
        assert.match(noEndpoint.output, /没有看过会话树|没能查看/, "…and says which of the two happened")
        {
          const looked = await tm.createTmTools(
            { directory: process.cwd(), client: { session: { messages: async () => ({}), children: async () => ({ data: [] }) } }, $: () => ({}) },
            {},
          )
          const emptyAfterLooking = await looked.tools.tm_join.execute({ ids: ["ses_nope"] }, LEAD)
          assert.ok(/会话树里也没有可认领的子会话/.test(emptyAfterLooking.output), "a host we DID query still gets the confirmed-empty sentence — the fix is a distinction, not a silencing")
          await looked.dispose()

          const threw = await tm.createTmTools(
            { directory: process.cwd(), client: { session: { messages: async () => ({}), children: async () => { throw new Error("ECONNREFUSED") } } }, $: () => ({}) },
            {},
          )
          const broken = await threw.tools.tm_join.execute({ ids: ["ses_nope"] }, LEAD)
          assert.ok(/没能查看宿主会话树/.test(broken.output) && !/会话树里也没有可认领/.test(broken.output), "a failed query reports as a failed query, never as an empty tree")
          assert.match(broken.output, /ECONNREFUSED/, "…and carries the host's own reason so the lead can tell transport from absence")
          await threw.dispose()
        }
        await noKids.dispose()
      }

      {
        const { rt, calls } = await seeded("disp-cancel", {
          children: [leftover("ses_r1", "一 (@tester subagent ·tm)"), leftover("ses_r2", "二 (@reviewer subagent ·tm)")],
          statusMap: { ses_r1: { type: "idle" }, ses_r2: { type: "busy" } },
        })
        const snap = await rt.tools.tm_join.execute({ waitMs: 0 }, LEAD)
        assert.ok(snap.output.includes("1 完成 / 1 运行中"), "the host status map settles what the event bus missed")
        assert.ok(snap.output.includes("还有 1 个子代理在跑") && snap.output.includes("不是交付"), "an open child is announced as unfinished work, never as a wrap-up")
        const cancelled = await rt.tools.tm_join.execute({ cancel: true }, LEAD)
        assert.equal(calls.abort.length, 1, "cancel:true aborts the one still-running child")
        assert.ok(cancelled.output.includes("aborted on request"), "an aborted child reports why")
        await rt.dispose()

        const fat = "FINDINGS:\n" + "长行 · evidence line with a source https://example.org/x\n".repeat(400)
        const { rt: fatRt } = await seeded("disp-fat", {
          children: [leftover("ses_fat", "胖 (@researcher subagent ·tm)")],
          replies: { ses_fat: fat },
          completedFor: ["ses_fat"],
          statusMap: {},
        })
        const big = await fatRt.tools.tm_join.execute({}, LEAD)
        assert.ok(big.output.includes("已卸载") && big.output.includes("ref: tm://runs/"), "a fat child reply arrives as a handle + preview, not inline")
        await fatRt.dispose()
      }

      // the wait budget, as pure arithmetic — the numbers a lead parks on
      assert.deepEqual(dmod.joinBudget(300_000, 60_000, undefined), { budget: 60_000, repeat: false, streak: 1 }, "the first bounded wait is clamped to TM_JOIN_MAX_WAIT_MS")
      assert.deepEqual(dmod.joinBudget(300_000, 60_000, { stillRunning: 2, streak: 1 }), { budget: 10_000, repeat: true, streak: 2 }, "a wait following a wait that settled nothing is cut to 10s")
      assert.deepEqual(dmod.joinBudget(5_000, 60_000, { stillRunning: 0, streak: 1 }), { budget: 5_000, repeat: false, streak: 1 }, "once everything settled, the next wait is a fresh one")
      assert.deepEqual(dmod.joinBudget(0, 60_000, { stillRunning: 3, streak: 4 }), { budget: 0, repeat: false, streak: 4 }, "a snapshot costs nothing and neither extends nor resets the streak")
      assert.equal(dmod.REPEAT_WAIT_MS, 10_000, "the repeat budget is the number the description promises")
      {
        process.env.TM_JOIN_MAX_WAIT_MS = "300"
        const keepAlive = setInterval(() => {}, 50)
        try {
          const { rt } = await seeded("join-wait", {
            children: [leftover("ses_w", "等 (@tester subagent ·tm)")],
            statusMap: { ses_w: { type: "busy" } },
          })
          assert.ok(rt.tools.tm_join.description.includes("A wait BLOCKS YOU") && rt.tools.tm_join.description.includes("capped at 300ms"), "the tool says waiting parks the lead, and never renders '0s'")
          const first = await rt.tools.tm_join.execute({ waitMs: 300 }, LEAD)
          assert.ok(!first.output.includes("连续第"), "the first wait is just a wait")
          const again = await rt.tools.tm_join.execute({ waitMs: 300 }, LEAD)
          assert.ok(again.output.includes("连续第 2 次等待"), "the second consecutive wait is named as such")
          assert.ok(again.output.includes("别再等") && again.output.includes("open handoff"), "and answered with what to do instead of another park")
          await rt.dispose()
        } finally {
          clearInterval(keepAlive)
          delete process.env.TM_JOIN_MAX_WAIT_MS
        }
      }

      // the goal tripwire, read off the host's own todo list
      assert.deepEqual(
        dmod.openHostTodos([
          { content: "跑通回归", status: "completed" },
          { content: "补文档", status: "in_progress" },
          { content: "等用户拍板", status: "pending" },
        ]).map((t) => t.content),
        ["补文档", "等用户拍板"],
        "completed/cancelled items are not open work; pending and in_progress are",
      )
      assert.deepEqual(dmod.openHostTodos(undefined), [], "a missing todo payload is no open work, never a crash")
      {
        const { rt, calls } = await seeded("disp-goal", {
          children: [leftover("ses_g", "目标 (@tester subagent ·tm)")],
          completedFor: ["ses_g"],
          statusMap: {},
          todos: [
            { content: "为 tm_pty 写清治理边界", status: "pending" },
            { content: "已完成的旧项", status: "completed" },
          ],
        })
        const withOpen = await rt.tools.tm_join.execute({}, LEAD)
        assert.ok(withOpen.output.includes("目标未达成"), "a settled round with open todos says the goal is NOT met")
        assert.ok(withOpen.output.includes("为 tm_pty 写清治理边界"), "and names the open item verbatim")
        assert.ok(!withOpen.output.includes("已完成的旧项"), "completed items are not thrown at the lead as unfinished")
        assert.ok(withOpen.output.includes("先用 todowrite 更新状态"), "a stale list gets the one fix that resolves it, not another lap of waiting")
        assert.deepEqual(calls.todo, ["ses_lead"], "the todo read is scoped to the CALLING session")
        await rt.dispose()

        const { rt: doneRt } = await seeded("disp-goal-done", {
          children: [leftover("ses_g2", "目标 (@tester subagent ·tm)")],
          completedFor: ["ses_g2"],
          statusMap: {},
          todos: [{ content: "全部做完", status: "completed" }],
        })
        const closed = await doneRt.tools.tm_join.execute({}, LEAD)
        assert.ok(!closed.output.includes("目标未达成"), "a clean todo list adds no warning")
        assert.ok(closed.output.includes("全部已结算"), "and the round still reports its own state")
        await doneRt.dispose()

        // …and the two ways the check can NOT happen.  Silence here read as
        // "checked and clean" on v2 (whose client shim has no session.todo), at
        // the exact moment a lead decides to wrap up — the same overstatement this
        // tool already fixed on the adoption path, one floor later.
        {
          const { rt: noSeam } = await seeded("disp-goal-noseam", {
            children: [leftover("ses_g3", "目标 (@reviewer subagent ·tm)")],
            completedFor: ["ses_g3"],
            statusMap: {},
            // no `todos` at all: the seam is absent, exactly like createV2Client()
          })
          const unchecked = await noSeam.tools.tm_join.execute({}, LEAD)
          assert.ok(!unchecked.output.includes("目标未达成"), "an unread list is never reported as an unmet goal")
          assert.ok(unchecked.output.includes("目标核对没做成"), "…but the round says the check did not run")
          assert.ok(unchecked.output.includes("不等于"), "…and refuses to let 已结算 read as 已达成")
          assert.ok(!unchecked.output.includes("todowrite"), "…and does not tell the lead to call a tool this host has no seam for")
          await noSeam.dispose()

          const { rt: brokenRt } = await seeded("disp-goal-broken", {
            children: [leftover("ses_g4", "目标 (@architect subagent ·tm)")],
            completedFor: ["ses_g4"],
            statusMap: {},
            todos: "THROW",
          })
          const broken = await brokenRt.tools.tm_join.execute({}, LEAD)
          assert.ok(/目标核对没做成.*返回异常/.test(broken.output), "a failing todo endpoint says it failed, distinctly from having no seam")
          await brokenRt.dispose()
        }
      }

      // the pure helpers that outlived the dispatcher
      assert.deepEqual(dmod.parseIdList('["ses_a","ses_b"]'), ["ses_a", "ses_b"], "a JSON-array string parses (real models send this)")
      assert.deepEqual(dmod.parseIdList(["ses_a", " ses_b "]), ["ses_a", "ses_b"], "a real array still parses (trimmed)")
      assert.equal(dmod.parseIdList(undefined), null, "absent ids = no filter")
      assert.ok(dmod.describeHostError({ name: "ProviderAuthError", data: { message: "No API key for opencode", ref: "err_9f2" } }).includes("No API key for opencode"), "a nested host error stays readable — [object Object] destroyed the only diagnostic once")
      assert.ok(!dmod.describeHostError({ foo: 1 }).includes("[object Object]"), "an unrecognised object never renders as [object Object]")
      assert.equal(dmod.hostBackgroundSubagentsEnabled({}), false, "no flag -> the host has no visible background card to offer")
      assert.equal(dmod.hostBackgroundSubagentsEnabled({ OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true" }), true, "the specific flag turns it on")
      assert.equal(dmod.hostBackgroundSubagentsEnabled({ OPENCODE_EXPERIMENTAL: "1" }), true, "the umbrella flag counts")
      assert.equal(dmod.hostBackgroundSubagentsEnabled({ OPENCODE_EXPERIMENTAL: "1", OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false" }), false, "the specific value overrides the umbrella, both ways")
      assert.deepEqual(dmod.parseDispatchTitle("修登录页 (@implementer subagent ·tm)", ["implementer"]), { agent: "implementer", label: "修登录页" }, "a leftover dispatch title parses")
      assert.deepEqual(dmod.parseDispatchTitle("tm:researcher:auth-bug", ["researcher"]), { agent: "researcher", label: "auth-bug" }, "the pre-1.5.15 title still parses")
      assert.equal(dmod.parseDispatchTitle("Explore the repo (@tester subagent)", ["tester"]), null, "a host task child's title never parses — that is what the marker is for")
      assert.equal(dmod.parseDispatchTitle("随便一个会话", ["tester"]), null, "an ordinary session is not ours")
    }
    console.log("10. tm_dispatch removed (not registered, lead denied) + tm_join as the collect side: adoption of leftovers (both title shapes) with a host task child never claimed on speculation, named-id claims verified against host parentage, status/event settle, cancel, offloaded fat replies, the wait budget and its chained-wait cut, the goal tripwire with the todowrite escape, and the pure helpers")
  }

  // ---------- 11. bash timeout clamp — RETIRED with the v1 personality ----------
  // The clamp MODULE (src/tm/bash-timeout.ts: resolveBashTimeout /
  // createBashTimeoutHook / parseTimeoutArg) was deleted with the v1 personality;
  // the clamp now lives in src/host/v2-guard.ts (applyV2ShellTimeoutClamp, commit
  // e15bca3) and is pinned by test-v2-adapter.  The CONFIG plumbing below stays:
  // bashTimeoutProbeMs / bashTimeoutMaxMs are still read by v2 (src/host/v2.ts) and
  // must keep resolving.
  {
    console.log("  11. bash timeout clamp module: SKIPPED — src/tm/bash-timeout.ts removed with the v1 personality; v2 clamp in src/host/v2-guard.ts (test-v2-adapter)")
    // config plumbing (still live — v2 reads these knobs)
    const cfgBt = tm.resolveTmConfig({ TM_BASH_TIMEOUT_MAX_MS: "1200000", TM_BASH_TIMEOUT_PROBE_MS: "0" })
    assert.equal(cfgBt.bashTimeoutMaxMs, 1200000, "TM_BASH_TIMEOUT_MAX_MS resolves")
    assert.equal(cfgBt.bashTimeoutProbeMs, 0, "TM_BASH_TIMEOUT_PROBE_MS=0 disables the probe ceiling")
    assert.equal(tm.resolveTmConfig({}).bashTimeoutMaxMs, 0, "the general cap is OFF by default")
    assert.equal(tm.resolveTmConfig({}).bashTimeoutProbeMs, 60_000, "the probe ceiling ships enabled")
    assert.equal(tm.resolveTmConfig({ TM_BASH_TIMEOUT_MAX_MS: "banana" }).bashTimeoutMaxMs, 0, "invalid value falls back to the default")
    console.log("  11. bash timeout config plumbing: OK (v2 still reads bashTimeoutProbeMs/MaxMs)")
  }
    // ---------- 12. tm_board_write — the board's write side (a role with no file tool) ----------
    {
      const bd = await import("./dist/tm/board.js")
      const root = mktmp("board")
      const events = []
      const pipes = {
        nextStepId: () => "s0120",
        store: { appendTrajectory: (e) => events.push(e), blackboardRoot: root, trajectoryRoot: root },
      }
      const mk = (over = {}) =>
        bd.buildBoardWriteTool({
          pipelines: pipes,
          boardRoot: root,
          stamp: () => "20260101-000000",
          ...over,
        })
      const arch = { agent: "architect", sessionID: "ses_arch" }

      // ---- pure: the path pieces are chosen here, not by the model ----
      assert.equal(bd.sessionKeyStamp(new Date(2026, 0, 2, 3, 4, 5)), "20260102-030405", "session key = the yyyyMMdd-HHmmss shape the board note advertises (a role with no bash cannot run Get-Date)")
      assert.equal(bd.sanitizeSlug("auth/design"), "auth-design", "a separator inside a segment becomes a dash, never a directory hop")
      assert.equal(bd.sanitizeSlug("../../etc/passwd"), "etc-passwd", "dot-dot pairs cannot escape a segment")
      assert.equal(bd.sanitizeSlug(".env"), "env", "leading dots go, so the .env / shell-rc family cannot be produced")
      assert.equal(bd.sanitizeSlug("认证 设计"), "认证-设计", "CJK survives — these users write CJK")
      assert.equal(bd.sanitizeSlug("   "), "", "whitespace is not a name")
      assert.equal(bd.nextOrdinal(["01-architect-design.md", "07-team-plan.md"]), 8, "a hand-written ordinal the lead created is counted")
      assert.equal(bd.nextOrdinal([]), 1, "the first file of a task is 01")
      assert.equal(bd.roundSuffix(["01-x.md"], "01-x"), "-r2", "a revision is a NEW file, never a rewrite")
      assert.equal(bd.roundSuffix(["01-x.md", "01-x-r2.md"], "01-x"), "-r3")
      assert.equal(bd.roundSuffix(["01-x.md"], "02-y"), "", "a free name needs no round")
      assert.deepEqual(
        bd.findFamily(["01-architect-design.md"], "architect", "design"),
        { base: "01-architect-design", round: "-r2" },
        "a revision keeps the family's NN and adds the round — the pairing has to be visible in a listing",
      )
      assert.deepEqual(
        bd.findFamily(["01-x-design.md", "01-x-design-r3.md"], "x", "design"),
        { base: "01-x-design", round: "-r4" },
        "the round advances past the highest existing one, not past the count",
      )
      assert.equal(bd.findFamily(["01-architect-design.md"], "architect", "risks"), null, "another topic is not this family")

      // ---- end to end: write, revise, join the lead's folder ----
      const tool = mk()
      const body = "设计说明：".repeat(40)
      const out1 = String((await tool.execute({ task: "auth", topic: "design", content: body }, arch)).output ?? "")
      const f1 = path.join(root, "20260101-000000", "auth", "01-architect-design.md")
      assert.ok(out1.includes(f1), `the reply carries the absolute path — got: ${out1.slice(0, 200)}`)
      assert.ok(fs.existsSync(f1) && fs.readFileSync(f1, "utf8").includes(body), "the bytes are ON DISK (the role that wrote them owns no file tool)")
      assert.ok(!out1.includes("设计说明"), "…and the content is NOT echoed back — that round-trip is what the board exists to prevent")
      assert.ok(
        events.some((e) => e.event === "board_write" && Number(e.bytes) > 0 && e.file === "01-architect-design.md"),
        "the write is trajectory-audited with its byte count",
      )
      const out2 = String((await tool.execute({ task: "auth", topic: "design", content: "第二版" }, arch)).output ?? "")
      assert.ok(out2.includes("01-architect-design-r2.md"), `a revision lands as a new round — got: ${out2.slice(0, 180)}`)
      assert.ok(fs.readFileSync(f1, "utf8").includes(body), "the first version is untouched — the board's history IS the audit trail")
      const out3 = String((await tool.execute({ task: "auth", topic: "risks", content: "风险清单" }, arch)).output ?? "")
      assert.ok(out3.includes("02-architect-risks.md"), "the ordinal advances per task dir")
      // The role comes from the host's ctx: a child that files a report under a
      // borrowed name would corrupt the lead's view of who did what.
      const spoof = String((await tool.execute({ task: "auth", topic: "claim", content: "x", role: "implementer" }, arch)).output ?? "")
      assert.ok(spoof.includes("03-architect-claim.md"), "the filename role is the CALLER's role, not an argument")
      const joined = String((await tool.execute({ task: "auth", topic: "note", session: "20260915-101010", content: "x" }, arch)).output ?? "")
      assert.ok(joined.includes(path.join("20260915-101010", "auth")), "passing the lead's session folder joins it instead of forking a second board")

      // ---- refusals write nothing ----
      const empty = String((await tool.execute({ task: "auth", topic: "x", content: "   " }, arch)).output ?? "")
      assert.ok(empty.includes("phase=args") && empty.includes("缺少 content"), "an empty deliverable is an args error")
      const capped = mk({ cfg: { boardMaxChars: 1500 } })
      const big = String((await capped.execute({ task: "auth", topic: "huge", content: "字".repeat(2000) }, arch)).output ?? "")
      assert.ok(big.includes("超过上限"), "content over the cap refuses instead of truncating")
      assert.equal(fs.existsSync(path.join(root, "20260101-000000", "auth", "04-architect-huge.md")), false, "…and no partial file is left behind")
      const escape = String((await tool.execute({ task: "../../../escape", topic: "x", content: "y" }, arch)).output ?? "")
      const within = path.resolve(root)
      assert.ok(escape.includes(within), `even a traversal-shaped task stays under the board root — got: ${escape.slice(0, 160)}`)
      assert.equal(fs.existsSync(path.join(os.tmpdir(), "escape")), false, "…and nothing is created outside it")
      const tiny = mk({ cfg: { boardMaxFiles: 4 } })
      for (const t of ["a", "b", "c", "d"]) await tiny.execute({ task: "quota", topic: t, content: "x" }, arch)
      const over = String((await tiny.execute({ task: "quota", topic: "e", content: "x" }, arch)).output ?? "")
      assert.ok(over.includes("上限") && over.includes("ttlDays"), "the per-session file cap names the reclaim path (TTL), not a magic delete")

      // ---- a symlinked task dir is not a way out ----
      try {
        const outside = mktmp("board-outside")
        const linkRoot = mktmp("board-link")
        fs.mkdirSync(path.join(linkRoot, "sess"), { recursive: true })
        fs.symlinkSync(outside, path.join(linkRoot, "sess", "task"), "dir")
        const lk = bd.buildBoardWriteTool({ pipelines: pipes, boardRoot: linkRoot, stamp: () => "s" })
        const out = String((await lk.execute({ task: "task", topic: "x", session: "sess", content: "y" }, arch)).output ?? "")
        assert.ok(out.includes("符号链接") || out.includes("越出"), `a symlinked task dir is refused — got: ${out.slice(0, 180)}`)
        assert.equal(fs.readdirSync(outside).length, 0, "…and nothing landed on the other side of it")
      } catch (e) {
        if (!/EPERM|eperm|operation not permitted/i.test(String(e && e.message))) throw e
        console.log("  (symlink refusal skipped: this Windows account cannot create directory symlinks)")
      }
      console.log("12. tm_board_write: OK (board-scoped writer for roles with no file tool — path chosen by the tool, revisions never overwrite, content never echoed, traversal/symlink/quota/cap refusals write nothing)")
    }

    // ---------- 13. network egress red line: an IP literal is not a domain ----------
    {
      const eg = await import("./dist/tm/egress.js")
      const hard = (h) => eg.classifyHost(h).level === "forbidden"
      const ask = (h) => eg.classifyHost(h).level === "private"
      const loop = (h) => eg.classifyHost(h).level === "loopback"
      const open = (h) => eg.classifyHost(h).level === "public"

      // NEVER consentable — a cloud metadata endpoint is not a thing a dialog can
      // help the user judge, and no UI-verification flow needs it.
      for (const h of [
        "169.254.169.254", // AWS/OpenStack/IMDSv1
        "169.254.1.1",
        "0.0.0.0",
        "224.0.0.1",
        "240.0.0.1",
        "198.18.0.1", // benchmarking range
        "::",
        "ff02::1",
        "100::1",
        "2001:10::1",
        "::ffff:169.254.169.254", // IPv4-mapped: the SAME target wearing an IPv6 coat
        "64:ff9b::a9fe:a9fe", // DNS64/NAT64 well-known prefix carrying 169.254.169.254
      ]) {
        assert.equal(hard(h), true, `${h} is a non-routable / metadata-shaped target and stays a hard red line`)
      }
      // Loopback (127.0.0.0/8, ::1, localhost, *.localhost): it only reaches a
      // service the user started on their OWN machine, so it is its own tier and
      // is allowed by default (see egress.ts / webfetch.ts — on v2 a plugin cannot
      // raise a dialog, so "needs approval" there would mean "always refused").
      for (const h of ["127.0.0.1", "localhost", "api.localhost", "::1"]) {
        assert.equal(loop(h), true, `${h} is loopback — its own tier, allowed by default`)
      }
      // Private space (RFC1918, ULA, CGNAT, fe80::/10): it reaches OTHER machines,
      // so it stays gated and "*" must never answer for it.
      for (const h of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "fe80::1", "fc00::1", "100.64.0.1"]) {
        assert.equal(ask(h), true, `${h} is private space — it goes to the dialog, not silently past the gate`)
      }
      for (const h of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2001:4860:8000::8", "example.com", "cn.bing.com"]) {
        assert.equal(open(h), true, `${h} is ordinary public space`)
      }
      // Bracket + trailing-dot + case spellings the URL parser hands us.
      assert.equal(loop("[::1]"), true, "bracketed IPv6 loopback hostname normalizes")
      assert.equal(eg.classifyHost("Example.LocalHost.").level, "loopback", "case and the trailing root dot do not change the verdict")
      assert.equal(eg.classifyHost("").level, "public", "an empty host is not an IP claim (the URL parser owns that error)")
      assert.equal(eg.classifyHost("999.1.1.1").level, "public", "an unparseable dotted quad is not mistaken for private space")

      // ---- wired into the ONE door every web tool passes through ----
      const WF = await import("./dist/tm/webfetch.js")
      // "*" is a documented operator setting; it must not become a way to read the
      // instance metadata service into the model context.
      const meta = WF.checkWebUrl("http://169.254.169.254/latest/meta-data/iam/security-credentials/", ["*"])
      assert.equal(meta.ok, false, "metadata endpoint refused even with the allowlist wide open")
      assert.equal(meta.askable ?? false, false, "…and it is NOT askable — no dialog can rescue it")
      assert.ok(/红线|不可批准/.test(meta.message), `the message says it is a red line — got: ${meta.message}`)
      const loopV = WF.checkWebUrl("http://127.0.0.1:8787/admin", ["*"])
      assert.equal(loopV.ok, true, "loopback is allowed by default, not refused for want of a dialog")
      assert.equal(loopV.via, "loopback", "…and the verdict names the tier that let it through (not an allowlist hit)")
      const namedV = WF.checkWebUrl("http://localhost:5173/", ["*"])
      assert.equal(namedV.ok, true, "a .localhost name is loopback too")
      // Private space is still gated and "*" cannot answer for it — naming one host
      // in the allowlist is the operator's exit, and it opens only THAT host.
      const priv = WF.checkWebUrl("http://10.1.2.3:8080/api", ["127.0.0.1"])
      assert.equal(priv.ok, false, "naming one host does not open the whole RFC1918 space")
      assert.equal(priv.askable, true, "an unnamed private host still asks (v1) rather than passing quietly")
      assert.equal(WF.checkWebUrl("http://10.1.2.3:8080/api", ["10.1.2.3"]).ok, true, "…but naming the private host itself is a real per-host decision that lets it through")
      assert.equal(WF.checkWebUrl("http://169.254.169.254/latest/meta-data/", ["169.254.169.254"]).ok, false, "and naming the METADATA endpoint explicitly still does not open it — that range has no consent path at all")
      assert.match(String(WF.checkWebUrl("http://10.1.2.3:8080/api", ["cn.bing.com"]).message), /TM_WEBFETCH_ALLOWED_DOMAINS/, "the private refusal names the operator's remedy instead of only the dialog that will never open")
      // …but an ask with no dialog is a gate with no exit, which is exactly the v2
      // shape. The policy seam is one setter, and the address red line is not on it.
      try {
        assert.equal(WF.setPrivateSpacePolicy("allow"), "allow", "TM_PRIVATE_SPACE=allow is accepted")
        const privOn = WF.checkWebUrl("http://10.1.2.3:8080/api", ["*"])
        assert.equal(privOn.ok, true, "private space passes when the operator opted out of asking")
        assert.equal(privOn.via, "private-allowed", "and the verdict SAYS why it passed, so a report cannot call it an allowlist hit")
        assert.equal(WF.checkWebUrl("http://192.168.1.1/", ["*"]).ok, true, "private space as a class, not one named host")
        const meta = WF.checkWebUrl("http://169.254.169.254/latest/meta-data/", ["*"])
        assert.equal(meta.ok, false, "the metadata endpoint is refused under private-allow too")
        assert.equal(meta.askable, undefined, "and it stays non-consentable: the policy cannot be traded for it")
        assert.equal(WF.setPrivateSpacePolicy("deny"), "deny", "deny is a third state, not a typo for ask")
        const off = WF.checkWebUrl("http://10.1.2.3:8080/api", ["*"])
        assert.equal(off.ok, false, "deny refuses private space outright")
        assert.equal(off.askable, undefined, "and does not pretend a dialog will come")
        // Loopback is NOT on this policy: it is its own tier and stays allowed even
        // under deny, because it only ever reaches the user's own machine.
        assert.equal(WF.checkWebUrl("http://127.0.0.1:8787/", ["*"]).ok, true, "loopback is allowed under deny too — it is not governed by the private-space policy")
        assert.equal(WF.setPrivateSpacePolicy("nonsense"), "ask", "an unparseable value falls back to ASK, the v1 default")
        assert.equal(WF.privateSpacePolicy(), "ask", "readable, so the boot line and the tool agree")
      } finally {
        WF.setPrivateSpacePolicy("ask")
      }
      const pub = WF.checkWebUrl("https://cn.bing.com/search?q=x", ["*"])
      assert.equal(pub.ok, true, "a public host is untouched by the egress rule")
      console.log("13. egress red line: OK (metadata/link-local/multicast/reserved + IPv4-mapped and DNS64 carriers are hard; loopback is its own default-allowed tier; RFC1918/ULA/CGNAT/.fe80 stay gated and \"*\" cannot answer for them)")
    }

    // ---------- 14. a redirect says where it came from; a 429 says when ----------
    {
      const wf = await import("./dist/tm/webfetch.js")
      const res = (status, headers, body) => ({
        status,
        headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
        text: async () => body ?? "",
      })
      const mkTool = (impl, domains) =>
        wf.buildTmWebfetchTool({
          pipelines: { store: { appendTrajectory: () => {} }, nextStepId: () => "sE14", govern: (_s, _t, c) => c },
          cfg: { ...tm.resolveTmConfig({}), webfetchAllowedDomains: domains ?? ["cn.bing.com"] },
          fetchImpl: impl,
        })
      const o2 = (r) => String(r?.output ?? "")

      // (1) an allowlisted shortener that bounces off-site used to report only
      // the last host — which reads as "this site will not fetch" and sends the
      // agent back to the entry URL it just watched fail.
      const seen = []
      const chain = mkTool(async (u) => {
        seen.push(u)
        if (u.includes("learn.microsoft.com")) return res(302, { location: "https://m.example.net/p" })
        return res(200, { "content-type": "text/plain" }, "never reached")
      }, ["learn.microsoft.com"])
      const chained = o2(await chain.execute({ url: "https://learn.microsoft.com/shortcut" }, { directory: process.cwd() }))
      assert.equal(seen.length, 1, "the off-site hop is never fetched")
      assert.ok(
        /跳转链: learn\.microsoft\.com → m\.example\.net/.test(chained),
        `the refusal names BOTH hops in order — got: ${chained.slice(0, 300)}`,
      )
      assert.ok(/停在第 2 跳/.test(chained), `…and says which hop stopped it — got: ${chained.slice(0, 300)}`)

      // (2) 429 with a numeric Retry-After is a WAIT, and the agent has to be
      // able to tell it apart from "this URL is dead".
      const limited = mkTool(async () => res(429, { "retry-after": "30", "content-type": "text/plain" }, ""))
      const lim = o2(await limited.execute({ url: "https://cn.bing.com/search?q=x" }, { directory: process.cwd() }))
      assert.ok(lim.includes("429") && lim.includes("30"), `the 429 carries its own Retry-After — got: ${lim.slice(0, 220)}`)
      assert.ok(!/07:28/.test(lim), "and it does not invent a date")

      // (3) an HTTP-date Retry-After is not a countdown; do not turn it into
      // seconds the agent will sleep on.
      const dated = mkTool(async () => res(503, { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }, ""))
      const dOut = o2(await dated.execute({ url: "https://cn.bing.com/search?q=x" }, { directory: process.cwd() }))
      assert.ok(dOut.includes("503") && !/21 秒|15 秒|07:28/.test(dOut), `a date-shaped Retry-After is not laundered into seconds — got: ${dOut.slice(0, 220)}`)

      // (4) the ordinary path stays quiet — no chain line for a direct hit.
      const direct = mkTool(async () => res(200, { "content-type": "text/plain" }, "plain body"))
      const d2 = o2(await direct.execute({ url: "https://cn.bing.com/x" }, { directory: process.cwd() }))
      assert.ok(d2.includes("plain body") && !/跳转链|第 1 跳/.test(d2), "a single-hop fetch reports no trail")
      console.log("14. redirect trail + Retry-After: OK (both hops named and the stopping hop counted; 429/503 carry a numeric Retry-After; an HTTP date is not laundered into seconds; a direct hit stays quiet)")
    }

    // ---------- 15. content negotiation: the page GET asks for Markdown, the engines do not ----------
    {
      const wf = await import("./dist/tm/webfetch.js")
      const cm = await import("./dist/tm/cache.js")
      const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
      const mkRes = (body, ct) => ({
        status: 200,
        headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? ct : null) },
        text: async () => body,
      })
      const tool = (impl, extra) =>
        wf.buildTmWebfetchTool({
          pipelines: { store: { appendTrajectory: () => {} }, nextStepId: () => "sE15", govern: (_s, _t, c) => c },
          cfg: { ...tm.resolveTmConfig({}), webfetchAllowedDomains: ["learn.microsoft.com", "cn.bing.com"] },
          fetchImpl: impl,
          ...extra,
        })
      const o5 = (r) => String(r?.output ?? "")
      const ctx5 = { directory: process.cwd() }

      // (1) fetchWebText's DEFAULT header is the browser-shaped one, byte-exact.
      // tm_search's engine legs call it and do not pass an accept — the
      // 2026-09-14 anti-bot benchmark calibrated exactly that string, so a
      // markdown-first preference must never leak into it by default.
      let seenAccept = ""
      await wf.fetchWebText(new URL("https://cn.bing.com/search?q=x"), ["cn.bing.com"], {
        fetchImpl: async (_u, init) => {
          seenAccept = String((init && init.headers && init.headers.accept) || "")
          return mkRes("<html><body><h1>hit</h1></body></html>", "text/html")
        },
      })
      assert.equal(seenAccept, BROWSER_ACCEPT, "the shared default Accept is unchanged, byte-exact (image/avif+webp ARE the browser fingerprint)")

      // (2) tm_webfetch's own GET asks for Markdown first — measured on this
      // host: learn.microsoft.com returns text/markdown at 11 449 B where the
      // browser-shaped request gets 60 778 B of HTML (3/3 runs, and bing/csdn/
      // MDN are byte-identical either way, so the preference costs nothing).
      const sent = []
      const md = o5(
        await tool(async (u, init) => {
          sent.push(String((init && init.headers && init.headers.accept) || ""))
          return mkRes("# 标题\n\n看 [链接](https://example.com/a) 和 `code`。", "text/markdown")
        }, {}).execute({ url: "https://learn.microsoft.com/en-us/dotnet/core/" }, ctx5),
      )
      assert.ok(sent[0].startsWith("text/markdown,"), `tm_webfetch leads with text/markdown — got: ${sent[0]}`)
      assert.ok(sent[0].includes("text/html"), "…and still accepts HTML, so a host that ignores the hint keeps working")
      assert.ok(sent[0].includes("image/avif"), "…and keeps the browser-shaped tail intact (the UA disguise is the point of the header)")

      // (3) a Markdown body must NOT go through the HTML stripper — its brackets,
      // backticks and links are content, not markup.
      assert.ok(md.includes("[链接](https://example.com/a)"), `markdown survives verbatim — got: ${md.slice(0, 200)}`)
      assert.ok(md.includes("`code`") && md.includes("# 标题"), "…including headings and inline code")
      assert.ok(/markdown/i.test(md), "and the reply SAYS the page arrived as markdown (so the shape is not a mystery)")

      // (4) ONE page, ONE cache entry — the preference changes what the writer
      // asked for, never how many entries a URL owns (§6m-c pins this, and it
      // caught the first version of this change splitting the store in two).
      let hits = 0
      const counting = async (_u, init) => (hits++, mkRes("# 同一份文档", "text/markdown"))
      const cache = cm.createWebCache({ dir: mktmp("accept-cache"), ttlSec: 300 })
      const first = o5(await tool(counting, { cache }).execute({ url: "https://learn.microsoft.com/x" }, ctx5))
      const second = await wf.fetchWebText(new URL("https://learn.microsoft.com/x"), ["learn.microsoft.com"], { fetchImpl: counting, cache })
      assert.ok(first.includes("# 同一份文档"), "the markdown body arrives intact")
      assert.equal(second.contentType, "text/markdown", "the reader gets the STORED negotiation, not an assumed one")
      assert.equal(hits, 1, "the second caller reads the same entry (the negotiation is a request-time preference, not a shard key)")

      // (5) the HTML path is untouched: an HTML body is still stripped to text.
      const html = o5(
        await tool(async () => mkRes("<html><body><h1>标题</h1><p>正文</p><script>x=1</script></body></html>", "text/html; charset=utf-8"), {})
          .execute({ url: "https://learn.microsoft.com/en-us/dotnet/core/y" }, ctx5),
      )
      assert.ok(html.includes("正文") && !html.includes("x=1"), "HTML still goes through the extractor (and <script> dies)")
      console.log("15. Accept negotiation: OK (shared default byte-exact for the engine legs, tm_webfetch leads with text/markdown and keeps the browser tail, markdown passes through unstripped and labelled, one page keeps ONE cache entry and the reader gets the stored content-type, HTML path untouched)")
    }

    // ---------- 16. the date the model reads is computed when it is read ----------
    {
      const wf = await import("./dist/tm/webfetch.js")
      const line = wf.searchDateLine(new Date(2026, 0, 2))
      assert.ok(line.includes("2026-01-02"), `the date line prints the day it was given — got: ${line}`)
      assert.ok(/最新|最近/.test(line), "…and says what to do with it (anchor recency judgements here, not in training memory)")
      // The whole point: two renders across a month boundary DIFFER.  A constant
      // captured at plugin startup cannot do this, and the desktop is a long-lived
      // process — the sessions that run for days are exactly the ones that drift.
      const jan = wf.searchDateLine(new Date(2026, 0, 31))
      const feb = wf.searchDateLine(new Date(2026, 1, 1))
      assert.notEqual(jan, feb, "the line is a function of the clock, not a module constant")
      assert.ok(/\(检索于 /.test(jan) && !/2026-01-31/.test(feb), "…month and day both come from the argument")
      // default = today, and it is recomputed per call
      const today = new Date()
      const pad = (n) => String(n).padStart(2, "0")
      assert.ok(
        wf.searchDateLine().includes(`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`),
        "no argument means THIS moment, formatted the same way",
      )
      // wired into the ONE header every engine and the auto route render through
      const listed = wf.renderSearchHits("舞蹈教学", "auto", [{ url: "https://example.com/a", title: "A" }])
      assert.ok(/检索于 \d{4}-\d{2}-\d{2}/.test(listed), `the hit list carries the date — got: ${listed.split("\n")[0]}`)
      assert.ok(listed.indexOf("检索于") < listed.indexOf("1. "), "…BEFORE the hits, so it anchors the read")
      // The auto route has its OWN header — a date on the per-engine path and
      // none on the default one is exactly the drift this repo keeps hitting.
      const sm2 = await import("./dist/tm/search.js")
      const fusedHead = sm2.renderFusedHits("舞蹈教学", ["bing", "moegirl"], [{ url: "https://example.com/b", title: "B" }], []).split("\n")[0]
      assert.ok(/检索于 \d{4}-\d{2}-\d{2}/.test(fusedHead), `the DEFAULT route's header carries it too — got: ${fusedHead}`)
      console.log("16. recency anchor: OK (the date is computed per render across a month boundary, defaults to now, and rides the one header every search route renders)")
    }

    // ---------- 17. layered team-mode.jsonc is wired into the runtime ----------
    {
      const ws = mktmp("cfg-e2e")
      const globalDir = mktmp("cfg-global")
      // A project file sets two observable values the runtime must actually use.
      fs.writeFileSync(
        path.join(ws, "team-mode.jsonc"),
        `{ "offloadThreshold": 7777, "searchDefaultEngine": "hn" }`,
      )
      const rt = await tm.createTmTools(
        { directory: ws, client: {}, $: () => ({}) },
        { env: { TM_STORE_RECLAIM: "off" }, configRoots: { globalDir, projectDir: ws } },
      )
      assert.equal(rt.config.offloadThreshold, 7777, "the project file's offloadThreshold reaches the runtime config")
      assert.equal(rt.config.searchDefaultEngine, "hn", "…and searchDefaultEngine too")

      // The tm_search descriptor must publish the SAME default (goal #6: no drift
      // between what the model is told and what the runtime does).
      const sArgs = await (await import("./dist/tm/args-schema.js")).buildSearchArgsSchema(rt.config.searchDefaultEngine)
      const engDesc = sArgs.engine?.description ?? sArgs.engine?.descriptor ?? ""
      assert.match(engDesc, /default hn/, "the tm_search descriptor names the file's default engine")

      // tm_stats carries the config section naming the winning layer.
      const stats = await rt.tools.tm_stats.execute({}, { directory: ws })
      const out = String(stats?.output ?? "")
      assert.match(out, /分层配置/, "tm_stats renders the config section")
      assert.match(out, /offloadThreshold=project/, "…naming the layer each key came from")

      // TM_CONFIG_ENV_ONLY ignores the file entirely.
      const rtEnvOnly = await tm.createTmTools(
        { directory: ws, client: {}, $: () => ({}) },
        { env: { TM_STORE_RECLAIM: "off", TM_CONFIG_ENV_ONLY: "1" }, configRoots: { globalDir, projectDir: ws } },
      )
      assert.equal(rtEnvOnly.config.offloadThreshold, 2000, "TM_CONFIG_ENV_ONLY=1 ignores the file (default stands)")
      assert.equal(rtEnvOnly.config.searchDefaultEngine, "auto", "…for every key")
      await rt.dispose()
      await rtEnvOnly.dispose()
      console.log("17. layered config wiring: OK (project file reaches the runtime + the tm_search descriptor + tm_stats; TM_CONFIG_ENV_ONLY ignores it)")
    }

} finally {
  restoreEnv()
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log("\nALL TM-TOOLS TESTS PASSED ✅")

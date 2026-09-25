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
    // #62 (from a real session): tm_browser's close now verifies that the OS pid
    // actually exited, but the agent had NO allowed way to double-check leftover
    // msedge trees — `tasklist` was refused by this very allowlist, so a
    // "已确认关闭" claim was unverifiable by the one party who cared. Read-only
    // process LISTING is now allowed; nothing that can act is.
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
  const readTool = runtime.tools.tm_read
  const grepTool = runtime.tools.tm_grep
  const bashTool = runtime.tools.tm_bash
  const fetchTool = runtime.tools.tm_fetch

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

  // 6c. fetch auth: cross-run, tampered, missing, malformed, expired + structure
  {
    const handleOut = (await readTool.execute({ path: "big2000.txt" }, ctx)).output
    const hRef = refOf(handleOut)
    const hTok = tokOf(handleOut)
    const res = (await fetchTool.execute({ ref: hRef, access_token: hTok }, ctx)).output
    assert.ok(res.includes("已返回 1 行"), "sanity: single-line payload fetches")
    // cross-run rejection
    const runtime2 = await tm.createTmTools({ directory: mktmp("run2"), client: fakeClient({}), $: fake$Ok("") })
    const cross = (await runtime2.tools.tm_fetch.execute({ ref: hRef, access_token: hTok }, { directory: root6 })).output
    assert.ok(cross.includes("[tm_fetch 失败 · phase=permission]"), "cross-run: structured error rendered as text (BUG#1)")
    assert.ok(cross.includes("run 不匹配"), "cross-run: run mismatch reason")
    assert.ok(cross.includes(tm.HANDLE_INVALID_MESSAGE), "cross-run: spec message")
    // tampered token
    const tampered = hTok.slice(0, -1) + (hTok.endsWith("0") ? "1" : "0")
    const bad = (await fetchTool.execute({ ref: hRef, access_token: tampered }, ctx)).output
    assert.ok(bad.includes("token 校验失败"), "tampered token rejected")
    // omitted token = THIS run's token (a real session re-typed the same 64
    // hex chars into every call; it is a run constant, not a per-handle secret)
    const omitted = (await fetchTool.execute({ ref: hRef }, ctx)).output
    assert.ok(!omitted.includes("phase=args") && !omitted.includes("phase=permission"), "omitted access_token resolves against the current run")
    assert.ok(omitted.includes("已返回"), "and the payload is served")
    const crossNoTok = (await runtime2.tools.tm_fetch.execute({ ref: hRef }, { directory: root6 })).output
    assert.ok(crossNoTok.includes("run 不匹配"), "the SAME omission on another run is still refused — the default never widens authority")
    // malformed ref
    const malformed = (await fetchTool.execute({ ref: "file:///etc/passwd", access_token: hTok }, ctx)).output
    assert.ok(malformed.includes("ref 格式无效"), "malformed ref rejected")
    // expired: forge an expired index entry (last append wins), then fetch
    const idxFile = path.join(runtime.store.blackboardRoot, "runs", runtime.runId, "index.jsonl")
    const idxLines = fs.readFileSync(idxFile, "utf8").trim().split("\n")
    const last = JSON.parse(idxLines[idxLines.length - 1])
    last.expire_at = 1 // 1970
    fs.writeFileSync(idxFile, [...idxLines.slice(0, -1), JSON.stringify(last)].join("\n") + "\n")
    const expired = (await fetchTool.execute({ ref: last.ref, access_token: hTok }, ctx)).output
    assert.ok(expired.includes("已过期"), "expired handle rejected")
    assert.ok(expired.includes(tm.HANDLE_INVALID_MESSAGE), "expired: spec message")
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
  console.log("6c. tm_fetch auth + structure: OK (cross-run, tamper, missing, malformed, expired, cap)")

  // 6d. P2 scope through tm_read (incl. client envelope self-check)
  {
    const outside = await readTool.execute({ path: "../outside.txt" }, ctx)
    assert.ok(outside.output.includes("phase=permission"), ".. escape -> permission")
    assert.ok(outside.output.includes("P2"), "P2 boundary named")
    const external = mktmp("ext")
    fs.writeFileSync(path.join(external, "f.txt"), "x")
    const externalRead = await readTool.execute({ path: path.join(external, "f.txt") }, ctx)
    assert.ok(externalRead.output.includes("phase=permission"), "absolute outside -> permission")
    // blackboard dir is inside the read scope (P2: 项目根+黑板+Trajectory)
    const bbFile = path.join(runtime.store.blackboardRoot, "runs", "x.md")
    fs.mkdirSync(path.dirname(bbFile), { recursive: true })
    fs.writeFileSync(bbFile, "stored notes")
    const bbRead = await readTool.execute({ path: bbFile }, ctx)
    assert.ok(!bbRead.output.includes("失败"), "blackboard scope readable")
    // client error envelope {ok:true, data:{error:{name,data:{message}}}} -> structured error
    // ("absent.txt" EXISTS on disk so P2 realpath passes, but it is NOT a fixture
    // key in the fake client, so the client emits the error envelope)
    const missing = await readTool.execute({ path: "absent.txt" }, ctx)
    assert.ok(missing.output.includes("[tm_read 失败 · phase=client]"), "envelope error phase (BUG#1 text)")
    assert.ok(missing.output.includes("no absent.txt"), "envelope message surfaced")
  }
  console.log("6d. P2 scope + client envelope: OK (escape, extra scope, error envelope)")

  // 6e. R6 reuse: tm_* is NOT an R6 bypass (same source, in-tool layer)
  {
    const envRead = await readTool.execute({ path: ".env" }, ctx)
    assert.ok(envRead.output.includes("phase=permission"), "tm_read .env blocked")
    assert.ok(envRead.output.includes(ep.ENV_PROTECT_MESSAGE), "tm_read .env: R6 message")
    assert.ok(envRead.output.includes("env-file-path"), "tm_read .env: category tag")
    const exampleRead = await readTool.execute({ path: "small.txt" }, ctx)
    assert.equal(exampleRead.output, smallPayload, "normal read unaffected (.env.example exemption lives in the matcher)")
    const bashEnv = await bashTool.execute({ command: "printenv PATH" }, ctx)
    assert.ok(bashEnv.output.includes("bash-env-command"), "tm_bash printenv blocked via R6")
    const bashEnvFile = await bashTool.execute({ command: "cat .env" }, ctx)
    assert.ok(bashEnvFile.output.includes("env-file-path"), "tm_bash cat .env blocked via R6")
    const grepEnv = await grepTool.execute({ pattern: "*.env" }, ctx)
    assert.ok(grepEnv.output.includes("env-file-path"), "tm_grep *.env pattern blocked via R6")
  }
  console.log("6e. R6 reuse in-tool: OK (tm_read/tm_grep/tm_bash env reads blocked, same source)")

  // 6f. P3 allowlist through tm_bash (what R6 does not forbid must still be allowlisted)
  {
    const ok = await bashTool.execute({ command: "ls -la" }, ctx)
    assert.ok(!ok.output.includes("失败"), "allowlisted ls executes")
    const deny = await bashTool.execute({ command: "rm -rf x" }, ctx)
    assert.ok(deny.output.includes("phase=permission"), "non-allowlisted denied")
    assert.ok(deny.output.includes("白名单"), "deny message names the allowlist")
    assert.ok(deny.output.includes("HUMAN"), "deny suggests HUMAN approval")
    const redirect = await bashTool.execute({ command: "ls > out.txt" }, ctx)
    assert.ok(redirect.output.includes("重定向"), "redirect denied")
    const subst = await bashTool.execute({ command: "ls $(rm -rf x)" }, ctx)
    assert.ok(subst.output.includes("命令替换"), "M1: command substitution denied in-tool")
    const findDel = await bashTool.execute({ command: "find . -delete" }, ctx)
    assert.ok(findDel.output.includes("find"), "find -delete denied")
    const tailF = await bashTool.execute({ command: "tail -f app.log" }, ctx)
    assert.ok(tailF.output.includes("挂起"), "tail -f denied")
    const gcWait = await bashTool.execute({ command: "Get-Content app.log -Wait" }, ctx)
    assert.ok(gcWait.output.includes("挂起"), "Get-Content -Wait denied")
    // round-3: quoted pipe must survive the P3 head check end-to-end
    const pipeQuoted = await bashTool.execute({ command: 'rg "err|warn" src' }, ctx)
    assert.ok(!pipeQuoted.output.includes("失败"), 'quoted pipe passes P3 in-tool (rg "err|warn" src)')
    // round-3 major #2: assignment prefix rejected in-tool with the right reason
    const assignCmd = await bashTool.execute({ command: "BASH_ENV=x.sh ls" }, ctx)
    assert.ok(assignCmd.output.includes("phase=permission"), "assignment prefix -> permission in-tool")
    assert.ok(assignCmd.output.includes("赋值"), "assignment prefix reason surfaced in-tool")
  }
  // Test-Path: existence probes are read-only — allowlisted so PTC/tm_bash
  // can run the version/env-path check batch a real session ran as 3 bash
  // round-trips (embedded $env: inside the command still trips R6 by design)
  assert.equal(
    tm.classifyReadonlyCommand("Test-Path \"x\"", tm.DEFAULT_BASH_READONLY_ALLOWED).ok,
    true,
    "Test-Path allowlisted (read-only existence probe)",
  )

  console.log("6f. P3 matrix through tm_bash: OK (allow, deny, redirect, substitution, find -delete, tail -f, -Wait, quoted pipe, assignment prefix)")

  // 6g. tm_bash success + offload + shell error structure
  {
    const bashOut = (await bashTool.execute({ command: "cat big.log" }, ctx)).output
    assert.ok(bashOut.includes("已卸载"), "big bash output offloads")
    assert.ok(bashOut.includes("cat big.log"), "bash preview clue carries command")
    // limit 2500 is capped to TM_FETCH_MAX_LINES=2000 — slice equality proves round-trip
    const bRef = refOf(bashOut)
    const fetchBack = (await fetchTool.execute({ ref: bRef, access_token: tokOf(bashOut), limit: 2500 }, ctx)).output
    assert.ok(fetchBack.includes("共 2500 行"), "bash payload round-trip: full line count")
    assert.ok(fetchBack.includes("已返回 2000 行"), "bash payload round-trip: fetch cap applies")
    assert.ok(fetchBack.endsWith(bigLines.slice(0, 2000).join("\n")), "bash payload round-trips via tm_fetch")
    // shell failure -> structured error with line extraction + noise stripped
    const failing$ = () => { throw { stderr: "\x1b[31mcat: secret: line 3: permission denied\x1b[0m\n\n\n", message: "Command failed" } }
    const runtimeFail = await tm.createTmTools({ directory: root6, client: fakeClient({}), $: failing$ })
    const shellErr = await runtimeFail.tools.tm_bash.execute({ command: "cat secret" }, ctx)
    assert.ok(shellErr.output.includes("[tm_bash 失败 · phase=execute · line=3]"), "shell error phase+line rendered")
    assert.ok(shellErr.output.includes("permission denied"), "shell error message kept")
    assert.ok(!shellErr.output.includes("\x1b[31m"), "ANSI stripped")
  }
  console.log("6g. tm_bash execution: OK (offload round-trip, clue, structured shell error + line)")

  // 6g2. An EMPTY result is an answer, not a mystery.  Live cost: a 0-line
  // `Get-Content | Select-Object -Skip 168` and a 0-hit tm_grep both came back
  // as nothing, and the model burned rounds deciding whether the tool had run
  // at all — then wrote down the wrong conclusion ("output got swallowed").
  {
    const rtEmpty = await tm.createTmTools({ directory: mktmp("empty6"), client: fakeClient({}), $: fake$Ok("") })
    const emptyBash = (await rtEmpty.tools.tm_bash.execute({ command: "ls" }, ctx)).output
    assert.ok(emptyBash.includes("stdout 为空") && emptyBash.includes("0 行"), "empty bash output states that it produced 0 lines")
    assert.ok(emptyBash.includes("cwd="), "…names the directory relative paths resolved against")
    assert.ok(emptyBash.includes("tm_read"), "…and points at the tool that reads files without the shell's decoding")
    const emptyGrep = (await rtEmpty.tools.tm_grep.execute({ pattern: "ArkType|ark_type" }, ctx)).output
    assert.ok(emptyGrep.includes("0 命中"), "a 0-hit grep reports the count instead of returning nothing")
    assert.ok(emptyGrep.includes("ArkType|ark_type"), "…echoes the pattern it judged")
    assert.ok(emptyGrep.includes("不证明整个仓库没有"), "…and bounds the claim: 0 here is not 0 everywhere")
    assert.ok(!emptyGrep.includes("去掉 path"), "a root-wide search is NOT told to widen a scope it never narrowed")
    const narrowed = (await rtEmpty.tools.tm_grep.execute({ pattern: "nothing-here", path: "src" }, ctx)).output
    assert.ok(narrowed.includes('path="src"'), "a narrowed search names the path that produced the 0, so the widening move is actionable")
    const rtFull = await tm.createTmTools({
      directory: mktmp("empty6b"),
      client: fakeClient({ __grep: "src/a.ts:3:hello" }),
      $: fake$Ok("one line"),
    })
    const fullBash = (await rtFull.tools.tm_bash.execute({ command: "ls" }, ctx)).output
    assert.ok(fullBash.trim() === "one line" && !fullBash.includes("stdout 为空"), "a command that DID print is returned untouched — the note never rides along")
    const fullGrep = (await rtFull.tools.tm_grep.execute({ pattern: "hello" }, ctx)).output
    assert.ok(fullGrep.includes("src/a.ts:3:hello") && !fullGrep.includes("0 命中"), "and a real hit is not decorated either")
  }

  // 6k. P0 regression: the shell-bridge fallback must reach the PTC pipeline
  // too.  v1.5.4 resolved the Bun-global $ fallback for the MAIN tm_bash
  // path only — PTC's pipeline instance got input.$ raw, so on desktops
  // where the loader does not pass $ through, every PTC tm.bash bridged
  // call died with "宿主 shell 桥（$）不可用".
  {
    const prev$ = globalThis.$
    const prevBun$ = globalThis.Bun ? globalThis.Bun.$ : undefined
    const hadBun = Boolean(globalThis.Bun)
    globalThis.$ = fake$Ok("bridge-ok")
    try {
      const rt = await tm.createTmTools({ directory: root6, client: fakeClient({}) }) // NO input.$
      const mainOut = (await rt.tools.tm_bash.execute({ command: "ls" }, ctx)).output
      assert.ok(mainOut.includes("bridge-ok"), "main tm_bash uses the Bun-global $ fallback")
      const ptc = await rt.tools.tm_ptc_run.execute(
        { program: 'const r = await tm.bash({ command: "ls" }); return r.ok ? r.data : r.error.message' },
        ctx,
      )
      assert.ok(ptc.output.includes("bridge-ok"), "PTC tm.bash bridging uses the SAME $ fallback")
      assert.ok(!ptc.output.includes("不可用"), "no missing-shell-bridge error anywhere in the PTC run")
    } finally {
      if (prev$ === undefined) delete globalThis.$
      else globalThis.$ = prev$
      if (!hadBun) { /* no Bun global to restore */ }
      else if (prevBun$ === undefined) delete globalThis.Bun.$
      else globalThis.Bun.$ = prevBun$
    }
  }
  console.log("6k. shell-bridge fallback shared by main + PTC pipelines: OK (P0)")

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
      // 403 after header disguise → DIRECTIVE: call tm_browser (not "try again")
      const forbidden = await wf.execute({ url: "https://baike.baidu.com/item/x" }, ctx)
      assert.ok(
        forbidden.output.includes("tm_browser") && forbidden.output.includes('action:"open"'),
        "403 → directive to call tm_browser with the exact action chain",
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
    const inline3 = (await runtimeT.tools.tm_read.execute({ path: "t3000.txt" }, ctx)).output
    assert.ok(inline3.startsWith("aaaa") && !inline3.includes("已卸载"), "TEXT tier: 3000 tokens rides inline (4000 boundary)")
    const off4 = (await runtimeT.tools.tm_read.execute({ path: "t4000.txt" }, ctx)).output
    assert.ok(off4.includes("已卸载") && off4.includes("tokens: 4000"), "TEXT tier: == 4000 offloads (conservative boundary)")
    const jsonOff = (await runtimeT.tools.tm_read.execute({ path: "j2500.json" }, ctx)).output
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
    const textOff = (await runtimeT.tools.tm_read.execute({ path: "t4000.txt" }, ctx)).output
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

    // #14: a live session spent ~30 browser navigations on cn.bing.com/search?q=…
    // — one query per round trip, on the channel tm_search already owns.
    {
      const sl = await import("./dist/tm/serp-loop.js")
      const serpUrl = `https://cn.bing.com/search?q=${encodeURIComponent("神椿 动漫")}`
      const serp = sl.serpTarget(serpUrl)
      assert.equal(serp.engine, "bing", "a bing results page is recognised, with the query decoded")
      assert.equal(serp.query, "神椿 动漫", "…and the query comes back readable")
      assert.equal(sl.serpTarget("https://cn.bing.com/")?.engine, undefined, "a bare home page (no query) is NOT a search")
      assert.equal(sl.serpTarget("https://baike.baidu.com/item/%E5%85%83%E7%A5%9E/10593772"), null, "an article is not a search — the guard must not eat real pages")
      assert.equal(sl.serpTarget("https://github.com/search?q=opencode&type=repositories").engine, "github", "github's search path maps to the github engine")
      assert.equal(sl.serpTarget("not a url"), null, "a malformed URL is simply not a search")
      assert.equal(sl.serpTarget("https://stackoverflow.com/questions/12/x"), null, "a question page is not /search")

      const loop = sl.createSerpLoopGuard(2)
      assert.equal(loop.observe("https://cn.bing.com/search?q=a").blocked, false, "the first SERP grab passes — bing's HTML is sometimes an anti-bot shell and only a real browser gets through")
      assert.equal(loop.observe("https://cn.bing.com/search?q=b").blocked, false, "…and the second")
      const third = loop.observe("https://cn.bing.com/search?q=c")
      assert.equal(third.blocked, true, "past the limit the navigation is refused")
      const refusal = sl.serpRefusal(third)
      assert.ok(refusal.includes("tm_search") && refusal.includes("bing"), "the refusal names the tool and the engine that should have been used")
      assert.ok(refusal.includes("反爬壳子"), "…and it keeps the legitimate fallback on the record instead of banning the path")
      assert.equal(loop.observe("https://example.com/docs"), null, "a non-SERP URL is not counted and not judged at all")
      assert.equal(loop.seen(), 3, "only search pages feed the counter")
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

  // 6o. tm_browser — governed interactive browser (Plan C: headful CDP pipe).
  {
    // headless resolution matrix (environment adaptivity)
    assert.equal(tm.resolveHeadless({ TM_BROWSER_HEADLESS: "1" }), true, "force headless")
    assert.equal(tm.resolveHeadless({ TM_BROWSER_HEADLESS: "0" }), false, "force headful")
    if (process.platform === "linux") {
      assert.equal(tm.resolveHeadless({ DISPLAY: ":0" }), false, "auto: DISPLAY present → headful")
      assert.equal(tm.resolveHeadless({}), true, "auto: no DISPLAY/WAYLAND → headless")
    } else {
      assert.equal(tm.resolveHeadless({}), false, "auto: win/mac desktop sessions → headful")
    }
    // discovery: TM_BROWSER_PATH override wins
    const fake = path.join(os.tmpdir(), `tm-browser-fake-${Date.now()}.exe`)
    fs.writeFileSync(fake, "x")
    assert.equal(tm.findBrowserExecutable({ TM_BROWSER_PATH: fake }), path.resolve(fake), "TM_BROWSER_PATH override wins")
    fs.rmSync(fake, { force: true })
    // default-browser resolution: Chromium-family filter + registry parsers
    assert.equal(tm.isChromiumFamily("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), true, "chrome.exe is Chromium-family")
    assert.equal(tm.isChromiumFamily("/usr/bin/brave"), true, "brave (linux) is Chromium-family")
    assert.equal(tm.isChromiumFamily("C:\\Program Files\\Mozilla Firefox\\firefox.exe"), false, "firefox is NOT CDP-capable")
    assert.equal(
      tm.parseProgId("HKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    ChromeHTML\r\n"),
      "ChromeHTML",
      "reg ProgId parsed",
    )
    assert.equal(
      tm.parseRegCommand('    (Default)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1\r\n'),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "reg open-command exe parsed",
    )
    assert.equal(
      tm.parseDesktopExec('[Desktop Entry]\nName=Chrome\nExec=/usr/bin/google-chrome-stable %U\n'),
      "/usr/bin/google-chrome-stable",
      "xdg desktop Exec parsed",
    )
    if (process.platform === "win32") {
      // fake registry: default = a REAL file named chrome.exe → resolver returns it
      const chromeFake = path.join(mktmp("defbrowser"), "chrome.exe")
      fs.writeFileSync(chromeFake, "x")
      const fakeReg = (cmd, args) =>
        args.some((a) => String(a).includes("UserChoice"))
          ? "    ProgId    REG_SZ    ChromeHTML\r\n"
          : `    (Default)    REG_SZ    "${chromeFake}" --single-argument %1\r\n`
      assert.equal(
        tm.defaultBrowserExecutable({}, fakeReg),
        chromeFake,
        "default browser (Chromium-family) resolved from the registry",
      )
      const ffReg = (cmd, args) =>
        args.some((a) => String(a).includes("UserChoice"))
          ? "    ProgId    REG_SZ    FirefoxURL\r\n"
          : "    (Default)    REG_SZ    \"C:\\FF\\firefox.exe\" -osint -url \"%1\"\r\n"
      assert.equal(tm.defaultBrowserExecutable({}, ffReg), null, "Firefox default → null (CDP cannot drive it; probe list takes over)")
      // Issue #5 of 2026-09-18: the user's default was Edge BETA, installed
      // machine-wide (HKLM\SOFTWARE\Classes) with the association recorded on
      // https.  The old probe read http + HKCU only, came back null, and the
      // STABLE candidate path won — so stable Edge kept opening.
      const betaFake = path.join(mktmp("defbrowser-beta"), "Microsoft", "Edge Beta", "Application", "msedge.exe")
      fs.mkdirSync(path.dirname(betaFake), { recursive: true })
      fs.writeFileSync(betaFake, "x")
      const betaReg = (cmd, args) => {
        const a = String(args.join(" "))
        if (a.includes("UrlAssociations\\http\\UserChoice")) throw new Error("reg: key not found")
        if (a.includes("UrlAssociations\\https\\UserChoice")) return "    ProgId    REG_SZ    MSEdgeBetaHTM\r\n"
        if (a.includes("HKCU\\Software\\Classes")) throw new Error("reg: key not found")
        if (a.includes("HKLM\\SOFTWARE\\Classes")) return `    (Default)    REG_SZ    "${betaFake}" --no-first-run --url "%1"\r\n`
        throw new Error(`unexpected probe: ${a}`)
      }
      assert.equal(
        tm.defaultBrowserExecutable({}, betaReg),
        betaFake,
        "https UserChoice + HKLM classes resolve Edge BETA when http/HKCU both fail",
      )
      assert.equal(
        tm.playwrightLaunchTarget(betaFake).channel,
        undefined,
        "the discovered BETA path launches as-is (channel msedge would silently open stable)",
      )
      assert.equal(
        tm.playwrightLaunchTarget(betaFake.replace("Edge Beta", "Edge")).channel,
        "msedge",
        "a stable-shaped path is the only case allowed to carry a channel",
      )
    }
    // allowlist is checked BEFORE any browser spawns (works without a browser)
    const blocked = await runtime.tools.tm_browser.execute({ action: "open", url: "https://evil.example.com/x" }, ctx)
    assert.ok(blocked.output.includes("phase=permission"), "disallowed host → permission error, no spawn")
    const noUrl = await runtime.tools.tm_browser.execute({ action: "open" }, ctx)
    assert.ok(noUrl.output.includes("缺少 url"), "open without url → args error")
    // real round-trip ONLY when a browser exists (skip on bare CI).  Mode is
    // an OPERATOR setting now (TM_BROWSER_HEADLESS) — the model-facing
    // `headless` arg is gone, so a test suite must never pop a window on the
    // developer running it.
    if (tm.findBrowserExecutable()) {
      const savedHeadless = process.env.TM_BROWSER_HEADLESS
      process.env.TM_BROWSER_HEADLESS = "1"
      // its OWN runtime: this block drives a real browser, and the shared §6
      // runtime has already been through env changes in earlier sections
      // (store dirs, allowlists) — a live round-trip must not inherit those.
      const liveRt = await tm.createTmTools({
        directory: mktmp("browser-live"),
        client: fakeClient({}),
        $: fake$Ok(""),
      })
      const B = liveRt.tools.tm_browser
      try {
        const open = await B.execute({ action: "open", url: "https://cn.bing.com" }, ctx)
        assert.ok(open.output.includes("浏览器已启动") && open.output.includes("无头"), "open launches headless via the env knob and reports the REAL mode")
        assert.ok(open.output.includes("已导航"), "open navigates")
        const read = await B.execute({ action: "read" }, ctx)
        assert.ok(/bing/i.test(read.output), "read extracts page text")
        const shot = await B.execute({ action: "screenshot" }, ctx)
        const shotPath = /截图已保存（PNG \d+ bytes）：(.+)$/m.exec(shot.output)?.[1]
        assert.ok(shotPath && fs.existsSync(shotPath.trim()) && fs.statSync(shotPath.trim()).size > 1000, "screenshot PNG written to the run store")
        assert.ok(shot.output.includes("上下文只携带路径"), "default screenshot ships the path, not the pixels")
        assert.equal(shot.attachments, undefined, "no attachment unless the caller asks")
        const shotImg = await B.execute({ action: "take_screenshot", image: true }, ctx)
        assert.ok(
          Array.isArray(shotImg.attachments) && shotImg.attachments.length === 1,
          "image:true attaches ONE file :: " + JSON.stringify(String(shotImg.output)).slice(0, 240),
        )
        assert.equal(shotImg.attachments?.[0]?.mime, "image/jpeg", "the model gets a JPEG (a real page is ~1.5MB as PNG — never inline that)")
        assert.equal(shotImg.attachments?.[0]?.type, "file", "attachment carries the official {type:'file'} shape")
        assert.ok(String(shotImg.attachments?.[0]?.url ?? "").startsWith("data:image/jpeg;base64,"), "pixels ride as a data URL")
        assert.ok(shotImg.attachments[0].url.length < 400_000 * 1.4 + 64, "the attached image respects TM_BROWSER_IMAGE_MAX_BYTES (base64 ceiling)")
        const after = await B.execute({ action: "take_screenshot" }, ctx)
        assert.equal(after.attachments, undefined, "attachments do NOT leak onto the next call")
        const closed = await B.execute({ action: "close" }, ctx)
        assert.ok(
          closed.output.includes("已确认关闭") || closed.output.includes("警告：关闭未完全成功"),
          "close states an VERIFIED verdict — success or an explicit warning, never a bare claim",
        )
        assert.ok(fs.existsSync(shotPath.trim()), "screenshot stays in the run store after close (TTL owns reclamation)")
      } finally {
        await liveRt.dispose()
        if (savedHeadless === undefined) delete process.env.TM_BROWSER_HEADLESS
        else process.env.TM_BROWSER_HEADLESS = savedHeadless
      }
    } else {
      console.log("  (no browser found — live round-trip skipped)")
    }
  }
  console.log("6o. tm_browser: OK (headless matrix, discovery override + DEFAULT-browser registry/xdg resolution with Chromium-family filter, pre-spawn allowlist, live round-trip when a browser exists)")

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
    const degraded = (await runtimeD.tools.tm_read.execute({ path: "big2000.txt" }, ctx)).output
    assert.ok(degraded.includes("[警告]"), "degraded: warning banner present")
    assert.ok(degraded.includes("降级"), "degraded: warning text present")
    assert.ok(degraded.includes("--- 内容（截断）"), "degraded: truncation marker")
    assert.ok(degraded.includes("c".repeat(8000)), "degraded: truncated to threshold*4 chars in output")
  }
  console.log("6h. degraded path: OK (store failure -> truncated + warning in output, no throw)")

  // 6j. BUG#2 regression: REAL host client shapes (tester-probed, no `ok` field) —
  //   file.read -> {data:{type:"text",content}, request, response}
  //   find.text -> {data:[{path, lines[], line}, ...], request, response}
  {
    const realClient = {
      file: {
        read: async () => ({ data: { type: "text", content: "real-host file body" }, request: {}, response: {} }),
      },
      find: {
        text: async () => ({
          data: [
            { path: "src/app.ts", lines: ["export function a() {}", "const b = 1"], line: 12 },
            { path: "src/b.ts", lines: ["const c = 3"], line: 40 },
          ],
          request: {},
          response: {},
        }),
      },
    }
    const rt = await tm.createTmTools({ directory: root6, client: realClient, $: fake$Ok("") })
    const readRes = await rt.tools.tm_read.execute({ path: "small.txt" }, ctx)
    assert.equal(readRes.output, "real-host file body", "BUG#2: ok-less file.read envelope unwraps")
    const grepRes = await rt.tools.tm_grep.execute({ pattern: "x" }, ctx)
    assert.ok(grepRes.output.includes("src/app.ts:12: export function a() {}"), "BUG#2: match path:line:text extraction")
    assert.ok(grepRes.output.includes("src/b.ts:40: const c = 3"), "BUG#2: second match extracted")
    // big real-shape match array -> offload; the 命中 N 行 clue must match the
    // RENDERED hit lines (previously JSON-stringified and mismatched)
    const many = Array.from({ length: 600 }, (_, i) => ({
      path: `src/f${i}.ts`, lines: [`const v${i} = ${i}; ${"x".repeat(40)}`], line: i + 1,
    }))
    const rt2 = await tm.createTmTools({
      directory: root6,
      client: { ...realClient, find: { text: async () => ({ data: many, request: {}, response: {} }) } },
      $: fake$Ok(""),
    })
    const bigGrep = await rt2.tools.tm_grep.execute({ pattern: "v" }, ctx)
    assert.ok(bigGrep.output.includes("已卸载"), "BUG#2: real-shape match array offloads")
    assert.ok(/命中 600 行/.test(bigGrep.output), "BUG#2: match-count clue from rendered hit lines")
    assert.ok(bigGrep.output.includes("src/f0.ts:1:"), "BUG#2: path:line structure survives into preview")
  }
  console.log("6j. real-host client shapes: OK (ok-less unwrap, match path/line/text extraction, hit count)")

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

  /* ---------- 7. loader integration: tool segment next to config + R6 hook ---------- */
  {
    clearTmEnv()
    const hooks = await plugin.server({ directory: root6, client: fakeClient({}), $: fake$Ok("") }, { envProtect: true })
    assert.equal(typeof hooks.config, "function", "config hook still present")
    assert.equal(typeof hooks["tool.execute.before"], "function", "R6 hook still present")
    assert.ok(hooks.tool, "tool segment present")
    for (const name of ["tm_read", "tm_grep", "tm_bash", "tm_fetch"]) {
      const def = hooks.tool[name]
      assert.equal(typeof def.execute, "function", `${name}: execute present`)
      assert.ok(def.description && def.description.length > 100, `${name}: description written`)
    }
    assert.ok(hooks.tool.tm_bash.description.includes("PowerShell"), "tm_bash: dialect note")
    assert.ok(hooks.tool.tm_bash.description.includes("R6"), "tm_bash: R6 note")
    assert.ok(hooks.tool.tm_bash.description.includes("READ-ONLY"), "tm_bash: READ-ONLY promise (M1 fixed)")
    assert.ok(hooks.tool.tm_bash.description.includes("command substitution"), "tm_bash: substitution escape documented")
    assert.ok(hooks.tool.tm_bash.description.includes("-Wait"), "tm_bash: PS -Wait hang documented")
    assert.ok(hooks.tool.tm_grep.description.includes("rg"), "tm_grep: names rg (anti-#14791)")
    assert.ok(hooks.tool.tm_grep.description.includes("PREFER"), "tm_grep: preference guidance")
    assert.ok(hooks.tool.tm_grep.description.includes("tm_fetch"), "tm_grep: handle protocol")
    assert.ok(hooks.tool.tm_grep.description.includes("expire_at"), "tm_grep: handle shape complete (nit)")
    assert.ok(hooks.tool.tm_read.description.includes("TM_OFFLOAD_THRESHOLD"), "tm_read: threshold documented")
    assert.ok(hooks.tool.tm_fetch.description.includes("access_token"), "tm_fetch: auth documented")
    assert.ok(hooks.tool.tm_fetch.description.includes("structure"), "tm_fetch: structure mode documented")
    // BUG#1: every execute() returns the ToolResult contract — {output: string},
    // never a bare object (bare objects crash the host result pipeline: c.split)
    const probe = await hooks.tool.tm_read.execute({ path: ".env" }, { directory: root6 })
    assert.ok(
      probe && typeof probe === "object" && typeof probe.output === "string" && probe.output.length > 0,
      "BUG#1: execute returns {output: string} satisfying ToolResult",
    )
    // BUG#3: args is a ZodRawShape (plain {key: validator} object), NOT a
    // z.object() wrapper (the wrapper serialized garbage into the LLM spec)
    let zodAvailable = false
    try {
      const zm = await import("zod")
      zodAvailable = Boolean(zm?.z ?? zm?.default?.z)
    } catch {}
    for (const name of ["tm_read", "tm_grep", "tm_bash", "tm_fetch"]) {
      const def = hooks.tool[name]
      assert.ok(def.args && typeof def.args === "object", `${name}: args present`)
      assert.equal(typeof def.args.parse, "undefined", `${name}: args is a raw shape (no z.object wrapper)`)
      assert.ok(!("_def" in def.args), `${name}: args is not itself a zod validator`)
      if (zodAvailable) {
        assert.ok(
          Object.values(def.args).some((v) => v && typeof v === "object" && "_def" in v),
          `${name}: raw-shape values are zod validators`,
        )
      }
    }
  }
  console.log("7. loader integration: OK (config + R6 hook + tool segment, ToolResult shape, ZodRawShape args)")

  /* ---------- 8. hook-level alias: tm_* pass through R6's own interception ---------- */
  {
    clearTmEnv()
    const hooks = await plugin.server({ directory: root6 }, { envProtect: true })
    await assert.rejects(
      hooks["tool.execute.before"]({ tool: "tm_read" }, { args: { path: ".env" } }),
      (err) => err.message.startsWith(ep.ENV_PROTECT_MESSAGE) && err.message.includes("[category=env-file-path]"),
      "hook blocks tm_read .env",
    )
    await assert.rejects(
      hooks["tool.execute.before"]({ tool: "tm_bash" }, { args: { command: "printenv" } }),
      (err) => err.message.includes("[category=bash-env-command]"),
      "hook blocks tm_bash printenv",
    )
    await assert.rejects(
      hooks["tool.execute.before"]({ tool: "tm_grep" }, { args: { pattern: "*.env", path: "src" } }),
      (err) => err.message.includes("[category=env-file-path]"),
      "hook blocks tm_grep env-file pattern",
    )
    await hooks["tool.execute.before"]({ tool: "tm_read" }, { args: { path: "src/app.ts" } }) // passes
    await hooks["tool.execute.before"]({ tool: "tm_bash" }, { args: { command: "ls -la" } }) // passes
    // single source: R6 off disables BOTH layers (hook + in-tool)
    process.env.TM_ENV_PROTECT = "off"
    const hooksOff = await plugin.server({ directory: root6 }, { envProtect: true })
    await hooksOff["tool.execute.before"]({ tool: "tm_read" }, { args: { path: ".env" } })
    const runtimeOff = await tm.createTmTools({
      directory: root6, client: fakeClient({ "small.txt": smallPayload }), $: fake$Ok(""),
    })
    const offRead = await runtimeOff.tools.tm_read.execute({ path: "small.txt" }, ctx)
    assert.equal(offRead.output, smallPayload, "off mode: tools unaffected (same source)")
  }
  console.log("8. hook alias: OK (tm_* covered by R6 hook, off disables both layers)")

  /* ---------- 9. tm_ptc_run (M1 contract skeleton) ---------- */
  clearTmEnv()
  {
    // 9a. config resolution for the PTC knobs (typed defaults + fail-soft)
    const cfg = tm.resolveTmConfig({})
    assert.equal(cfg.ptcMaxProgramChars, 4000, "ptc default program cap")
    assert.equal(cfg.ptcMaxCalls, 20, "ptc default max calls")
    assert.equal(cfg.ptcMaxErrors, 3, "ptc default max errors")
    assert.equal(cfg.ptcTimeoutMs, 60000, "ptc default timeout")
    assert.equal(cfg.ptcEngine, "auto", "ptc default engine")
    const ptcEnv = tm.resolveTmConfig({
      TM_PTC_MAX_CALLS: "50", TM_PTC_MAX_ERRORS: "10", TM_PTC_TIMEOUT_MS: "300000",
      TM_PTC_ENGINE: "worker", TM_PTC_MAX_PROGRAM_CHARS: "8000",
    })
    assert.equal(ptcEnv.ptcMaxCalls, 50, "ptc calls env override")
    assert.equal(ptcEnv.ptcMaxErrors, 10, "ptc errors env override")
    assert.equal(ptcEnv.ptcTimeoutMs, 300000, "ptc timeout env override")
    assert.equal(ptcEnv.ptcEngine, "worker", "ptc engine env override")
    assert.equal(ptcEnv.ptcMaxProgramChars, 8000, "ptc program cap env override")
    // out-of-range env values fall back to defaults (envInt guard)
    assert.equal(tm.resolveTmConfig({ TM_PTC_MAX_CALLS: "9999" }).ptcMaxCalls, 20, "calls over 200 -> default")
    assert.equal(tm.resolveTmConfig({ TM_PTC_TIMEOUT_MS: "1000" }).ptcTimeoutMs, 60000, "timeout under 5s -> default")
    assert.equal(tm.resolveTmConfig({ TM_PTC_ENGINE: "garbage" }).ptcEngine, "auto", "bad engine -> auto")
    console.log("9a. PTC config: OK (typed defaults, env overrides, range guards)")

    // 9b. clamp matrix — callers may only TIGHTEN (ceiling=cfg, floor=hard)
    assert.deepEqual(tm.resolvePtcBudgets(cfg, {}), { maxCalls: 20, maxErrors: 3, timeoutMs: 60000 }, "omit -> ceilings")
    assert.deepEqual(
      tm.resolvePtcBudgets(cfg, { max_calls: 5, max_errors: 1, timeout_ms: 10000 }),
      { maxCalls: 5, maxErrors: 1, timeoutMs: 10000 }, "tighten honored",
    )
    assert.deepEqual(
      tm.resolvePtcBudgets(cfg, { max_calls: 9999, max_errors: 100, timeout_ms: 99999999 }),
      { maxCalls: 20, maxErrors: 3, timeoutMs: 60000 }, "cannot loosen past ceiling",
    )
    assert.deepEqual(
      tm.resolvePtcBudgets(cfg, { max_calls: 0, max_errors: -5, timeout_ms: 100 }),
      { maxCalls: 1, maxErrors: 1, timeoutMs: 5000 }, "cannot go below floor",
    )
    assert.equal(tm.resolvePtcBudgets(cfg, { max_calls: "abc" }).maxCalls, 20, "garbage -> ceiling")
    const cfg50 = { ...cfg, ptcMaxCalls: 50, ptcMaxErrors: 10, ptcTimeoutMs: 120000 }
    assert.equal(tm.resolvePtcBudgets(cfg50, { max_calls: 40 }).maxCalls, 40, "tighten under custom ceiling")
    assert.equal(tm.resolvePtcBudgets(cfg50, { max_calls: 100 }).maxCalls, 50, "clamp to custom ceiling")
    console.log("9b. budget clamp: OK (tighten-only, ceiling/floor, garbage)")

    // 9c. arg validation (program length, empty, label truncate, default label)
    const overCap = tm.parsePtcArgs({ program: "x".repeat(4001) }, cfg)
    assert.equal(overCap.ok, false, "program over cap rejected")
    assert.equal(overCap.error.error.phase, "args", "over-cap is an args error")
    assert.equal(tm.parsePtcArgs({ program: "   " }, cfg).ok, false, "blank program rejected")
    const longLabel = tm.parsePtcArgs({ program: "return 1", label: "z".repeat(100) }, cfg)
    assert.equal(longLabel.args.label.length, 80, "label truncated to 80")
    const defLabel = tm.parsePtcArgs({ program: "return 1" }, cfg)
    assert.equal(defLabel.ok, true, "valid program")
    assert.equal(defLabel.args.label, "ptc-run", "default label")
    // Wave B Minor② — budgets REJECT unknown keys (loud validation). A typo
    // like max_call (missing the s) used to slip past the type + per-field
    // checks and silently resolve to the ceiling default; now it is a hard
    // args error that NAMES the offending key and the legal set.
    const typoBudgets = tm.parsePtcArgs({ program: "return 1", budgets: { max_call: 3 } }, cfg)
    assert.equal(typoBudgets.ok, false, "budgets unknown key (max_call) is REJECTED, not silently defaulted")
    assert.equal(typoBudgets.error.error.phase, "args", "unknown budget key -> args-phase error")
    assert.ok(typoBudgets.error.error.message.includes("max_call"), "the unknown key is NAMED in the error")
    assert.ok(typoBudgets.error.error.message.includes("max_calls") && typoBudgets.error.error.message.includes("timeout_ms"), "the legal key set is named")
    const okBudgets = tm.parsePtcArgs({ program: "return 1", budgets: { max_calls: 3, max_errors: 1, timeout_ms: 8000 } }, cfg)
    assert.equal(okBudgets.ok, true, "all-legal budgets keys still pass")
    assert.deepEqual(okBudgets.args.budgets.setByUser, ["max_calls", "max_errors", "timeout_ms"], "legal keys resolve + tracked")
    console.log("9c. arg schema: OK (length cap, blank reject, label trunc/default, budgets reject unknown key w/ legal-set hint)")

    // static pre-scan (the FIRST gate — wired into runPtc + the tool since M2)
    assert.equal(tm.staticPscan("const x=await tm.read({})").rejected, false, "clean program passes pscan")
    assert.equal(tm.staticPscan("require('fs')").rejected, true, "require caught by pscan")
    assert.equal(tm.staticPscan("process.exit(1)").rejected, true, "process caught by pscan")
    assert.ok(tm.staticPscan("globalThis.x").tokens.includes("globalThis"), "globalThis token reported")
    // T6/C1: the pre-scan strips string / comment / regex-literal / template-
    // TEXT bodies first, so a grep pattern (or comment) that merely MENTIONS a
    // banned word is DATA, not an executable escape.  But a template's ${...}
    // INTERPOLATION is executed, so it is RETAINED and scanned (the old stripper
    // deleted the whole template and missed `x ${require(...)} y`).
    // executable tokens (outside any literal) are still caught.
    assert.equal(tm.stripNonExecutable('tm.grep({ pattern: "require|process" })'), 'tm.grep({ pattern:   })', "strip replaces the string body with a single space")
    assert.equal(tm.staticPscan('return await tm.grep({ pattern: "require|process|globalThis|fs" })').rejected, false, "banned words INSIDE a search-pattern string do not reject")
    assert.equal(tm.staticPscan('`see the require docs for process`').rejected, false, "banned words in template TEXT do not reject")
    assert.equal(tm.staticPscan('const msg = `x ${ process.exit(1) } y`').rejected, true, "C1: a banned call inside a ${...} INTERPOLATION is now scanned (old stripper deleted it)")
    assert.ok(tm.staticPscan('`${ require("fs") }`').tokens.includes("require"), "require inside an interpolation is reported")
    assert.equal(tm.staticPscan('const o = { pattern: /\\brequire\\b/ }; return o').rejected, false, "C1: a regex LITERAL naming a banned word is data, not an escape (false-positive fixed)")
    assert.ok(tm.staticPscan('return tm.read.constructor("x")').tokens.includes("constructor("), "constructor( escape call-site token")
    assert.ok(tm.staticPscan('return eval("1")').tokens.includes("eval("), "eval( escape call-site token")
    assert.ok(tm.staticPscan('return Function("x")()').tokens.includes("Function("), "Function( escape call-site token")
    assert.equal(tm.staticPscan("// use require() or process.exit here\nreturn 1").rejected, false, "banned words in a line comment do not reject")
    assert.equal(tm.staticPscan("/* require, process, globalThis */ return 1").rejected, false, "banned words in a block comment do not reject")
    assert.equal(tm.staticPscan("/* unterminated require").rejected, true, "unterminated comment tail still scanned (fail-closed)")
    assert.equal(tm.staticPscan('const s = "a \\" require b"; return s').rejected, false, "escaped quote inside a string does not end it early")
    assert.equal(tm.staticPscan('require(process.argv)').rejected, true, "real executable require+process still rejected")
    console.log("9d. staticPscan: OK (executable-only scan strips string/template/comment; real tokens still caught)")

    // run helper (mock bridge — never touches a real client)
    const engine = () => new tm.InlineSequentialEngine()
    const runWith = (program, bridge, budgets, nowFn) =>
      tm.runPtc({
        program, label: "t", budgets, parentStepId: "s0007", cfg,
        bridge, engine: engine(), ...(nowFn ? { now: nowFn } : {}),
      })
    const MAX = { maxCalls: 10, maxErrors: 3, timeoutMs: 60000 }

    // 9e. five statuses, each independently triggered
    {
      const ok = await runWith(
        'const r = await tm.read({ path: "a" }); return { hello: r }',
        { call: async () => ({ ok: true, data: "inline-text" }) }, MAX,
      )
      assert.equal(ok.status, "ok", "status ok on normal return")
      assert.equal(ok.returned, true, "returned flag")
      assert.equal(ok.okCount, 1, "one ok step")
      assert.equal(ok.calls, 1, "one call")

      const callStop = await runWith(
        'for (let i = 0; i < 5; i++) { await tm.bash({ command: "ls" }) } return 9',
        { call: async () => ({ ok: true, data: "x" }) }, { ...MAX, maxCalls: 2 },
      )
      assert.equal(callStop.status, "stopped-call-budget", "call budget stops the run")
      assert.equal(callStop.calls, 2, "exactly maxCalls dispatched")
      assert.equal(callStop.okCount, 2, "produced ok steps are NOT lost on stop")

      const errStop = await runWith(
        'for (let i = 0; i < 5; i++) { await tm.grep({ pattern: "p" }) } return 8',
        { call: async () => ({ ok: false, error: { tool: "tm_grep", phase: "args", message: "bad" } }) },
        { ...MAX, maxErrors: 2 },
      )
      assert.equal(errStop.status, "stopped-error-budget", "error budget stops the run")
      assert.equal(errStop.errCount, 2, "two error steps recorded")
      assert.equal(errStop.retries, 0, "args phase is NEVER retried")
      assert.equal(errStop.okCount, 0, "no ok steps in the all-error run")

      // timeout: the injected clock jumps past the deadline after call #2, so
      // call #3's pre-check trips the time budget — the 2 produced steps stay.
      {
        const start = 1000
        let clock = start
        let n = 0
        const bridge = {
          call: async () => { n++; if (n === 2) clock = start + 10_000_000; return { ok: true, data: "r" } },
        }
        const to = await runWith(
          'await tm.read({ path: "a" }); await tm.read({ path: "b" }); await tm.read({ path: "c" }); return 3',
          bridge, { maxCalls: 10, maxErrors: 3, timeoutMs: 5000 }, () => clock,
        )
        assert.equal(to.status, "timeout", "deadline trip -> timeout status")
        assert.equal(to.okCount, 2, "produced steps before the timeout are retained")
      }

      // engine-error: the program throws on the M1 legacy MAIN-thread engine
      // (which does not tag program faults — the driver sees a raw reject).
      {
        const ee = await runWith('throw new Error("boom")', { call: async () => ({ ok: true, data: "x" }) }, MAX)
        assert.equal(ee.status, "engine-error", "legacy inline engine: throw -> engine-error")
        assert.equal(ee.returned, false, "no return value captured")
        assert.ok(ee.engineError && /boom/.test(ee.engineError.message), "engine error message kept")
        assert.equal(ee.engineError.phase, "execute", "engine error phase tagged execute")
      }

      // SIXTH status — program-error: on a SANDBOXED engine (InlineVmEngine) a
      // program throw is tagged PtcProgramError by the engine -> "program-error"
      // (NOT engine-error), and auto mode must NOT re-run it.
      {
        const pe = await tm.runPtc({
          program: 'throw new Error("boom-prog")', label: "t", budgets: MAX,
          parentStepId: "s0007", cfg, engine: new tm.InlineVmEngine(5000),
          bridge: { call: async () => ({ ok: true, data: "x" }) },
        })
        assert.equal(pe.status, "program-error", "sandboxed engine: program throw -> program-error (sixth status)")
        assert.equal(pe.degraded, false, "program-error never auto-degrades")
        assert.ok(pe.engineError && /boom-prog/.test(pe.engineError.message), "program-error keeps the message")
      }

      // retry <=1 on an idempotent phase, then success; retries counted, no err row
      {
        let n = 0
        const bridge = {
          call: async () => {
            n++
            return n === 1
              ? { ok: false, error: { tool: "tm_read", phase: "client", message: "transient" } }
              : { ok: true, data: "recovered" }
          },
        }
        const rt = await runWith('const r = await tm.read({ path: "a" }); return r', bridge, MAX)
        assert.equal(rt.status, "ok", "retry then success is still ok")
        assert.equal(rt.retries, 1, "one retry counted")
        assert.equal(rt.okCount, 1, "the retried step is an ok row")
        assert.equal(rt.errCount, 0, "no error row after a successful retry")
        assert.equal(n, 2, "bridge called exactly twice (once + one retry)")
      }

      // a retryable failure AT the deadline must not buy extra wall-clock
      // time: no retry, the error row is recorded with the run still alive
      {
        let n = 0
        const start = 1000
        let clock = start
        const bridge = {
          call: async () => {
            n++
            clock = start + 10_000_000 // deadline blows past DURING the call
            return { ok: false, error: { tool: "tm_read", phase: "client", message: "transient at the wire" } }
          },
        }
        const dr = await runWith(
          'const r = await tm.read({ path: "a" }); return r',
          bridge, { maxCalls: 10, maxErrors: 3, timeoutMs: 5000 }, () => clock,
        )
        assert.equal(dr.status, "ok", "a lone error under the budget does not stop the run")
        assert.equal(dr.retries, 0, "NO retry once past the deadline")
        assert.equal(n, 1, "bridge called exactly once (retry suppressed)")
        assert.equal(dr.errCount, 1, "the error step is recorded")
      }
    }
    console.log("9e. six statuses: OK (ok, stopped-call-budget, stopped-error-budget, timeout, engine-error [legacy inline], program-error [sandboxed]) + retry-once")

    // 9f. composite step number survives REF_PATTERN + STEP_FILE, handle parses
    {
      const root = mktmp("ptc-ref")
      const store = new tm.RunStore({
        projectRoot: root, blackboardDir: ".bb/", trajectoryDir: ".tj/",
        runId: "r-ptc", ttlDays: 7,
      })
      const composite = "s0007.k03"
      const ref = tm.buildRef("r-ptc", composite)
      assert.deepEqual(tm.parseRef(ref), { runId: "r-ptc", stepId: composite }, "REF_PATTERN accepts dotted step id")
      const st = store.writeResult(composite, {
        tool: "tm_bash", content: '{"error":{}}', tokens: 4, contentType: "json", preview: "p", expireAt: Date.now() + 1000,
      })
      assert.equal(st.ref, ref, "store builds the composite ref")
      assert.equal(store.readStepFile(composite).content, '{"error":{}}', "STEP_FILE round-trips under a dotted step dir")
      assert.ok(fs.existsSync(path.join(root, ".bb", "runs", "r-ptc", "steps", composite, "001-tm_bash.md")), "error file lands at steps/sXXXX.kNN/")
      console.log("9f. composite step number: OK (parseRef + writeResult + readStepFile under sXXXX.kNN)")
    }

    // 9g. trajectory event shapes (design §6): parent call + child call/result/
    //     error (with ptc parent tag) + finish (with counters + status)
    {
      const root = mktmp("ptc-tj")
      const store = new tm.RunStore({
        projectRoot: root, blackboardDir: ".bb/", trajectoryDir: ".tj/",
        runId: "r-tj", ttlDays: 7,
      })
      const out = await tm.runPtc({
        program: 'await tm.read({ path: "a" }); await tm.read({ path: "b" }); return 1',
        label: "L", budgets: { maxCalls: 5, maxErrors: 2, timeoutMs: 60000 },
        parentStepId: "s0007", cfg, store,
        engine: engine(),
        bridge: { call: async () => ({ ok: false, error: { tool: "tm_read", phase: "permission", message: "denied" } }) },
      })
      assert.equal(out.status, "stopped-error-budget", "two permission errors trip the budget")
      const lines = fs.readFileSync(store.trajectoryFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      const parentCall = lines.find((l) => l.tool === "tm_ptc_run" && l.event === "call")
      assert.ok(parentCall && parentCall.step_id === "s0007", "parent call event on the PTC step id")
      assert.equal(parentCall.label, "L", "parent call carries label")
      assert.ok(/^[0-9a-f]{64}$/.test(parentCall.program_sha256), "parent call carries program sha256")
      assert.ok(parentCall.budgets && parentCall.budgets.maxCalls === 5, "parent call carries budgets")
      const childCalls = lines.filter((l) => l.event === "call" && l.tool === "tm_read")
      assert.equal(childCalls.length, 2, "two child call events")
      assert.ok(childCalls.every((c) => /^s0007\.k\d\d$/.test(c.step_id)), "child step ids are composite sXXXX.kNN")
      assert.equal(childCalls[0].ptc, "s0007", "child call carries ptc parent tag")
      const errEv = lines.find((l) => l.event === "error")
      assert.equal(errEv.phase, "permission", "error event carries phase")
      assert.equal(errEv.retry, false, "permission error not retried (retry:false flag present)")
      assert.ok(/\/steps\/s0007\.k\d\d\/result$/.test(errEv.ref), "error event carries the composite full-text ref")
      const finish = lines.find((l) => l.tool === "tm_ptc_run" && l.event === "finish")
      assert.equal(finish.status, "stopped-error-budget", "finish carries the final status")
      assert.equal(finish.calls, 2, "finish calls count")
      assert.equal(finish.errors, 2, "finish errors count")
      assert.ok(fs.existsSync(path.join(root, ".bb", "runs", "r-tj", "steps", "s0007.k01", "001-tm_read.md")), "full error persisted under composite dir")
      console.log("9g. trajectory shapes: OK (parent call + child call/error + finish, ptc tags, composite refs)")
    }

    // 9h. summary shape pin (fixed headers verbatim + row formats)
    {
      const oc = await runWith(
        'const r = await tm.read({ path: "a" }); return 1',
        { call: async () => ({ ok: true, data: "hello" }) }, MAX,
      )
      const text = tm.renderPtcSummary(oc)
      const L = text.split("\n")
      assert.equal(tm.PTC_SUMMARY_HEADER, "PTC 摘要", "summary header const")
      assert.equal(L[0], `PTC 摘要 · t · status=ok`, "line0 verbatim label+status")
      assert.equal(tm.PTC_OK_SECTION, "-- 成功分部（≤8 行，超出整表卸载）", "ok section const verbatim")
      assert.equal(tm.PTC_OK_HEADER, " #  tool      ms   tokens  落点(inline|ref 短码)", "ok header const verbatim")
      assert.equal(tm.PTC_ERR_SECTION, "-- 错误分部（全量错误已落 run store）", "err section const verbatim")
      assert.equal(tm.PTC_ERR_HEADER, " #  tool      phase      line  retry  message(截断)", "err header const verbatim")
      assert.match(L[1], /^steps=1 ok=1 err=0 retries=0 ms=\d+ {2}engine=inline$/, "metrics line verbatim (two spaces before engine)")
      // T6: the budgets echo line (T1 fix) now sits between the metrics line
      // and the ok section, so the "line2" pin is WRONG — locate by content.
      assert.match(L[2], /^budgets: calls≤10 err≤3 to=60000ms \(defaults\)$/, "budgets echo line (all defaults) sits at line2")
      const okSec = L.indexOf(tm.PTC_OK_SECTION)
      assert.ok(okSec >= 0, "ok section present")
      assert.equal(L[okSec + 1], tm.PTC_OK_HEADER, "ok header right after the section")
      assert.match(L[okSec + 2], /^ 1 {2}tm_read.*inline$/, "success row: seq + tool + inline dest after header")
      assert.ok(text.includes(tm.PTC_ERR_SECTION), "err section present even with no errors")
      assert.ok(text.includes(tm.PTC_ERR_HEADER), "err header present")
      assert.ok(text.includes(tm.PTC_RETURN_PREFIX + "1"), "return value line")
      // T6 budgets provenance echo: an over-ceiling call is shown CLAMPED (the
      // operator sees the squeeze, not just the final number), and a tightened
      // one is shown as custom with the field named.
      const clampedRun = await runWith(
        'return 1', { call: async () => ({ ok: true, data: "x" }) },
        { ...tm.resolvePtcBudgetsDetailed(cfg, { max_calls: 9999, max_errors: 1 }).budgets, setByUser: ["max_calls", "max_errors"], clamped: ["max_calls"] },
      )
      const clampedText = tm.renderPtcSummary(clampedRun).split("\n").find((l) => l.startsWith("budgets:"))
      assert.ok(clampedText.includes("CLAMPED: max_calls"), "over-ceiling field flagged CLAMPED")
      assert.ok(clampedText.includes("custom: max_calls, max_errors"), "user-set fields named")
      assert.ok(!clampedText.includes("CLAMPED: max_errors"), "non-clamped set field not flagged")
      // an offloaded success row shows the ref short code
      const oc2 = await runWith(
        'await tm.bash({ command: "ls" }); return 1',
        { call: async () => ({ ok: true, data: { offloaded: true, ref: "tm://runs/r/steps/s0007.k01/result", tokens: 9000 } }) }, MAX,
      )
      assert.ok(tm.renderPtcSummary(oc2).includes("ref:s0007.k01"), "offloaded row shows ref short code")
      // educator line: ok steps + no returned data → warning present;
      // runs WITH a return value carry no warning
      const nr = await runWith(
        'await tm.read({ path: "a" }); await tm.grep({ pattern: "x" })',
        { call: async () => ({ ok: true, data: "piece" }) }, MAX,
      )
      const nrText = tm.renderPtcSummary(nr)
      assert.ok(nrText.includes("程序未 return 数据"), "no-return educator warning present")
      assert.ok(nrText.includes("2 次成功桥接"), "warning counts the discarded ok steps")
      assert.ok(!tm.renderPtcSummary(oc).includes("程序未 return 数据"), "runs with a return value carry no warning")
      // engine-error row shows the program tool + message
      const ee = await runWith('throw new Error("kaboom")', { call: async () => ({ ok: true, data: "x" }) }, MAX)
      const eeText = tm.renderPtcSummary(ee)
      assert.ok(/status=engine-error$/.test(eeText.split("\n")[0]), "engine-error status in header")
      assert.ok(eeText.includes("tm_ptc_run") && eeText.includes("kaboom"), "engine-error row lists program + message")
      assert.ok(eeText.includes("引擎错误"), "engine fault renders the 引擎错误 label")
      // program-error row renders the DISTINCT 程序错误 label (T6 six-state)
      const peRun = await tm.runPtc({
        program: 'throw new Error("prog-oom")', label: "t", budgets: MAX,
        parentStepId: "s0007", cfg, engine: new tm.InlineVmEngine(5000),
        bridge: { call: async () => ({ ok: true, data: "x" }) },
      })
      const peText = tm.renderPtcSummary(peRun)
      assert.ok(/status=program-error$/.test(peText.split("\n")[0]), "program-error status in header")
      assert.ok(peText.includes("程序错误") && !peText.includes("引擎错误"), "program fault renders the 程序错误 label (distinct)")
      assert.ok(peText.includes("prog-oom"), "program-error row keeps the message")
      console.log("9h. summary shape pin: OK (verbatim headers, metrics format, inline/ref/err rows, return line)")
    }

    // 9i. tm_ptc_run tool builds + renders summary + IS registered (M3)
    {
      const tool = tm.buildPtcRunTool({
        cfg, store: new tm.RunStore({ projectRoot: mktmp("ptc-tool"), blackboardDir: ".bb", trajectoryDir: ".tj", runId: "r-t", ttlDays: 7 }),
        nextStepId: () => "s0001", ctx: { directory: process.cwd() }, accessToken: "a".repeat(64),
        bridge: { call: async () => ({ ok: true, data: "hi" }) },
      })
      assert.equal(typeof tool.execute, "function", "ptc tool execute present")
      assert.ok(tool.description.includes("tm.read") && /zero LLM round-trips/i.test(tool.description) && tool.description.includes("≥3 tm_read"), "ptc description documents the program protocol + trigger threshold")
      // ZodRawShape-style args (no z.object wrapper; descriptor fallback path)
      assert.ok(tool.args.program && typeof tool.args.program === "object", "ptc args.raw shape present")
      const res = await tool.execute({ program: 'const r = await tm.read({ path: "a" }); return r.ok', budgets: { max_calls: 3 } }, { directory: process.cwd() })
      assert.equal(typeof res.output, "string", "ToolResult {output:string} contract honored")
      assert.ok(res.output.includes("PTC 摘要") && res.output.includes("status=ok"), "tool output is the aggregation summary")
      // M3 (v1.5.4 revised): tm_ptc_run IS registered in the tool segment and
      // ALL SIX agents carry the allow (team included — overrides the tm_*
      // wildcard; see CHANGELOG 1.5.4)
      const hooks = await plugin.server({ directory: mktmp("ptc-reg"), client: fakeClient({}), $: fake$Ok("") }, { envProtect: true })
      assert.ok("tm_ptc_run" in hooks.tool, "tm_ptc_run registered in the tool segment (M3)")
      assert.deepEqual(
        Object.keys(hooks.tool).sort(),
        [
          "tm_bash", "tm_board_write", "tm_browser", "tm_fetch", "tm_grep", "tm_join",
          "tm_memory", "tm_ptc_run", "tm_pty", "tm_read", "tm_search", "tm_stats", "tm_webfetch",
        ],
        "registered tm_* set: tm_join collects host task children but tm_dispatch is gone (a plugin-spawned child is not closeable by the user), and tm_board_write is the board's write side",
      )
      // program over the cap is rejected through the tool as an args error
      const big = await tool.execute({ program: "x".repeat(4001) }, { directory: process.cwd() })
      assert.ok(big.output.includes("phase=args") && big.output.includes("program 超过长度上限"), "over-cap program -> args error text")
    }
    console.log("9i. tm_ptc_run tool: OK (builds + renders summary, honors ToolResult; registered in tool segment, five-tool set)")

    // 9j. REAL engines — previously ZERO coverage (9e-9i all ran
    // InlineSequentialEngine with a mock bridge, while auto mode tries
    // WorkerEngine FIRST on a real host).
    {
      const fakeBridge = { call: async (tool) => ({ ok: true, data: `ran:${tool}` }) }
      const runOpts = (program, engine, budgets) => ({
        program, label: "eng", budgets, parentStepId: "s0901", cfg, bridge: fakeBridge,
        ...(engine ? { engine } : {}),
      })

      // WorkerEngine happy path: program runs in a real thread, bridged
      // calls round-trip over MessagePort RPC, the result crosses back.
      const okRun = await tm.runPtc(runOpts(
        'const a = await tm.read({}); const b = await tm.grep({}); return [a.data, b.data].join("+")',
        new tm.WorkerEngine(),
        { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
      ))
      assert.equal(okRun.status, "ok", "worker: happy path ok")
      assert.equal(okRun.engine, "worker", "worker: engine recorded")
      assert.equal(okRun.returnValue, "ran:tm_read+ran:tm_grep", "worker: bridged calls round-trip over RPC")
      assert.equal(okRun.okCount, 2, "worker: both bridged calls in the summary")

      // WorkerEngine: program throw -> program-error (T6: tagged kind:"program"
      // by the bootstrap, mapped by the driver; NOT engine-error, no degrade).
      const throwRun = await tm.runPtc(runOpts(
        'throw new Error("worker-boom")',
        new tm.WorkerEngine(),
        { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
      ))
      assert.equal(throwRun.status, "program-error", "worker: program throw -> program-error")
      assert.equal(throwRun.degraded, false, "worker: program-error never triggers the inline auto-degrade")
      assert.ok(throwRun.engineError && throwRun.engineError.message.includes("worker-boom"), "worker: error message crosses the worker boundary")
      assert.equal(throwRun.engineError.phase, "execute", "worker: program-error phase is execute")

      // WorkerEngine: hard wall-clock timeout -> terminate() -> status timeout
      const t0 = Date.now()
      const timeoutRun = await tm.runPtc(runOpts(
        "await new Promise(() => {})", // never resolves
        new tm.WorkerEngine(),
        { maxCalls: 5, maxErrors: 2, timeoutMs: 800 },
      ))
      assert.equal(timeoutRun.status, "timeout", "worker: wall-clock timeout")
      assert.ok(Date.now() - t0 < 10000, "worker: terminate is prompt")
      assert.equal(timeoutRun.okCount, 0, "worker: timeout run has no ok steps")

      // WorkerEngine sandbox surface (T6): the program runs in a null-prototype
      // node:vm context — require/process are ABSENT (stronger than the old
      // env:{} "empty process.env" isolation: process is undefined outright, so
      // Object.keys(process.env) can never even start), while the whitelisted
      // setTimeout + a real console survive.  Direct engine.run (bypasses
      // runPtc, whose pscan would ban the `process` word in the program text).
      const sandboxSurface = await new tm.WorkerEngine().run(
        'return [typeof require, typeof process, typeof setTimeout, typeof console].join(",")',
        fakeBridge,
        new AbortController().signal,
      )
      assert.equal(sandboxSurface, "undefined,undefined,function,object", "worker sandbox: require/process absent, setTimeout/console present")
      // the container object itself has NO .constructor prototype rung (T6 harden)
      const ctorLeak = await new tm.WorkerEngine().run(
        'return typeof ({}).constructor',
        fakeBridge,
        new AbortController().signal,
      )
      // the vm's OWN intrinsics are intact (fresh realm) — only the host-realm
      // Object.prototype chain the sandbox container carried is cut.
      assert.equal(ctorLeak, "function", "vm realm still has its own Object/Function intrinsics")

      // WorkerEngine body runs in strict mode (parity with the inline
      // engines): an undeclared assignment throws inside the vm → program-error.
      const strictRun = await tm.runPtc(runOpts(
        'undeclaredGlobal = 1; return "sloppy-ok"',
        new tm.WorkerEngine(),
        { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
      ))
      assert.equal(strictRun.status, "program-error", "worker: program body is strict-mode (throw -> program-error)")

      // InlineVmEngine: synchronous busy-loop killed by the (injectable)
      // compile timeout — an ENGINE-side kill, so engine-error (NOT program:
      // the program never ran to a throw; the vm refused to finish).
      const vmRun = await tm.runPtc(runOpts(
        "while (true) {}",
        new tm.InlineVmEngine(200),
        { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
      ))
      assert.equal(vmRun.status, "engine-error", "inline-vm: sync busy-loop -> engine-error (compile-timeout kill)")
    }
    console.log("9j. real engines: OK (WorkerEngine RPC/program-error/terminate/sandbox, strict-mode, InlineVmEngine compile-timeout->engine-error)")

    // 9k. T6/C2 PTC <-> web bridge: the six-way allow set, the bridge's
    //     {ok,data}/{ok:false,error} normalization over a web tool's REAL
    //     rendered ToolResult, the TM_PTC_WEB_BRIDGE=off rejection, and the C2
    //     ROLE GATE: the bridge actively ctx.ask's the CALLER's ruleset BEFORE
    //     the web tool's execute, so a non-web role is denied (permission
    //     phase) and execute is NEVER reached.  The unwrap format is pinned
    //     against a REAL result.ts render, so a header drift (tool.ts:57 mirrors
    //     result.ts:47 by hand) can no longer turn a denied call into a silent
    //     ok:true of error text.
    {
      // the bridge allow set is now six, and the web pair is tagged separately
      assert.deepEqual(
        [...tm.BRIDGE_ALLOW].sort(),
        ["tm_bash", "tm_fetch", "tm_grep", "tm_read", "tm_search", "tm_webfetch"],
        "BRIDGE_ALLOW carries all six bridged tools",
      )
      assert.deepEqual([...tm.WEB_BRIDGE_TOOLS].sort(), ["tm_search", "tm_webfetch"], "web bridge subset is the two network tools")
      const fakePipelines = {
        tmRead: async () => "R",
        tmGrep: async () => "G",
        tmBash: async () => "B",
        tmFetch: async () => "F",
      }
      // a caller ctx whose ruleset ALLOWS the web tool (ask resolves silently)
      const allowCtx = (extra) => ({ sessionID: "web-role", ask: async () => {}, ...extra })
      // a caller ctx whose ruleset DENIES it (a deny rule makes ctx.ask throw)
      const denyCtx = (extra) => ({ sessionID: "no-web-role", ask: async () => { throw new Error("denied by ruleset") }, ...extra })
      // render a REAL governed error exactly the way result.ts does (pins the format)
      const realErr = (tool, phase, msg, line) => tm.toToolResult(line == null ? tm.tmError(tool, phase, msg) : tm.tmError(tool, phase, msg, line)).output

      // ok result: the web tool returns a rendered hit list -> {ok:true,data}
      const okHandle = { execute: async () => ({ output: "hit list\n1. Foo https://x" }) }
      const bo = await tm.pipelineBridge(fakePipelines, allowCtx(), { tm_search: okHandle, tm_webfetch: okHandle }).call("tm_search", { query: "foo" })
      assert.equal(bo.ok, true, "search ok -> ok:true")
      assert.ok(bo.data.includes("hit list"), "inline search text is the data")
      // format-drift pin: a REAL result.ts permission error renders with the
      // `[<tool> 失败 · phase=…]` header the bridge unwraps back to ok:false.
      const searchErrHandle = { execute: async () => ({ output: realErr("tm_search", "permission", "role gate denied") }) }
      const bd = await tm.pipelineBridge(fakePipelines, allowCtx(), { tm_search: searchErrHandle, tm_webfetch: searchErrHandle }).call("tm_search", { query: "x" })
      assert.equal(bd.ok, false, "a real rendered web error unwraps to ok:false")
      assert.equal(bd.error.phase, "permission", "phase parsed from the REAL result.ts header")
      assert.equal(bd.error.tool, "tm_search", "tool name parsed from the REAL header")
      assert.ok(bd.error.message.includes("role gate denied"), "message body recovered")
      // line-bearing REAL header parses the line number too
      const lineErrHandle = { execute: async () => ({ output: realErr("tm_webfetch", "execute", "boom", 7) }) }
      const bl = await tm.pipelineBridge(fakePipelines, allowCtx(), { tm_search: lineErrHandle, tm_webfetch: lineErrHandle }).call("tm_webfetch", { url: "https://x" })
      assert.equal(bl.error.line, 7, "error line parsed from the REAL rendered header")
      // web bridge OFF (no handles wired) -> explicit args error, NOT a crash
      const off = await tm.pipelineBridge(fakePipelines, allowCtx()).call("tm_search", { query: "x" })
      assert.equal(off.ok, false, "web-off search errors")
      assert.match(off.error.message, /TM_PTC_WEB_BRIDGE/, "web-off names the toggle")
      // non-web pipelines still pass straight through the four (NO ask needed)
      const rd = await tm.pipelineBridge(fakePipelines, { sessionID: "x" }).call("tm_read", { path: "a" })
      assert.deepEqual(rd, { ok: true, data: "R" }, "read passthrough unchanged")
      // C2 ROLE GATE — REAL DENIAL: a non-web role's bridged tm.search is
      // refused by the BRIDGE's own ctx.ask; the web tool execute must NOT run.
      let webExecuted = false
      const spyHandle = { execute: async () => { webExecuted = true; return { output: "MUST NOT RUN" } } }
      const denyCall = await tm.pipelineBridge(fakePipelines, denyCtx(), { tm_search: spyHandle, tm_webfetch: spyHandle }).call("tm_search", { query: "x" })
      assert.equal(denyCall.ok, false, "non-web role bridged search is denied")
      assert.equal(denyCall.error.phase, "permission", "the denial is a permission error")
      assert.equal(denyCall.error.tool, "tm_search", "the denial names the tool")
      assert.equal(webExecuted, false, "the denied call NEVER reaches the web tool execute")
      // the gate ASKS under the web permission name with the target host/engine
      let asked = null
      const spyAsk = { sessionID: "r", ask: async (req) => { asked = req } }
      await tm.pipelineBridge(fakePipelines, spyAsk, { tm_search: okHandle, tm_webfetch: okHandle }).call("tm_search", { query: "x", engine: "bing" })
      assert.equal(asked.permission, "tm_search", "gate asks under the tm_search permission name")
      assert.ok(asked.patterns.some((pat) => /bing/.test(pat)), "search gate patterns carry the engine")
      await tm.pipelineBridge(fakePipelines, spyAsk, { tm_search: okHandle, tm_webfetch: okHandle }).call("tm_webfetch", { url: "https://api.example.com/x" })
      assert.equal(asked.permission, "tm_webfetch", "gate asks under the tm_webfetch permission name")
      assert.ok(asked.patterns.some((pat) => /api\.example\.com/.test(pat)), "webfetch gate patterns carry the host")
      // fail-CLOSED: no ask bridge on ctx -> bridged web is refused, not allowed
      const noAsk = await tm.pipelineBridge(fakePipelines, { sessionID: "x" }, { tm_search: okHandle, tm_webfetch: okHandle }).call("tm_search", { query: "x" })
      assert.equal(noAsk.ok, false, "a ctx without ask is fail-closed for bridged web")
      assert.equal(noAsk.error.phase, "permission", "unverifiable web grant is denied")
      // an offload handle block (multi-line, no leading error marker) stays ok
      const handleText = "payload too large (about 9000 tokens), offloaded to the run store.\nref: tm://runs/r/steps/s0009.k01/result\naccess_token: t"
      const offH = { execute: async () => ({ output: handleText }) }
      const oh = await tm.pipelineBridge(fakePipelines, allowCtx(), { tm_search: offH, tm_webfetch: offH }).call("tm_search", { query: "x" })
      assert.equal(oh.ok, true, "an offload handle from the web tool is an ok data result")
      assert.ok(oh.data.includes("ref: tm://"), "the handle ref is preserved for tm.fetch follow-up")
      // the tool description now documents the web bridges
      const tool = tm.buildPtcRunTool({
        cfg, store: new tm.RunStore({ projectRoot: mktmp("ptc-k"), blackboardDir: ".bb", trajectoryDir: ".tj", runId: "r-k", ttlDays: 7 }),
        nextStepId: () => "s0001", ctx: { directory: process.cwd() }, accessToken: "a".repeat(64),
        bridge: { call: async () => ({ ok: true, data: "hi" }) },
      })
      assert.ok(tool.description.includes("tm.search") && tool.description.includes("tm.webfetch"), "description documents the web bridges")
      assert.ok(/TM_PTC_WEB_BRIDGE/.test(tool.description), "description names the web toggle")
      // END-TO-END (C2): a non-web role's PTC run that calls tm.search records a
      // permission ERROR STEP and the web tool execute is never reached.
      let e2eExecuted = false
      const e2eBridge = tm.pipelineBridge(fakePipelines, denyCtx(), {
        tm_search: { execute: async () => { e2eExecuted = true; return { output: "MUST NOT RUN" } } },
        tm_webfetch: { execute: async () => ({ output: "unused" }) },
      })
      const runDeny = await tm.runPtc({
        program: 'const r = await tm.search({ query: "x" }); return r.ok ? 0 : r.error.phase',
        label: "deny", budgets: { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
        parentStepId: "s0010", cfg, engine: new tm.InlineSequentialEngine(), bridge: e2eBridge,
      })
      assert.equal(runDeny.status, "ok", "a role-denied web call is a normal error step, run completes")
      assert.equal(runDeny.errCount, 1, "the permission denial is recorded as one error step")
      assert.equal(runDeny.steps[0].phase, "permission", "step carries the permission phase")
      assert.equal(runDeny.returnValue, "permission", "program observed the error phase through the bridge")
      assert.equal(e2eExecuted, false, "end-to-end: a denied role never reaches the web execute")
      // END-TO-END allow: a web role's PTC run reaches the web execute + data.
      let allowExecuted = false
      const allowBridge = tm.pipelineBridge(fakePipelines, allowCtx(), {
        tm_search: { execute: async () => { allowExecuted = true; return { output: "hit list ok" } } },
        tm_webfetch: { execute: async () => ({ output: "unused" }) },
      })
      const runAllow = await tm.runPtc({
        program: 'const r = await tm.search({ query: "x" }); return r.ok ? "ran" : r.error.phase',
        label: "allow", budgets: { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
        parentStepId: "s0011", cfg, engine: new tm.InlineSequentialEngine(), bridge: allowBridge,
      })
      assert.equal(allowExecuted, true, "end-to-end: a web role DOES reach the web execute")
      assert.equal(runAllow.returnValue, "ran", "the web role's bridged search returned data")
    }
    console.log("9k. PTC<->web bridge (C2): OK (six-way allow, REAL result.ts header unwrap incl. line, active ctx.ask role gate denies non-web WITHOUT execute + fail-closed no-ask, host/engine patterns, TM_PTC_WEB_BRIDGE=off reject, non-web calls skip the ask, offload passthrough, end-to-end deny step + allow run)")

    // 9l. C1 sandbox-escape red lines + the "never replay a started program"
    //     rule.  Every escape vector is run DIRECTLY on a real engine (bypassing
    //     runPtc, whose pscan now bans constructor(/eval(/Function() so the
    //     program text itself could never reach the sandbox) — the point is to
    //     prove the vm.wrap + codeGeneration containment holds even when pscan
    //     is skipped.  Each must THROW or return a THREW marker, never ESCAPED.
    {
      const fakeBridge = { call: async (tool) => ({ ok: true, data: { output: "ran:" + tool } }) }
      const sig = new AbortController().signal
      const runEsc = async (eng, prog) => {
        try { return { r: await eng.run(prog, fakeBridge, sig) } }
        catch (e) { return { err: String((e && e.message) || e) } }
      }
      const vectors = [
        ["ctor", 'try { return "ESCAPED:" + tm.read.constructor("return process")() } catch (e) { return "THREW:" + e.message }'],
        ["chain", 'try { return "ESCAPED:" + ({}).constructor.constructor("return process")() } catch (e) { return "THREW:" + e.message }'],
        ["eval", 'try { return "ESCAPED:" + eval("1+1") } catch (e) { return "THREW:" + e.message }'],
        ["newfunc", 'try { return "ESCAPED:" + new Function("return 1")() } catch (e) { return "THREW:" + e.message }'],
        ["dataobj", 'const r = await tm.read({}); try { return "ESCAPED:" + r.constructor("return process")() } catch (e) { return "THREW:" + e.message }'],
        ["imp", 'try { return "ESCAPED:" + await import("node:fs") } catch (e) { return "THREW:" + e.message }'],
      ]
      for (const [name, prog] of vectors) {
        const w = await runEsc(new tm.WorkerEngine(), prog)
        const out = w.r == null ? "THREW:" + w.err : String(w.r)
        assert.ok(!out.startsWith("ESCAPED"), `worker: ${name} escape must not succeed (${out})`)
        assert.ok(/THREW|disallowed|not a function|not specified/.test(out), `worker: ${name} escape blocked (${out})`)
        const iv = await runEsc(new tm.InlineVmEngine(8000), prog)
        const iout = iv.r == null ? "THREW:" + iv.err : String(iv.r)
        assert.ok(!iout.startsWith("ESCAPED"), `inline: ${name} escape must not succeed (${iout})`)
        assert.ok(/THREW|disallowed|not a function|not specified/.test(iout), `inline: ${name} escape blocked (${iout})`)
      }
      // the facade reaches the governed bridge normally (containment != breakage).
      const norm = await new tm.WorkerEngine().run(
        'const r = await tm.read({ path: "a" }); return r.ok ? r.data.output : "notok"',
        fakeBridge, new AbortController().signal,
      )
      assert.equal(norm, "ran:tm_read", "C1 hardening keeps a normal bridged call working")

      // NO-REPLAY: a worker that STARTED (dispatched >=1 call) then crashed as an
      // engine fault is NOT re-run on the more-privileged inline realm.
      const crasher = { name: "worker", async run(program, bridge) { await bridge.call("tm_read", {}); throw new Error("worker crashed mid-run") } }
      const noReplay = await tm.runPtc({
        program: 'const a = await tm.read({}); return a.ok', label: "crash",
        budgets: { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
        parentStepId: "s0920", cfg, engine: crasher,
        bridge: { call: async () => ({ ok: true, data: "x" }) },
      })
      assert.equal(noReplay.status, "engine-error", "post-start worker crash surfaces as engine-error")
      assert.equal(noReplay.calls, 1, "the crash happened after the program started (1 bridged call)")
      assert.equal(noReplay.degraded, false, "C1: a started-then-crashed program is NOT replayed on inline")
      assert.equal(noReplay.engine, "worker", "still attributed to the worker engine (no inline fallback ran)")

      // INIT failure (worker could not start, ZERO calls) -> degrade IS allowed.
      const initFail = { name: "worker", async run() { throw new Error("node:worker_threads unavailable") } }
      const degradedRun = await tm.runPtc({
        program: 'return "ran-on-inline"', label: "initfail",
        budgets: { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
        parentStepId: "s0921", cfg, engine: initFail,
        bridge: { call: async () => ({ ok: true, data: "x" }) },
      })
      assert.equal(degradedRun.status, "ok", "engine-init fault degrades to inline and RUNS the program")
      assert.equal(degradedRun.degraded, true, "engine-init fault marks the run degraded")
      assert.equal(degradedRun.engine, "inline", "the fallback executed on the inline engine")
      assert.equal(degradedRun.returnValue, "ran-on-inline", "the program executed once on the inline engine")
    }
    console.log("9l. C1 escape containment: OK (constructor/chain/eval/new Function/data-object/dynamic-import escapes throw in BOTH real engines, a normal bridged call still works, started-then-crashed worker NOT replayed on inline, engine-init fault still degrades)")
  }

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
    const BRIEF = "重构 tm_browser 的关闭路径：目标是 close 之后窗口必须真的消失，涉及 src/tm/browser.ts，完成判据是 npm test 全绿。"

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
      assert.ok(denied.output.includes("只有 team"), "tm_join keeps the lead-only runtime lock (the second lock is agents.ts denying it)")
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
        assert.ok((await noKids.tools.tm_join.execute({}, LEAD)).output.includes("没有待收集的派发"), "no children endpoint -> the same honest answer, no crash")
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
      }

      // #80: a settled child still holding a browser is reported as a FACT at the
      // moment the lead reads the round, not left to a prompt rule the child may
      // never have followed.
      assert.equal(dmod.leaseTripwire([], "ses_lead"), null, "no held lease adds nothing")
      {
        const line = dmod.leaseTripwire(
          [
            { id: "b2", owner: "ses_x", agent: "researcher", idleMs: 45_000 },
            { id: "b3", owner: "ses_y", agent: "", idleMs: 1_500 },
          ],
          "ses_lead",
        )
        assert.ok(line.includes("2 个浏览器还开着"), "counts them")
        assert.ok(line.includes("b2（researcher · 空闲 45s）"), "names the id, the owning role, and how long it has sat")
        assert.ok(line.includes("未知角色"), "an owner with no recorded role is still reported, never dropped")
        assert.ok(/已确认关闭/.test(line) && /进程未核验/.test(line), "points at the tool's own verdicts instead of a bare 已关闭")
        // The seam is the whole design: tm_join must read the browser tool's OWN
        // lease table, or the two drift and the warning lies.
        const idxSrc = fs.readFileSync(new URL("./dist/tm/index.js", import.meta.url), "utf8")
        assert.ok(/browserLeases:\s*\(\)\s*=>\s*browserTool\.leases\(\)/.test(idxSrc), "tm_join is wired to the browser's own lease table")
        const brSrc = fs.readFileSync(new URL("./dist/tm/browser.js", import.meta.url), "utf8")
        assert.ok(/leases:\s*\(\)/.test(brSrc), "tm_browser exposes that table instead of a copy of it")
      }
      // #86: the LIVE recheck caught the blind spot — the lead opened b5, kept it
      // on purpose, collected a child, and nothing said a word about the window
      // the USER could see. Filtering to settled children only was the whole bug.
      {
        const own = dmod.leaseTripwire([{ id: "b5", owner: "ses_lead", agent: "team", idleMs: 62_000 }], "ses_lead")
        assert.ok(own.includes("你自己还占着 b5"), "the caller's own lease is named as its own")
        assert.ok(own.includes("空闲 62s"), "with how long it has sat")
        assert.ok(!/子代理已结算/.test(own), "and NOT accused of being a settled child — keeping a window across rounds is legitimate")
        assert.ok(/向用户说明/.test(own), "the next move is to close it or tell the user why")
        const mixed = dmod.leaseTripwire(
          [
            { id: "b5", owner: "ses_lead", agent: "team", idleMs: 10_000 },
            { id: "b2", owner: "ses_x", agent: "researcher", idleMs: 30_000 },
          ],
          "ses_lead",
        )
        assert.ok(/子代理已结算/.test(mixed) && /你自己还占着/.test(mixed), "a mixed round reports both groups, separately worded")
      }
      // #87: the LIVE regression of #86 still failed, by a different path — the
      // lead dispatched a SYNCHRONOUS host task (never registered here, the host
      // collects it inline), so tm_join hit its "nothing to collect" early return
      // and the lease check — which lived in the header below it — never ran.
      // A forgotten window must be reported on EVERY answer tm_join gives.
      {
        const dSrc = fs.readFileSync(new URL("./dist/tm/dispatch.js", import.meta.url), "utf8")
        const uses = (dSrc.match(/leaseLine\(\)/g) || []).length
        assert.ok(uses >= 2, `the lease line is attached to every return path, not just the settled-round header (found ${uses})`)
        const earlyAt = dSrc.indexOf("if (!mine.length)")
        assert.ok(earlyAt > 0, "the early 'nothing to collect' return is still findable")
        const early = dSrc.slice(earlyAt, earlyAt + 900)
        assert.ok(early.includes("leaseLine"), "…including the early 'nothing to collect' return")
        // And that message must not diagnose a SUCCESSFUL dispatch as a failure.
        assert.ok(!/那说明派发生本身没成功/.test(early), "no more asserting the dispatch failed when a sync host task simply never registers here")
        assert.ok(/同步/.test(early), "it names the real reason instead")
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

  // ---------- 11. bash timeout clamp (tool.execute.before mutation) ----------
  // The host's shell tool defaults to 120 s (flags.bashDefaultTimeoutMs ??
  // 2*60*1e3) and models pass 120000+ for `Get-ChildItem`.  The plugin owns no
  // timer; it clamps the ARG through the official mutable hook, and only for
  // commands the P3 read-only allowlist already accepts.
  {
    const bt = await import("./dist/tm/bash-timeout.js")
    const RO = ["ls", "grep", "Get-ChildItem"]
    const r = (o2) => bt.resolveBashTimeout({ readonlyAllowed: RO, probeMs: 60_000, maxMs: 0, ...o2 })
    assert.deepEqual(
      r({ command: "Get-ChildItem .", timeoutMs: 120000 }),
      { changed: true, via: "probe", from: 120000, to: 60000 },
      "a read-only probe carrying 120 s is clamped to the probe ceiling",
    )
    assert.equal(r({ command: "npm test", timeoutMs: 120000 }).changed, false, "a real build/test run keeps the model's timeout (general cap is off by default)")
    assert.deepEqual(
      r({ command: "npm test", timeoutMs: 600000, maxMs: 300000 }),
      { changed: true, via: "max", from: 600000, to: 300000 },
      "TM_BASH_TIMEOUT_MAX_MS caps everything once the user opts in",
    )
    assert.equal(r({ command: "ls", timeoutMs: null }).changed, false, "no timeout supplied = untouched (never invent one for the model)")
    assert.equal(r({ command: "ls", timeoutMs: 30000 }).changed, false, "already under the ceiling = no rewrite")
    assert.equal(r({ command: "ls", timeoutMs: 90000, probeMs: 0 }).changed, false, "probeMs=0 disables the probe ceiling")
    assert.equal(bt.parseTimeoutArg("120000"), 120000, "a stringified timeout still parses (LLMs do this)")
    assert.equal(bt.parseTimeoutArg("0"), null, "zero is not a timeout")
    assert.equal(bt.parseTimeoutArg("abc"), null, "garbage = absent, never a clamp to NaN")
    // hook behavior
    const clamped = []
    const hook = bt.createBashTimeoutHook({ probeMs: 60_000, maxMs: 0, readonlyAllowed: RO, onClamp: (i) => clamped.push(i) })
    const out = { args: { command: "ls -la", timeout: 120000 } }
    assert.equal(hook({ tool: "bash", sessionID: "s1" }, out), true, "the hook mutates output.args")
    assert.equal(out.args.timeout, 60000, "args.timeout rewritten in place")
    assert.equal(clamped.length, 1, "one clamp reported for the trajectory")
    assert.equal(hook({ tool: "write", sessionID: "s1" }, { args: { command: "ls", timeout: 120000 } }), false, "only the built-in bash tool is touched")
    assert.equal(out.args.command, "ls -la", "the command itself is never rewritten")
    assert.equal(hook({ tool: "bash" }, undefined), false, "a malformed hook payload cannot throw")
    assert.equal(hook({ tool: "bash" }, { args: { command: "rm -rf /", timeout: 120000 } }), false, "a NON-allowlisted command is left alone (this hook never widens what may run)")
    // config plumbing
    const cfgBt = tm.resolveTmConfig({ TM_BASH_TIMEOUT_MAX_MS: "1200000", TM_BASH_TIMEOUT_PROBE_MS: "0" })
    assert.equal(cfgBt.bashTimeoutMaxMs, 1200000, "TM_BASH_TIMEOUT_MAX_MS resolves")
    assert.equal(cfgBt.bashTimeoutProbeMs, 0, "TM_BASH_TIMEOUT_PROBE_MS=0 disables the probe ceiling")
    assert.equal(tm.resolveTmConfig({}).bashTimeoutMaxMs, 0, "the general cap is OFF by default")
    assert.equal(tm.resolveTmConfig({}).bashTimeoutProbeMs, 60_000, "the probe ceiling ships enabled")
    assert.equal(tm.resolveTmConfig({ TM_BASH_TIMEOUT_MAX_MS: "banana" }).bashTimeoutMaxMs, 0, "invalid value falls back to the default")
    // wired through the real plugin hook (clamp runs, R6 still guards)
    {
      const hooks = await plugin.server({ directory: mktmp("bt-wire"), client: fakeClient({}), $: fake$Ok("") }, { envProtect: true })
      const wired = { args: { command: "grep -R TODO src", timeout: 900000 } }
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, wired)
      assert.equal(wired.args.timeout, 60000, "the composed plugin hook clamps a read-only bash timeout")
      let threw = null
      try {
        await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: "printenv PATH" } })
      } catch (e) {
        threw = e
      }
      assert.ok(threw, "R6 interception still fires from the SAME hook")
    }
    console.log("11. bash timeout clamp: OK (probe-only ceiling by default, opt-in global cap, never invents a timeout, never widens the allowlist, string args tolerated, composed with R6)")
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
      // Private space: reachable from the user's own machine, so a coding agent has
      // genuine reasons (a local dev API). Ask, and never let "*" answer for it.
      for (const h of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "localhost", "api.localhost", "::1", "fe80::1", "fc00::1", "100.64.0.1"]) {
        assert.equal(ask(h), true, `${h} is private space — it goes to the dialog, not silently past the gate`)
      }
      for (const h of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2001:4860:8000::8", "example.com", "cn.bing.com"]) {
        assert.equal(open(h), true, `${h} is ordinary public space`)
      }
      // Bracket + trailing-dot + case spellings the URL parser hands us.
      assert.equal(ask("[::1]"), true, "bracketed IPv6 hostname normalizes")
      assert.equal(eg.classifyHost("Example.LocalHost.").level, "private", "case and the trailing root dot do not change the verdict")
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
      const loop = WF.checkWebUrl("http://127.0.0.1:8787/admin", ["*"])
      assert.equal(loop.ok, false, "loopback is not silently open under \"*\" either")
      assert.equal(loop.askable, true, "…but a local dev server is something a user CAN judge, so it asks")
      const named = WF.checkWebUrl("http://localhost:5173/", ["*"])
      assert.equal(named.askable, true, "a .localhost name asks too")
      const pub = WF.checkWebUrl("https://cn.bing.com/search?q=x", ["*"])
      assert.equal(pub.ok, true, "a public host is untouched by the egress rule")
      console.log("13. egress red line: OK (metadata/link-local/multicast/reserved + IPv4-mapped and DNS64 carriers are hard; loopback/RFC1918/ULA/CGNAT/.localhost ask and \"*\" cannot answer for them)")
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

} finally {
  restoreEnv()
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log("\nALL TM-TOOLS TESTS PASSED ✅")

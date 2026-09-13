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
]
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const clearTmEnv = () => { for (const k of ENV_KEYS) delete process.env[k] }
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
    // webfetch allowlist: seeded hosts (engines + data sources), env
    // override, explicit empty
    assert.deepEqual(
      cfg.webfetchAllowedDomains,
      [
        "mobile.moegirl.org.cn",
        "search.bilibili.com",
        "cn.bing.com",
        "www.bing.com",
        "www.baidu.com",
        "www.sogou.com",
        "www.so.com",
        "registry.npmjs.org",
        "api.github.com",
      ],
      "default webfetch allowlist = the CN-reachable lookup hosts",
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
    // missing token
    const missing = (await fetchTool.execute({ ref: hRef }, ctx)).output
    assert.ok(missing.includes("phase=args"), "missing token -> args error")
    assert.ok(missing.includes("access_token"), "missing token message")
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
        "mobile.moegirl.org.cn",
        "search.bilibili.com",
        "cn.bing.com",
        "www.bing.com",
        "www.baidu.com",
        "www.sogou.com",
        "www.so.com",
        "registry.npmjs.org",
        "api.github.com",
      ],
      "seeded allowlist = the CN-reachable lookup hosts (engines + npm + github api)",
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

  // 6m-s. tm_search — the governed search FRONT: engine table (all hosts on
  // the seed allowlist, CN-reachable, no API keys), HTML SERP → extracted
  // title+URL hit list, npm/github JSON → structured render, engine arg
  // validation, empty-result → alternative engines, registration.
  {
    const reg = runtime.tools.tm_search
    assert.ok(reg && typeof reg.execute === "function", "tm_search registered on the runtime tool surface")

    // engine table sanity: every buildUrl host is allowlisted by the seeds
    const seeds = tm.DEFAULT_WEBFETCH_DOMAINS
    for (const key of tm.SEARCH_ENGINE_NAMES) {
      const eng = tm.SEARCH_ENGINES[key]
      assert.ok(eng && typeof eng.buildUrl === "function", `engine ${key} defined`)
      const u = new URL(eng.buildUrl(encodeURIComponent("测试 q")))
      assert.equal(tm.hostAllowed(u.hostname, seeds), true, `engine ${key} host ${u.hostname} allowlisted`)
      assert.ok(tm.checkWebUrl(u.toString(), seeds).ok, `engine ${key} url passes checkWebUrl`)
    }
    assert.deepEqual(
      tm.SEARCH_ENGINE_NAMES.sort(),
      ["baidu", "bilibili", "bing", "bing-int", "github", "moegirl", "npm", "so", "sogou"],
      "engine roster = 9 CN-reachable sources",
    )

    // HTML SERP extraction through the registered tool (bing b_algo shape)
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
    globalThis.fetch = async (input) => {
      const url = String(input)
      if (url.includes("bing.com/search")) return res200(bingSerp)
      if (url.includes("registry.npmjs.org/-/v1/search")) return res200(npmJson, "application/json")
      if (url.includes("api.github.com/search")) return res200(ghJson, "application/json")
      if (url.includes("mobile.moegirl.org.cn/api.php")) return res200(mwJson, "application/json")
      if (url.includes("sogou.com")) return res200("<html><body></body></html>")
      return res200("<html></html>")
    }
    try {
      const bing = await reg.execute({ query: "测试 q" }, ctx)
      assert.ok(bing.output.includes("[search] bing × \"测试 q\""), "search header carries engine + raw query")
      assert.ok(bing.output.includes("Great result about 测试") && bing.output.includes("https://example.org/great-result"), "hit title+url extracted")
      assert.ok(!bing.output.includes("cn.bing.com/ck"), "click-tracker anchor excluded")
      assert.ok(!bing.output.includes("下一页") && !bing.output.includes("/images"), "engine chrome anchors excluded")
      assert.ok(bing.output.includes("2. Second hit"), "hits are numbered")
      assert.ok(!bing.output.includes("snippet one"), "raw SERP snippets NOT inlined (hit list, not page dump)")

      const npm = await reg.execute({ query: "left pad", engine: "npm" }, ctx)
      assert.ok(npm.output.includes("left-pad@1.3.0 — String left pad"), "npm JSON → name@version + description")
      assert.ok(npm.output.includes("https://registry.npmjs.org/left-pad/latest"), "npm hit links to the registry metadata URL")

      const gh = await reg.execute({ query: "repo", engine: "github" }, ctx)
      assert.ok(gh.output.includes("owner/repo ★4321 — A repo"), "github JSON → owner/repo ★stars — desc")
      assert.ok(gh.output.includes("https://github.com/owner/repo"), "github hit links to the repo page")

      const mw = await reg.execute({ query: "初音", engine: "moegirl" }, ctx)
      assert.ok(mw.output.includes('[search] moegirl × "初音" → 42 条词条'), "moegirl MediaWiki API → header with totalhits")
      assert.ok(mw.output.includes("1. 初音未来 — 虚拟歌手 Hatsune Miku"), "moegirl hit: title + tag-stripped snippet")
      assert.ok(mw.output.includes(`https://mobile.moegirl.org.cn/${encodeURIComponent("初音未来")}`), "moegirl hit links to the article URL")

      const unknown = await reg.execute({ query: "x", engine: "yahoo" }, ctx)
      assert.ok(unknown.output.includes("phase=args") && unknown.output.includes("未知引擎") && unknown.output.includes("bing"), "unknown engine → args error with roster")
      const noq = await reg.execute({}, ctx)
      assert.ok(noq.output.includes("phase=args") && noq.output.includes("缺少 query"), "missing query → args error")
      const empty = await reg.execute({ query: "whatever", engine: "sogou" }, ctx)
      assert.ok(
        empty.output.includes("没有返回可提取的结果") && empty.output.includes("bing / so / baidu"),
        "thin SERP → switch-engine hint with alternatives",
      )
    } finally {
      globalThis.fetch = realFetch
    }

    // unit-level: extractor handles single-quoted hrefs + entity titles
    const unit = tm.extractSearchHits(`<a href='https://example.com/a&amp;b'>A &amp; B research</a>`)
    assert.ok(unit.length === 1 && unit[0].url === "https://example.com/a&b" && unit[0].title === "A & B research", "extractor: single-quote href + entity decode")
  }
  console.log("6m-s. tm_search: OK (9-engine table allowlisted, SERP → hit list, trackers/chrome excluded, npm/github/moegirl structured, switch-engine hint, args-phase validation)")

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
      return encRes(
        `<html><body><li><h2><a href="https://example.org/${tag}-r1">First hit for ${tag}</a></h2></li>` +
          `<li><h2><a href="https://example.net/${tag}-r2">Second hit for ${tag}</a></h2></li></body></html>`,
      )
    }
    try {
      const engines = ["bing", "bing-int", "sogou", "so"]
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
    } finally {
      cleanup()
      fs.rmSync(path.join(os.tmpdir(), "opencode-team", "memories", "global"), { recursive: true, force: true })
    }
  }
  console.log("6n. tm_memory: OK (add/update/search scoring/list/forget, slug-collision guard, scope filter, content cap, frontmatter round-trip)")

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
    // allowlist is checked BEFORE any browser spawns (works without a browser)
    const blocked = await runtime.tools.tm_browser.execute({ action: "open", url: "https://evil.example.com/x" }, ctx)
    assert.ok(blocked.output.includes("phase=permission"), "disallowed host → permission error, no spawn")
    const noUrl = await runtime.tools.tm_browser.execute({ action: "open" }, ctx)
    assert.ok(noUrl.output.includes("缺少 url"), "open without url → args error")
    // real round-trip ONLY when a browser exists (skip on bare CI)
    if (tm.findBrowserExecutable()) {
      const open = await runtime.tools.tm_browser.execute({ action: "open", url: "https://cn.bing.com", headless: true }, ctx)
      assert.ok(open.output.includes("浏览器已启动") && open.output.includes("已导航"), "open launches + navigates")
      const read = await runtime.tools.tm_browser.execute({ action: "read" }, ctx)
      assert.ok(/bing/i.test(read.output), "read extracts page text")
      const shot = await runtime.tools.tm_browser.execute({ action: "screenshot" }, ctx)
      const shotPath = /截图已保存（\d+ bytes）：(.+)$/m.exec(shot.output)?.[1]
      assert.ok(shotPath && fs.existsSync(shotPath.trim()) && fs.statSync(shotPath.trim()).size > 1000, "screenshot PNG written to the run store")
      const closed = await runtime.tools.tm_browser.execute({ action: "close" }, ctx)
      assert.ok(closed.output.includes("已关闭"), "close kills the child + cleans the temp profile")
      assert.ok(fs.existsSync(shotPath.trim()), "screenshot stays in the run store after close (TTL owns reclamation)")
    } else {
      console.log("  (no browser found — live round-trip skipped)")
    }
  }
  console.log("6o. tm_browser: OK (headless matrix, discovery override, pre-spawn allowlist, live round-trip when a browser exists)")

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
    console.log("9c. arg schema: OK (length cap, blank reject, label trunc/default)")

    // static pre-scan (the FIRST gate — wired into runPtc + the tool since M2)
    assert.equal(tm.staticPscan("const x=await tm.read({})").rejected, false, "clean program passes pscan")
    assert.equal(tm.staticPscan("require('fs')").rejected, true, "require caught by pscan")
    assert.equal(tm.staticPscan("process.exit(1)").rejected, true, "process caught by pscan")
    assert.ok(tm.staticPscan("globalThis.x").tokens.includes("globalThis"), "globalThis token reported")
    console.log("9d. staticPscan: OK (writes + detects banned tokens; run path unaffected in M1)")

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

      // engine-error: the program throws (not a budget stop, not a sandbox fault)
      {
        const ee = await runWith('throw new Error("boom")', { call: async () => ({ ok: true, data: "x" }) }, MAX)
        assert.equal(ee.status, "engine-error", "program throw -> engine-error")
        assert.equal(ee.returned, false, "no return value captured")
        assert.ok(ee.engineError && /boom/.test(ee.engineError.message), "engine error message kept")
        assert.equal(ee.engineError.phase, "execute", "engine error phase tagged execute")
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
    console.log("9e. five statuses: OK (ok, stopped-call-budget, stopped-error-budget, timeout, engine-error) + retry-once")

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
      assert.equal(L[2], tm.PTC_OK_SECTION, "ok section present at line2")
      assert.equal(L[3], tm.PTC_OK_HEADER, "ok header at line3")
      assert.match(L[4], /^ 1 {2}tm_read.*inline$/, "success row: seq + tool + inline dest")
      assert.ok(text.includes(tm.PTC_ERR_SECTION), "err section present even with no errors")
      assert.ok(text.includes(tm.PTC_ERR_HEADER), "err header present")
      assert.ok(text.includes(tm.PTC_RETURN_PREFIX + "1"), "return value line")
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
        ["tm_bash", "tm_browser", "tm_fetch", "tm_grep", "tm_memory", "tm_ptc_run", "tm_read", "tm_search", "tm_webfetch"],
        "registered tm_* set includes tm_ptc_run + tm_webfetch + tm_search + tm_memory + tm_browser",
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

      // WorkerEngine: program throw -> engine-error carrying the message
      const throwRun = await tm.runPtc(runOpts(
        'throw new Error("worker-boom")',
        new tm.WorkerEngine(),
        { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
      ))
      assert.equal(throwRun.status, "engine-error", "worker: program throw -> engine-error")
      assert.ok(throwRun.engineError && throwRun.engineError.message.includes("worker-boom"), "worker: error message crosses the worker boundary")

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

      // WorkerEngine env:{} isolation: the parent's env is invisible to the
      // program (direct engine.run — pscan would ban `process` in runPtc).
      const envKeys = await new tm.WorkerEngine().run(
        "return Object.keys(process.env).length",
        fakeBridge,
        new AbortController().signal,
      )
      assert.equal(envKeys, 0, "worker env:{} — parent environment not inherited")

      // WorkerEngine body runs in strict mode (parity with the inline
      // engines): an undeclared assignment must throw inside the worker.
      const strictRun = await tm.runPtc(runOpts(
        'undeclaredGlobal = 1; return "sloppy-ok"',
        new tm.WorkerEngine(),
        { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
      ))
      assert.equal(strictRun.status, "engine-error", "worker: program body is strict-mode")

      // InlineVmEngine: synchronous busy-loop killed by the (injectable)
      // compile timeout — the fallback's documented kill path.
      const vmRun = await tm.runPtc(runOpts(
        "while (true) {}",
        new tm.InlineVmEngine(200),
        { maxCalls: 5, maxErrors: 2, timeoutMs: 30000 },
      ))
      assert.equal(vmRun.status, "engine-error", "inline-vm: sync busy-loop killed by compile timeout")
    }
    console.log("9j. real engines: OK (WorkerEngine RPC/throw/terminate/env-isolation/strict, InlineVmEngine compile-timeout kill)")
  }
} finally {
  restoreEnv()
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log("\nALL TM-TOOLS TESTS PASSED ✅")

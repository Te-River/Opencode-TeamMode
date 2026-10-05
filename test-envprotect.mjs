/**
 * R6 env-protection verification (run with node after `npm run build`).
 *
 * Pins the code-level interception contract added in R6:
 *   1. mode resolution (strict default, fail-closed) + extra-deny parsing
 *   2. fixed structured block message (testable constant) + category tag
 *   3. env-file path matcher (basenames, both separators, glob forms)
 *   4. bash command classification — both dialects, all three modes
 *   5. file-tool routing — path-class multi-field scan per tool
 *   6. loader integration — hook installed by server(), env-var wiring,
 *      audit log shape + privacy red line (no command text / values ever)
 */
import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const ep = await import("./dist/envprotect.js")
const plugin = (await import("./dist/index.js")).default

/* ---------- 1. mode resolution + extra-deny parsing ---------- */
assert.equal(ep.resolveEnvProtectMode(undefined), "strict", "default strict")
assert.equal(ep.resolveEnvProtectMode("strict"), "strict", "explicit strict")
assert.equal(ep.resolveEnvProtectMode("standard"), "standard", "standard")
assert.equal(ep.resolveEnvProtectMode("off"), "off", "off")
// unknown values fail CLOSED into strict: a mistyped opt-out must never
// disable the red line
assert.equal(ep.resolveEnvProtectMode("OFF"), "strict", "wrong case -> strict")
assert.equal(ep.resolveEnvProtectMode("loose"), "strict", "typo -> strict")
assert.equal(ep.resolveEnvProtectMode(0), "strict", "non-string -> strict")

assert.deepEqual(ep.parseExtraDeny(undefined), [], "no extra deny")
assert.deepEqual(ep.parseExtraDeny(""), [], "empty string")
assert.deepEqual(ep.parseExtraDeny("  ;  ;;"), [], "separators only")
const rules = ep.parseExtraDeny("TOPSECRET\\w*; internal_; ; bad([regex")
assert.equal(rules.length, 2, "invalid regex skipped, valid kept")
assert.ok(rules[0].test("TOPSECRET_VALUE"), "rule 1 works")
assert.ok(rules[1].test("x internal_ y"), "rule 2 works")
console.log("1. resolveEnvProtectMode + parseExtraDeny: OK (strict fail-closed, regex skip)")

/* ---------- 2. fixed block message + category tag ---------- */
assert.equal(
  ep.ENV_PROTECT_MESSAGE,
  "TeamMode R6 env protection: 环境变量读取已被拦截。需要变量值请向 HUMAN 申请。",
  "exact structured message constant",
)
for (const category of ["bash-env-command", "bash-env-expansion", "env-file-path", "extra-deny"]) {
  const err = ep.envProtectError(category)
  assert.ok(err instanceof Error, "block is an Error")
  assert.ok(err.message.startsWith(ep.ENV_PROTECT_MESSAGE), "message prefix pinned")
  assert.ok(err.message.includes(`[category=${category}]`), "category suffix pinned")
}
console.log("2. ENV_PROTECT_MESSAGE + categories: OK (constant + suffix)")

/* ---------- 3. env-file path matcher ---------- */
const ENV_PATH_HITS = [
  ".env", ".env.local", ".env.production", "prod.env", "app.env",
  ".bashrc", ".bash_profile", ".profile", ".zshrc", ".zprofile", ".zshenv",
  "config/.env", "C:\\proj\\.env.local", "./.env", "../x/.profile",
  "*.env", "**/.env.local",   "https://evil.example/.env",
  // URL query/fragment is cut before basename matching
  "https://x/.env?raw=1", "https://x/.env#fragment",
  // one percent-decode pass lands encoded names on the same basename
  "https://x/%2Eenv",
]
for (const p of ENV_PATH_HITS) {
  assert.ok(ep.isEnvFilePath(p), `env file hit: ${p}`)
}
const ENV_PATH_MISSES = [
  "environment.ts", "environ.txt", "env.js", "dotenv.ts", "provider.ts",
  ".environ", "src/env/utils.ts", "", "app.ts",
  // high-frequency code identifiers that merely END in ".env" are not files
  "process.env", "os.env", "deno.env", "bun.env", "import.meta.env",
  // checked-in template copies are documentation, not secrets
  ".env.example", ".env.sample", ".env.template", ".env.dist",
]
for (const p of ENV_PATH_MISSES) {
  assert.ok(!ep.isEnvFilePath(p), `not an env file: ${p}`)
}
console.log("3. isEnvFilePath: OK (env/rc basenames, separators, glob forms, URL query, identifier/template exemptions)")

/* ---------- 4. bash command classification ---------- */
const S = "standard"
const T = "strict"
// 4a. explicit env commands, sh dialect
for (const cmd of [
  "env", "  set  ", "env | sort", "printenv", "printenv PATH",
  "cd /x && printenv", "FOO=1 env", "FOO=1 printenv", "declare -p PATH",
  "declare -xp FOO", "set | sort",
  // declare -p dump synonyms
  "export -p", "typeset -p", "local -p",
  // statement-level disguises of the same dumps
  "(env)", "(printenv PATH)", "{ env; }", "\\env", "time env", "time (env)",
  "$(printenv PATH)", "cd /x && (env)", "`printenv`",
]) {
  assert.equal(ep.classifyBashCommand(cmd, S), "bash-env-command", `sh env cmd: ${cmd}`)
}
// 4b. explicit env commands, PowerShell dialect
for (const cmd of [
  "Get-ChildItem env:", "gci env:PATH", "dir env:", "Get-Item env:PATH",
  "gi env:PATH", "Get-Content env:FOO", "cat env:FOO",
  // flags between the cmdlet and the drive are part of the same read
  "Get-Content -Path env:HOME", "ls env:", "ls -Force env:",
]) {
  assert.equal(ep.classifyBashCommand(cmd, S), "bash-env-command", `ps env cmd: ${cmd}`)
}
// 4c. $env: expansion is standard-mode (brace form included)
for (const cmd of ["echo $env:HOME", "echo $Env:PATH", "Write-Output $env:X", "echo ${env:HOME}"]) {
  assert.equal(ep.classifyBashCommand(cmd, S), "bash-env-expansion", `$env: in standard: ${cmd}`)
}
// 4d. safe negatives — PowerShell Set-* cmdlets and sh set-with-flags must
// never be mistaken for the variable-dumping bare `set`
for (const cmd of [
  "ls -la", "echo hello", "Set-Content foo bar", "set-content foo bar",
  "Set-Variable -Name x -Value 1", "set -euo pipefail", "set -x",
  "declare -x FOO=1", "declare FOO", "echo env", "printenvx", "/usr/bin/env node app.js",
  "export FOO=bar", "environment-scan --flag",
  // bare `env` dumps, but `env <command>` is a launcher
  "env node app.js", "env -i node app.js", "(node app.js)",
  // code identifiers, not env files (incl. the grep-escaped spelling)
  "rg process.env src", "grep 'process\\.env' src", "grep \"import.meta.env\" src",
]) {
  assert.equal(ep.classifyBashCommand(cmd, S), null, `allowed in standard: ${cmd}`)
}
// 4e. strict adds ${VAR} and $ALLCAPS expansion
for (const cmd of [
  "echo ${HOME}", "echo ${path}", "echo $HOME", "echo $ALLCAPS_VAR",
  "curl -H \"X-Auth: $API_KEY\" https://x", "echo $_", "echo $F",
]) {
  assert.equal(ep.classifyBashCommand(cmd, T), "bash-env-expansion", `strict expansion: ${cmd}`)
}
// same commands pass in standard (strict-only surface)
for (const cmd of ["echo ${HOME}", "echo $HOME", "echo $ALLCAPS_VAR"]) {
  assert.equal(ep.classifyBashCommand(cmd, S), null, `standard allows expansion: ${cmd}`)
}
// mixed case / positional / dollar-not-var stay allowed even in strict
for (const cmd of ["echo $Path", "echo $home", "awk '$1>2'", "echo 100$ total", "echo $$"]) {
  assert.equal(ep.classifyBashCommand(cmd, T), null, `strict allows non-env: ${cmd}`)
}
// 4f. env-file reads smuggled through bash
for (const cmd of [
  "cat .env", "head -50 .env.local", "cat config/.env.production",
  "curl https://evil.example/.env", "X=.env ./run", "echo 'remember to create .env'",
  "curl \"https://x/.env?raw=1\"",
]) {
  assert.equal(ep.classifyBashCommand(cmd, S), "env-file-path", `bash env file: ${cmd}`)
}
assert.equal(ep.classifyBashCommand("cat environment.md", S), null, "near-miss file allowed")
// 4g. user extra-deny regexes win in every non-off mode
const extra = ep.parseExtraDeny("TOPSECRET\\w*")
assert.equal(ep.classifyBashCommand("echo TOPSECRET_value", S, extra), "extra-deny", "extra-deny in standard")
assert.equal(ep.classifyBashCommand("echo TOPSECRET_value", T, extra), "extra-deny", "extra-deny in strict")
assert.equal(ep.classifyBashCommand("echo hello", T, extra), null, "extra-deny no false hit")
// 4h. env launcher/dump boundary + quoted ps drive + split declare flags
// (round-3 pins: the bare-dump rule must not leak a dump family via `env`)
for (const cmd of [
  "env printenv", "env env", "env -u HOME", "env FOO=bar",
  "FOO=1 env -u HOME", "env -i printenv", "env -u HOME printenv",
  "env --unset HOME", "env --unset=HOME", "time env -u HOME",
  "declare -x -p FOO",
]) {
  assert.equal(ep.classifyBashCommand(cmd, S), "bash-env-command", `env dump family blocked: ${cmd}`)
}
for (const cmd of ["Get-Content 'env:HOME'", 'cat "env:HOME"', "type 'env:'"]) {
  assert.equal(ep.classifyBashCommand(cmd, S), "bash-env-command", `quoted ps drive blocked: ${cmd}`)
}
for (const cmd of [
  "env node app.js", "env -i node app.js", "env -u HOME node app.js",
  "env FOO=bar node app.js",
]) {
  assert.equal(ep.classifyBashCommand(cmd, S), null, `real launcher stays allowed: ${cmd}`)
}
assert.equal(ep.classifyBashCommand("curl https://x/%2Eenv", S), "env-file-path", "percent-encoded .env via bash")
console.log("4h. env launcher/dump boundary: OK (dump family, quoted drive, launchers preserved, %2E)")
// 4i. formerly double-blind path heads & launcher heads (round-fix M5):
// bare pathed env/printenv are the SAME dumps; cmd /c runs its own statement.
// (Quote-aware segment splitting is a known pre-existing matcher limit —
// only cmd heads WITHOUT an inner quoted && form are pinned here.)
for (const cmd of [
  "/usr/bin/env", "/usr/bin/printenv", "/usr/bin/printenv PATH",
  "C:\\tools\\printenv", "cmd /c set", "cmd.exe /c set", "CMD /C SET",
  "cmd /c \"set\"", "cmd /c set PATH", "cmd /c printenv PATH",
  "cmd /c set | more", "time /usr/bin/env",
]) {
  assert.equal(ep.classifyBashCommand(cmd, S), "bash-env-command", `path/cmd head dump blocked: ${cmd}`)
}
for (const cmd of [
  "cmd /c echo hi", "cmd /c dir", "cmd /c set PATH=one-time", "cmd /c",
  "/usr/bin/env node app.js", "cmd /c node app.js",
]) {
  assert.equal(ep.classifyBashCommand(cmd, S), null, `path/cmd heads not over-blocked: ${cmd}`)
}
console.log("4i. path-head env/printenv + cmd /c heads: OK (M5 double-blind closed)")
console.log("4. classifyBashCommand: OK (sh+ps env cmds, set edge cases, strict/standard, env-file, extra-deny)")

/* ---------- 5. file-tool routing (path-class multi-field scan) ---------- */
assert.equal(ep.inspectToolCall("read", { filePath: ".env" }, S), "env-file-path", "read filePath")
assert.equal(ep.inspectToolCall("read", { filePath: "C:\\p\\.env.local" }, S), "env-file-path", "read win path")
assert.equal(ep.inspectToolCall("read", { filePath: "src/app.ts" }, S), null, "read normal file")
assert.equal(ep.inspectToolCall("grep", { pattern: "TODO", path: "src" }, S), null, "grep normal")
assert.equal(ep.inspectToolCall("grep", { pattern: ".env", path: "src" }, S), "env-file-path", "grep pattern field scanned")
assert.equal(ep.inspectToolCall("grep", { pattern: "X", include: "*.env" }, S), "env-file-path", "grep include field scanned")
assert.equal(ep.inspectToolCall("grep", { path: ".env.production" }, S), "env-file-path", "grep path field")
assert.equal(ep.inspectToolCall("glob", { pattern: "*.env" }, S), "env-file-path", "glob pattern")
assert.equal(ep.inspectToolCall("glob", { pattern: "**/*.ts", path: "src" }, S), null, "glob normal")
assert.equal(ep.inspectToolCall("glob", { pattern: ".env.*" }, S), "env-file-path", "glob .env.*")
assert.equal(ep.inspectToolCall("list", { path: "config/.env" }, S), "env-file-path", "list path")
assert.equal(ep.inspectToolCall("list", { path: "src" }, S), null, "list normal")
// non-path fields are never scanned; non-listed tools are out of R6 scope
assert.equal(ep.inspectToolCall("read", { filePath: "a.ts", note: ".env" }, S), null, "non-path key ignored")
assert.equal(ep.inspectToolCall("write", { filePath: ".env" }, S), null, "write tool out of scope (R6 = reads)")
assert.equal(ep.inspectToolCall("edit", { filePath: ".env" }, S), null, "edit tool out of scope")
assert.equal(ep.inspectToolCall("webfetch", { url: "https://x/.env" }, S), null, "unlisted tool not scanned")
// extra-deny applies to path fields too
assert.equal(ep.inspectToolCall("read", { filePath: "TOPSECRET.txt" }, S, extra), "extra-deny", "extra-deny on path field")
// code identifiers and template copies pass the path scan too
assert.equal(ep.inspectToolCall("grep", { pattern: "process.env", path: "src" }, S), null, "grep process.env pattern allowed")
assert.equal(ep.inspectToolCall("read", { filePath: ".env.example" }, S), null, "read .env.example allowed")
// off mode: everything passes (hook installed but no-op)
assert.equal(ep.inspectToolCall("bash", { command: "env" }, "off"), null, "off: bash passes")
assert.equal(ep.inspectToolCall("read", { filePath: ".env" }, "off"), null, "off: read passes")
console.log("5. inspectToolCall: OK (filePath/path/pattern/include, scope boundary, extra-deny, off)")

/* ---------- 6. loader integration + env-var wiring + audit — RETIRED with the
 *  v1 personality (1.7.0 cut).  This group drove plugin.server() to prove the
 *  R6 hook installed next to config, wired the env knobs, and wrote the privacy
 *  red-line audit.  plugin.server is gone; the R6 CLASSIFICATION it exercised is
 *  unchanged and stays pinned by groups 3-5 (the pure matchers + inspectToolCall),
 *  and the audit/hook wiring on v2 lives in src/host/v2-guard.ts (pinned by
 *  test-v2-adapter).  The NUMBER stays so 7 does not renumber. ---------- */
console.log("6. loader integration: SKIPPED — v1 plugin.server removed; R6 matchers pinned by groups 3-5, v2 hook wiring by test-v2-adapter")


/* ---------- 7. unified approval gate (R6 env face + R2 danger face) ---------- */
// FIX ROUND: fixtures now pin the REAL host shapes captured live on 1.18.29
// (gate-test report-p5): open = `permission.asked` with props
// { id, sessionID, permission:"bash", patterns:[<command segments>],
//   metadata:{command}, always:[...] } and NO type field; close =
// `permission.replied` with props { sessionID, requestID, reply } — or ONLY
// { sessionID } at the plugin hook — so a reply must cancel the session's
// WHOLE pending set (an approved command left on a live timer would
// auto-reject on a dead id → 4xx → permanent degraded).  The host pops its
// official confirmation dialog for the bash `ask` patterns injected into the
// execution roles (Layer 1); a single timer auto-REJECTS an unanswered
// dialog after TM_ASK_TIMEOUT_MIN (Layer 2) and a failed reply — including
// the v1 throwOnError:false `{error}` envelope — fails closed back to the
// hard throw (Layer 3).  The plugin NEVER self-allows.
{
  const ag = await import("./dist/approval-gate.js")
  const {
    createApprovalGate,
    resolveAskTimeoutMs,
    hasPermissionReplyCapability,
    DEFAULT_ASK_TIMEOUT_MIN,
  } = ag
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)) }

  // 7a. TM_ASK_TIMEOUT_MIN parsing (default 1; valid-but-short CLAMPS UP to
  // the 1-min floor — a late auto-reject on an already-approved dialog hits
  // an already-closed id, and classifyReplyFailure records that as benign
  // already-closed WITHOUT flipping degraded (T2), so short timers no
  // longer need the historic 3-min bus-lag floor; anything silly -> default)
  assert.equal(ag.MIN_ASK_TIMEOUT_MIN, 1, "floor is 1 minute (benign already-closed makes the bus lag harmless)")
  assert.equal(resolveAskTimeoutMs({}), DEFAULT_ASK_TIMEOUT_MIN * 60000, "default 1min")
  assert.equal(resolveAskTimeoutMs({}), 60000, "default timeout resolves to 60000ms")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "1" }), 60000, "1min is legal at the new 1-min floor (no clamp)")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "2" }), 120000, "2min honoured (above the floor)")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: " 3 " }), 180000, "trimmed + honoured above the floor")
  // P0 floor knob (TM_ASK_TIMEOUT_FLOOR_MIN, resolveTmConfig().askTimeoutFloorMin):
  // the clamp floor is read from config, not hardcoded.  Defaults to 1 now;
  // a stricter posture can still raise it via CONFIG alone.
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "1", TM_ASK_TIMEOUT_FLOOR_MIN: "5" }), 300000, "floor knob: 1min clamps to a configured 5-min floor")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "10", TM_ASK_TIMEOUT_FLOOR_MIN: "5" }), 600000, "floor knob: a value above the floor is honoured unchanged")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "1", TM_ASK_TIMEOUT_FLOOR_MIN: "1" }), 60000, "floor knob at its default 1 -> 1min honoured")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "1", TM_ASK_TIMEOUT_FLOOR_MIN: "0" }), 60000, "invalid floor (0<1) falls back to the default 1")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "2", TM_ASK_TIMEOUT_FLOOR_MIN: "abc" }), 120000, "non-numeric floor falls back to the default 1 (2min > 1min honoured)")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "10" }), 600000, "10min honoured unchanged")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "1440" }), 86400000, "24h boundary honoured")
  for (const bad of ["0", "-5", "99999", "abc", "1.5x", ""]) {
    assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: bad }), 60000, `invalid -> default 1min: "${bad}"`)
  }

  // 7b. ask-pattern builder — mode-sensitive, default stays allow
  {
    const strictAsk = ep.bashAskPatterns("strict")
    assert.equal(strictAsk["*"], "allow", "default `*` allow preserved (T2.1 grant intact)")
    for (const p of ["printenv", "printenv *", "env *", "set", "export -p", "declare -p *"]) {
      assert.equal(strictAsk[p], "ask", `R6 env ask present: ${p}`)
    }
    for (const p of ["rm *", "Remove-Item *", "git push *", "git commit *", "curl *", "Invoke-WebRequest *", "npm install *", "npm publish *", "pip install *", "winget *", "choco *", "taskkill *", "Stop-Process *", "kill *", "shutdown *", "format *", "chmod *", "takeown *", "icacls *"]) {
      assert.equal(strictAsk[p], "ask", `R2 danger ask present: ${p}`)
    }
    // round-fix M3: bare no-arg shapes (the arg-carrying globs cannot match
    // them — `git push` alone would run with no dialog otherwise)
    for (const p of ["git push", "git commit", "npm publish"]) {
      assert.equal(strictAsk[p], "ask", `R2 bare ask present (M3): ${p}`)
    }
    assert.equal(strictAsk["npm test"], undefined, "npm test NOT asked (verification stack stays silent)")
    assert.equal(strictAsk["tsc"], undefined, "tsc NOT asked")
    assert.equal(strictAsk["git status"], undefined, "git status NOT asked")
    const offAsk = ep.bashAskPatterns("off")
    assert.equal(offAsk["printenv *"], undefined, "off drops the R6 env ask face")
    assert.equal(offAsk["rm *"], "ask", "off KEEPS the R2 danger face (independent red line)")
  }

  // 7c. isAskGatedEnvCommand — the expressible/inexpressible split
  {
    for (const c of [
      "printenv", "printenv PATH", "env", "env FOO=bar", "set",
      "export -p", "declare -p PATH", "Get-ChildItem env:PATH",
      "$env:PATH",
    ]) {
      assert.ok(ep.isAskGatedEnvCommand(c, "strict"), `gated (dialog governs): ${c}`)
      assert.ok(ep.classifyBashCommand(c, "strict"), `and it IS an env read: ${c}`)
    }
    for (const c of [
      "$(printenv PATH)", "(env)", "\\env", "time env", "FOO=1 env",
      "echo ${HOME}", "echo $API_KEY", "cd /x && printenv",
      "Get-Content -Path env:HOME", "printenvx", "/usr/bin/env node app.js",
      // round-fix M4: the deferral matcher is BYTE-EXACT.  Any case/trim
      // deviation from the injected config spelling stays hard-throwing —
      // deferring on a looser match risks a silent env read behind a form
      // the host's (possibly case-sensitive) glob never pops.
      "GET-CONTENT ENV:PATH", "PrintEnv PATH", " printenv", "printenv\t",
      "$ENV:PATH", "Get-Childitem env:PATH",
      // round-fix M5: path/launcher heads cannot be dialog-expressed
      "/usr/bin/env", "/usr/bin/printenv", "cmd /c set",
    ]) {
      assert.ok(!ep.isAskGatedEnvCommand(c, "strict"), `not gated -> stays hard throw: ${c}`)
    }
    // env-file reads are never popup-governed (built-in read is denied; the
    // dialog grammar cannot express an arbitrary .env path)
    assert.ok(!ep.isAskGatedEnvCommand("cat .env", "strict"), "cat .env stays hard")
    // user extra-deny always wins over the popup (an extra-deny hit is hard,
    // never dialog-governed)
    assert.ok(!ep.isAskGatedEnvCommand("printenv PATH", "strict", [/printenv/]), "extra-deny hit not gated")
  }

  // 7d. categorizePermission — event gate + audit category only (never text).
  // Fixtures pin the REAL 1.18.29 permission.asked shape (no type field,
  // tool in `permission`, patterns[]) plus the d.ts legacy spellings, and the
  // compound-command behavior the host showed (segmented patterns[], ONE
  // dialog approves the whole line — pinned here, nothing to fix).
  assert.equal(
    ep.categorizePermission({
      id: "per_x", sessionID: "ses_x", permission: "bash",
      patterns: ["Get-ChildItem env:PATH"], metadata: { command: "Get-ChildItem env:PATH" },
      always: ["Get-ChildItem *"],
    }),
    "env",
    "real host asked: env face, NO type field",
  )
  assert.equal(
    ep.categorizePermission({
      permission: "bash", patterns: ["echo g3head", "rm g3-target.txt"],
      metadata: { command: "echo g3head; rm g3-target.txt" },
    }),
    "danger",
    "compound command: segmented patterns[] still categorize (tail danger, no bypass)",
  )
  assert.equal(
    ep.categorizePermission({ patterns: ["printenv PATH"], metadata: { command: "printenv PATH" } }),
    "env",
    "asked without permission field: metadata.command is bash evidence",
  )
  assert.equal(ep.categorizePermission({ patterns: ["rm -rf x"] }), "danger", "patterns[] array danger")
  assert.equal(ep.categorizePermission({ type: "bash", pattern: "git push origin main" }), "danger", "legacy singular + type")
  assert.equal(ep.categorizePermission({ permission: "bash", patterns: ["git push"] }), "danger", "bare git push (M3)")
  assert.equal(ep.categorizePermission({ type: "bash", patterns: ["npm publish"] }), "danger", "bare npm publish (M3)")
  // LOOSE on the arming side: a case-shifted pattern that popped a dialog is
  // still ours (over-matching here can only arm a timer for an open dialog)
  assert.equal(ep.categorizePermission({ permission: "bash", patterns: ["PRINTENV PATH"] }), "env", "loose matcher arms the timer case-insensitively")
  assert.equal(ep.categorizePermission({ permission: "edit", patterns: ["src/a.ts"] }), null, "non-bash not governed")
  assert.equal(ep.categorizePermission({ patterns: ["src/a.ts"] }), null, "path-shaped patterns without type are NOT bash evidence")
  assert.equal(ep.categorizePermission({ patterns: ["set"] }), null, "bare word without command metadata: no bash proof")
  assert.equal(ep.categorizePermission({ type: "edit", pattern: "printenv.ts" }), null, "edit dialog stays with the human")
  assert.equal(ep.categorizePermission({ type: "bash", pattern: "npm test" }), null, "npm test not governed")
  assert.equal(ep.categorizePermission({}), null, "empty props")
  assert.equal(ep.categorizePermission(null), null, "null-safe")

  // 7e. reply-capability detection
  assert.ok(!hasPermissionReplyCapability({ app: { log() {} } }), "audit-only client is not reply-capable")
  assert.ok(hasPermissionReplyCapability({ postSessionIdPermissionsPermissionId() {} }), "v1 reply method detected")
  assert.ok(hasPermissionReplyCapability({ permission: { reply() {} } }), "permission.reply namespace detected")

  // 7f. timer on REAL event shapes: asked -> timeout -> reject ONLY;
  // replied{sessionID} -> cancel the WHOLE session; ghosts stay suppressed.
  {
    const replies = []
    const logs = []
    // REAL-host-shaped mocks: SDK endpoint methods REQUIRE their `this`
    // receiver (live-observed: an unbound fetch-and-call — `const post =
    // c.post...; await post({...})` — throws synchronously inside the SDK,
    // so every auto-reject silently failed and the gate flipped degraded
    // with the dialog still open).  If the gate ever regresses to that
    // pattern these mocks THROW, and the timeout-rejected assertions below
    // fail — the lesson from the R6 app.log unbind bug, pinned for real.
    const appOwner = {
      log(req) {
        if (this !== appOwner) throw new TypeError("SDK app.log called unbound (this lost)")
        logs.push(String(req?.body?.message ?? ""))
      },
    }
    const client = {
      app: appOwner,
      postSessionIdPermissionsPermissionId(o) {
        if (this !== client) throw new TypeError("SDK reply endpoint called unbound (this lost)")
        replies.push(o)
        return Promise.resolve({ data: true })
      },
    }
    const made = []
    const fake = {
      setTimeoutFn: (cb, ms) => { const t = { cb, ms, cleared: false, id: made.length }; made.push(t); return t },
      clearTimeoutFn: (h) => { if (h) h.cleared = true },
    }
    let clock = 1000
    // notify hook: EVERY permission.asked fires ONE toast message (dedupe by
    // request id) naming the first pattern + the auto-reject timeout — the
    // user asked to be notified wherever a confirmation window pops
    {
      const toasts = []
      const nGate = createApprovalGate({
        client, timeoutMs: 600000, timers: fake, now: () => clock,
        notify: (m) => toasts.push(String(m)),
      })
      nGate.handleEvent({ type: "permission.asked", properties: {
        id: "per_n1", sessionID: "ses_9", permission: "bash",
        patterns: ["printenv PATH"], metadata: { command: "printenv PATH" },
      } })
      assert.equal(toasts.length, 1, "notify fired once for a fresh dialog")
      assert.ok(toasts[0].includes("printenv PATH") && toasts[0].includes("自动拒绝"), "toast names the pending pattern + timeout")
      nGate.handleEvent({ type: "permission.asked", properties: {
        id: "per_n1", sessionID: "ses_9", permission: "bash",
        patterns: ["printenv PATH"], metadata: { command: "printenv PATH" },
      } })
      assert.equal(toasts.length, 1, "duplicate asked replay does NOT re-notify")
      nGate.handleEvent({ type: "permission.asked", properties: {
        id: "per_n2", sessionID: "ses_9", permission: "tm_webfetch",
        patterns: ["https://example.org/page"], metadata: {},
      } })
      assert.equal(toasts.length, 2, "tm_* ctx.ask dialogs notify too (non-bash permission covered)")
      assert.ok(toasts[1].includes("https://example.org/page"), "web-dialog toast names the URL")
      nGate.handleEvent({ type: "permission.replied", properties: {
        sessionID: "ses_9", requestID: "per_n1", reply: "once",
      } })
      nGate.handleEvent({ type: "permission.asked", properties: {
        id: "per_n1", sessionID: "ses_9", permission: "bash",
        patterns: ["printenv PATH"], metadata: { command: "printenv PATH" },
      } })
      assert.equal(toasts.length, 2, "ghost asked replay after a reply does NOT re-notify")
    }

    const gate = createApprovalGate({ client, timeoutMs: 600000, timers: fake, now: () => clock })
    assert.equal(gate.isArmed(), true, "armed while capable")
    // the exact 1.18.29 permission.asked payload (report-p5): no type field,
    // tool name in `permission`, concrete command segments in `patterns[]`
    gate.handleEvent({ type: "permission.asked", properties: {
      id: "per_p1", sessionID: "ses_1", permission: "bash",
      patterns: ["printenv PATH"], metadata: { command: "printenv PATH" }, always: ["printenv *"],
    } })
    gate.handleEvent({ type: "permission.asked", properties: {
      id: "per_p2", sessionID: "ses_1", permission: "bash",
      patterns: ["echo g3head", "rm g3-target.txt"], metadata: { command: "echo g3head; rm g3-target.txt" },
    } })
    assert.equal(gate.pendingSize(), 2, "env + compound-danger asks pending")
    assert.equal(gate.hasLiveAsk("ses_1"), true, "env-classified ask registers the session (deferral whitelist)")
    assert.equal(gate.canDefer("ses_1"), true, "registered + armed -> deferral allowed")
    assert.equal(gate.canDefer("ses_stock"), false, "unregistered session: NO deferral (C1 bypass closed)")
    assert.equal(gate.canDefer(undefined), false, "no sessionID: NO deferral")
    // a NON-governed dialog (edit) must not be tracked
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_p3", sessionID: "ses_1", permission: "edit", patterns: ["src/a.ts"] } })
    assert.equal(gate.pendingSize(), 2, "edit dialog left to the human (not governed)")
    assert.ok(logs.some((l) => l.endsWith(":: bash :: env :: ask")) && logs.some((l) => l.endsWith(":: bash :: danger :: ask")), "ask audited per governed dialog")
    // replied (real wire shape {sessionID, requestID, reply}) — ONE cancel
    // must drop EVERY pending timer of that session: an approved command left
    // on a live timer would reject on a dead id later (4xx -> degraded)
    gate.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_1", requestID: "per_p1", reply: "once" } })
    assert.equal(gate.pendingSize(), 0, "session-wide cancel on replied")
    assert.ok(made.every((t) => t.cleared), "no orphan timers survive the session cancel")
    assert.ok(logs.some((l) => l.endsWith(":: bash :: env :: allowed-once")), "human verdict audited (reply, not response)")
    // late/duplicate asked replay for the closed id -> ghost must NOT re-arm
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_p1", sessionID: "ses_1", permission: "bash", patterns: ["printenv PATH"], metadata: { command: "printenv PATH" } } })
    assert.equal(gate.pendingSize(), 0, "tombstoned asked replay ignored (no ghost timer)")
    // genuine NEW dialog in the same session still arms afterwards
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_p4", sessionID: "ses_1", permission: "bash", patterns: ["Get-ChildItem env:PATH"], metadata: { command: "Get-ChildItem env:PATH" }, always: ["Get-ChildItem *"] } })
    assert.equal(gate.pendingSize(), 1, "fresh asked after a replied one is timed")
    // the remaining timer reaches its deadline -> auto-reject (reject only!)
    const live = made.find((t) => !t.cleared)
    assert.ok(live, "exactly one live timer remains")
    live.cb()
    await flush()
    assert.equal(gate.pendingSize(), 0, "cleared after timeout auto-reject")
    assert.equal(replies.length, 1, "exactly one SDK reply (the timeout)")
    assert.equal(replies[0].path.permissionID, "per_p4", "rejects the timed-out request, not the answered one")
    assert.equal(replies[0].path.id, "ses_1", "session id forwarded")
    // NEGATIVE red-line assertion: the plugin never self-allows.
    assert.ok(replies.every((r) => r.body.response === "reject"), "plugin ONLY ever replies reject — never once/always/allow")
    assert.ok(logs.some((l) => l.endsWith(":: bash :: env :: timeout-rejected")), "timeout audited")
    // privacy red line on the GATE audit too: category+verdict only
    assert.ok(logs.every((l) => !/printenv|Get-ChildItem|g3-target|rm /i.test(l)), "gate audit never carries command/pattern text")
    // envApproved: "always" on env ask → session blanket-approved
    // Reset for a clean gate to test the always→envApproved path
    const gate2 = createApprovalGate({ client, timeoutMs: 600000, timers: fake, now: () => clock })
    assert.equal(gate2.isEnvApproved("ses_always"), false, "not approved initially")
    gate2.handleEvent({ type: "permission.asked", properties: {
      id: "per_env1", sessionID: "ses_always", permission: "bash",
      patterns: ["printenv PATH"], metadata: { command: "printenv PATH" }, always: ["printenv *"],
    } })
    assert.equal(gate2.isEnvApproved("ses_always"), false, "not approved until replied")
    gate2.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_always", requestID: "per_env1", reply: "always" } })
    assert.equal(gate2.isEnvApproved("ses_always"), true, "always on env ask → env approved")
    assert.equal(gate2.isEnvApproved("ses_other"), false, "other session not approved")
    assert.equal(gate2.isEnvApproved(undefined), false, "undefined session not approved")
    // "once" on env ask → NOT approved
    const gate3 = createApprovalGate({ client, timeoutMs: 600000, timers: fake, now: () => clock })
    gate3.handleEvent({ type: "permission.asked", properties: {
      id: "per_env2", sessionID: "ses_once", permission: "bash",
      patterns: ["printenv PATH"], metadata: { command: "printenv PATH" }, always: ["printenv *"],
    } })
    gate3.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_once", requestID: "per_env2", reply: "once" } })
    assert.equal(gate3.isEnvApproved("ses_once"), false, "once on env ask → NOT approved")
    // "always" on danger ask → NOT env approved
    const gate4 = createApprovalGate({ client, timeoutMs: 600000, timers: fake, now: () => clock })
    gate4.handleEvent({ type: "permission.asked", properties: {
      id: "per_d1", sessionID: "ses_danger", permission: "bash",
      patterns: ["rm x"], metadata: { command: "rm x" },
    } })
    gate4.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_danger", requestID: "per_d1", reply: "always" } })
    assert.equal(gate4.isEnvApproved("ses_danger"), false, "always on danger ask → NOT env approved (env-only scope)")
    // replied carrying ONLY { sessionID } (observer-attested degraded shape):
    // cancel-all + short ghost window; other sessions unaffected
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_p5", sessionID: "ses_2", permission: "bash", patterns: ["npm publish"], metadata: { command: "npm publish" } } })
    assert.equal(gate.pendingSize(), 1, "ses_2 armed")
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_p5b", sessionID: "ses_3", permission: "bash", patterns: ["printenv"], metadata: { command: "printenv" } } })
    assert.equal(gate.pendingSize(), 2, "ses_3 armed independently")
    gate.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_2" } })
    assert.equal(gate.pendingSize(), 1, "bare {sessionID} reply cancels only its own session")
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_p6", sessionID: "ses_2", permission: "bash", patterns: ["printenv"], metadata: { command: "printenv" } } })
    assert.equal(gate.pendingSize(), 1, "id-less reply ghost-window suppresses that session's fresh asks briefly")
    clock += 61_000 // window elapsed
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_p6", sessionID: "ses_2", permission: "bash", patterns: ["printenv"], metadata: { command: "printenv" } } })
    assert.equal(gate.pendingSize(), 2, "after the window the session arms again (window only absorbs ghosts)")
    // out-of-vocabulary response word -> degraded audit, NEVER "rejected"
    gate.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_3", requestID: "per_p5b", reply: "lgtm" } })
    assert.ok(logs.some((l) => l.endsWith(":: bash :: env :: degraded")), "unknown verdict word audited degraded")
    assert.ok(!logs.some((l) => /per_p5b|lgtm/.test(l)), "response word itself never audited verbatim")
    // danger-only asked must NOT register deferral (session may ask rm yet
    // silently allow printenv under its own stock rules)
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_d", sessionID: "ses_d", permission: "bash", patterns: ["rm gone.txt"], metadata: { command: "rm gone.txt" } } })
    assert.equal(gate.canDefer("ses_d"), false, "danger-face dialog alone never grants env deferral")
    // registerExecSession: the pre-tool exec-route index.ts feeds from
    // message.updated / chat.message
    gate.registerExecSession("ses_team")
    assert.equal(gate.canDefer("ses_team"), true, "exec-role session registration enables deferral")
    // revokeExecSession: index.ts feeds this when a user prompt routes to an
    // agent that does NOT carry our injected ask set (the verified host passes
    // {tool, sessionID, callID} with NO agent to tool.execute.before, so the
    // per-turn agent signal can only ride message.updated/chat.message).
    // Without revocation a session that once ran a team prompt stayed
    // deferrable forever — a stale window for silent env reads.
    gate.revokeExecSession("ses_team")
    assert.equal(gate.canDefer("ses_team"), false, "revoke drops the exec registration (mixed-agent window closed)")
    assert.equal(gate.hasLiveAsk("ses_team"), false, "revoke clears the live-ask set")
    gate.registerExecSession("ses_team")
    assert.equal(gate.canDefer("ses_team"), true, "a later exec-role prompt re-registers from fresh evidence")
    gate.dispose()
    assert.equal(gate.isArmed(), false, "disarmed after dispose")
    assert.equal(gate.canDefer("ses_team"), false, "disposed gate defers nothing")
  }

  // 7g. SDK reply FAILURE is CLASSIFIED, not a blanket degraded flip.
  // Round-fix M2 kept: the v1 client defaults to throwOnError:false — an HTTP
  // failure RESOLVES with an envelope.  The REAL contract (now pinned) is
  // `{ error: { name, data:{message} }, response: { status } }` — the old mock
  // faked a top-level `{error:{name,status}}` shape the host never sends.  A
  // 404/NotFound means the dialog was ALREADY closed (the D4 late-reply race):
  // BENIGN — do NOT degrade.  A 400/BadRequest is a reply-shape bug and a real
  // Error / 5xx / empty body is transport — both still fail closed.  Pin the
  // classifier, the per-class gate behaviour, and never-self-allow intact.
  {
    // 7g-0. classifyReplyFailure (unit) on the real envelope shapes.
    assert.equal(ag.classifyReplyFailure(Object.assign(new Error("x"), { status: 404 })), "benign-closed", "404 -> benign-closed")
    assert.equal(ag.classifyReplyFailure({ name: "PermissionNotFound" }), "benign-closed", "PermissionNotFound name -> benign-closed")
    assert.equal(ag.classifyReplyFailure({ _tag: "NotFoundError" }), "benign-closed", "_tag NotFound -> benign-closed")
    assert.equal(ag.classifyReplyFailure({ name: "BadRequest", status: 400 }), "param-shape", "400/BadRequest -> param-shape")
    assert.equal(ag.classifyReplyFailure({ name: "InvalidRequest", data: { message: "bad" } }), "param-shape", "InvalidRequest name -> param-shape")
    assert.equal(ag.classifyReplyFailure(new Error("host down")), "transport", "real Error -> transport")
    assert.equal(ag.classifyReplyFailure({ name: "InternalServerError", status: 500 }), "transport", "5xx -> transport")
    assert.equal(ag.classifyReplyFailure(undefined), "transport", "empty/undefined -> transport")
  }

  // Arm one bash-env dialog, fire the timeout auto-reject against a reply
  // endpoint whose shape is `shape`, return { gate, logs, replies }.
  async function driveFailedReply(shape) {
    const logs = []
    const replies = []
    // this-bound host mocks (same anti-unbind teeth as 7f) — an unbound reply
    // call would throw BEFORE the failure shapes below are even reached.
    const appOwner = {
      log(req) {
        if (this !== appOwner) throw new TypeError("SDK app.log called unbound (this lost)")
        logs.push(String(req?.body?.message ?? ""))
      },
    }
    const client = {
      app: appOwner,
      postSessionIdPermissionsPermissionId(o) {
        if (this !== client) throw new TypeError("SDK reply endpoint called unbound (this lost)")
        replies.push(o)
        // REAL v1 envelope contract: { error: {...}, response: { status } }.
        if (shape === "rejection") return Promise.reject(new Error("host down at /api/secret-path"))
        if (shape === "closedTag") return Promise.resolve({ error: { _tag: "PermissionNotFound" }, response: {} })
        if (shape === "empty") return Promise.resolve({ error: { name: "Error" }, response: undefined })
        const meta =
          shape === "closed404" ? { status: 404, name: "NotFoundError" }
          : shape === "shape400" ? { status: 400, name: "BadRequest" }
          : { status: 500, name: "InternalServerError" }
        return Promise.resolve({
          error: { name: meta.name, data: { message: "detail at /api/secret-path" } },
          response: { status: meta.status },
        })
      },
    }
    const made = []
    const fake = { setTimeoutFn: (cb) => { const t = { cb, cleared: false }; made.push(t); return t }, clearTimeoutFn: (h) => { if (h) h.cleared = true } }
    const gate = createApprovalGate({ client, timeoutMs: 1000, timers: fake })
    assert.equal(gate.isArmed(), true, `${shape}: starts armed`)
    gate.handleEvent({ type: "permission.asked", properties: { id: "x", sessionID: "s", permission: "bash", patterns: ["env FOO=bar"], metadata: { command: "env FOO=bar" } } })
    assert.equal(gate.pendingSize(), 1, `${shape}: pending armed`)
    assert.equal(gate.canDefer("s"), true, `${shape}: registered while healthy`)
    made[0].cb()
    await flush()
    return { gate, logs, replies }
  }

  // benign-closed (404 real envelope): NO degraded flip, already-closed audit.
  {
    const { gate, logs, replies } = await driveFailedReply("closed404")
    assert.equal(gate.pendingSize(), 0, "closed404: entry dropped even though already closed")
    assert.equal(gate.isArmed(), true, "closed404: a benign 'already closed' does NOT degrade the gate")
    assert.equal(gate.canDefer("s"), true, "closed404: a healthy gate still defers for the session")
    assert.ok(replies.every((r) => r.body.response === "reject"), "closed404: the plugin STILL only rejects (never self-allows)")
    const line = logs.find((l) => /:: already-closed/.test(l))
    assert.ok(line, "closed404: 'already-closed' verdict audited")
    assert.ok(/err=NotFoundError status=404$/.test(line), "closed404: non-privacy status diagnostic preserved via the envelope")
    assert.ok(!logs.some((l) => /degraded/.test(l)), "closed404: never audited degraded")
    assert.ok(!/secret-path|FOO|detail/.test(line), "closed404: error message / params never audited")
  }
  // benign-closed via _tag with NO numeric status: still benign (no flip).
  {
    const { gate, logs } = await driveFailedReply("closedTag")
    assert.equal(gate.isArmed(), true, "closedTag: a _tag NotFound (no status) is benign too")
    assert.ok(logs.some((l) => /:: already-closed/.test(l)), "closedTag: already-closed audited")
  }
  // param-shape (400): STILL fails closed, rejected-shape-bug audit.
  {
    const { gate, logs } = await driveFailedReply("shape400")
    assert.equal(gate.isArmed(), false, "shape400: a reply-shape bug fails closed (degrades)")
    assert.equal(gate.canDefer("s"), false, "shape400: degraded gate defers nothing")
    const line = logs.find((l) => /:: rejected-shape-bug/.test(l))
    assert.ok(line, "shape400: 'rejected-shape-bug' verdict audited")
    assert.ok(/err=BadRequest status=400$/.test(line), "shape400: status diagnostic on the bug audit")
    assert.ok(!/secret-path|detail|FOO/.test(line), "shape400: message never audited")
  }
  // transport (real Error rejection): STILL fails closed — the historic path.
  {
    const { gate, logs, replies } = await driveFailedReply("rejection")
    assert.equal(gate.isArmed(), false, "rejection: a transport failure fails closed")
    assert.equal(gate.canDefer("s"), false, "rejection: degraded gate defers nothing")
    assert.ok(replies.every((r) => r.body.response === "reject"), "rejection: only a reject was ever sent")
    const line = logs.find((l) => /:: degraded/.test(l))
    assert.ok(line, "rejection: degraded verdict audited")
    assert.ok(/err=Error$/.test(line), "rejection: error class recorded, no status")
    assert.ok(!/host down|secret-path|FOO/.test(line), "rejection: message/params never audited")
    gate.handleEvent({ type: "permission.asked", properties: { id: "y", sessionID: "s", permission: "bash", patterns: ["env"], metadata: { command: "env" } } })
    assert.equal(gate.pendingSize(), 0, "rejection: a degraded gate stops opening new timers")
  }
  // transport (5xx envelope): fails closed.
  {
    const { gate, logs } = await driveFailedReply("fiveHundred")
    assert.equal(gate.isArmed(), false, "fiveHundred: a 5xx envelope is transport -> degrade")
    assert.ok(logs.some((l) => /:: degraded/.test(l)), "fiveHundred: degraded audited")
  }
  // transport (status-less error body): fails closed.
  {
    const { gate, logs } = await driveFailedReply("empty")
    assert.equal(gate.isArmed(), false, "empty: a status-less error body is transport -> degrade")
    assert.ok(logs.some((l) => /:: degraded/.test(l)), "empty: degraded audited")
  }

  // 7g-2. R1#8 LATE VERDICT: the timer auto-rejected (the reject landed), THEN
  // the human's real reply reached the plugin late.  A `late-<verdict>` audit
  // is recorded for observability ONLY — it never re-arms, never revives the
  // command, and sends no second SDK reply (the plugin still only rejects).
  {
    const logs = []
    const replies = []
    const appOwner = {
      log(req) {
        if (this !== appOwner) throw new TypeError("SDK app.log called unbound (this lost)")
        logs.push(String(req?.body?.message ?? ""))
      },
    }
    const client = {
      app: appOwner,
      postSessionIdPermissionsPermissionId(o) {
        if (this !== client) throw new TypeError("SDK reply endpoint called unbound (this lost)")
        replies.push(o)
        return Promise.resolve({ data: true })
      },
    }
    const made = []
    const fake = { setTimeoutFn: (cb) => { const t = { cb, cleared: false }; made.push(t); return t }, clearTimeoutFn: (h) => { if (h) h.cleared = true } }
    const gate = createApprovalGate({ client, timeoutMs: 1000, timers: fake })
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_late", sessionID: "ses_l", permission: "bash", patterns: ["printenv PATH"], metadata: { command: "printenv PATH" } } })
    made[0].cb() // the timer fires first -> the auto-reject lands
    await flush()
    assert.ok(logs.some((l) => l.endsWith(":: bash :: env :: timeout-rejected")), "late-1: the timeout auto-reject was audited")
    const repliesAfterTimeout = replies.length
    // the human's genuine "once" now arrives LATE (past the timer) on a real reply word:
    gate.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_l", requestID: "per_late", reply: "once" } })
    assert.ok(logs.some((l) => l.endsWith(":: bash :: env :: late-allowed-once")), "late-2: the real verdict is recorded as late-<verdict>")
    assert.equal(replies.length, repliesAfterTimeout, "late-3: NO second SDK reply is sent on a late verdict (never revive, never self-allow)")
    assert.equal(gate.pendingSize(), 0, "late-4: the late reply re-arms nothing")
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_late", sessionID: "ses_l", permission: "bash", patterns: ["printenv PATH"], metadata: { command: "printenv PATH" } } })
    assert.equal(gate.pendingSize(), 0, "late-5: the closed id stays tombstoned after the late verdict (ghost still suppressed)")
    // an out-of-vocabulary late word must NOT fabricate a verdict / late-degraded
    const lateBefore = logs.filter((l) => /late-/.test(l)).length
    assert.ok(lateBefore >= 1, "late-pre: the per_late 'once' reply already produced a late-allowed-once")
    gate.handleEvent({ type: "permission.asked", properties: { id: "per_l2", sessionID: "ses_l2", permission: "bash", patterns: ["printenv"], metadata: { command: "printenv" } } })
    made[made.length - 1].cb()
    await flush()
    gate.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_l2", requestID: "per_l2", reply: "lgtm" } })
    assert.equal(logs.filter((l) => /late-/.test(l)).length, lateBefore, "late-6: an unknown late word never becomes a late-<verdict>")
    assert.ok(!logs.some((l) => /late-degraded/.test(l)), "late-6b: no fabricated late-degraded for an out-of-vocab word")
    // a reply for an id we NEVER saw must NOT self-trigger a late audit (the
    // wasClosed guard reads closed.has() BEFORE this reply tombstones it).
    gate.handleEvent({ type: "permission.replied", properties: { sessionID: "ses_unknown", requestID: "per_unknown", reply: "once" } })
    assert.equal(logs.filter((l) => /late-/.test(l)).length, lateBefore, "late-7: an unknown-id reply does not fabricate a late verdict")
  }

  // 7h / 7h-2. The R6 hook's deferral and the session-wide env-approved pass were
  // properties of v1's `createEnvProtectHook` — a `tool.execute.before` factory that
  // hard-threw until the approval gate could arm. The v1 personality is cut (26209fa),
  // nothing on 2.x calls that factory any more, and 2.x gives a plugin no dialog to
  // defer to: the guard fails CLOSED instead. What those two groups protected therefore
  // lives in two different places now, and both are pinned: the per-command R6/R2
  // classification by the pure matchers above (groups 3-5) and by test-v2-adapter's
  // permission-guard group, and the never-self-allow / reply-capable discipline by the
  // gate module's own blocks (7a-7d). The NUMBERS stay so 7i and 7j do not renumber.
  console.log("  7h/7h-2. v1 R6 hook deferral + env-approved pass: SKIPPED — createEnvProtectHook removed with the v1 personality; 2.x fails closed (test-v2-adapter guard group, groups 3-5 here)")

  // 7i. end-to-end through server() (gate + real-host event routing + session
  // registration via message.updated) - RETIRED with the v1 personality (1.7.0
  // cut).  This drove plugin.server() to wire the composed R6+gate hook and the
  // event/chat.message/dispose routes.  plugin.server is gone.  The approval-gate
  // MODULE itself (createApprovalGate: asked/replied shapes, session-wide cancel,
  // ghost tombstones, scoped deferral registry, timeout parse, never self-allow,
  // SDK error-envelope fail-closed) is personality-agnostic and stays pinned by the
  // pure 7a-7h blocks above; the v2 hook wiring lives in src/host/v2-guard.ts
  // (pinned by test-v2-adapter).  The NUMBER stays so 7j does not move.
  console.log("  7i. end-to-end through server(): SKIPPED - v1 plugin.server removed; gate module pinned by 7a-7h, v2 wiring by test-v2-adapter")

  // 7i2. dead-popup guard via plugin.server() - RETIRED with the v1 personality
  // for the same reason (it drove the v1 config hook to assert the R6 env ask face
  // is omitted when the gate cannot arm).  The never-self-allow / dead-popup
  // invariant is a property of the gate + config-surgery, pinned elsewhere.
  console.log("  7i2. dead-popup guard via server(): SKIPPED - v1 plugin.server removed")


  // 7j. tm_bash rejection guidance now points at the official-dialog path
  {
    const guard = await import("./dist/tm/guard.js")
    const v = guard.classifyReadonlyCommand("rm -rf build", [])
    assert.ok(!v.ok, "rm still rejected in tm_bash (read-only allowlist)")
    assert.ok(/官方确认框/.test(v.suggestion) && /bash/.test(v.suggestion), "rejection guidance mentions the bash confirmation dialog")
  }
  console.log("7. unified approval gate: OK (real-host asked/replied shapes, session-wide cancel + ghost tombstones, scoped deferral registry, timeout parse, ask patterns incl. bare M3, expressible/inexpressible + byte-exact M4 split, categorize inference, timer reject-only, never self-allow, SDK {error}-envelope fail-closed, hook session-scoping, off no-timer, dead-popup guard, tm_bash guidance)")
}

console.log("\nALL ENV-PROTECT TESTS PASSED ✅")

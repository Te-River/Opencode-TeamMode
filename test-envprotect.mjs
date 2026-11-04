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
// group 8 checks the two envprotect leaves against the SHIPPED v2 guard faces
// (webGuard / pathGuard / shellGuard / applyV2EnvFileInputGuard), so a claim here
// is measured against the enforcement that runs, not against the matcher's own text.
const vg = await import("./dist/host/v2-guard.js")

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
// off mode: R6's fine ask face is ungated, the env-file PATH red line is NOT
assert.equal(ep.inspectToolCall("bash", { command: "env" }, "off"), null, "off: bash face passes (its ask glob is not installed under off)")
assert.equal(ep.inspectToolCall("grep", { pattern: "TODO", path: "src" }, "off"), null, "off: an ordinary grep still passes")
assert.equal(ep.inspectToolCall("read", { filePath: ".env" }, "off"), "env-file-path", "off does NOT lift the env-file path red line (resolution (a))")
assert.equal(ep.inspectToolCall("glob", { pattern: "*.env" }, "off"), "env-file-path", "…and the same under the glob shape")
assert.equal(ep.inspectToolCall("read", { filePath: "TOPSECRET.txt" }, "off", extra), null, "off DOES switch off the user's extra-deny preference face (a preference has a consent path)")
console.log("5. inspectToolCall: OK (filePath/path/pattern/include, scope boundary, extra-deny, off = fine face only)")

/* ---------- 6. loader integration + env-var wiring + audit — RETIRED with the
 *  v1 personality (1.7.0 cut).  This group drove plugin.server() to prove the
 *  R6 hook installed next to config, wired the env knobs, and wrote the privacy
 *  red-line audit.  plugin.server is gone; the R6 CLASSIFICATION it exercised is
 *  unchanged and stays pinned by groups 3-5 (the pure matchers + inspectToolCall),
 *  and the audit/hook wiring on v2 lives in src/host/v2-guard.ts (pinned by
 *  test-v2-adapter).  The NUMBER stays so 7 does not renumber. ---------- */
console.log("6. loader integration: SKIPPED — v1 plugin.server removed; R6 matchers pinned by groups 3-5, v2 hook wiring by test-v2-adapter")


/* ---------- 7. R6/R2 ask-face classification + tm_bash guidance ---------- */
// The unified approval gate MODULE (createApprovalGate / resolveAskTimeoutMs /
// hasPermissionReplyCapability / classifyReplyFailure) was deleted with the v1
// personality: v2 gives a plugin no dialog to raise, so a timer that
// auto-rejects an unanswered dialog has no object to manage.  What remains in
// this group are the personality-agnostic pieces — the ask-pattern builder, the
// expressible/inexpressible split, the permission categorizer (all envprotect
// pure functions) and tm_bash's rejection guidance.  The v2 guard wiring is
// pinned by test-v2-adapter.
{
  // 7a. TM_ASK_TIMEOUT_MIN parsing — RETIRED with the approval gate module
  // (approval-gate.ts deleted with the v1 personality).  v2 raises no plugin
  // dialog, so there is no timer to configure; the v2 guard fails closed and is
  // pinned by test-v2-adapter's permission-guard group.
  console.log("  7a. ask-timeout parsing: SKIPPED — approval-gate.ts removed with the v1 personality; v2 has no plugin dialog (test-v2-adapter guard group)")

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

  // 7e. reply-capability detection — RETIRED with the approval gate module
  // (hasPermissionReplyCapability lived in approval-gate.ts).  v2 has no reply
  // seam to detect; the v2 guard fails closed (test-v2-adapter guard group).
  console.log("  7e. reply-capability detection: SKIPPED — approval-gate.ts removed with the v1 personality")

  // 7f. timer on REAL event shapes (asked -> timeout -> reject ONLY; replied
  // -> cancel the whole session; ghosts suppressed) — RETIRED with the approval
  // gate module.  The timer existed to auto-reject an unanswered HOST dialog;
  // v2 gives a plugin no dialog to raise, so there is nothing to time out.  The
  // v2 guard fails closed instead (test-v2-adapter permission-guard group).
  console.log("  7f. approval-gate timer: SKIPPED — approval-gate.ts removed with the v1 personality; v2 raises no plugin dialog")

  // 7g. SDK reply FAILURE classification (classifyReplyFailure) + late-verdict
  // handling — RETIRED with the approval gate module.  Both were properties of
  // the v1 reply path (postSessionIdPermissionsPermissionId / permission.reply),
  // which v2 does not have; the plugin never self-allows and v2 fails closed
  // (test-v2-adapter permission-guard group).
  console.log("  7g. reply-failure classification + late verdicts: SKIPPED — approval-gate.ts removed with the v1 personality")

  // 7h / 7h-2. The R6 hook's deferral and the session-wide env-approved pass were
  // properties of v1's `createEnvProtectHook` — a `tool.execute.before` factory that
  // hard-threw until the approval gate could arm. The v1 personality is cut (26209fa),
  // nothing on 2.x calls that factory any more, and 2.x gives a plugin no dialog to
  // defer to: the guard fails CLOSED instead. What those two groups protected therefore
  // lives in two different places now, and both are pinned: the per-command R6/R2
  // classification by the pure matchers above (groups 3-5) and by test-v2-adapter's
  // permission-guard group. The NUMBERS stay so 7i and 7j do not renumber.
  console.log("  7h/7h-2. v1 R6 hook deferral + env-approved pass: SKIPPED — createEnvProtectHook removed with the v1 personality; 2.x fails closed (test-v2-adapter guard group, groups 3-5 here)")

  // 7i. end-to-end through server() (gate + real-host event routing + session
  // registration via message.updated) - RETIRED with the v1 personality (1.7.0
  // cut).  This drove plugin.server() to wire the composed R6+gate hook and the
  // event/chat.message/dispose routes.  plugin.server is gone, and the approval
  // gate module it drove is gone with it (v2 raises no plugin dialog).  The
  // per-command classification stays pinned by the pure matchers above (groups
  // 3-5); the v2 hook wiring lives in src/host/v2-guard.ts (pinned by
  // test-v2-adapter).  The NUMBER stays so 7j does not move.
  console.log("  7i. end-to-end through server(): SKIPPED - v1 plugin.server removed; gate module removed too, v2 wiring by test-v2-adapter")

  // 7i2. dead-popup guard via plugin.server() - RETIRED with the v1 personality
  // for the same reason (it drove the v1 config hook to assert the R6 env ask face
  // is omitted when the gate cannot arm).  The never-self-allow / dead-popup
  // invariant is a property of the config-surgery, pinned elsewhere.
  console.log("  7i2. dead-popup guard via server(): SKIPPED - v1 plugin.server removed")


  // 7j. tm_bash rejection guidance now points at the official-dialog path
  {
    const guard = await import("./dist/tm/guard.js")
    const v = guard.classifyReadonlyCommand("rm -rf build", [])
    assert.ok(!v.ok, "rm still rejected in tm_bash (read-only allowlist)")
    assert.ok(/官方确认框/.test(v.suggestion) && /bash/.test(v.suggestion), "rejection guidance mentions the bash confirmation dialog")
  }
  console.log("7. R6/R2 ask-face classification: OK (ask patterns incl. bare M3, expressible/inexpressible + byte-exact M4 split, categorize inference, tm_bash guidance; approval-gate timer/reply blocks retired with the v1 personality)")
}

/* ---------- 8. the `mode === "off"` branch of the two leaf matchers (2469ab4) ----------
 * Commit 2469ab4 added `if (mode === "off") return false` to `isAskGatedEnvCommand`
 * (src/envprotect/gate-predicates.ts:101) and `if (mode === "off") return null` to
 * `classifyPathFields` (src/envprotect/hook.ts:45), both claimed "zero runtime change,
 * provable". Every pre-existing case in this file passed "strict"/"standard", so BOTH
 * branches were uncovered — a rule with no failing test behind it is a hope, so the
 * branches get a matrix here, in the order the two claims stand or fall:
 *   8a three-mode matrix per leaf (strict ≡ standard, off distinct);
 *   8b the SEMANTICS that make off→false right instead of a mirror of the code: the R6
 *      env ask face is installed only when `mode !== "off" && envFace`
 *      (src/envprotect/patterns.ts:149-152), so a `true` under off defers a verdict to a
 *      dialog the config never opens — and on 2.x a plugin raises no dialog at all, the
 *      guard fails closed (src/host/v2-guard.ts). Checked against the SHIPPED guard, not
 *      against the implementation's own text.
 *      `false` also does NOT mean "not an env read": classifyBashCommand keeps naming
 *      these commands env reads under off ("`off` is handled by the caller",
 *      src/envprotect/bash-classify.ts:180-181). The two matchers must not be conflated.
 *   8c the path leaf under strict/standard (env family blocked, templates + code
 *      identifiers pass, extra-deny wins) and its routing parity with inspectToolCall —
 *      the only in-tree caller, and the place where "behaviour unchanged" is checkable;
 *   8d what the SAME `isEnvFilePath` red line answers on every other shipped face under
 *      off — after resolution (a) all four path-bearing faces (classifyPathFields,
 *      inspectToolCall, pathGuard, the #58 INPUT face) answer the way webGuard always
 *      did, so the group pins the WHOLE group: leaving any one of them honouring `off`
 *      fails its own line here;
 *   8e the case that was written RED when the split was still open. Resolution (a) —
 *      the red line holds under `off` for the env-file-path category, the user's
 *      extra-deny preference keeps switching off — landed, so this assertion is now the
 *      regression guard; its message (verbatim, unchanged) is what a future split reads.
 * -------------------------------------------------------------------------------------------- */
{
  const MODES = ["strict", "standard", "off"]
  let n = 0
  const eq = (a, b, m) => { n++; assert.equal(a, b, m) }
  const ok = (v, m) => { n++; assert.ok(v, m) }
  const GATED = [
    "printenv", "printenv PATH", "env", "env FOO=bar", "set",
    "export -p", "declare -p PATH", "Get-ChildItem env:PATH", "$env:PATH",
  ]
  const NOT_GATED = [
    "$(printenv PATH)", "(env)", "\\env", "time env", "FOO=1 env", "echo ${HOME}",
    "echo $API_KEY", "cd /x && printenv", "Get-Content -Path env:HOME", "printenvx",
    "/usr/bin/env", "GET-CONTENT ENV:PATH", "PrintEnv PATH", " printenv", "printenv\t",
    "$ENV:PATH", "Get-Childitem env:PATH", "/usr/bin/printenv", "cmd /c set", "cat .env",
  ]

  /* 8a. isAskGatedEnvCommand — three modes, same two lists.
   * strict ≡ standard (the function consults `mode` for nothing else), and `off` flips
   * the GATED list to false. That flip is the new branch, and it IS observable at the
   * leaf: before 2469ab4 these same nine commands answered `true` under "off". */
  for (const c of GATED) {
    const s = ep.isAskGatedEnvCommand(c, "strict")
    const d = ep.isAskGatedEnvCommand(c, "standard")
    eq(s, d, `strict ≡ standard for a dialog-governed form: ${c}`)
    eq(s, true, `strict still gates: ${c}`)
    eq(d, true, `standard still gates: ${c}`)
    eq(ep.isAskGatedEnvCommand(c, "off"), false, `off gates NOTHING: ${c}`)
  }
  for (const c of NOT_GATED) {
    for (const mode of MODES) {
      eq(ep.isAskGatedEnvCommand(c, mode), false, `stays hard-throw, never gated (${mode}): ${c}`)
    }
  }
  // user extra-deny wins over the popup in every mode, and a non-matching extra list
  // never suppresses a gate (the extra scan runs before the off check is irrelevant here —
  // both answers are false under off, so the strict/standard rows are the load-bearing ones)
  eq(ep.isAskGatedEnvCommand("printenv PATH", "strict", [/printenv/]), false, "extra-deny hit not gated (strict)")
  eq(ep.isAskGatedEnvCommand("printenv PATH", "standard", [/printenv/]), false, "extra-deny hit not gated (standard)")
  eq(ep.isAskGatedEnvCommand("printenv PATH", "off", [/printenv/]), false, "extra-deny hit not gated (off)")
  eq(ep.isAskGatedEnvCommand("printenv PATH", "strict", [/TOPSECRET\w*/]), true, "non-matching extra list does not ungate")

  /* 8b. the entailment, checked against the config the same mode produces. */
  {
    const byteExact = (pattern, text) =>
      new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(text)
    const strictAsk = ep.bashAskPatterns("strict")
    const stdAsk = ep.bashAskPatterns("standard")
    const offAsk = ep.bashAskPatterns("off")
    for (const c of GATED) {
      const hits = ep.R6_ENV_BASH_ASK_PATTERNS.filter((k) => byteExact(k, c))
      ok(hits.length > 0, `a gated form must be reachable by the injected ask globs: ${c}`)
      ok(hits.every((k) => strictAsk[k] === "ask"), `strict installs the ask glob for: ${c}`)
      ok(hits.every((k) => stdAsk[k] === "ask"), `standard installs the ask glob for: ${c}`)
      ok(hits.every((k) => offAsk[k] === undefined), `off installs NO env ask glob, so a true here would defer to a dialog that cannot open: ${c}`)
      // the R2 face is independent of the R6 kill switch (off keeps it)
      eq(offAsk["rm *"], "ask", `off keeps the R2 danger face (independent red line): ${c}`)
      // shipped guard agrees with the leaf, in both directions
      eq(vg.shellGuard(c, "strict")?.effect, "ask", `v2 shellGuard asks what strict gates: ${c}`)
      eq(vg.shellGuard(c, "standard")?.effect, "ask", `v2 shellGuard asks what standard gates: ${c}`)
      eq(vg.shellGuard(c, "off"), null, `v2 shellGuard is silent where off ungates: ${c}`)
      // and the read is still a READ — off ungoverns it, it does not launder it
      ok(ep.classifyBashCommand(c, "off") !== null, `classifyBashCommand still names it an env read under off: ${c}`)
    }
    eq(ep.classifyBashCommand("cat .env", "off"), "env-file-path", "env-file read via bash still classified under off")
    console.log("  8a/8b. isAskGatedEnvCommand x 3 modes + ask-face entailment: OK (strict ≡ standard, off gates nothing, shipped shellGuard agrees, the read is still an env read)")
  }

  /* 8c. classifyPathFields — strict/standard matrix + routing parity. */
  const ENV_ARGS = [
    ["read", { filePath: ".env" }],
    ["read", { filePath: "C:\\proj\\.env.local" }],
    ["grep", { pattern: ".env" }],
    ["grep", { include: "*.env" }],
    ["glob", { pattern: ".env.*" }],
    ["list", { path: "config/.env" }],
  ]
  for (const [tool, args] of ENV_ARGS) {
    for (const mode of ["strict", "standard"]) {
      eq(ep.classifyPathFields(args, mode), "env-file-path", `${tool} ${JSON.stringify(args)} blocked in ${mode}`)
      eq(ep.inspectToolCall(tool, args, mode), ep.classifyPathFields(args, mode), `routing parity (${mode}): the leaf change did not move the answer the caller gets`)
    }
  }
  for (const mode of MODES) {
    eq(ep.classifyPathFields({ filePath: ".env.example" }, mode), null, `checked-in template passes (${mode})`)
    eq(ep.classifyPathFields({ filePath: ".env.dist" }, mode), null, `template suffix .dist passes (${mode})`)
    eq(ep.classifyPathFields({ pattern: "*.env.template" }, mode), null, `template glob passes (${mode})`)
    eq(ep.classifyPathFields({ pattern: "process\\.env" }, mode), null, `code identifier (escaped) passes (${mode})`)
    eq(ep.classifyPathFields({ filePath: "src/app.ts" }, mode), null, `ordinary file passes (${mode})`)
    eq(ep.classifyPathFields({ filePath: "a.ts", note: ".env" }, mode), null, `non-path key never scanned (${mode})`)
    eq(ep.classifyPathFields(undefined, mode), null, `undefined args are null-safe (${mode})`)
    eq(ep.classifyPathFields("not-an-object", mode), null, `non-object args untouched (${mode})`)
  }
  eq(ep.classifyPathFields({ filePath: "printenv.txt" }, "strict", [/printenv/]), "extra-deny", "extra-deny wins on a path field (strict)")
  eq(ep.classifyPathFields({ filePath: "printenv.txt" }, "standard", [/printenv/]), "extra-deny", "extra-deny wins on a path field (standard)")
  console.log("  8c. classifyPathFields strict/standard + template/identifier exceptions + inspectToolCall parity: OK")

  /* 8d. The faces of the same red line under `envProtect: "off"` — after resolution (a)
   * every path-bearing face answers the SAME way the URL face always did. */
  {
    const envFileUrl = vg.webGuard(["https://x/.env"])
    eq(vg.webGuard.length, 1, "webGuard takes NO mode parameter (arity 1) — the remote env-file URL face is mode-independent")
    eq(envFileUrl?.effect, "deny", "FACT: a remote .env URL is still denied under any envProtect setting")
    eq(envFileUrl?.why, "env-file URL", "FACT: the URL face refuses with its own category")
    eq(vg.pathGuard("read", [".env"], "strict").effect, "deny", "FACT: pathGuard denies a local .env in strict")
    eq(vg.pathGuard("read", [".env"], "standard").effect, "deny", "FACT: pathGuard denies a local .env in standard")
    eq(vg.pathGuard("read", [".env"], "off")?.effect, "deny", "FIXED (was null — v2-guard.ts:135, c75c26f5 2026-10-06): the env-file path red line does not read the mode")
    eq(vg.pathGuard("read", [".env"], "off")?.why, "env-file-path", "…and refuses with the same category the strict row uses")
    eq(ep.inspectToolCall("read", { filePath: ".env" }, "off"), "env-file-path", "FIXED (was null — hook.ts:85, 392bdf5f 2026-09-13): the routed answer under off is a refusal")
    eq(ep.classifyPathFields({ filePath: "printenv.txt" }, "off", [/printenv/]), null, "FACT: off still switches off the user's extra-deny preference (not a red line), so the leaf returns null for a preference-only hit")
    const offReport = {
      seen: 0, byAction: {}, strictened: 0, denied: 0, shellMatched: 0, foreignSkipped: 0,
      envFileDenied: 0, envFileDeniedByInput: 0, envFileInputSeen: 0, envFileInputForeignSkipped: 0, envFileInputThrew: 0,
    }
    let offInputHandler = null
    const inputGuard = await vg.applyV2EnvFileInputGuard(
      { tool: { hook: (_name, handler) => { offInputHandler = handler; return () => {} } } },
      { envProtectMode: "off", report: offReport },
    )
    eq(inputGuard?.registrations?.length, 1, "FIXED (was 0 — v2-guard.ts:656, d6138370 2026-10-06): off registers the grep/glob INPUT face like every other mode")
    ok(typeof offInputHandler === "function", "and what it registered is a real handler")
    let threw = null
    try {
      await offInputHandler({ tool: "grep", sessionID: "ses_off", agent: "team", input: { path: "config/.env" } })
    } catch (e) {
      threw = String(e?.message ?? e)
    }
    ok(threw !== null && threw.includes("R6 红线"), `off still throws at the INPUT face for a grep in an env file: ${threw}`)
    eq(offReport.envFileDeniedByInput, 1, "and the refusal is COUNTED, so tm_stats can show it fired")
    threw = null
    try {
      await offInputHandler({ tool: "grep", sessionID: "ses_off", agent: "team", input: { path: "src" } })
    } catch (e) {
      threw = String(e?.message ?? e)
    }
    eq(threw, null, "an ordinary grep path is untouched under off too — the tightening is scoped to the red-line category")
    console.log("  8d. env-file red line under off, per shipped face: OK (URL face hard, path face hard — the faces no longer split)")
  }

  /* 8e. Formerly the DELIBERATE PRODUCT_BUG case (expected RED).  Resolution (a) —
   * the red line holds under `off` for CATEGORY_ENV_FILE_PATH, extra-deny keeps
   * switching off — landed, so this assertion is the REGRESSION GUARD for it: it
   * goes red again the moment any path shape answers null under off.  Read its
   * message in full if it fires. */
  const lifted = []
  for (const [, args] of ENV_ARGS) {
    const got = ep.classifyPathFields(args, "off")
    if (got !== "env-file-path") lifted.push(`${JSON.stringify(args)} -> ${JSON.stringify(got)}`)
  }
  console.log(`  case count so far: ${n} assertions in group 8 (8a-8d all green). Now the former PRODUCT_BUG case, green by resolution (a).`)
  assert.deepStrictEqual(
    lifted,
    [],
    [
      "PRODUCT_BUG (this failure is intended, and it is the only one in this suite):",
      "the env-file PATH red line is not refused under mode \"off\" — classifyPathFields",
      "(src/envprotect/hook.ts:45, added by 2469ab4) answers null for every .env shape:",
      ...lifted.map((l) => "      " + l),
      "Expected: \"env-file-path\" (the red line survives the mode switch). Basis, in the",
      "project's own words and code, not in what the implementation happens to return:",
      "  - AGENTS.md (R6/R2 on 2.x): env-file paths are a class with NO consent path that",
      "    \"stay refused under every setting\"; v2-guard.ts:130-132 calls pathGuard \"A RED",
      "    LINE, not a gate ... there is no consent path to name\" — yet envProtect:\"off\"",
      "    IS the consent path that removes it.",
      "  - The SAME isEnvFilePath matcher is enforced with NO mode knob elsewhere, so off",
      "    splits one red line across faces: webGuard (src/host/v2-guard.ts:84, arity 1 —",
      "    https://x/.env still denied) and the native-browser preview path face",
      "    (src/host/v2-browser-gate.ts:196-201, switched only by v2BrowserGate, never by",
      "    envProtect) both stay hard, while a Team role may read .env with the native",
      "    read tool.",
      "Scope — NOT introduced by 2469ab4: the leaf merely joined the pre-existing gates at",
      "  src/host/v2-guard.ts:135 (c75c26f5 2026-10-06), :656 (d6138370 2026-10-06) and",
      "  src/envprotect/hook.ts:85 (392bdf5f 2026-09-13); this file's line 221 has pinned",
      "  \"off: read passes\" since a199ad88 (2026-09-08). So the commit's \"no behaviour",
      "  change\" claim holds for the ONE in-tree caller (8c parity) but the policy it",
      "  encodes is the one above, and it is now the exported leaf's contract too.",
      "Two honest resolutions — one must be taken, the faces must not stay split:",
      "  (a) red line holds under off: stop honouring off for CATEGORY_ENV_FILE_PATH in",
      "      pathGuard / inspectToolCall / this leaf (extra-deny may keep switching off),",
      "      flip line 221, and this assertion goes green by itself.",
      "  (b) off = R6 fully off INCLUDING the path face: then change this expectation to",
      "      null AND correct AGENTS.md's \"under every setting\", and decide whether",
      "      webGuard and the browser-gate path face follow the same switch.",
      "Do not \"fix\" this by deleting the case; the split is what is being reported.",
    ].join("\n"),
  )
}

console.log("\nALL ENV-PROTECT TESTS PASSED ✅")

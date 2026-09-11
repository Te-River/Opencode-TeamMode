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

/* ---------- 6. loader integration + env-var wiring + audit ---------- */

const callHook = (hooks, tool, args) => hooks["tool.execute.before"]({ tool }, { args })
// Class-method form ON PURPOSE: the real SDK's app.log depends on `this`
// bound to the app object, so this mock rejects any unbound/destructured
// call — the exact regression shape of the old destructured audit call.
const auditClient = () => {
  const calls = []
  const client = {
    app: {
      log(req) {
        if (this !== client.app) throw new TypeError("audit log lost its this binding")
        calls.push(req)
      },
    },
  }
  return { calls, client }
}

// negative control: prove the mock really enforces `this` binding, so the
// audit assertions below cannot pass against a destructured implementation
{
  const { client, calls } = auditClient()
  const { log } = client.app
  assert.throws(() => log({ body: {} }), /this binding/, "mock rejects unbound log calls")
  assert.equal(calls.length, 0, "unbound call recorded nothing")
}

let tmpRoot = ""
try {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "envp-test-"))

  // 6a. default (no TM_ENV_PROTECT) -> strict; hook installed next to config
  delete process.env.TM_ENV_PROTECT
  delete process.env.TM_ENV_PROTECT_EXTRA_DENY
  {
    const a = auditClient()
    const hooks = await plugin.server({ directory: tmpRoot, client: a.client }, {})
    assert.equal(typeof hooks.config, "function", "config hook still present")
    assert.equal(typeof hooks["tool.execute.before"], "function", "R6 hook installed")
    await callHook(hooks, "bash", { command: "echo hello" })
    assert.equal(a.calls.length, 0, "no audit on pass-through")
    await assert.rejects(
      callHook(hooks, "bash", { command: "printenv PATH" }),
      (err) => err.message.startsWith(ep.ENV_PROTECT_MESSAGE)
        && err.message.includes("[category=bash-env-command]"),
      "default mode strict: printenv blocked with structured message",
    )
    assert.equal(a.calls.length, 1, "audit written on block")
  }

  // 6b. audit shape + privacy red line: tool name + category ONLY
  {
    const a = auditClient()
    const hooks = await plugin.server({ directory: tmpRoot, client: a.client }, {})
    await assert.rejects(callHook(hooks, "bash", { command: "cat .env && more" }))
    assert.equal(a.calls.length, 1, "one audit entry")
    const entry = a.calls[0]
    assert.equal(entry.body.level, "warn", "audit level warn")
    assert.equal(entry.body.service, "team-mode-env-protect", "audit service id")
    assert.equal(entry.body.message, "team-mode-env-protect :: bash :: env-file-path",
      "audit message = service :: tool :: category (file sinks drop the service field)")
    // privacy red line: never the command text, path, or any value
    assert.ok(!entry.body.message.includes(".env"), "audit must not contain the path")
    assert.ok(!entry.body.message.includes("cat"), "audit must not contain the command")
    assert.ok(!entry.body.message.includes("more"), "audit must not contain command tail")
  }

  // 6c. TM_ENV_PROTECT=standard: explicit env cmds + env files blocked,
  // $VAR expansion allowed
  process.env.TM_ENV_PROTECT = "standard"
  {
    const hooks = await plugin.server({ directory: tmpRoot }, {})
    await assert.rejects(callHook(hooks, "bash", { command: "printenv" }), undefined, "standard blocks printenv")
    await assert.rejects(callHook(hooks, "read", { filePath: ".env" }), undefined, "standard blocks .env read")
    await callHook(hooks, "bash", { command: "echo $HOME" })
    await callHook(hooks, "bash", { command: "echo ${HOME}" })
  }

  // 6d. TM_ENV_PROTECT=off: hook installed, everything passes, no audit
  process.env.TM_ENV_PROTECT = "off"
  {
    const a = auditClient()
    const hooks = await plugin.server({ directory: tmpRoot, client: a.client }, {})
    assert.equal(typeof hooks["tool.execute.before"], "function", "off: hook still installed")
    await callHook(hooks, "bash", { command: "env" })
    await callHook(hooks, "read", { filePath: ".env" })
    assert.equal(a.calls.length, 0, "off: no audit entries")
  }

  // 6e. invalid mode value fails closed into strict
  process.env.TM_ENV_PROTECT = "loose"
  {
    const hooks = await plugin.server({ directory: tmpRoot }, {})
    await assert.rejects(callHook(hooks, "bash", { command: "echo $HOME" }), undefined, "typo mode -> strict expansion block")
  }

  // 6f. TM_ENV_PROTECT_EXTRA_DENY applies in standard mode (all non-off modes)
  process.env.TM_ENV_PROTECT = "standard"
  process.env.TM_ENV_PROTECT_EXTRA_DENY = "TOPSECRET\\w*"
  {
    const hooks = await plugin.server({ directory: tmpRoot }, {})
    await assert.rejects(
      callHook(hooks, "bash", { command: "echo TOPSECRET_value" }),
      (err) => err.message.includes("[category=extra-deny]"),
      "extra-deny fires in standard mode",
    )
    await assert.rejects(callHook(hooks, "read", { filePath: "TOPSECRET.txt" }), undefined, "extra-deny on read path")
  }

  // 6g. audit endpoint failure must never turn a block into a pass-through
  {
    const failing = { app: { log() { return Promise.reject(new Error("log endpoint down")) } } }
    const hooks = await plugin.server({ directory: tmpRoot, client: failing }, {})
    await assert.rejects(
      callHook(hooks, "bash", { command: "printenv" }),
      (err) => err.message.startsWith(ep.ENV_PROTECT_MESSAGE),
      "block still thrown when audit fails",
    )
  }
} finally {
  // cleanup must run even when an assertion above throws, or the process
  // environment leaks TM_ENV_PROTECT into whatever runs next in-process
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
  delete process.env.TM_ENV_PROTECT
  delete process.env.TM_ENV_PROTECT_EXTRA_DENY
}
console.log("6. loader integration: OK (hook installed, env wiring, off passthrough, fail-closed, audit shape + privacy, audit-failure resilience)")

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

  // 7a. TM_ASK_TIMEOUT_MIN parsing (default 10; valid-but-short CLAMPS UP to
  // the 3-min floor — the host delivers permission.replied ~120s late, so a
  // 1-min timer would auto-reject an already-approved dialog on a dead id;
  // anything silly -> default)
  assert.equal(ag.MIN_ASK_TIMEOUT_MIN, 3, "bus-lag floor is 3 minutes")
  assert.equal(resolveAskTimeoutMs({}), DEFAULT_ASK_TIMEOUT_MIN * 60000, "default 10min")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "1" }), 180000, "1min clamps UP to the 3-min floor (no D4 double-reject race)")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "2" }), 180000, "2min clamps to the floor")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: " 3 " }), 180000, "floor honoured + trimmed")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "10" }), 600000, "10min honoured unchanged")
  assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: "1440" }), 86400000, "24h boundary honoured")
  for (const bad of ["0", "-5", "99999", "abc", "1.5x", ""]) {
    assert.equal(resolveAskTimeoutMs({ TM_ASK_TIMEOUT_MIN: bad }), 600000, `invalid -> default: "${bad}"`)
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
    gate.dispose()
    assert.equal(gate.isArmed(), false, "disarmed after dispose")
    assert.equal(gate.canDefer("ses_team"), false, "disposed gate defers nothing")
  }

  // 7g. SDK reply FAILURE -> degraded -> fail-closed (no more timers armed).
  // Round-fix M2: the v1 client defaults to throwOnError:false — HTTP/4xx
  // REPLY CALLS RESOLVE with an { error } envelope (sdk.gen contract).  The
  // old Promise.reject-only mock had no teeth: real-host dead ids resolved
  // happily and the degraded flip never fired.  Pin BOTH failure shapes.
  for (const shape of ["envelope", "rejection"]) {
    const logs = []
    // this-bound host mocks (same anti-unbind teeth as 7f) — an unbound
    // reply call would throw BEFORE the failure shapes below are even
    // reached, and the degraded assertions then fail
    const appOwner = {
      log(req) {
        if (this !== appOwner) throw new TypeError("SDK app.log called unbound (this lost)")
        logs.push(String(req?.body?.message ?? ""))
      },
    }
    const client = {
      app: appOwner,
      postSessionIdPermissionsPermissionId() {
        if (this !== client) throw new TypeError("SDK reply endpoint called unbound (this lost)")
        return shape === "envelope"
          ? Promise.resolve({ error: { name: "NotFoundError", status: 404 }, data: undefined })
          : Promise.reject(new Error("host down at /api/secret-path"))
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
    assert.equal(gate.pendingSize(), 0, `${shape}: entry dropped even on failure`)
    assert.equal(gate.isArmed(), false, `${shape}: a failed auto-reject degrades the gate (fail-closed)`)
    assert.equal(gate.canDefer("s"), false, `${shape}: degraded gate defers NOTHING even for registered sessions`)
    gate.handleEvent({ type: "permission.asked", properties: { id: "y", sessionID: "s", permission: "bash", patterns: ["env"], metadata: { command: "env" } } })
    assert.equal(gate.pendingSize(), 0, `${shape}: degraded gate stops opening new timers`)
    // degraded audit carries a NON-PRIVACY diagnostic: error class + host
    // status only (live-host debuggability), never message text or paths
    const diag = logs.find((l) => /:: degraded/.test(l))
    assert.ok(diag, `${shape}: degraded verdict audited`)
    assert.ok(
      shape === "envelope" ? /err=NotFoundError status=404$/.test(diag) : /err=Error$/.test(diag),
      `${shape}: degraded audit records err.name${shape === "envelope" ? " + status" : ""}`,
    )
    assert.ok(!/host down|secret-path|FOO/.test(diag), `${shape}: error message/params never audited`)
  }

  // 7h. hook-level deferral wiring — now SESSION-SCOPED (round-fix C1): the
  // gate hands the R6 hook `canDefer(sessionID)`; unregistered sessions keep
  // the hard throw even while the gate is globally healthy.
  {
    const hookApp = { log() { if (this !== hookApp) throw new TypeError("SDK app.log called unbound (this lost)") } }
    const hookClient = {
      app: hookApp,
      postSessionIdPermissionsPermissionId() {
        if (this !== hookClient) throw new TypeError("SDK reply endpoint called unbound (this lost)")
        return Promise.resolve({ data: true })
      },
    }
    const fakeTimers = { setTimeoutFn: () => ({}), clearTimeoutFn: () => {} }
    const gate = createApprovalGate({ client: hookClient, timeoutMs: 600000, timers: fakeTimers })
    // registration via a real-env-shaped asked event
    gate.handleEvent({ type: "permission.asked", properties: { id: "a1", sessionID: "s-team", permission: "bash", patterns: ["printenv PATH"], metadata: { command: "printenv PATH" } } })
    const hookAuditApp = { log() { if (this !== hookAuditApp) throw new TypeError("SDK app.log called unbound (this lost)") } }
    const hook = ep.createEnvProtectHook({ app: hookAuditApp }, "strict", [], {
      deferToApproval: (sid) => gate.canDefer(sid),
    })
    // expressible env read in a REGISTERED session -> deferred (no throw)
    await hook({ tool: "bash", sessionID: "s-team" }, { args: { command: "printenv PATH" } })
    await hook({ tool: "bash", sessionID: "s-team" }, { args: { command: "Get-ChildItem env:PATH" } })
    // UNREGISTERED session (stock build/plan) -> hard throw, NOT deferred
    await assert.rejects(hook({ tool: "bash", sessionID: "s-stock" }, { args: { command: "printenv PATH" } }), /category=bash-env-command/, "stock session keeps the hard throw — global R6 bypass closed")
    // missing sessionID -> no deferral possible
    await assert.rejects(hook({ tool: "bash" }, { args: { command: "printenv PATH" } }), /category=bash-env-command/, "no sessionID: stays hard")
    // M4: case/trim-deviated forms never defer even in a registered session
    await assert.rejects(hook({ tool: "bash", sessionID: "s-team" }, { args: { command: "GET-CONTENT ENV:PATH" } }), /category=bash-env-command/, "case mismatch: no deferral, no silent env read")
    await assert.rejects(hook({ tool: "bash", sessionID: "s-team" }, { args: { command: " printenv" } }), /category=bash-env-command/, "leading-space form: no deferral (host grammar unknown)")
    // M5: path/launcher heads stay hard everywhere
    await assert.rejects(hook({ tool: "bash", sessionID: "s-team" }, { args: { command: "/usr/bin/env" } }), /category=bash-env-command/, "path-head dump: hard throw")
    await assert.rejects(hook({ tool: "bash", sessionID: "s-team" }, { args: { command: "cmd /c set" } }), /category=bash-env-command/, "cmd-head dump: hard throw")
    // inexpressible env shapes stay hard even while registered
    await assert.rejects(hook({ tool: "bash", sessionID: "s-team" }, { args: { command: "$(printenv)" } }), /bash-env/, "command substitution stays hard when armed")
    await assert.rejects(hook({ tool: "bash", sessionID: "s-team" }, { args: { command: "echo $HOME" } }), /bash-env-expansion/, "ALLCAPS expansion stays hard when armed")
    await assert.rejects(hook({ tool: "bash", sessionID: "s-team" }, { args: { command: "cat .env" } }), /env-file-path/, "env-file read stays hard when armed")
    // the governed tm_bash channel NEVER defers (no dialog ever opens for it)
    await assert.rejects(hook({ tool: "tm_bash", sessionID: "s-team" }, { args: { command: "printenv PATH" } }), /bash-env-command/, "tm_bash stays hard regardless of the dialog")
    // degraded gate: registered session defers nothing
    gate.dispose()
    await assert.rejects(hook({ tool: "bash", sessionID: "s-team" }, { args: { command: "printenv PATH" } }), /category=bash-env-command/, "disposed gate: back to hard throw")
  }

  // 7i. end-to-end through server(): gate + real-host event routing +
  // session registration via message.updated (the live pre-tool channel)
  {
    const root7 = fs.mkdtempSync(path.join(os.tmpdir(), "envp-gate-"))
    try {
      delete process.env.TM_ENV_PROTECT
      // this-requiring host mocks (anti-unbind teeth, cf. 7f): an unbound
      // SDK call inside the gate would throw inside these mocks — and the
      // capableLogs assertion below proves the bound audit path is live
      const capableLogs = []
      const capableApp = {
        log(req) {
          if (this !== capableApp) throw new TypeError("SDK app.log called unbound (this lost)")
          capableLogs.push(String(req?.body?.message ?? ""))
        },
      }
      const capable = {
        app: capableApp,
        postSessionIdPermissionsPermissionId() {
          if (this !== capable) throw new TypeError("SDK reply endpoint called unbound (this lost)")
          return Promise.resolve({ data: true })
        },
      }
      const hooks = await plugin.server({ directory: root7, client: capable }, {})
      assert.equal(typeof hooks.event, "function", "event hook wired when the gate is armed")
      assert.equal(typeof hooks["chat.message"], "function", "chat.message registration hook wired")
      assert.equal(typeof hooks.dispose, "function", "dispose hook wired")
      await hooks.config({}) // the loader runs config() before any prompt
      // (a) exec-role user message registers BEFORE the session's first tool
      await hooks.event({ event: { type: "message.updated", properties: { info: { id: "m1", sessionID: "ses-msg", role: "user", agent: "implementer", time: { created: 1 } } } } })
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses-msg" }, { args: { command: "printenv PATH" } }) // deferred, no throw
      // (b) an env-classified asked event registers on its own
      await hooks.event({ event: { type: "permission.asked", properties: { id: "per-b", sessionID: "ses-ask", permission: "bash", patterns: ["printenv PATH"], metadata: { command: "printenv PATH" } } } })
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses-ask" }, { args: { command: "Get-ChildItem env:PATH" } }) // deferred
      assert.ok(
        capableLogs.some((l) => l.endsWith(":: bash :: env :: ask")),
        "asked audit reaches app.log through the full plugin wiring (SDK binding survives end-to-end)",
      )
      // (c) chat.message route
      await hooks["chat.message"]({ sessionID: "ses-chat", agent: "tester" }, { message: {}, parts: [] })
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses-chat" }, { args: { command: "set" } }) // deferred
      // (d) STOCK agent prompt never registers -> hard throw (C1 closed)
      await hooks.event({ event: { type: "message.updated", properties: { info: { id: "m2", sessionID: "ses-stock", role: "user", agent: "build", time: { created: 1 } } } } })
      await assert.rejects(
        hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses-stock" }, { args: { command: "printenv PATH" } }),
        /category=bash-env-command/,
        "stock build session: expressible env read still hard-throws (no dialog behind it)",
      )
      // (e) danger-only asked does NOT register env deferral
      await hooks.event({ event: { type: "permission.asked", properties: { id: "per-d", sessionID: "ses-danger", permission: "bash", patterns: ["rm gone.txt"], metadata: { command: "rm gone.txt" } } } })
      await assert.rejects(
        hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses-danger" }, { args: { command: "printenv" } }),
        /category=bash-env-command/,
        "an rm dialog proves nothing about env asks — stays hard",
      )
      // inexpressible + tm_bash unaffected by any registration
      await assert.rejects(hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses-msg" }, { args: { command: "cat .env" } }), /env-file-path/, "capable client still hard-blocks inexpressible env reads")
      await assert.rejects(hooks["tool.execute.before"]({ tool: "tm_bash", sessionID: "ses-msg" }, { args: { command: "printenv" } }), /bash-env-command/, "tm_bash stays hard with a capable client")
      // (f) an UNREGISTERED ask type (message.part.updated) must not throw
      await hooks.event({ event: { type: "message.part.updated", properties: { part: { id: "pp" } } } })
      hooks.dispose()
      // mode=off + capable client -> no gate armed: env reads pass (R6 off) and nothing is timed
      process.env.TM_ENV_PROTECT = "off"
      let offReplies = 0
      const offApp = { log() { if (this !== offApp) throw new TypeError("SDK app.log called unbound (this lost)") } }
      const capableOff = {
        app: offApp,
        postSessionIdPermissionsPermissionId() {
          if (this !== capableOff) throw new TypeError("SDK reply endpoint called unbound (this lost)")
          offReplies++
          return Promise.resolve({ data: true })
        },
      }
      const hooksOff = await plugin.server({ directory: root7, client: capableOff }, {})
      await hooksOff.event({ event: { type: "permission.asked", properties: { id: "z", sessionID: "s", permission: "bash", patterns: ["printenv PATH"], metadata: { command: "printenv PATH" } } } })
      await hooksOff["tool.execute.before"]({ tool: "bash", sessionID: "s" }, { args: { command: "printenv" } }) // off -> passes, un-timed
      assert.equal(offReplies, 0, "off mode arms no timer (no auto-reject fires)")
      hooksOff.dispose()
    } finally {
      fs.rmSync(root7, { recursive: true, force: true })
      delete process.env.TM_ENV_PROTECT
    }
  }

  // 7i2. dead-popup guard (round-fix item 7): with NO reply-capable client
  // the gate cannot arm -> the config hook omits the R6 env ask face (every
  // env read would hard-throw behind an unsatisfiable dialog), keeps R2.
  {
    const root7b = fs.mkdtempSync(path.join(os.tmpdir(), "envp-nogate-"))
    try {
      delete process.env.TM_ENV_PROTECT
      const hooksNo = await plugin.server({ directory: root7b, client: { app: { log() {} } } }, {})
      const cfgNo = {}
      await hooksNo.config(cfgNo)
      const bashNo = cfgNo.agent.team.permission.bash
      assert.equal(bashNo["*"], "allow", "no-gate host still keeps the T2.1 grant")
      assert.equal(bashNo["printenv *"], undefined, "no R6 env ask face while the gate cannot arm")
      assert.equal(bashNo["Get-ChildItem env:*"], undefined, "PS drive face off too")
      assert.equal(bashNo["rm *"], "ask", "R2 danger face independent of the gate")
      // and deferral is impossible: expressible env reads hard-throw
      await assert.rejects(
        hooksNo["tool.execute.before"]({ tool: "bash", sessionID: "s" }, { args: { command: "printenv PATH" } }),
        /category=bash-env-command/,
        "un-armed host: expressible env read still hard-throws",
      )
      assert.equal(typeof hooksNo["chat.message"], "function", "registration hook harmless without a gate")
      await hooksNo["chat.message"]({ sessionID: "s", agent: "tester" }, { message: {}, parts: [] }) // no crash
      hooksNo.dispose()
    } finally {
      fs.rmSync(root7b, { recursive: true, force: true })
    }
  }

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

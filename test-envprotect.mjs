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

console.log("\nALL ENV-PROTECT TESTS PASSED ✅")

/**
 * R6 — code-level environment-variable read protection for Team mode.
 *
 * HUMAN-approved feature: in Team mode, EVERY path the model can use to
 * read environment variables / env files is intercepted in code, before
 * the tool runs, independent of prompt compliance. This hook throws inside
 * `tool.execute.before`, which opencode (verified live on 1.18.29) turns
 * into a failed tool call whose error text is returned to the model — so
 * the block is hard, not advisory.
 *
 * Surfaces covered (bash + PowerShell dialects, matched against the bash
 * tool's `args.command`, and against path-class args of the read / grep /
 * glob / list tools):
 *   1. explicit env commands: `env` — a dump whenever no outside command
 *      word follows: flags/assignments only (`env -0`, `env -u HOME`,
 *      `env FOO=bar`) or a command word that is itself `env`/`printenv`
 *      (`env printenv`); a real launcher (`env node app.js`, `env -i node
 *      app.js`) passes — `printenv`, bare `set` (sh context only —
 *      PowerShell `Set-*` cmdlets are never matched), `declare -p` and
 *      its dump synonyms `typeset -p` / `export -p` / `local -p` (flags
 *      may be split: `declare -x -p FOO`), and the PowerShell `env:`
 *      drive via Get-ChildItem / gci / dir / ls / Get-Item / gi /
 *      Get-Content / gc / cat / type (flags and optional quotes allowed
 *      between cmdlet and drive: `Get-Content 'env:HOME'`).  The same
  *      statement heads are caught behind statement noise: subshells and
  *      groups (`(env)`, `{ env; }`), escaped commands (`\env`), the `time`
  *      keyword prefix, command substitution (`$(printenv)`, backticks), the
  *      program-path twins of the dump heads (bare `/usr/bin/env` = full
  *      dump, `/usr/bin/printenv …`), and the Windows launcher head
  *      (`cmd /c set` = cmd.exe's own caseless full dump; `/k` and quoted
  *      inners included).
 *   2. `$env:` / `${env:...}` expansion (PowerShell);
 *   3. strict mode only: `${VAR}` and `$ALLCAPS_VAR` expansion;
 *   4. env-file paths: `.env`, `.env.*`, `*.env`, `.bashrc`,
 *      `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`
 *      (checked-in template copies like `.env.example` are exempt, and
 *      code identifiers like `process.env` are not files).
 *
 * TeamMode's own tm_* tools (tm_read / tm_grep / tm_bash) are aliased onto
 * read/grep/bash in `inspectToolCall`, so this interception covers them
 * identically — the plugin tools can never serve as an R6 bypass.
 *
 * Known limitation (accepted, documented): interpreter execution paths —
 * `bash -c "env"`, `node -e 'process.env'`, `python -c "import os; ..."` —
 * are NOT intercepted; the pattern surface stops at the command line
 * itself.  One decode pass covers URL-encoded names (`/%2Eenv`); a double
 * encoding (`/%252Eenv`) and a quoted dump head behind `env`
 * (`env 'printenv'`) stay ahead of the matcher by design.
 *
 * Configuration (read by the PLUGIN at startup — this is program-level
 * configuration of the tool itself, the same category as the ttlDays
 * option below; it is NOT what R6 defends against, which is the MODEL
 * reading environment variables through tool calls at runtime):
 *   - plugin option `envProtect` (v1.5.4, default FALSE) gates the whole
 *     feature: without opting in, nothing intercepts, no gate arms, no
 *     audit lines are written.  When opted in:
 *   - `TM_ENV_PROTECT`       = "strict" (default) | "standard" | "off";
 *     unknown values fail closed into strict.
 *   - `TM_ENV_PROTECT_EXTRA_DENY` = semicolon-separated user regexes,
 *     applied to every scanned string in any non-off mode.
 *
 * Audit red line (HUMAN privacy constraint): every interception is logged
 * via `client.app.log()` (level "warn", service "team-mode-env-protect")
 * recording ONLY the tool name and the pattern category. Command text,
 * paths, variable names and values are NEVER logged — the audit trail must
 * answer "what class of read was blocked", and must not become a place
 * where secrets accumulate.
 */

/** Audit log service identifier (also the query key for "what was blocked"). */
export const ENV_PROTECT_SERVICE = "team-mode-env-protect"

/**
 * Fixed structured message returned to the model on every block.  The
 * category is appended as a machine-readable suffix; tests pin both.
 */
export const ENV_PROTECT_MESSAGE =
  "TeamMode R6 env protection: 环境变量读取已被拦截。需要变量值请向 HUMAN 申请。"

/** Pattern categories surfaced in the block message and the audit log. */
export const CATEGORY_BASH_ENV_COMMAND = "bash-env-command"
export const CATEGORY_BASH_ENV_EXPANSION = "bash-env-expansion"
export const CATEGORY_ENV_FILE_PATH = "env-file-path"
export const CATEGORY_EXTRA_DENY = "extra-deny"

/* ------------------------------------------------------------------ */
/*  Unified approval gate — host-native `ask` pattern sets (Layer 1)   */
/* ------------------------------------------------------------------ */
/**
 * Two faces are routed to the OpenCode official confirmation dialog by
 * declaring them `ask` in each agent's bash permission object.  The host
 * pops a dialog for any command matching one of these patterns and SUSPENDS
 * it: a human reply ("once"/"always") runs the command, a "reject" or NO
 * REPLY is handled by the approval timer (Layer 2, see approval-gate.ts)
 * which auto-REJECTS after TM_ASK_TIMEOUT_MIN.  The plugin NEVER self-allows.
 *
 * These are the shapes a wildcard CAN express (head-anchored globs, matching
 * the probe-verified grammar: `printenv*`, `rm *`, `Get-ChildItem env:*`).
 * Wildcards CANNOT express (embedded `${VAR}` / `$ALLCAPS` / `$env:` inside
 * another command, command substitution `$(printenv)`, subshell/escaped/
 * `time`-prefixed heads, `VAR=… env` assignment prefixes, split `declare -xp`,
 * env-file paths at arbitrary positions) stay the classifier's HARD THROW —
 * that is the `isAskGatedEnvCommand` boundary, kept in lockstep with the
 * classifier so a form we stop throwing on is exactly a form the dialog shows.
 */

/** R6 env face — the wildcard-expressible environment-variable reads. */
export const R6_ENV_BASH_ASK: Readonly<Record<string, "ask">> = Object.freeze({
  printenv: "ask",
  "printenv *": "ask",
  env: "ask",
  "env *": "ask",
  set: "ask",
  "export -p": "ask",
  "export -p *": "ask",
  "declare -p": "ask",
  "declare -p *": "ask",
  "typeset -p": "ask",
  "typeset -p *": "ask",
  "local -p": "ask",
  "local -p *": "ask",
  "$env:*": "ask",
  "Get-ChildItem env:*": "ask",
  "gci env:*": "ask",
  "dir env:*": "ask",
  "ls env:*": "ask",
  "Get-Item env:*": "ask",
  "gi env:*": "ask",
  "Get-Content env:*": "ask",
  "gc env:*": "ask",
  "cat env:*": "ask",
  "type env:*": "ask",
})

/** R2 danger face — destructive / publishing / network / install / process /
 *  privilege commands.  Independent of TM_ENV_PROTECT (R2 is its own red
 *  line); the built-in bash tool stays `allow` for everything else, so the
 *  normal verification stack (npm test, tsc, git status/diff) never pops. */
export const R2_DANGER_BASH_ASK: Readonly<Record<string, "ask">> = Object.freeze({
  // deletion
  rm: "ask",
  "rm *": "ask",
  rmdir: "ask",
  "rmdir *": "ask",
  rd: "ask",
  "rd *": "ask",
  del: "ask",
  "del *": "ask",
  Erase: "ask",
  "Erase *": "ask",
  "Remove-Item *": "ask",
  "Remove-Item": "ask",
  // git publish (bare forms too — `git push` / `git commit` WITHOUT args are
  // the shapes the arg-carrying globs cannot match)
  "git push *": "ask",
  "git push": "ask",
  "git commit *": "ask",
  "git commit": "ask",
  // network
  curl: "ask",
  "curl *": "ask",
  "wget *": "ask",
  "Invoke-WebRequest *": "ask",
  "Invoke-RestMethod *": "ask",
  // package management
  "npm install *": "ask",
  "npm i *": "ask",
  "npm publish *": "ask",
  "npm publish": "ask",
  "pip install *": "ask",
  "pip3 install *": "ask",
  "winget *": "ask",
  "choco *": "ask",
  // process / system
  "taskkill *": "ask",
  "Stop-Process *": "ask",
  "kill *": "ask",
  "shutdown *": "ask",
  "format *": "ask",
  // privilege
  "chmod *": "ask",
  "takeown *": "ask",
  "icacls *": "ask",
})

/** Ordered key lists (frozen) — single source for the matcher + the gate. */
export const R6_ENV_BASH_ASK_PATTERNS: readonly string[] = Object.freeze(
  Object.keys(R6_ENV_BASH_ASK),
)
export const R2_DANGER_BASH_ASK_PATTERNS: readonly string[] = Object.freeze(
  Object.keys(R2_DANGER_BASH_ASK),
)

/**
 * The bash permission object injected into the four execution-role agents
 * (team / implementer / reviewer / tester).  Default stays `allow`
 * (`"*": "allow"`, preserving the T2.1 matrix semantics — bash is granted,
 * not removed); only the listed shapes escalate to the host dialog.  The R6
 * env face is dropped when `mode === "off"` (the R6 kill switch) AND when
 * `envFace` is false — index.ts passes false while the approval gate cannot
 * arm: the R6 hook then hard-throws every env read BEFORE its dialog could
 * ever satisfy it, so injecting the env asks would only create dead popups
 * a human can answer yet never make runnable.  The R2 face is always
 * present (its dialog is the whole gate — no code-level throw is involved).
 */
export function bashAskPatterns(mode: EnvProtectMode, envFace = true): Record<string, string> {
  const out: Record<string, string> = { "*": "allow" }
  if (mode !== "off" && envFace) {
    for (const p of R6_ENV_BASH_ASK_PATTERNS) out[p] = "ask"
  }
  for (const p of R2_DANGER_BASH_ASK_PATTERNS) out[p] = "ask"
  return out
}

export type EnvProtectMode = "strict" | "standard" | "off"

/**
 * Resolve the protection mode.  Only exact "standard" / "off" switch those
 * modes on; everything else (unset, typos, wrong case) fails CLOSED into
 * strict — a mistyped opt-out must never disable the red line.
 */
export function resolveEnvProtectMode(raw: unknown): EnvProtectMode {
  if (raw === "standard") return "standard"
  if (raw === "off") return "off"
  return "strict"
}

/**
 * Parse `TM_ENV_PROTECT_EXTRA_DENY` (semicolon-separated regex bodies).
 * Invalid regexes are skipped rather than crashing plugin startup; the
 * remaining rules still apply.  Empty/absent input yields no extra rules.
 */
export function parseExtraDeny(raw: unknown): RegExp[] {
  if (typeof raw !== "string") return []
  const rules: RegExp[] = []
  for (const part of raw.split(";")) {
    const body = part.trim()
    if (!body) continue
    try {
      rules.push(new RegExp(body))
    } catch {
      /* user regex failed to compile — skip it, keep the rest */
    }
  }
  return rules
}

/** The block error handed back to the model (fixed text + category tag). */
export function envProtectError(category: string): Error {
  return new Error(`${ENV_PROTECT_MESSAGE} [category=${category}]`)
}

// ---------- env-file path matching ----------

/** Shell/rc basenames whose content is effectively an env dump. */
const ENV_FILE_BASENAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
])

/** Checked-in template suffixes — documentation copies, not real secrets. */
const ENV_TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist)$/

/**
 * Code identifiers that merely end in ".env" and name an object, not a
 * file (`process.env`, `import.meta.env`, ...).  The escaped form is
 * listed too because a grep pattern like `process\.env` survives
 * tokenization with its backslash.
 */
const ENV_IDENTIFIER = /^(?:process|deno|bun|os|import\.meta)\.env$/i

/**
 * True when the value points at an env file.  Matches on the BASENAME with
 * both separators handled; URL query/fragment tails are cut first so
 * `https://x/.env?raw=1` matches the same basename as a plain path, and
 * asterisks are stripped so glob patterns like "*.env" or a recursive deep
 * form of ".env.local" are caught by the same matcher as real paths.
 * (Note: glob spellings are written without backticks here — a double-star
 * + slash inside JSDoc would close the comment block early.)
 */
export function isEnvFilePath(raw: string): boolean {
  const value = String(raw ?? "")
    // one percent-decode pass FIRST, so URL-encoded names like
    // `https://x/%2Eenv` land on the same basename as the plain path
    // (single pass only: `%252E` decodes to `%2E` and stays encoded)
    .replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[?#].*$/, "")
    .replace(/\*/g, "")
    .trim()
  if (!value) return false
  // A code identifier like `process.env` is not a file path, however it is
  // segmented.  The unescaped form matters because a grep pattern spelled
  // `process\.env` would otherwise split at the backslash into path +
  // basename `.env` and slip past the identifier check below.
  if (ENV_IDENTIFIER.test(value) || ENV_IDENTIFIER.test(value.replace(/\\/g, ""))) {
    return false
  }
  const segments = value.split(/[\\/]/)
  const base = (segments[segments.length - 1] || "").toLowerCase()
  if (!base) return false
  if (base === ".env") return true
  if (base.startsWith(".env.")) {
    // `.env.example` and friends are safe checked-in documentation
    if (ENV_TEMPLATE_SUFFIX.test(base)) return false
    return true
  }
  if (base.endsWith(".env")) {
    if (ENV_IDENTIFIER.test(base) || ENV_IDENTIFIER.test(base.replace(/\\/g, ""))) {
      return false
    }
    return true
  }
  return ENV_FILE_BASENAMES.has(base)
}

// ---------- bash command classification ----------

/**
 * Split a command into shell segments so compound statements like
 * `cd /x && printenv` are checked at every statement boundary.
 */
function splitSegments(command: string): string[] {
  return command.split(/&&|\|\||[;\n|&]/)
}

/**
 * First token + remainder of one segment.  Statement noise is peeled off
 * until stable so the real statement head surfaces: subshell/group
 * openers and closers (`(env)`, `{ env; }`), escaped commands (`\env`),
 * and the `time` keyword prefix (`time (env)` needs two passes).  Leading
 * `VAR=value` assignment prefixes are skipped so `FOO=1 env` is still
 * recognized as an env dump.
 */
function commandToken(segment: string): { token: string; rest: string } {
  let s = segment.trim()
  for (;;) {
    for (;;) {
      const next = s
        .replace(/^[({\\]+/, "")
        .replace(/[)}]+$/, "")
        .replace(/^time\s+/, "")
        .trim()
      if (next === s) break
      s = next
    }
    const sp = s.search(/\s/)
    const token = sp === -1 ? s : s.slice(0, sp)
    const isAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
    if (!isAssignment) return { token, rest: sp === -1 ? "" : s.slice(sp).trim() }
    s = sp === -1 ? "" : s.slice(sp).trim()
    if (!s) return { token: "", rest: "" }
  }
}

/**
 * env options whose value is a SEPARATE token (GNU env: `-u NAME`,
 * `-S STRING`, `-C DIR`, long spellings included) — without this table the
 * value token would be mistaken for the launched command word and a dump
 * like `env -u HOME` would pass as a launcher.
 */
const ENV_VALUE_OPTS = new Set(["u", "s", "c", "--unset", "--split-string", "--chdir"])

/**
 * Classify the argument tail of an `env` invocation.  True (dump) when no
 * outside command word remains: a bare `env`, flags/assignments only
 * (`env -0`, `env -i`, `env -u HOME`, `env FOO=bar`), or when the command
 * word is itself `env`/`printenv` (`env printenv`, `env -i env`) — the
 * single-token bypass of the bare-dump rule.  A real launcher — the first
 * non-flag, non-assignment token names any other program (`env node
 * app.js`, `env -i node app.js`) — returns false and stays allowed.
 */
function envRestIsDump(rest: string): boolean {
  const tokens = rest.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
    if (token.startsWith("-")) {
      const shortTakesValue =
        /^-[a-z0-9]+$/i.test(token) &&
        [...token.slice(1)].some((ch) => ENV_VALUE_OPTS.has(ch.toLowerCase()))
      if ((shortTakesValue || ENV_VALUE_OPTS.has(token.toLowerCase())) && i + 1 < tokens.length) {
        i++
      }
      continue
    }
    const cmd = token.toLowerCase()
    return cmd === "env" || cmd === "printenv"
  }
  return true
}

/**
 * Statement-head env dumps.  Case matters for `set`: the exact lowercase
 * bare `set` (no arguments) is the sh builtin that prints every variable,
 * while PowerShell `Set-*` cmdlets and `set -euo pipefail` style flags are
 * never variable dumps and must pass.  `env`/`printenv` are matched
 * case-insensitively AND path-agnostically: the basename decides, so the
 * formerly double-blind path heads are covered too — a bare `/usr/bin/env`
 * (or `./env`) is the SAME full dump as bare `env`, and `/usr/bin/printenv`
 * (with or without vars) the same read as bare `printenv`; `env <command>`
 * keeps its launcher/dump boundary via envRestIsDump either way
 * (`/usr/bin/env node app.js` still passes, bare `/usr/bin/env` throws —
 * the dialog grammar cannot express path heads, so these stay hard).
 * `declare -p` prints variable definitions in reusable form, and so do its
 * synonyms `typeset -p` / `export -p` / `local -p` — with the flag allowed
 * to be split from `-p` by one other option (`declare -x -p FOO`).
 */
function isEnvDumpStatement(token: string, rest: string): boolean {
  if (!token) return false
  const lower = token.toLowerCase()
  // program-path heads resolve by basename (`/usr/bin/env`, `C:\bin\printenv`)
  const base = lower.split(/[\\/]/).pop() || lower
  if (base === "env") return envRestIsDump(rest)
  if (base === "printenv") return true
  if (base === "declare" || base === "typeset" || base === "export" || base === "local") {
    return /^\s*(?:-[a-z]+\s+)?-[a-z]*p[a-z]*\b/.test(` ${rest}`)
  }
  if (token === "set") return rest === ""
  return false
}

/**
 * `cmd /c <inner>` / `cmd.exe /k "<inner>"` (case-insensitive — cmd.exe is
 * the Windows shell): the inner string runs as its own cmd statement, so a
 * bare `set` there is the SAME full env dump the sh builtin is — and cmd's
 * `SET` is caseless (no PowerShell `Set-*`-cmdlet confusion is possible
 * inside cmd.exe).  Returns the peeled inner command, or null when the
 * segment head is not a cmd launcher.
 */
function cmdShellInner(token: string, rest: string): string | null {
  if (!/^(?:cmd|cmd\.exe)$/i.test(token)) return null
  const m = /^\/[ck]\s+(.*)$/i.exec(rest.trim())
  if (!m) return null
  let inner = m[1].trim()
  const q = /^(["'])([\s\S]*)\1$/.exec(inner)
  if (q) inner = q[2].trim()
  return inner || null
}

/** PowerShell `env:` drive access without the `$` prefix.  Optional
 *  parameter flags and optional quotes between the cmdlet and the drive
 *  (`Get-Content -Path env:HOME`, `Get-Content 'env:HOME'`, `ls env:`) are
 *  part of the same read. */
const PS_ENV_DRIVE =
  /(?:^|[\s;&|("'`])(?:get-childitem|gci|dir|ls|get-item|gi|get-content|gc|cat|type)\s+(?:-[A-Za-z]+\s+)*['"]?env:/i

/** `$env:` / `${env:...}` expansion (PowerShell), case-insensitive like
 *  the drive itself. */
const PS_ENV_EXPANSION = /\$\{?env:/i

/**
 * Command substitutions that run a command line of their own.  Captured
 * content excludes parens, so there is no nesting and the recursive
 * classification in classifyBashCommand cannot loop.
 */
const COMMAND_SUBSTITUTION = /\$\(([^()]*)\)|`([^`]*)`/g

/** strict-mode brace expansion, e.g. `${HOME}`. */
const BRACE_EXPANSION = /\$\{[^}]*\}/

/** strict-mode bare all-caps variable, e.g. `$API_KEY` (also `$F`, `$_`).
 *  The lookahead pins the END of the identifier so mixed-case names like
 *  `$Path` never match on their capitalized prefix alone. */
const ALLCAPS_EXPANSION = /\$[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])/

/**
 * Tokenize a bash command and report whether any token names an env file —
 * catches `cat .env`, `head -50 .env.local`, `curl https://x/.env`,
 * `X=.env ./run` (the token survives because `=`, `.`, `/`, `:` stay inside
 * tokens).  Quote/glob leftovers are stripped per token.
 */
function bashEnvFileHit(command: string): boolean {
  const tokens = command.split(/[\s'"`|;&<>()]+/)
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^[*'"`]+|[*'"`]+$/g, "")
    if (token && isEnvFilePath(token)) return true
  }
  return false
}

/**
 * Classify a bash/PowerShell command string.  Returns the pattern category
 * when the command must be blocked, null when it may pass.  `off` is
 * handled by the caller; user extra-deny rules take precedence.
 */
export function classifyBashCommand(
  command: string,
  mode: EnvProtectMode,
  extra: RegExp[] = [],
): string | null {
  const text = String(command ?? "")
  if (!text) return null

  for (const rule of extra) {
    if (rule.test(text)) return CATEGORY_EXTRA_DENY
  }

  for (const segment of splitSegments(text)) {
    const { token, rest } = commandToken(segment)
    if (isEnvDumpStatement(token, rest)) return CATEGORY_BASH_ENV_COMMAND
    // `cmd /c <inner>` runs a statement of its own — classify the inner
    // command (covers `cmd /c printenv`, `cmd /c "cat .env"`, …) and add the
    // cmd-case-specific dump heads the sh rules keep case-strict
    const cmdInner = cmdShellInner(token, rest)
    if (cmdInner) {
      const innerCategory = classifyBashCommand(cmdInner, mode, extra)
      if (innerCategory) return innerCategory
      if (!cmdInner.includes("=") && /^set(?:\s|$)/i.test(cmdInner)) {
        return CATEGORY_BASH_ENV_COMMAND // cmd.exe prints env for `set` / `set NAME`
      }
    }
  }

  // command substitution runs its own command line: classify the inner
  // text recursively (`$(printenv) PATH`, backtick `cat .env`)
  for (const match of text.matchAll(COMMAND_SUBSTITUTION)) {
    const inner = match[1] ?? match[2]
    if (!inner) continue
    const innerCategory = classifyBashCommand(inner, mode, extra)
    if (innerCategory) return innerCategory
  }

  if (PS_ENV_DRIVE.test(text)) return CATEGORY_BASH_ENV_COMMAND
  if (PS_ENV_EXPANSION.test(text)) return CATEGORY_BASH_ENV_EXPANSION

  if (mode === "strict") {
    if (BRACE_EXPANSION.test(text)) return CATEGORY_BASH_ENV_EXPANSION
    if (ALLCAPS_EXPANSION.test(text)) return CATEGORY_BASH_ENV_EXPANSION
  }

  if (bashEnvFileHit(text)) return CATEGORY_ENV_FILE_PATH
  return null
}

// ---------- approval-gate deferral predicates ----------

/** Compile `*` into `.*`, escape every other regex metacharacter, anchor. */
function globToRegex(pattern: string, flags: "" | "i"): RegExp {
  let out = ""
  for (const ch of pattern) {
    if (ch === "*") out += ".*"
    else if (".+?^${}()|[]\\".includes(ch)) out += "\\" + ch
    else out += ch
  }
  return new RegExp("^" + out + "$", flags)
}

/**
 * Two spellings of the same glob grammar:
 *  - LOOSE (case-insensitive, trimmed) — dialog IDENTIFICATION only
 *    (categorizePermission): over-matching here can merely arm a timer for a
 *    dialog the host already opened, never let a command run;
 *  - EXACT (byte-for-byte, no trim) — the DEFERRAL side: a command is only
 *    passed through to the dialog when it reproduces the injected config
 *    pattern head exactly, so ANY host matcher at least as greedy as ours
 *    must pop the dialog.  Case/trim leniency on this side would defer forms
 *    like `GET-CONTENT ENV:PATH` that a byte-exact host grammar never pops
 *    — a SILENT env read with no popup.  If the host turns out to be
 *    case-insensitive, exact costs nothing but a few extra hard throws
 *    (fail-closed direction).
 */
const GLOB_CACHE = new Map<string, RegExp>()
function glob(pattern: string, flags: "" | "i"): RegExp {
  const key = flags + pattern
  let re = GLOB_CACHE.get(key)
  if (!re) {
    re = globToRegex(pattern, flags)
    GLOB_CACHE.set(key, re)
  }
  return re
}

/** True when `text` matches ANY of the given ask globs (LOOSE, host-style). */
export function commandMatchesAnyAskPattern(text: unknown, patterns: readonly string[]): boolean {
  const t = String(text ?? "").trim()
  if (!t) return false
  for (const p of patterns) if (glob(p, "i").test(t)) return true
  return false
}

/** Byte-exact deferral-side match (see the GLOB_CACHE note above). */
function commandMatchesAnyAskPatternExact(
  text: string,
  patterns: readonly string[],
): boolean {
  if (!text) return false
  for (const p of patterns) if (glob(p, "").test(text)) return true
  return false
}

/**
 * True when a built-in-bash command is an environment read in a form the
 * host is configured to ASK about (and therefore the dialog governs it).
 * The hook then lets it proceed WITHOUT throwing, so a human approval is
 * meaningful.  Kept deliberately narrower than classifyBashCommand: every
 * form it accepts is a head-anchored single statement that matches one of
 * R6_ENV_BASH_ASK BYTE-EXACTLY (so the dialog WILL fire under any host
 * grammar at least as greedy as ours — no case/trim leniency, see
 * commandMatchesAnyAskPatternExact), and every hazard that breaks that
 * alignment (compound statements, substitutions, `${…}`, `$ALLCAPS`,
 * assignment prefixes, `time`/subshell/escaped heads, user extra-deny, path
 * heads like `/usr/bin/env`, `cmd /c …`, and the PowerShell env-drive forms
 * with intervening flags or quotes that the globs miss) returns false → the
 * classifier keeps hard-throwing.  tm_* channels are hard-blocked separately
 * (the dialog never opens for them).
 */
export function isAskGatedEnvCommand(
  command: string,
  mode: EnvProtectMode,
  extra: RegExp[] = [],
): boolean {
  const text = String(command ?? "")
  if (!text.trim()) return false
  for (const r of extra) if (r.test(text)) return false
  // command substitution runs its own line — the outer pattern never matches
  if (/\$\(|`|<\(|>\(/.test(text)) return false
  // ${VAR} brace expansion is wildcard-inexpressible
  if (/\$\{[^}]*\}/.test(text)) return false
  const segs = splitSegments(text).map((s) => s.trim()).filter(Boolean)
  if (segs.length !== 1) return false
  const seg = segs[0]
  // byte-exact head: a VAR=value prefix, stray leading whitespace or any
  // case deviation from the injected pattern fails here and stays hard
  if (!commandMatchesAnyAskPatternExact(text, R6_ENV_BASH_ASK_PATTERNS)) return false
  const { token, rest } = commandToken(seg)
  // classic dump head: printenv / env / set / declare|typeset|export|local -p
  if (isEnvDumpStatement(token, rest)) return true
  // PowerShell env: drive read with no flags between the cmdlet and the
  // drive, spellings byte-identical to the config globs (see the doc above)
  if (/^(?:Get-ChildItem|gci|dir|ls|Get-Item|gi|Get-Content|gc|cat|type)\s+env:/.test(seg)) {
    return true
  }
  // leading `$env:` drive form (matches the `$env:*` config glob)
  if (text.startsWith("$env:")) return true
  return false
}

/**
 * Coarse category for a host permission-event payload, used ONLY to gate the
 * timer, to register the deferral session, and to tag the audit (never the
 * pattern text itself).  Returns null for anything that is not one of OUR
 * injected bash asks, so the gate leaves other tools' dialogs (edit,
 * webfetch, host-native rules) alone.
 *
 * Real 1.18.29 `permission.asked` props carry NO `type` field: the tool name
 * rides in `permission` and the concrete command segments in `patterns[]`
 * (plus `metadata.command` with the raw line).  Inference order, defensive
 * across builds:
 *   1. explicit tool field (`type` || `permission`) — non-bash is a hard no;
 *   2. absent tool field → bash evidence = `metadata.command` present, or a
 *      candidate that is COMMAND-SHAPED (contains whitespace: our command
 *      globs all need an embedded space except bare keys, and bare-key
 *      patterns like a file named `set` cannot prove bash without the
 *      command metadata beside them).
 * Matching here is the LOOSE glob (case-insensitive): over-matching can only
 * arm a timer for a dialog the host already opened, never run a command —
 * the deferral side keeps the byte-exact matcher (isAskGatedEnvCommand).
 */
export function categorizePermission(props: {
  type?: string
  permission?: string
  pattern?: string | string[]
  patterns?: string | string[]
  title?: string
  metadata?: Record<string, unknown>
} | null | undefined): "env" | "danger" | null {
  if (!props) return null
  const type = String(props.type ?? props.permission ?? "").trim().toLowerCase()
  if (type && type !== "bash") return null
  const raw = props.patterns ?? props.pattern
  const list = raw == null ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)]
  const metaCmd = typeof props.metadata?.command === "string" ? props.metadata.command : ""
  const title = typeof props.title === "string" ? props.title : ""
  const candidates = [...list]
  if (metaCmd) candidates.push(metaCmd)
  if (title) candidates.push(title)
  if (!candidates.length) return null
  if (!type) {
    // no tool field at all (live 1.18.29 asked): bash evidence = the bash
    // tool's own metadata.command, or a command-shaped candidate (contains
    // whitespace — every multi-word ask glob needs one; single bare words
    // like a path named `set` prove nothing without metadata beside them)
    if (!metaCmd && !candidates.some((c) => /\s/.test(c))) return null
  }
  const hits = (patterns: readonly string[]) =>
    candidates.some(
      (p) =>
        (patterns as readonly string[]).includes(p) || commandMatchesAnyAskPattern(p, patterns),
    )
  if (hits(R6_ENV_BASH_ASK_PATTERNS)) return "env"
  if (hits(R2_DANGER_BASH_ASK_PATTERNS)) return "danger"
  return null
}


// ---------- file-tool path classification ----------

/**
 * Path-class argument keys scanned defensively across read / grep / glob /
 * list (read uses `filePath`; the others historically use `path`, and
 * `pattern` / `include` select files for glob / grep).  Keys outside this
 * set (descriptions, notes) are never scanned.
 */
const PATH_LIKE_KEYS = /^(filepath|path|file|dir|directory|pattern|include)$/i

/**
 * Classify the path-class arguments of a file tool.  Returns the pattern
 * category when the call must be blocked, null when it may pass.
 */
export function classifyPathFields(
  args: Record<string, unknown> | undefined,
  mode: EnvProtectMode,
  extra: RegExp[] = [],
): string | null {
  if (!args || typeof args !== "object") return null
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || !value) continue
    if (!PATH_LIKE_KEYS.test(key)) continue
    for (const rule of extra) {
      if (rule.test(value)) return CATEGORY_EXTRA_DENY
    }
    if (isEnvFilePath(value)) return CATEGORY_ENV_FILE_PATH
  }
  return null
}

// ---------- tool-call level routing ----------

/** File tools whose path-class arguments are scanned for env files. */
const PATH_SCAN_TOOLS = new Set(["read", "grep", "glob", "list"])

/**
 * TeamMode's own tm_* tools alias onto the built-in surface so the SAME
 * interception applies to them (anti-backdoor: tm_read/tm_grep/tm_bash must
 * never become an R6 bypass by virtue of a different tool name).  The tools
 * ALSO re-check with the same matchers inside their own pipelines — this
 * hook-level alias is the outer defense layer.
 */
const TM_TOOL_ALIASES: Record<string, string> = {
  tm_read: "read",
  tm_grep: "grep",
  tm_bash: "bash",
}

/**
 * Top routing: tool name + tool args -> category to block, or null to pass.
 * `off` always passes (the hook stays installed but is a no-op).
 */
export function inspectToolCall(
  tool: string,
  args: Record<string, unknown> | undefined,
  mode: EnvProtectMode,
  extra: RegExp[] = [],
): string | null {
  if (mode === "off") return null
  const rawName = String(tool ?? "").trim().toLowerCase()
  const name = TM_TOOL_ALIASES[rawName] ?? rawName
  if (name === "bash") {
    const command = (args as { command?: unknown } | undefined)?.command
    return classifyBashCommand(String(command ?? ""), mode, extra)
  }
  if (PATH_SCAN_TOOLS.has(name)) {
    return classifyPathFields(args, mode, extra)
  }
  return null
}

// ---------- hook factory ----------

/** Structural subset of the opencode SDK client used for audit logging. */
interface AuditClient {
  app?: {
    log?: (request: unknown) => unknown | Promise<unknown>
  }
}

/**
 * Best-effort audit of one interception.  Records ONLY the tool name and
 * the pattern category (privacy red line: never command text, paths,
 * variable names or values); the message embeds the service id itself so
 * file-backed log sinks that drop the `service` field stay greppable.  A
 * failing audit endpoint must never turn a block into a pass-through, so
 * every failure is swallowed after the call attempt.
 */
async function auditInterception(
  client: unknown,
  tool: string,
  category: string,
): Promise<void> {
  try {
    // Call the method THROUGH the app object.  Destructuring `app.log`
    // first would drop the SDK's `this` binding, so every real call died
    // inside the SDK and was silently swallowed here — zero audit entries.
    const app = (client as AuditClient | null | undefined)?.app
    if (!app || typeof app.log !== "function") return
    await app.log({
      body: {
        level: "warn",
        service: ENV_PROTECT_SERVICE,
        message: `${ENV_PROTECT_SERVICE} :: ${tool} :: ${category}`,
      },
    })
  } catch {
    /* audit is best-effort; the block below still takes effect */
  }
}

/**
 * Build the `tool.execute.before` hook.  The hook is installed in every
 * mode; with mode "off" it returns immediately and everything passes.
 * When a block triggers, the audit entry is written first, then the fixed
 * structured error is thrown so opencode surfaces it to the model as the
 * failed tool result.
 *
 * `options.deferToApproval` (the unified approval gate) — called with the
 * tool call's `input.sessionID`; when it reports `true`, a built-in-bash
 * environment read in an EXACT ask-glob form is passed through WITHOUT
 * throwing, because the official confirmation dialog is the live gate for
 * it (approve → runs, reject or timeout → the host blocks it).  The signal
 * is SESSION-SCOPED on purpose: the gate registers only sessions carrying
 * our injected bash ask set (exec-role chat.message, or an R6-env-classified
 * `permission.asked`), so a stock build/plan session — where no dialog would
 * ever open for `printenv` — keeps the hard throw instead of slipping the
 * read through a global arm flag.  Reaching the deferral point at all
 * additionally requires the command to match the config globs byte-exactly,
 * so the dialog is GUARANTEED to fire wherever deferral happens.  A failed
 * auto-reject flips the gate back to `false` everywhere, restoring the hard
 * throw (fail-closed).  tm_* channels are never deferred (no dialog opens
 * for them).
 */
export function createEnvProtectHook(
  client: unknown,
  mode: EnvProtectMode,
  extra: RegExp[] = [],
  options: { deferToApproval?: (sessionID?: string) => boolean; envApproved?: (sessionID?: string) => boolean } = {},
): (input: unknown, output: unknown) => Promise<void> {
  return async (input: unknown, output: unknown): Promise<void> => {
    if (mode === "off") return
    const tool = String((input as { tool?: unknown } | null)?.tool ?? "")
    const rawSid = (input as { sessionID?: unknown } | null)?.sessionID
    const sessionID = typeof rawSid === "string" && rawSid.trim() !== "" ? rawSid.trim() : undefined
    const args = (output as { args?: Record<string, unknown> } | null)?.args
    const category = inspectToolCall(tool, args, mode, extra)
    if (!category) return
    // Session-wide env approval ("always" on first env ask) — pass silently;
    // the "always" event itself was already audited by the approval gate.
    // The blanket NEVER covers env-FILE reads (CATEGORY_ENV_FILE_PATH):
    // files on disk (.env, shell rc family) never open a dialog of their
    // own (they are not in the ask-pattern set), so no "always" verdict can
    // have consented to them — they keep hard-throwing even in an
    // env-approved session.
    if (
      sessionID &&
      options.envApproved?.(sessionID) &&
      category !== CATEGORY_ENV_FILE_PATH
    ) {
      return
    }
    // Defer ONLY the built-in bash tool (never its tm_bash alias), ONLY in a
    // registered session, for the exact forms the config escalates to `ask`.
    if (tool.trim().toLowerCase() === "bash" && sessionID && options.deferToApproval?.(sessionID)) {
      const command = (args as { command?: unknown } | undefined)?.command
      if (isAskGatedEnvCommand(String(command ?? ""), mode, extra)) return
    }
    await auditInterception(client, tool, category)
    throw envProtectError(category)
  }
}

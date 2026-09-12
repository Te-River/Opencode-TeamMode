/**
 * R6 — bash/PowerShell command classification (env dumps, expansions,
 * env-file tokens, cmd /c heads, command substitution).  Split out of the
 * former monolithic envprotect.ts; behavior unchanged.
 */

import type { EnvProtectMode } from "./patterns.js"
import {
  CATEGORY_BASH_ENV_COMMAND,
  CATEGORY_BASH_ENV_EXPANSION,
  CATEGORY_ENV_FILE_PATH,
  CATEGORY_EXTRA_DENY,
} from "./patterns.js"
import { isEnvFilePath } from "./path-classify.js"
import { splitShellSegments } from "../shell-text.js"

// statement segmentation is the shared implementation in ../shell-text.ts;
// local name kept for the call sites in this module.
const splitSegments = splitShellSegments

// ---------- bash command classification ----------

/**
 * First token + remainder of one segment.  Statement noise is peeled off
 * until stable so the real statement head surfaces: subshell/group
 * openers and closers (`(env)`, `{ env; }`), escaped commands (`\env`),
 * and the `time` keyword prefix (`time (env)` needs two passes).  Leading
 * `VAR=value` assignment prefixes are skipped so `FOO=1 env` is still
 * recognized as an env dump.
 */
export function commandToken(segment: string): { token: string; rest: string } {
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
export function isEnvDumpStatement(token: string, rest: string): boolean {
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

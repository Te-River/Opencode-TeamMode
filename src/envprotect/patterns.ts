/**
 * R6/R2 — environment-protection constants, the host-native `ask` pattern
 * sets (Layer 1 of the unified approval gate), and the mode/config parsing.
 * Split out of the former monolithic envprotect.ts; behavior unchanged.
 *
 * These are the shapes a wildcard CAN express (head-anchored globs).  The
 * plugin NEVER self-allows; an unanswered dialog is auto-REJECTED by the
 * approval timer (see approval-gate.ts).
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

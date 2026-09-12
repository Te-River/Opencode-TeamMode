/**
 * Unified approval gate — deferral predicates.  The byte-exact vs loose glob
 * split: LOOSE (case-insensitive, trimmed) identifies dialogs for the gate;
 * BYTE-EXACT governs deferral, so a command is only passed through when the
 * host dialog is GUARANTEED to fire.  Split out of the former monolithic
 * envprotect.ts; behavior unchanged.
 */

import type { EnvProtectMode } from "./patterns.js"
import { R2_DANGER_BASH_ASK_PATTERNS, R6_ENV_BASH_ASK_PATTERNS } from "./patterns.js"
import { commandToken, isEnvDumpStatement } from "./bash-classify.js"
import { splitShellSegments } from "../shell-text.js"

// local alias for the shared segmentation (call sites below)
const splitSegments = splitShellSegments

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


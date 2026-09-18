/**
 * Host-hook leverage beyond the tool surface (2026-09-18 audit follow-up).
 *
 * Everything here rides an ALREADY-PUBLISHED plugin hook — no host source is
 * touched — and each knob is independently switchable, because this host's
 * d.ts has promised surfaces the runtime never delivered (`permission.ask`
 * is declared and never fires on 1.18.29/30). So: pure decisions in one
 * place, adapters that never throw and never mutate unless the payload has
 * the exact shape we verified.
 *
 * The four hooks implemented here:
 *   - `tool.definition`                → append OUR discipline to a built-in
 *     tool's OWN description, where the model decides (a bash timeout rule
 *     buried in a system prompt loses to one printed next to the parameter);
 *   - `chat.params`                    → per-agent sampling overrides
 *     (off by default: "all agents at 0.2" is a documented project
 *     invariant, so changing it is the user's call, not ours);
 *   - `experimental.session.compacting`
 *     + `experimental.compaction.autocontinue` → keep the reply skeleton and
 *     the handle rules ALIVE across a compaction, instead of letting the
 *     summarizer invent its own contract;
 *   - `shell.env`                      → NO_COLOR/TERM=dumb for every child
 *     shell (ANSI escapes in npm/cargo/pytest output are pure context
 *     tokens), plus an explicit operator passthrough.
 *
 * Deliberately NOT here: `experimental.chat.messages.transform`. Rewriting
 * the outgoing message array means guessing the live shape of tool results
 * at that layer; a wrong guess silently deletes the evidence the EVIDENCE
 * line depends on. It needs a live host probe first, not a plausible patch.
 */

export const HOOK_ENV_DEFAULTS = {
  toolHints: "on",
  agentTemperature: "off",
  compactionContext: "on",
  compactionAutoContinue: "on",
  shellNoColor: "on",
} as const

type EnvLike = Record<string, string | undefined>
const isOn = (raw: string | undefined, def: string): boolean => {
  const v = String(raw ?? "").trim().toLowerCase()
  if (v === "") return def === "on"
  return !(v === "off" || v === "0" || v === "false" || v === "no")
}

/** The on/off switches the plugin entry needs before building adapters. */
export function hookSwitches(env: EnvLike = process.env): { toolHints: boolean; compactionContext: boolean } {
  return {
    toolHints: isOn(env.TM_TOOL_HINTS, HOOK_ENV_DEFAULTS.toolHints),
    compactionContext: isOn(env.TM_COMPACTION_CONTEXT, HOOK_ENV_DEFAULTS.compactionContext),
  }
}

/* ---------- tool.definition ---------- */

/**
 * Footers appended to a built-in tool's description, keyed by tool id.
 * Short, imperative, and about THIS plugin's guarantees — the point is that
 * the model reads it at the call site, not thousands of tokens earlier.
 */
export const TOOL_HINTS: Record<string, string> = {
  bash:
    "\n\n[OpenCode TeamMode] Time discipline: leave `timeout` out unless this step is genuinely slow — the default kill is 120 s and a bigger number only lengthens the silence, a read-only probe (ls/grep/rg/cat/Get-ChildItem) is never a 120-second command (values above the probe ceiling are clamped before the command runs). Independent steps do NOT belong chained with `;` into one call — separate calls, or one tm_ptc_run program.",
  task:
    "\n\n[OpenCode TeamMode] This blocks your session until the child returns. For independent work that must overlap your own, prefer tm_dispatch (returns at once) + tm_join (collect) and keep the brief self-contained.",
}

/**
 * The `tool.definition` adapter. Returns true when it appended (so the
 * caller can log it). Idempotent: a re-issued description that already
 * carries the marker is left byte-exact, and the host description is never
 * replaced — only extended.
 */
export function applyToolDefinition(
  input: unknown,
  output: unknown,
  enabled = true,
): boolean {
  if (!enabled) return false
  try {
    const toolID = String((input as { toolID?: unknown } | null)?.toolID ?? "").trim().toLowerCase()
    const key = Object.keys(TOOL_HINTS).find((k) => toolID === k || toolID.endsWith(`:${k}`) || toolID.endsWith(`/${k}`))
    if (!key) return false
    const out = output as { description?: unknown } | null | undefined
    if (!out || typeof out.description !== "string") return false
    const marker = "[OpenCode TeamMode]"
    if (out.description.includes(marker)) return false
    out.description = out.description + TOOL_HINTS[key]
    return true
  } catch {
    return false
  }
}

/* ---------- chat.params ---------- */

/**
 * Sampling per role, ONLY when the operator opts in. architect is the one
 * role whose job (design alternatives) genuinely suffers at 0.2; the
 * mechanical roles stay cold — a specialist that hallucinates a file path
 * costs the whole team a round.
 */
export const AGENT_TEMPERATURES: Record<string, number> = {
  architect: 0.35,
  researcher: 0.3,
  team: 0.2,
  implementer: 0.2,
  reviewer: 0.1,
  tester: 0.2,
}

/**
 * `TM_AGENT_TEMPERATURE` = off | on | `agent=value;agent=value`.
 * Returns the temperature to force, or null to leave the host's value alone.
 * A malformed table resolves to null rather than half-applying garbage.
 */
export function resolveAgentTemperature(agent: unknown, env: EnvLike = process.env): number | null {
  const raw = String(env.TM_AGENT_TEMPERATURE ?? HOOK_ENV_DEFAULTS.agentTemperature).trim().toLowerCase()
  if (raw === "" || raw === HOOK_ENV_DEFAULTS.agentTemperature) return null
  const name = String(agent ?? "").trim().toLowerCase()
  if (!name) return null
  if (raw === "on" || raw === "true" || raw === "1") {
    const t = AGENT_TEMPERATURES[name]
    return typeof t === "number" ? t : null
  }
  const table: Record<string, number> = {}
  for (const part of raw.split(/[;,]/)) {
    const m = /^\s*([a-z0-9_-]{1,24})\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(part)
    if (!m) return null
    const value = Number(m[2])
    if (!Number.isFinite(value) || value < 0 || value > 2) return null
    table[m[1]] = value
  }
  return typeof table[name] === "number" ? table[name] : null
}

/** The `chat.params` adapter: only `temperature` is touched, and only when
 *  this agent has an override. */
export function applyChatParams(input: unknown, output: unknown, env: EnvLike = process.env): boolean {
  try {
    const t = resolveAgentTemperature((input as { agent?: unknown } | null)?.agent, env)
    if (t === null) return false
    const out = output as { temperature?: unknown } | null | undefined
    if (!out || typeof out.temperature !== "number") return false
    out.temperature = t
    return true
  } catch {
    return false
  }
}

/* ---------- compaction ---------- */

/**
 * Context lines handed to the host's compaction summarizer
 * (`experimental.session.compacting` → `output.context[]`).  We ADD to the
 * default prompt and never replace it: setting `output.prompt` would void
 * whatever the host itself learns to preserve, and the summarizer would stop
 * being the host's.
 *
 * Each line corresponds to a thing that, once summarized away, cannot be
 * re-derived without spending a round to rediscover it:
 *   - the reply skeleton — prose instead of STATUS:/CHANGES/… makes the
 *     lead's machine check fail for the rest of the session;
 *   - offload handles (ref/access_token/expire_at) — they are the ONLY
 *     window onto a payload that never entered context;
 *   - child session ids from tm_dispatch — an uncollected dispatch is
 *     running work, and after a summary it looks indistinguishably like done
 *     work;
 *   - provenance (file:line / URL + confidence) — without it a finding
 *     degrades into model memory, the one thing this project refuses;
 *   - the todo list and board paths — the state lives there, not in chat.
 */
export const COMPACTION_CONTEXT = [
  "OpenCode TeamMode contract survives compaction: every specialist reply keeps the STATUS / CHANGES / FINDINGS / EVIDENCE / HANDOFF skeleton and the lead machine-checks it — never summarize a reply into prose without those keys.",
  "Offloaded payloads are addressed by handle (ref + access_token + expire_at) from tm_* results. Carry the handles forward VERBATIM; never re-run a tool to rediscover a payload a handle already names.",
  "Async dispatches (tm_dispatch) and their child session ids must survive: an uncollected child is still-running work, not finished work.",
  "Every finding keeps its source (file:line or URL) and confidence tag after compaction, otherwise it is unverifiable memory.",
  "The todo list and the blackboard files are the state, not the transcript: keep task items and board paths, drop chit-chat and raw command echo.",
]

/** The `experimental.session.compacting` adapter — additive, idempotent. */
export function applySessionCompacting(output: unknown, enabled = true): boolean {
  if (!enabled) return false
  try {
    const out = output as { context?: unknown } | null | undefined
    if (!out) return false
    if (!Array.isArray(out.context)) out.context = []
    const list = out.context as string[]
    let added = 0
    for (const line of COMPACTION_CONTEXT) {
      if (!list.includes(line)) {
        list.push(line)
        added++
      }
    }
    return added > 0
  } catch {
    return false
  }
}

/**
 * `experimental.compaction.autocontinue`.  Left ALONE by default: the host
 * resuming after a summary is what keeps a long pipeline moving, and
 * stopping mid-flight without being asked is a worse surprise than a
 * continued one.  `TM_COMPACTION_AUTOCONTINUE=off` opts out — then the run
 * pauses for the user to re-read state before anything touches files again.
 */
export function applyCompactionAutoContinue(output: unknown, env: EnvLike = process.env): boolean {
  try {
    if (isOn(env.TM_COMPACTION_AUTOCONTINUE, HOOK_ENV_DEFAULTS.compactionAutoContinue)) return false
    const out = output as { enabled?: unknown } | null | undefined
    if (!out || typeof out.enabled !== "boolean") return false
    out.enabled = false
    return true
  } catch {
    return false
  }
}

/* ---------- shell.env ---------- */

/**
 * Environment for every child shell. NO_COLOR/TERM=dumb is a token saving
 * with no functional cost (an agent reading a progress bar reads nothing),
 * and `TM_SHELL_ENV` is the explicit operator passthrough (`K=V;K2=V2`) —
 * deliberately allowlisted rather than forwarding process env, so this hook
 * can never become a side channel for secrets into a sub-agent's shell.
 */
export function resolveShellEnv(env: EnvLike = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  if (isOn(env.TM_SHELL_NO_COLOR, HOOK_ENV_DEFAULTS.shellNoColor)) {
    out.NO_COLOR = "1"
    out.CLANG_COLOR_MODE = "never"
    out.TERM = "dumb"
  }
  const raw = String(env.TM_SHELL_ENV ?? "").trim()
  if (raw) {
    for (const part of raw.split(/[;]/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]{0,40})\s*=\s*(.*)$/.exec(part)
      if (!m) continue
      out[m[1]] = m[2].replace(/\s+$/, "")
    }
  }
  return out
}

/** The `shell.env` adapter. Never deletes an existing key the host set. */
export function applyShellEnv(output: unknown, env: EnvLike = process.env): boolean {
  try {
    const patch = resolveShellEnv(env)
    const out = output as { env?: unknown } | null | undefined
    if (!out || Object.keys(patch).length === 0) return false
    if (!out.env || typeof out.env !== "object") out.env = {}
    const target = out.env as Record<string, string>
    let added = 0
    for (const [k, v] of Object.entries(patch)) {
      if (target[k] === undefined) {
        target[k] = v
        added++
      }
    }
    return added > 0
  } catch {
    return false
  }
}

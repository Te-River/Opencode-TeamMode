/**
 * Built-in bash TIMEOUT discipline (issue #6 of 2026-09-18).
 *
 * Where the 120 s comes from: the host's shell tool resolves
 * `flags.bashDefaultTimeoutMs ?? 2 * 60 * 1e3` (verified in the shipped
 * desktop bundle) — so when a model omits `timeout`, 120 s is the HOST
 * default, and models that do pass one routinely pass 120000+ for a
 * `Get-ChildItem`.  Three serialised probes then cost the user six minutes
 * of dead air, and every one of them was allowed to run for a reason no
 * model ever had.
 *
 * The plugin owns no shell timer, so the ONE non-invasive lever is the
 * official `tool.execute.before` hook, whose `output.args` is explicitly
 * mutable.  Two ceilings, both opt-out:
 *   - `TM_BASH_TIMEOUT_PROBE_MS` (default 60 000) — only for a command the
 *     P3 read-only allowlist already accepts (ls / grep / rg / cat /
 *     Get-ChildItem …).  A pure probe has no legitimate reason to outlive
 *     a minute, and this is where the wasted 120 s actually sits.
 *   - `TM_BASH_TIMEOUT_MAX_MS` (default 0 = OFF) — a global cap for
 *     everything else.  Off by default on purpose: a build/test run may
 *     legitimately need minutes, and silently killing one is worse than a
 *     slow one.  A user who wants the ceiling sets it.
 *
 * This clamps a number the model already volunteered; it never ADDS a
 * timeout where the model supplied none (that would turn the host's default
 * into OUR default, which is not this plugin's call to make).
 */

import { classifyReadonlyCommand } from "./guard.js"

export type BashTimeoutVerdict =
  | { changed: false; via: "none" | "already-short" }
  | { changed: true; via: "probe" | "max"; from: number; to: number }

/** Parse the model-supplied timeout defensively: the host schema says a
 *  positive integer of MILLISECONDS, but an LLM hands us `"120000"`,
 *  `120000.0`, or omits it entirely.  Anything unreadable means "no
 *  timeout was supplied" and is left alone. */
export function parseTimeoutArg(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.trunc(raw)
  if (typeof raw === "string") {
    const n = Number(raw.trim())
    if (Number.isFinite(n) && n > 0) return Math.trunc(n)
  }
  return null
}

/**
 * Decide the clamped timeout for one bash call.
 * `probeMs`/`maxMs` of 0 disable that ceiling.
 */
export function resolveBashTimeout(opts: {
  command: string
  timeoutMs: number | null
  probeMs: number
  maxMs: number
  readonlyAllowed: readonly string[]
}): BashTimeoutVerdict {
  const t = opts.timeoutMs
  if (t === null) return { changed: false, via: "none" }
  const probe = opts.probeMs > 0 && classifyReadonlyCommand(opts.command, opts.readonlyAllowed).ok
  if (probe && t > opts.probeMs) return { changed: true, via: "probe", from: t, to: opts.probeMs }
  if (opts.maxMs > 0 && t > opts.maxMs) return { changed: true, via: "max", from: t, to: opts.maxMs }
  if (!probe && opts.maxMs === 0) return { changed: false, via: "none" }
  return { changed: false, via: "already-short" }
}

/**
 * The hook fragment.  Returns true when it mutated `args.timeout` — the
 * caller may log that, and the trajectory keeps a count so a user asking
 * "why did my probe get killed at 60 s?" has an answer.
 *
 * Everything here is defensive by contract: `output.args` is `any` on the
 * host side, a non-bash tool must be untouched, and a malformed payload
 * must never turn into a thrown error inside a permission-adjacent hook.
 */
export function createBashTimeoutHook(deps: {
  probeMs: number
  maxMs: number
  readonlyAllowed: readonly string[]
  onClamp?: (info: { via: string; from: number; to: number }) => void
}): (input: unknown, output: unknown) => boolean {
  return (input: unknown, output: unknown): boolean => {
    try {
      const tool = String((input as { tool?: unknown } | null)?.tool ?? "").trim().toLowerCase()
      if (tool !== "bash") return false
      const args = (output as { args?: Record<string, unknown> } | null)?.args
      if (!args || typeof args !== "object") return false
      const command = typeof args.command === "string" ? args.command : ""
      if (!command) return false
      const verdict = resolveBashTimeout({
        command,
        timeoutMs: parseTimeoutArg(args.timeout),
        probeMs: deps.probeMs,
        maxMs: deps.maxMs,
        readonlyAllowed: deps.readonlyAllowed,
      })
      if (!verdict.changed) return false
      args.timeout = verdict.to
      deps.onClamp?.({ via: verdict.via, from: verdict.from, to: verdict.to })
      return true
    } catch {
      /* a timeout clamp must never break the call it is trying to speed up */
      return false
    }
  }
}

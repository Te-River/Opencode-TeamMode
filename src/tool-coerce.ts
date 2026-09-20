/**
 * Coerce the handful of built-in tool arguments the host validates strictly
 * and the model sends as strings.
 *
 * WHY (live evidence, 2026-09-20): a lead following our own "use the host's
 * visible background sub-agent" advice burned two failed `task` calls before
 * it got through — first `"background": "True"`, then `"background": "true"`.
 * The host's schema is `Schema.Boolean` and rejects a string outright, while
 * models routinely serialize booleans as text (every tm_* tool here already
 * tolerates `cancel: "true"` for exactly that reason). So the trap is real,
 * reproducible, and on the path we recommend.
 *
 * This is the same mutable-args surface the bash timeout clamp uses
 * (`tool.execute.before`), and the same discipline applies:
 *   - narrow scope — one known boolean per known tool, listed below;
 *   - lossless — only the strings true/false (any case) are converted, and
 *     anything else is left exactly as the model wrote it;
 *   - never invents an argument the model omitted, never widens what may run;
 *   - cannot throw into the hook: a bad coercion would fail the user's call.
 */

/** tool id (lower-cased, suffix-matched) → the boolean args it validates. */
const BOOLEAN_ARGS: Record<string, string[]> = {
  task: ["background"],
}

const TRUE_RE = /^(true|1|yes|on)$/i
const FALSE_RE = /^(false|0|no|off)$/i

/** Mutates `output.args` in place. Returns the keys it converted (empty when
 *  it did nothing, which is the overwhelmingly common case). */
export function coerceToolArgs(
  input: unknown,
  output: unknown,
): string[] {
  try {
    const rawID = String((input as { tool?: unknown; toolID?: unknown } | null)?.tool ??
      (input as { toolID?: unknown } | null)?.toolID ?? "").trim().toLowerCase()
    if (!rawID) return []
    const key = Object.keys(BOOLEAN_ARGS).find(
      (k) => rawID === k || rawID.endsWith(`:${k}`) || rawID.endsWith(`/${k}`),
    )
    if (!key) return []
    const args = (output as { args?: Record<string, unknown> } | null)?.args
    if (!args || typeof args !== "object" || Array.isArray(args)) return []
    const changed: string[] = []
    for (const name of BOOLEAN_ARGS[key]) {
      const value = args[name]
      if (typeof value !== "string") continue
      const t = value.trim()
      if (TRUE_RE.test(t)) {
        args[name] = true
        changed.push(name)
      } else if (FALSE_RE.test(t)) {
        args[name] = false
        changed.push(name)
      }
      // any other string is the model meaning something we do not interpret
    }
    return changed
  } catch {
    return []
  }
}

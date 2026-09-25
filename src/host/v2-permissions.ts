/**
 * v1's flat permission map -> v2's ordered `{action, resource, effect}` rules.
 *
 * v1 expressed an agent's whitelist as an object keyed by tool name, with two
 * tricks the v2 schema cannot hold: a value may be an OBJECT of
 * pattern->effect (the bash escalation that made the host's official dialog
 * fire for the R6/R2 faces), and `"tm_*"` was a literal wildcard KEY that
 * matched our whole tool family.  v2 takes only flat triples, so:
 *
 *  - a plain `tool: "allow"|"deny"|"ask"` becomes `{action: tool, resource:"*", effect}`;
 *  - an escalation object becomes ONE `ask` triple for that action — the object
 *    existed only to force a dialog, and `ask` is the effect that does it.  The
 *    per-pattern precision comes back in #94, where the `evaluate` hook can
 *    classify the actual command line (probed: `action:"shell"` carries the
 *    whole command in `resources[0]`).
 *
 * Anything whose effect is not one of the host's three literals is DROPPED
 * rather than guessed at: a rule the host cannot parse is worse than no rule,
 * because it may fail closed on the whole agent.
 */

export type PermissionEffect = "allow" | "deny" | "ask"

export interface PermissionTriple {
  action: string
  resource: string
  effect: PermissionEffect
}

const EFFECTS = new Set<string>(["allow", "deny", "ask"])

/**
 * v1 named its built-in tools differently.  Measured against the live v2
 * surface (probed `session.context.tools`: edit glob grep question read shell
 * skill subagent webfetch websearch write, plus patch/browser_*):
 *
 *   bash → shell · task → subagent · apply_patch → patch
 *
 * A name with no v2 counterpart (`list`, `todowrite`, `lsp`) is NOT emitted as
 * a phantom rule — the caller gets it back in `unmapped` so the boot log can
 * say "this part of the whitelist has no v2 equivalent yet", which is a
 * reportable fact, unlike a rule the host will never match.
 */
export const V2_ACTION_NAMES: Readonly<Record<string, string>> = {
  bash: "shell",
  task: "subagent",
  apply_patch: "patch",
}

const V2_ONLY_ACTIONS = new Set(["list", "todowrite", "lsp"])

function normalizeEffect(value: unknown): PermissionEffect | null {
  return typeof value === "string" && EFFECTS.has(value) ? (value as PermissionEffect) : null
}

export interface TranslateOptions {
  /**
   * With R6 on, v1 escalated `bash` to a pattern object so the host's OFFICIAL
   * dialog fired.  A plugin cannot raise a dialog on v2 (probed) — but the host
   * does honor an `ask` EFFECT it evaluates itself, so escalating the mapped
   * `shell` action to `ask` is the closest honest equivalent: the human is
   * asked, just per command rather than per pattern.  #94 refines the
   * per-pattern half through `permission.hook("evaluate")`.
   */
  escalateShellAsk?: boolean
}

/** The v1 `permission` block, as loosely as the host hands it to us. */
export function triplesFromAgentPermission(
  permission: Record<string, unknown> | undefined | null,
  options: TranslateOptions = {},
): { triples: PermissionTriple[]; unmapped: string[] } {
  const triples: PermissionTriple[] = []
  const unmapped: string[] = []
  if (!permission || typeof permission !== "object") return { triples, unmapped }
  for (const [v1Action, value] of Object.entries(permission)) {
    if (!v1Action) continue
    if (V2_ONLY_ACTIONS.has(v1Action)) {
      unmapped.push(v1Action)
      continue
    }
    const action = V2_ACTION_NAMES[v1Action] ?? v1Action
    const direct = normalizeEffect(value)
    if (direct) {
      const effect: PermissionEffect =
        options.escalateShellAsk && action === "shell" && direct === "allow" ? "ask" : direct
      triples.push({ action, resource: "*", effect })
      continue
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // pattern -> effect map: one dialog-forcing rule, and `ask` wins over
      // `allow` because that is what the object was for.
      const effects = Object.values(value)
        .map(normalizeEffect)
        .filter((e): e is PermissionEffect => e !== null)
      const effect: PermissionEffect = effects.includes("ask")
        ? "ask"
        : effects.includes("deny")
          ? "deny"
          : effects[0] ?? "ask"
      triples.push({ action, resource: "*", effect })
    }
  }
  return { triples, unmapped }
}

/**
 * Union that keeps the user's unrelated rules and lets OUR matrix decide OUR
 * actions (the matrix is the whitelist — that is the product's tool-surface
 * promise, and it must not be silently widened by a config edit half-applying
 * it).  Idempotent: running it twice changes nothing.
 */
export function mergeTriples(
  existing: ReadonlyArray<PermissionTriple> | undefined | null,
  ours: ReadonlyArray<PermissionTriple>,
): { triples: PermissionTriple[]; changed: boolean } {
  const base = Array.isArray(existing) ? existing : []
  const ourActions = new Set(ours.map((t) => t.action))
  const kept = base.filter((t) => !t || typeof t !== "object" ? false : !ourActions.has(String(t.action)))
  const keptClean = kept.filter((t) => t && typeof t.action === "string" && EFFECTS.has(String(t.effect)))
  const triples = [...keptClean.map((t) => ({ ...t, resource: typeof t.resource === "string" && t.resource ? t.resource : "*" })), ...ours]
  const changed =
    triples.length !== base.length ||
    JSON.stringify(triples) !== JSON.stringify(base)
  return { triples, changed }
}

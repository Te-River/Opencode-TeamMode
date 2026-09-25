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

/**
 * Tools the v1 personality registers and the v2 one does NOT — the host's own
 * `execute` (Code Mode) already covers `tm_ptc_run` on v2 (proved against a live
 * session: parallel governed calls, results still offloaded through handles).
 *
 * This is the single source for that fact: `v2.ts` skips them when registering,
 * and `scripts/gen-v2-config.mjs` drops their permission triples, because an
 * `allow` for an action the host has never heard of claims a capability that
 * does not exist.
 */
/**
 * Tools v1 keeps and v2 does not register.
 *
 * `tm_ptc_run` left because the host's own Code Mode does the job.  The other
 * three left for the opposite reason: on v2 the NATIVE read/grep/shell are the
 * better tools (paged reads, image/PDF attachment, background shell, and — since
 * 1.7.0's offload layer — they are now governed too, measured at 12,902 tokens
 * arriving as a 78-token preview).  Retiring them is only safe in that order,
 * which is why the governance moved to `execute.after` FIRST and this list is the
 * step that follows it, not the one that precedes it.
 *
 * v1 keeps all three: its `tool.execute.before` can rewrite arguments but not
 * results, so deleting them there would delete offload itself.
 */
export const V1_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "tm_ptc_run",
  "tm_read",
  "tm_grep",
  "tm_bash",
  /*
   * `tm_pty` executes on the host's OWN terminal sessions through `client.pty.*`,
   * and the v2 plugin context has no pty domain at all — so registering it meant
   * shipping a tool whose every start answers "宿主 pty 接口不可用". A tool that
   * cannot work is the overstated claim, not the fallback. v1 keeps it.
   * Revisit only when #28 measures the native `shell` background round-trip
   (what returns, how output is retrieved, how it is cancelled); if the host's own
   * background shell covers it, this stays retired and the prompt says `shell`.
   */
  "tm_pty",
])

/**
 * The v2 file/shell ladder runs through the host's own tools, so the triples that
 * DENY them must not be projected: v2-session.ts deletes every literal-`deny`
 * action from the request, and denying `read` while `tm_read` is unregistered
 * would leave a role with no way to open a file at all.  This is a translation
 * decision, not an edit to src/agents.ts — v1's matrix keeps its denies and the
 * two personalities' ladders genuinely differ now.
 *
 * Both halves have to agree, so the SAME set is consulted by `toolsToRemove()` in
 * v2-session.ts; this constant is the one source.  Letting the native file tools
 * back in does not lower a red line: v1's P2 scope ("stay inside the project +
 * the store dirs") is the host's own `external_directory` permission action on v2,
 * observed live answering `effect:"ask"` with a `permission.asked` behind it — a
 * real dialog where our code used to hard-throw.  The two red lines the host does
 * NOT know about (the address policy under `webfetch`, R6 under `shell`) are the
 * ones `v2-guard.ts` puts into `permission.hook("evaluate")`, and that happened
 * BEFORE this fork, which is the ordering AGENTS.md requires.
 */
export const V2_LADDER_ACTIONS: ReadonlySet<string> = new Set(["read", "grep", "glob"])

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
    // A rule for an action v2 never registers claims a capability that does not
    // exist, and `permission.evaluate` cannot even see it to enforce it.  One
    // source for the decision: this is the same set v2.ts skips when registering
    // and gen-v2-config.mjs uses for the markdown frontmatter.
    if (V1_ONLY_TOOLS.has(action)) continue
    const direct = normalizeEffect(value)
    if (direct) {
      // The v2 file ladder IS the native read/grep/glob, so a `deny` on them may
      // not be projected: v2-session.ts deletes every literal-deny action from the
      // request, and deleting them while tm_read/tm_grep are unregistered would
      // leave a role with no way to open a file.  An explicit allow still rides.
      if (V2_LADDER_ACTIONS.has(action) && direct === "deny") continue
      const effect: PermissionEffect =
        options.escalateShellAsk && action === "shell" && direct === "allow" ? "ask" : direct
      triples.push({ action, resource: "*", effect })
      // The host's 45 `browser_*` tools share ONE permission action named `browser`
      // (read from the binary), and they are NOT in the direct tool surface — so
      // deleting `browser_*` from `event.tools` at the request layer removes a
      // catalog the assembled request never contained, while a role that is denied
      // `tm_browser` can still reach every one of them from inside `execute`.
      // Projecting the deny is the only lever that speaks their language.
      if (action === "tm_browser" && direct === "deny") {
        triples.push({ action: "browser", resource: "*", effect: "deny" })
      }
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
 *
 * `drop` is the reclaim path for an upgrade: a rule naming an action this
 * personality never registers (a v1-only tool) can only have come from us, and
 * leaving it behind would keep claiming a capability the host does not have.
 */
export function mergeTriples(
  existing: ReadonlyArray<PermissionTriple> | undefined | null,
  ours: ReadonlyArray<PermissionTriple>,
  drop?: ReadonlySet<string>,
): { triples: PermissionTriple[]; changed: boolean } {
  const base = Array.isArray(existing) ? existing : []
  const ourActions = new Set(ours.map((t) => t.action))
  const kept = base.filter((t) => {
    if (!t || typeof t !== "object") return false
    const action = String(t.action)
    return !ourActions.has(action) && !drop?.has(action)
  })
  const keptClean = kept.filter((t) => t && typeof t.action === "string" && EFFECTS.has(String(t.effect)))
  const triples = [...keptClean.map((t) => ({ ...t, resource: typeof t.resource === "string" && t.resource ? t.resource : "*" })), ...ours]
  const changed =
    triples.length !== base.length ||
    JSON.stringify(triples) !== JSON.stringify(base)
  return { triples, changed }
}

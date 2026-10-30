/**
 * The agent permission matrix -> v2's ordered `{action, resource, effect}` rules.
 *
 * The matrix expresses a whitelist as an object keyed by tool name, with two
 * tricks the v2 schema cannot hold: a value may be an OBJECT of
 * pattern->effect (the bash escalation that made the host's official dialog
 * fire for the R6/R2 faces), and `"tm_*"` is a literal wildcard KEY that
 * matches our whole tool family.  v2 takes only flat triples, so:
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

import { isLeadAgent } from "../identity.js"

export type PermissionEffect = "allow" | "deny" | "ask"

export interface PermissionTriple {
  action: string
  resource: string
  effect: PermissionEffect
}

const EFFECTS = new Set<string>(["allow", "deny", "ask"])

/**
 * The matrix names three built-in tools differently from the host's v2 tool
 * ids.  Measured against the live v2 surface (probed `session.context.tools`:
 * edit glob grep question read shell skill subagent webfetch websearch write,
 * plus patch/browser_*):
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
 * COMPUTER USE — the optional `computeruse` MCP server (screenshot + mouse and
 * keyboard on the real desktop).  It is NOT our tool: the host spawns it from
 * `mcp.computeruse` and every one of its tools arrives as `<server>_<tool>`.
 *
 * A SENTINEL, not seven literal names, for the same reason `BROWSER_CATALOG`
 * exists: the server owns its tool list, so a literal list silently misses the
 * eighth tool a later release adds — and the miss has no symptom.  What turns
 * that silence into a number is `computeruse_deny_leak` in v2-probe.ts.
 *
 * The deny is derived from the ROLE (`computerUseAllowed`) rather than from a
 * key in `src/agents.ts`, because this file is the translation layer every
 * caller already goes through, and one source for "who may drive the desktop"
 * cannot drift from the removal plan it feeds.
 */
export const COMPUTER_USE_CATALOG = "computeruse_*"

/** The TWO roles that may drive the desktop: the lead and the dedicated
 *  `ComputerUser` specialist.  `researcher` and `tester` are deliberately OUT —
 *  the desktop belongs to one role whose entire brief is "look, act, read the
 *  verdict", and a role that reads untrusted web pages while holding the mouse is
 *  the worst combination this product can assemble.  The lead check goes through
 *  `isLeadAgent` (identity.ts), so `team` / `Team` / `TEAM` are one role. */
const COMPUTER_USE_SPECIALISTS: ReadonlySet<string> = new Set(["computeruser"])

export function computerUseAllowed(agentName: string | undefined | null): boolean {
  const name = String(agentName ?? "").trim()
  if (!name) return false
  if (isLeadAgent(name)) return true
  return COMPUTER_USE_SPECIALISTS.has(name.toLowerCase())
}

/**
 * Both spellings, always: `browser_*` was matched only in its underscore form
 * once and the Code Mode catalog's dotted `browser.snapshot` slipped past the
 * gate entirely (v2-browser-gate.ts:103-108).  The real name of a server tool is
 * measured at runtime, never assumed — `computeruse_tools` records what arrived.
 */
export function isComputerUseTool(name: string): boolean {
  const n = String(name ?? "").toLowerCase()
  return n.startsWith("computeruse_") || n.startsWith("computeruse.")
}

/**
 * The family as a PERMISSION ACTION name.  MEASURED on a real 2.2.1 host: MCP
 * tools DO reach `permission.evaluate`, with the underscore-joined action
 * `computeruse_control_status` and `resources:["computeruse_control_status"]` —
 * the seam the docs above called unmeasured.  That makes the permission layer the
 * primary defence, and this is the matcher it needs.
 *
 * Anchored at the START, unlike the loose mention probe below: a permission
 * ACTION is a name the host minted for a server tool, so `mcp__computeruse__x` /
 * `computeruse_x` / `computeruse.x` / `computer_use` are the family while a user's
 * own `my_computeruse_notes` is not.  Guessing at a substring is how a deny turns
 * into a data-loss bug.
 */
const COMPUTER_USE_ACTION = /^(?:mcp__)?computer[\s._-]?use(?:[._-]|$)/i

export function isComputerUseAction(name: string): boolean {
  return COMPUTER_USE_ACTION.test(String(name ?? "").trim())
}

/**
 * The family's name in every spelling a tool name or a program's source text can
 * carry it: `computeruse` (the MEASURED one — `computeruse.control_status` in a
 * real 2.2.1 Code Mode catalog), `computer_use`, `computer-use`, and therefore
 * also `mcp__computeruse__<tool>`.  ONE pattern for both readers below, because
 * two spelling lists is exactly how `browser_*` ended up governing nothing
 * (v2-browser-gate.ts:103-108): the request layer reads tool NAMES and the
 * `execute` gate reads program TEXT, and a spelling one of them forgets is a
 * silent hole.
 */
const COMPUTER_USE_MENTION = /computer[\s._-]?use/i

/**
 * The LOOSE probe: does this tool name mention the declared server at all, in any
 * spelling?  Deliberately NOT used to delete — a loose rule would also delete a
 * user tool called `my_computeruse_notes`, and guessing is how a deny becomes a
 * data-loss bug.  It is used for the two DIAGNOSTIC questions only: "what names did
 * the host actually mint?" and "is a denied role still holding — or CALLING — one
 * of them after our prefix removed nothing?"
 */
export function mentionsComputerUse(name: string): boolean {
  return COMPUTER_USE_MENTION.test(String(name ?? ""))
}

/**
 * Does a Code Mode `program` name the server?  This is the seam that matters on a
 * 2.x host: MCP tools are NOT in `event.tools` (measured — `architect`'s surface
 * carried five tools and no `computeruse*` name while
 * `tools.computeruse.control_status()` answered `{"ok":true}`), so the
 * request-layer prefix cannot delete what is not there.  `v2-computeruse-gate.ts`
 * refuses on a match.
 *
 * A text match is a REFUSAL in the safe direction and a MISS in the unsafe one: a
 * program that builds the name at runtime (`"computer" + "use"`) matches nothing
 * here.  That is why the gate also reads what actually RAN
 * (`metadata.toolCalls`) instead of treating this function as complete.
 */
export function programMentionsComputerUse(program: string): boolean {
  return COMPUTER_USE_MENTION.test(String(program ?? ""))
}

/**
 * RETIRED TOOLS — names the v1 personality used to register and this package
 * no longer ships.  v1 support was removed in 1.7.0, so these are historical
 * names; the set survives because it still has three live jobs:
 *
 *  - `v2.ts` skips them when registering, so a stale build or a future re-add
 *    cannot slip one back onto the tool surface;
 *  - `triplesFromAgentPermission` drops any permission rule naming one, and
 *    `mergeTriples` reclaims such a rule from an upgraded config — an `allow`
 *    for an action the host has never heard of claims a capability that does
 *    not exist;
 *  - `scripts/gen-v2-config.mjs` drops their triples from the generated
 *    markdown for the same reason.
 *
 * Why each left: `tm_ptc_run` because the host's own Code Mode does the job
 * (one program, N governed calls, zero round-trips, proved against a live
 * session: parallel governed calls, results still offloaded through handles).
 * `tm_read`/`tm_grep`/`tm_bash` because the NATIVE read/grep/shell are the
 * better tools (paged reads, image/PDF attachment, background shell, and —
 * since the offload layer — they are governed too, measured at 12,902 tokens
 * arriving as a 78-token preview).  Retiring them was only safe in that order,
 * which is why the governance moved to `execute.after` FIRST and this list is
 * the step that follows it, not the one that precedes it.
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
   * cannot work is the overstated claim, not the fallback.
   * Revisit only when #28 measures the native `shell` background round-trip
   (what returns, how output is retrieved, how it is cancelled); if the host's own
   * background shell covers it, this stays retired and the prompt says `shell`.
   */
  "tm_pty",
])

/**
 * The file/shell ladder runs through the host's own tools, so the triples that
 * DENY them must not be projected: v2-session.ts deletes every literal-`deny`
 * action from the request, and denying `read` while `tm_read` is unregistered
 * would leave a role with no way to open a file at all.  This is a translation
 * decision, not an edit to src/agents.ts — the matrix keeps its denies and the
 * ladder is applied at translation time.
 *
 * Both halves have to agree, so the SAME set is consulted by `toolsToRemove()` in
 * v2-session.ts; this constant is the one source.  Letting the native file tools
 * back in does not lower a red line: the P2 scope ("stay inside the project +
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
   * With R6 on, the matrix escalates `bash` to a pattern object so the host's
   * OFFICIAL dialog fires.  A plugin cannot raise a dialog on v2 (probed) — but
   * the host does honor an `ask` EFFECT it evaluates itself, so escalating the
   * mapped `shell` action to `ask` is the closest honest equivalent: the human
   * is asked, just per command rather than per pattern.  #94 refines the
   * per-pattern half through `permission.hook("evaluate")`.
   */
  escalateShellAsk?: boolean
  /**
   * Which role these triples are for.  Needed for the ONE tool the matrix does
   * not name: `tm_ledger` is not in the permission map, so nothing would ever
   * name it, and an unruled action is the host's default rather than our stated
   * rule.  The lead's list is the lead's: `allow` for it, `deny` for the five
   * specialists, which also makes the runtime gate (`onlyAgent: "Team"`)
   * visible in the config the user can read.
   */
  agentName?: string
}

/** The agent `permission` block, as loosely as the config hands it to us. */
export function triplesFromAgentPermission(
  permission: Record<string, unknown> | undefined | null,
  options: TranslateOptions = {},
): { triples: PermissionTriple[]; unmapped: string[] } {
  const triples: PermissionTriple[] = []
  const unmapped: string[] = []
  if (!permission || typeof permission !== "object") return { triples, unmapped }
  for (const [matrixAction, value] of Object.entries(permission)) {
    if (!matrixAction) continue
    // A trailing `*` is a PATTERN, not an action.  Declaring it as a triple would
    // claim the host has an action by that name (the same phantom-rule mistake
    // V2_ONLY_ACTIONS exists to avoid), so the rule is reported as unmapped and the
    // request layer — which deletes by prefix — is where it is actually enforced.
    if (matrixAction.endsWith("*")) {
      unmapped.push(matrixAction)
      continue
    }
    if (V2_ONLY_ACTIONS.has(matrixAction)) {
      unmapped.push(matrixAction)
      continue
    }
    const action = V2_ACTION_NAMES[matrixAction] ?? matrixAction
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
      // The host's 45 `browser_*` tools share ONE permission action named
      // `browser` (read from the binary), and they are NOT in the direct tool
      // surface — so deleting `browser_*` from `event.tools` at the request layer
      // removes a catalog the assembled request never contained.  The matrix now
      // names that action directly (`browser`), so the deny reaches the host's
      // own evaluator, which is the only lever that speaks their language.
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
  if (options.agentName) {
    const ledgerEffect = isLeadAgent(options.agentName) ? "allow" : "deny"
    if (!triples.some((x) => x.action === "tm_ledger")) {
      triples.push({ action: "tm_ledger", resource: "*", effect: ledgerEffect })
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
 * package never registers (a retired tool) can only have come from us, and
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

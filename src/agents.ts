/**
 * TeamMode agent definitions.
 *
 * Each agent is injected into the OpenCode config via the plugin's v1
 * `config` hook (the mechanism the shipped 1.18.x loader actually calls).
 * Users see them in the agent picker of OpenCode Desktop and can invoke
 * them with `@agent-name` or via the `/team-*` commands.
 *
 * The PROMPT STRINGS live in ./prompts/ (lead.ts, specialists.ts,
 * shared.ts) — extracted verbatim; test-blackboard.mjs pins them.  This
 * module owns the structure: roles, modes, colors, temperatures, and the
 * tool-whitelist matrix.
 *
 * Prompt design principles (v1.4.7 — "subtraction" release):
 *  - Deterministic routing table replaces free-form scheduling deliberation
 *    (fixes the lead's "inner monologue" — route selection is a lookup).
 *  - Structured reply skeleton (STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF)
 *    is the primary inter-agent channel; the file blackboard is demoted to
 *    an oversized-deliverable exception (>~50 lines). MANIFEST.md is gone.
 *  - Approval gate is a mechanical dispatch count (>=2 -> plan + wait);
 *    blocking uncertainties are batched and asked immediately.
 *  - Verified root causes go straight to the implementer — no ceremonial
 *    research dispatches.
 *  - Verification defaults to static checks; improvised browser automation
 *    is explicitly banned.
 *  - Adaptive review: one reviewer by default, three dimensions only for
 *    high-risk profiles.
 *  - All agents run at temperature 0.2 for format discipline.
 */

import type { AgentConfig, AgentPermission } from "./types.js"
import { TEAM_LEAD_PROMPT } from "./prompts/lead.js"
import {
  ARCHITECT_PROMPT,
  IMPLEMENTER_PROMPT,
  RESEARCHER_PROMPT,
  REVIEWER_PROMPT,
  TESTER_PROMPT,
} from "./prompts/specialists.js"
import { REPLY_CONTRACT, SHARED_RULES } from "./prompts/shared.js"
import { V1_ONLY_TOOLS } from "./host/v2-permissions.js"

/* ------------------------------------------------------------------ */
/*  Tool whitelist builder (Phase 2 / T2.1, G2 ruling "方案甲")        */
/* ------------------------------------------------------------------ */
/**
 * Builds the permission block that IS the agent's tool whitelist.
 *
 * Verified live (T0.4③): a "deny" permission removes the built-in tool
 * from the model's tool surface entirely — zero bypass, zero hallucinated
 * calls.  So a whitelist = deny every excluded built-in + allow the kept
 * set, exactly the shape the D6 probe validated
 * (%TEMP%/opencode/tm-probe/workspace/opencode.json).
 *
 * G2 rulings baked in:
 *  - glob/list never enter the whitelist — file enumeration goes through
 *    the host's own glob / shell;
 *  - the built-in webfetch/websearch tools stay removed — the governed
 *    tm_webfetch (domain-allowlisted, threshold-offloaded) is the sanctioned
 *    web FALLBACK channel, granted ONLY to team + researcher; user-
 *    configured MCP/plugin tools (browser automation, search, fetchers)
 *    pass through the whitelist untouched and are the HIGH-priority channel;
 *  - "tm_*" covers the governed retrieval/memory tools this package still
 *    registers (tm_fetch / tm_memory / tm_stats / tm_board_write); tm_webfetch,
 *    tm_search and tm_browser are explicit keys that override the wildcard per
 *    agent; the R6 env-protection hook aliases onto the native shell unchanged,
 *    so narrowing the surface does not weaken the anti-backdoor chain.
 *
 * T2.1 review revision (Critical fix): the built-in shell RETURNS for the
 * execution roles (team / implementer / reviewer / tester).  G2 only ruled
 * that glob/list enumeration goes through the governed channel — it never ruled
 * away command execution, and a read-only allowlist cannot run
 * npm test / tsc / --help probes.  R6 keeps governing the shell's env surface
 * through the envprotect hook, independently of this matrix.
 */
const NEVER_ALLOWED = [
  "read",
  "grep",
  "glob",
  "list",
  "apply_patch",
  "webfetch",
  "websearch",
  "lsp",
  "skill",
  "question",
] as const

/** Built-ins granted per agent; every one NOT granted is denied.  task and
 *  question are LEAD-ONLY grants (see the whitelist calls
 *  below): only the lead dispatches — specialists spawning sub-agents is
 *  the nesting the T3 task-reclaim closed (architect and reviewer lost
 *  "task"; the matrix deny is zero-bypass, live-verified T0.4③).  The
 *  lead's prompt MANDATES a ledger ("your state memory is the todo
 *  list") and batched blocking questions — denying those tools to the lead
 *  made the prompt unfulfillable; specialists answer through the lead
 *  (STATUS: blocked), never interrupt the user directly.
 *
 *  The ledger is NOT named here: this host registers no todo-writing built-in,
 *  and the tool that holds the list is `tm_ledger`, whose allow/deny triples
 *  `src/host/v2-permissions.ts` derives from the ROLE NAME (team → allow,
 *  the five specialists → deny).  Naming a tool the matrix cannot grant would
 *  be a second source of truth for a retired name — `V1_ONLY_TOOLS` there is
 *  the one list of what is gone. */
const PER_AGENT_TOOLS = ["edit", "write", "task", "bash", "question"] as const

/** The governed tools this package still registers, named explicitly next to
 *  the "tm_*" wildcard (belt-and-braces: the explicit allows survive even if a
 *  host ever stops expanding the wildcard).  tm_memory is the project memory
 *  store — not a network channel, available to all six agents.  tm_stats reads
 *  this plugin's own trajectory (no network, no shell, no secrets) so any role
 *  can answer "what did we spend" — and after a host upgrade, "what broke".
 *
 *  The list is PRUNED by `V1_ONLY_TOOLS` (src/host/v2-permissions.ts), the one
 *  source of truth for retired names: a `allow` key for a tool we no longer
 *  register claims a capability the host has never heard of, and the file
 *  ladder (read / grep / shell) plus the host's own `execute` cover what the
 *  retired trio used to. */
/** tm_board_write is in this set on purpose.  The blackboard is the ONLY
 *  oversized-deliverable channel, and two roles (architect, researcher) carry no
 *  write/edit/bash — `whitelist()` grants them no built-in at all, only the
 *  read-capable tm_* set — so a board write through the host's file tools is
 *  impossible for them by construction, and the rule that keeps a report from
 *  becoming a wall of text was un-followable exactly where it mattered.  A
 *  governed writer scoped to <board-root>/<session>/<task>/ is the small fix;
 *  it is not a file tool, because it can neither overwrite nor leave the board. */
const TM_TOOLS = [
  "tm_fetch",
  "tm_memory",
  "tm_stats",
  "tm_board_write",
].filter((name) => !V1_ONLY_TOOLS.has(name))

const whitelist = (
  ...granted: Array<(typeof PER_AGENT_TOOLS)[number]>
): AgentPermission => {
  const permission: AgentPermission = {}
  for (const tool of NEVER_ALLOWED) permission[tool] = "deny"
  for (const tool of PER_AGENT_TOOLS) {
    permission[tool] = granted.includes(tool) ? "allow" : "deny"
  }
  for (const tool of TM_TOOLS) permission[tool] = "allow"
  permission["tm_*"] = "allow"
  // Governed web channels (tm_webfetch / tm_search / tm_browser) — default
  // DENY for every agent; the explicit keys override the tm_* wildcard.
  // applyNetworkPermission grants the FULL set to the lead + researcher
  // and tm_browser alone to the tester (UI verification).
  permission["tm_webfetch"] = "deny"
  permission["tm_search"] = "deny"
  permission["tm_browser"] = "deny"
  // Nobody creates sub-agents through us any more: a tm_dispatch child is a
  // session the user can neither open from a card nor stop from the UI, so
  // delegation goes through the host's own `task` (governed, visible,
  // killable). tm_join stays the lead's tool — it COLLECTS children (including
  // host `task` children by id) and adopts leftovers from before the change.
  permission["tm_dispatch"] = "deny"
  permission["tm_join"] = "deny"
  return permission
}

/** Grant the async COLLECT lever to the lead only (issue #6 + #7).  No agent
 *  may spawn: `tm_dispatch` is denied unconditionally above and never
 *  registered on the tool surface, so delegation has exactly one route — the
 *  host's `task`. These matrix entries and the tools' own runtime `ctx.agent`
 *  checks are two independent locks. */
export function applyDispatcherPermission(permission: AgentPermission, isTeamLead: boolean): void {
  permission["tm_dispatch"] = "deny"
  permission["tm_join"] = isTeamLead ? "allow" : "deny"
}

/** Ask-map rules verified against the live host (1.18.30 asar probe):
 * PermissionV2.evaluate uses findLast over the flat ruleset, so the
 * explicit {"*": "ask"} rule registered here BEATS the later-matching
 * tm_* wildcard allow — without it, ctx.ask would resolve silently (the
 * tm_* allow rule matches every tm_* permission) and the official dialog
 * would never pop for out-of-allowlist targets.  The tools' own allowlist
 * short-circuit keeps seeded hosts dialog-free: ctx.ask is only called for
 * out-of-allowlist targets, where the dialog MUST decide. */
const WEB_ASK_MAP = { "*": "ask" } as const

/** Apply the network grant: the team lead and the researcher carry the
 *  FULL governed web channels (tm_webfetch / tm_search / tm_browser — the
 *  ask-map overrides the tm_* wildcard so out-of-allowlist targets pop the
 *  official dialog); the TESTER carries tm_browser ONLY (governed UI
 *  verification — no open web fetching); architect / implementer /
 *  reviewer keep the whitelist deny. */
function applyNetworkPermission(permission: AgentPermission, isWebRole: boolean, isTester = false): void {
  permission["tm_webfetch"] = isWebRole ? { ...WEB_ASK_MAP } : "deny"
  permission["tm_search"] = isWebRole ? { ...WEB_ASK_MAP } : "deny"
  permission["tm_browser"] = isWebRole || isTester ? { ...WEB_ASK_MAP } : "deny"
}

/* ------------------------------------------------------------------ */
/*  Agent definitions                                                  */
/* ------------------------------------------------------------------ */

const teamLead: AgentConfig = {
  mode: "primary",
  description:
    "Team lead orchestrator — routes work to specialist agents " +
    "(architect, implementer, reviewer, tester, researcher) via a fixed " +
    "routing table, enforces the approval gate and review/test feedback " +
    "loop, and synthesizes their outputs into a coherent deliverable.  " +
    "Use when the task requires multi-step collaboration across " +
    "different expertise areas.",
  prompt: TEAM_LEAD_PROMPT,
  color: "#E879F9", // purple
  // Whitelist: TM_TOOLS + tm_webfetch/tm_search/tm_browser (the lead is
  // a network role) + subagent dispatch + edit (<=10-line non-product edits) +
  // write (board files) + shell (discovery-gate probes) + question
  // (the lead's ledger discipline and batched blocking questions are
  // prompt mandates — they need their tools).  The ledger itself is
  // `tm_ledger`, allowed for this role by name in the permission layer.
  permission: whitelist("task", "edit", "write", "bash", "question"),
  temperature: 0.2,
}

const architect: AgentConfig = {
  mode: "subagent",
  description:
    "System architect — designs module structure, API contracts, data models, " +
    "and technical strategy; revises designs when review or testing exposes a " +
    "flaw.  Use when you need a design doc, architecture decision record, or " +
    "module breakdown before implementation.",
  prompt: ARCHITECT_PROMPT,
  color: "#38BDF8", // sky blue
  // Whitelist: TM_TOOLS only (T3 task-reclaim: "task" DROPPED — no
  // sub-agents for sub-agents, the lead is the only dispatcher);
  // tm_webfetch DENIED (not a network role).  Fully read-only by design
  // (T2.1): output lives in the reply; if a board artifact is ever
  // dispatched, the BLACKBOARD WRITE FAILED fallback hands the content to
  // the lead inline (see Blackboard rules).
  // No bash — unchanged from the pre-T2.1 architect bash:deny posture.
  permission: whitelist(),
  temperature: 0.2,
}

const implementer: AgentConfig = {
  mode: "subagent",
  description:
    "Core implementer — writes production code, creates files, and builds " +
    "features according to the architect's design; applies review-driven fix " +
    "tasks.  Use when you need clean, working code written quickly.",
  prompt: IMPLEMENTER_PROMPT,
  color: "#4ADE80", // green
  // Whitelist: TM_TOOLS + edit/write (code implementation) + bash (narrowest
  // verification for the fix: build / typecheck / failing test);
  // tm_webfetch DENIED (not a network role).
  permission: whitelist("edit", "write", "bash"),
  temperature: 0.2,
}

const reviewer: AgentConfig = {
  mode: "subagent",
  description:
    "Code reviewer — reviews ONE dimension per dispatch (completeness / " +
    "correctness / impact) with severity-graded, actionable findings; the " +
    "lead defaults to one correctness dispatch and escalates to three " +
    "parallel dimensions only for high-risk changes.  Use before merging " +
    "any non-trivial change.",
  prompt: REVIEWER_PROMPT,
  color: "#FB923C", // orange
  // Whitelist: TM_TOOLS + bash; tm_webfetch DENIED (not a network role).
  // T3 task-reclaim: "task" DROPPED (only the lead dispatches).  No
  // edit/write (T2.1): findings travel in the reply skeleton; a dispatched
  // board artifact rides the BLACKBOARD WRITE FAILED
  // inline fallback (see Blackboard rules).  bash backs the evidence
  // standard — the reviewer must be able to run npm test / tsc itself.
  permission: whitelist("bash"),
  temperature: 0.2,
}

const tester: AgentConfig = {
  mode: "subagent",
  description:
    "Test engineer — writes and runs unit/integration tests, classifies " +
    "failures (product bug vs bad test vs environment), verifies via build, " +
    "typecheck, static analysis and API-level tests, verifies user-visible " +
    "frontend changes through the governed tm_browser (UI verification of " +
    "this project only), and reports a clear verdict.  Use to validate " +
    "correctness or raise coverage.",
  prompt: TESTER_PROMPT,
  color: "#F472B6", // pink
  // Whitelist: TM_TOOLS + edit/write (test files) + bash (the whole
  // verification stack: build / typecheck / lint / test runs).
  // tm_browser granted for governed UI verification; tm_webfetch / tm_search
  // DENIED (open web lookups stay with the lead + researcher).
  permission: whitelist("edit", "write", "bash"),
  temperature: 0.2,
}

const researcher: AgentConfig = {
  mode: "subagent",
  description:
    "Researcher — investigates the local repository (code, configs, " +
    "installed/vendored packages, shipped documentation) and, when local " +
    "sources are insufficient, the web via the priority ladder: governed " +
    "tm_search / tm_browser / tm_webfetch first, user-configured MCP tools " +
    "second.  Every finding carries a source (file:line or URL) and a " +
    "confidence tag so the team can decide what needs verification.  Use " +
    "for information that must inform a technical decision.",
  prompt: RESEARCHER_PROMPT,
  color: "#A78BFA", // violet
  // Whitelist: TM_TOOLS + tm_webfetch / tm_search / tm_browser (the
  // researcher is a network role).  The built-in webfetch/websearch tools
  // stay removed — web lookups ride user-configured MCP tools (preferred)
  // or the governed tm_* web channels (allowlisted, threshold-offloaded).
  // No built-in `bash` grant — whitelist() denies every built-in here, which is
  // intentional trimming (local research reads, it does not run).  The role is
  // not tool-less: it keeps the governed tm_* set, and on v2 the host's own
  // read/grep/glob + Code Mode `execute`, which our matrix never denies.
  permission: whitelist(),
  temperature: 0.2,
}

/* Append the reply contract and shared rules to every specialist prompt. */
for (const a of [architect, implementer, reviewer, tester, researcher]) {
  a.prompt = (a.prompt ?? "") + REPLY_CONTRACT + SHARED_RULES
}

/* tm_webfetch — ONLY team + researcher get allow (the two network roles).
 * Applied once at module init. */
if (teamLead.permission) {
  applyNetworkPermission(teamLead.permission, true)
  applyDispatcherPermission(teamLead.permission, true)
}
for (const a of [architect, implementer, reviewer, tester, researcher]) {
  if (a.permission) {
    // tester: tm_browser only (UI verification); researcher: full web grant
    applyNetworkPermission(a.permission, a === researcher, a === tester)
    applyDispatcherPermission(a.permission, false)
  }
}

/* ------------------------------------------------------------------ */
/*  Export all agents keyed by name                                    */
/* ------------------------------------------------------------------ */

export const agents: Record<string, AgentConfig> = {
  "team": teamLead,
  architect,
  implementer,
  reviewer,
  tester,
  researcher,
}

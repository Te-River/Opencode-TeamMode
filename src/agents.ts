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
 *    tm_bash (ls / dir / Get-ChildItem);
 *  - the built-in webfetch/websearch tools stay removed — the governed
 *    tm_webfetch (domain-allowlisted, threshold-offloaded) is the sanctioned
 *    web FALLBACK channel, granted ONLY to team + researcher; user-
 *    configured MCP/plugin tools (browser automation, search, fetchers)
 *    pass through the whitelist untouched and are the HIGH-priority channel;
 *  - "tm_*" covers the four governed read/search/exec tools (tm_read /
 *    tm_grep / tm_bash / tm_fetch); tm_webfetch and tm_ptc_run are explicit
 *    keys that override the wildcard per agent; the R6 env-protection hook
 *    aliases onto read/grep/bash unchanged, so narrowing the surface does
 *    not weaken the anti-backdoor chain.
 *
 * T2.1 review revision (Critical fix): the built-in bash RETURNS for the
 * execution roles (team / implementer / reviewer / tester).  G2 only ruled
 * that glob/list enumeration goes through tm_bash — it never ruled away
 * command execution, and tm_bash is a read-only allowlist that cannot run
 * npm test / tsc / --help probes.  R6 keeps governing bash's env surface
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
  "todowrite",
  "lsp",
  "skill",
  "question",
] as const

/** Built-ins granted per agent; every one NOT granted is denied.  task,
 *  todowrite and question are LEAD-ONLY grants (see the whitelist calls
 *  below): only the lead dispatches — specialists spawning sub-agents is
 *  the nesting the T3 task-reclaim closed (architect and reviewer lost
 *  "task"; the matrix deny is zero-bypass, live-verified T0.4③).  The
 *  lead's prompt MANDATES a todo list ("your state memory is the todo
 *  list") and batched blocking questions — denying those tools to the lead
 *  made the prompt unfulfillable; specialists answer through the lead
 *  (STATUS: blocked), never interrupt the user directly. */
const PER_AGENT_TOOLS = ["edit", "write", "task", "bash", "todowrite", "question"] as const

/** The governed tools, named explicitly next to the "tm_*" wildcard
 *  (belt-and-braces: the explicit allows survive even if a host ever
 *  stops expanding the wildcard).  tm_memory is the project memory store —
 *  not a network channel, available to all six agents.  tm_stats reads this
 *  plugin's own trajectory (no network, no shell, no secrets) so any role can
 *  answer "what did we spend" — and after a host upgrade, "what broke". */
const TM_TOOLS = ["tm_read", "tm_grep", "tm_bash", "tm_fetch", "tm_memory", "tm_stats"] as const

/** M3: tm_ptc_run — explicit per-agent grant.  v1.5.4 revised the original
 *  M3 ruling (five specialists = allow, team = deny): ALL SIX agents now
 *  get `allow` (per user request, CHANGELOG 1.5.4), overriding the tm_*
 *  wildcard by explicit-key priority.  PTC remains a governed, read-only
 *  bridge — the full tm_* pipeline (P2/P3/R6/offload) runs on every
 *  bridged call, so the lead running batch programs is a convenience
 *  change, not a governance change. */
const PTC_TOOL = "tm_ptc_run" as const

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
  // tm_pty starts a real process, so it must pop the OFFICIAL dialog on
  // every use: the WEB_ASK_MAP shape is what makes PermissionV2's findLast
  // resolve to `ask` instead of swallowing the ask under the tm_* allow.
  // Default deny; the lead gets the ask-map (applyDispatcherPermission).
  permission["tm_pty"] = "deny"
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
  permission["tm_pty"] = isTeamLead ? { ...WEB_ASK_MAP } : "deny"
}

/** Apply the tm_ptc_run grant to an agent's permission block.  All six
 *  agents get `allow` (overrides the tm_* wildcard for explicit key priority). */
function applyPtcPermission(permission: AgentPermission, _isTeamLead: boolean): void {
  permission[PTC_TOOL] = "allow"
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
  // Whitelist: tm_* x4 + tm_ptc_run + tm_webfetch/tm_search/tm_browser (the lead is
  // a network role) + task dispatch + edit (<=10-line non-product edits) +
  // write (board files) + bash (discovery-gate probes) + todowrite + question
  // (the lead's TodoList discipline and batched blocking questions are
  // prompt mandates — they need their tools).
  permission: whitelist("task", "edit", "write", "bash", "todowrite", "question"),
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
  // Whitelist: tm_* x4 only (T3 task-reclaim: "task" DROPPED — no
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
  // Whitelist: tm_* x4 + edit/write (code implementation) + bash (narrowest
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
  // Whitelist: tm_* x4 + bash; tm_webfetch DENIED (not a network role).
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
  // Whitelist: tm_* x4 + edit/write (test files) + bash (the whole
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
  // Whitelist: tm_* x4 + tm_webfetch / tm_search / tm_browser (the
  // researcher is a network role).  The built-in webfetch/websearch tools
  // stay removed — web lookups ride user-configured MCP tools (preferred)
  // or the governed tm_* web channels (allowlisted, threshold-offloaded).
  // No bash / no execution rights is intentional trimming — local research
  // reads, it does not run.
  permission: whitelist(),
  temperature: 0.2,
}

/* Append the reply contract and shared rules to every specialist prompt. */
for (const a of [architect, implementer, reviewer, tester, researcher]) {
  a.prompt = (a.prompt ?? "") + REPLY_CONTRACT + SHARED_RULES
}

/* tm_ptc_run permission — all six agents get allow (overrides the tm_*
 * wildcard; v1.5.4 revised the original team=deny ruling).  tm_webfetch —
 * ONLY team + researcher get allow (the two network roles).  Applied once
 * at module init. */
if (teamLead.permission) {
  applyPtcPermission(teamLead.permission, true)
  applyNetworkPermission(teamLead.permission, true)
  applyDispatcherPermission(teamLead.permission, true)
}
for (const a of [architect, implementer, reviewer, tester, researcher]) {
  if (a.permission) {
    applyPtcPermission(a.permission, false)
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

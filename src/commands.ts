/**
 * TeamMode command definitions.
 *
 * Each command is injected into the OpenCode config via the plugin's
 * `config` hook.  Users invoke them with `/team-plan`, `/team-review`, etc.
 * in both OpenCode Desktop and the TUI.
 *
 * v1.4.7: /team-run mirrors the deterministic routing + approval gate +
 * reply-skeleton workflow; /team-review notes the lead's adaptive depth.
 */

import type { CommandConfig } from "./types.js"

/* ------------------------------------------------------------------ */
const teamPlan: CommandConfig = {
  description:
    "Create a comprehensive implementation plan — architecture, task breakdown, and risk analysis.",
  agent: "architect",
  template: `Analyze the following task and produce a detailed implementation plan.

## Task
$ARGUMENTS

## Required output
1. **Overview** — What we are building and why.
2. **Architecture** — Module structure, key interfaces, data flow.
3. **File manifest** — Every file to create or modify, with a one-line summary.
4. **Task breakdown** — Ordered steps the implementer can execute, noting dependencies.
5. **Risks & open questions** — Anything uncertain.

Read existing project files as needed to ground your plan in reality.
Do not write implementation code — only the plan.`,
}

/* ------------------------------------------------------------------ */
const teamImplement: CommandConfig = {
  description:
    "Implement a feature or task — write production code following the project's conventions.",
  agent: "implementer",
  template: `Implement the following task.  Follow the project's existing code style and conventions.

## Task
$ARGUMENTS

## Rules
- Read relevant existing files before writing code.
- Handle errors properly.
- After finishing, list every file you created or modified.`,
}

/* ------------------------------------------------------------------ */
const teamReview: CommandConfig = {
  description:
    "Review code with a single focused dimension — completeness, correctness, or impact (default: correctness).",
  agent: "reviewer",
  template: `Perform a single-dimension code review on the following scope.

## Scope
$ARGUMENTS

## Dimension
$ARGUMENTS may name one dimension: completeness (requirements coverage),
correctness (logic & security), or impact (regressions & blast radius).
If no dimension is named, review correctness.  Ignore the other dimensions
— parallel reviewers own them.

If no specific scope is given, review all recently modified files in the project.

Use the standard severity scale:
- 🔴 Critical (must fix)
- 🟡 Warning (should fix)
- 🔵 Suggestion (nice to have)
- ✅ Praise (good patterns)

Include file paths, line numbers, and concrete fix suggestions.`,
}

/* ------------------------------------------------------------------ */
const teamTest: CommandConfig = {
  description:
    "Generate comprehensive tests — unit, integration, and edge-case coverage.",
  agent: "tester",
  template: `Write comprehensive tests for the following scope.

## Scope
$ARGUMENTS

If no specific scope is given, identify the most recently modified source files and write tests for them.

## Requirements
- Use the project's existing test framework and conventions.
- Cover happy path, edge cases, and error paths.
- Each test must be deterministic and test exactly one behavior.
- Use descriptive test names.`,
}

/* ------------------------------------------------------------------ */
const teamResearch: CommandConfig = {
  description:
    "Research a topic — libraries, APIs, best practices, or documentation.",
  agent: "researcher",
  template: `Research the following topic and provide actionable findings.

## Topic
$ARGUMENTS

## Required output
1. **Summary** — Key findings in 2-3 sentences.
2. **Details** — Structured findings with sources.
3. **Recommendation** — What the team should do, with trade-offs.
4. **Sources** — Links or file paths consulted.

Cite your sources.  Do not fabricate URLs or API details.`,
}

/* ------------------------------------------------------------------ */
const teamRun: CommandConfig = {
  description:
    "Full team workflow — deterministic routing, approval gate on >=3 dispatches, structured handoffs.",
  agent: "team",
  template: `Execute the full team workflow for the following task.

## Task
$ARGUMENTS

## Workflow
1. Triage: a question/consult gets an answer with zero file changes (fixes
   merely proposed, awaiting go-ahead).  Explicit action requests continue
   below.  Honor and restate user-stated boundaries in every dispatch.
2. Route via the routing table and COUNT the dispatches.  Never shorten a
   product-change pipeline below 3 dispatches; never split one request
   into sub-3-dispatch pieces to dodge the gate.
3. Research phase: read the project's README (plus AGENTS.md/CLAUDE.md if
   present) and the relevant source yourself; dispatch researcher ONLY for
   genuinely unknown external tech.  Blocking uncertainties go to the user
   IMMEDIATELY, batched into ONE message — never drip-feed, never guess.
4. Approval gate: if the pipeline involves >=2 sub-agent dispatches,
   present the plan (Goal / Root cause or scope with file:line / Change
   list / Pipeline / Assumptions & risks / Open questions — <=30 lines)
   and END TURN.  Execute only after approval.  0-1 dispatches: open with
   a 1-2 line notice and proceed.  Root cause already verified?  Skip
   ceremonial research — the fix spec goes straight to implementer.
5. Execute the pipeline in routing-table order; batch independent
   dispatches.  Relay each specialist's HANDOFF verbatim into the next
   dispatch; enforce the STATUS-skeleton reply contract (missing skeleton
   -> PROTOCOL_VIOLATION: one retry with it inline, then downgrade and
   note it).
6. Adaptive review: default single reviewer (correctness); escalate to 3
   parallel dimensions only for high-risk profiles (auth/security surface,
   cross-module data contracts, public APIs across >=3 files).
7. Feedback loop: Critical/Major findings and tester product-bugs become
   fix tasks -> implementer fixes -> re-review affected scope -> re-run
   tests.  Max 2 loops, then escalate.  A "UI NOT VERIFIED:" line is
   relayed honestly, not hidden.
8. Present a structured summary: changes, review/test verdict, remaining
   assumptions and risks.  If the project keeps a CHANGELOG.md, append an
   entry for the delivered changes (offer to create one if missing).  Leave
   any board directories in place — the plugin's TTL sweeper reclaims
   idle boards; never delete them yourself.`,
}

/* ------------------------------------------------------------------ */
/*  Export all commands keyed by name                                 */
/* ------------------------------------------------------------------ */

export const commands: Record<string, CommandConfig> = {
  "team-plan": teamPlan,
  "team-implement": teamImplement,
  "team-review": teamReview,
  "team-test": teamTest,
  "team-research": teamResearch,
  "team-run": teamRun,
}

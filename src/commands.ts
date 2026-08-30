/**
 * TeamMode command definitions.
 *
 * Each command is injected into the OpenCode config via the plugin's
 * `config` hook.  Users invoke them with `/team-plan`, `/team-review`, etc.
 * in both OpenCode Desktop and the TUI.
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
    "Review code for correctness, security, performance, and maintainability.",
  agent: "reviewer",
  template: `Perform a thorough code review on the following scope.

## Scope
$ARGUMENTS

If no specific scope is given, review all recently modified files in the project.

Use the standard review checklist:
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
    "Full team workflow — the team lead orchestrates all agents to complete a complex task end-to-end.",
  agent: "team",
  template: `Execute the full team workflow for the following task.

## Task
$ARGUMENTS

## Workflow
1. Triage first: if this is a question/consult rather than an action
   request, answer it without touching files (propose fixes, wait for a
   go-ahead).  Honor and restate any user-stated boundaries everywhere.
2. Understand the goal and acceptance criteria.
3. **Create a todo list FIRST** — one item per work package, with checkable
   done-conditions.  Update statuses live (exactly one in_progress).
4. Dispatch sub-tasks to the appropriate agents:
   - Design / architecture → architect
   - Implementation → implementer
   - Code review → reviewer
   - Testing → tester
   - Research → researcher
5. Coordinate through the shared blackboard: one task directory; every
   dispatch carries a manifest (Task / Reads: only the files needed /
   Write to: one owned artifact file); artifacts are frozen — revisions are
   new round-suffixed files; keep MANIFEST.md's \`## Current state\` header
   updated each converged round.  Run independent sub-tasks in parallel.
6. Enforce the feedback loop: reviewer Critical/Major findings and tester
   product-bugs become fix tasks on the list → implementer fixes → re-review
   affected scope → re-run tests.  Repeat until clean (max 2 loops, then
   escalate).
7. Collect all outputs, resolve conflicts, synthesize a final result.
8. Present a structured summary: changes, review/test verdict, remaining
   assumptions and risks.  Then delete the task blackboard directory.`,
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

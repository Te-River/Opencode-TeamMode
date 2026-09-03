# Changelog

All notable changes to `@te-river/opencode-team-mode` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is semver, with the working-label "1.5.0" feature train shipped
under 1.4.x patch slots (the registry never saw a 1.5.0).

## [1.4.6] — 2026-09-03

Orchestration upgrade: hard pipeline gates, three-dimensional parallel
review, evidence standards, and blackboard contract discipline — tuned to
keep the lead coordinating instead of drifting into hand execution.

### Added — Team Lead
- **Pipeline gates (hard ordering)**: research gates planning; design gates
  code; code gates verify; verify gates review; UI verification gates done
  on user-visible frontend changes; all gates the final report; batch
  independent dispatches in one round; scale/skip phases with a one-line
  rationale.
- **Ultra Review**: every non-trivial change gets EXACTLY 3 parallel
  reviewer dispatches, one dimension each (completeness / correctness /
  impact, mutually ignored), merged by the lead into one severity-grouped
  report before the feedback loop. Trivial changes may skip with a stated
  reason.
- **Evidence standard**: "done / fixed / passed" claims without verifiable
  evidence (command output, logs, diffs, screenshots) are rejected — for
  sub-agents and the lead alike.
- **Discovery gate**: external CLI/API/runtime usage must be verified
  (`--help`, docs, versions) before any implementation dispatch that
  touches it.
- **Verbatim contracts**: when parallel implementers interoperate, the
  exact data contract is written once and pasted verbatim into every
  affected dispatch (mismatches are the #1 source of integration bugs).
- **README-first**: the lead reads the project's README (plus
  AGENTS.md/CLAUDE.md) before anything else and restates binding
  conventions in dispatches.
- **CHANGELOG maintenance**: delivered changes append an entry to the
  project's CHANGELOG.md (Keep-a-Changelog style) when one exists; the
  lead offers to create one when it doesn't.
- **Research perspectives**: 2+ researchers on the same codebase get
  distinct lenses (simplicity & maintainability / minimal-change risk /
  performance & runtime correctness) with file:line evidence required.

### Changed
- **Reviewer** is now a single-dimension reviewer: each dispatch reviews
  exactly one dimension (completeness / correctness / impact) with a
  per-dimension checklist; standalone use without a dimension defaults to
  correctness and says so. Severity scale, verdict lines, blackboard
  protocol and single-dimension re-review retained.
- **Tester** gained a UI verification mode: user-visible frontend changes
  are verified against the real page/flow with screenshot + console
  evidence; when no browser tooling exists the report ends with
  `UI NOT VERIFIED: <what needs manual checking>` instead of pretending.
- All specialists gained a shared **Evidence rule** (no narrative-only
  completions) and a **Project conventions** rule (README/AGENTS.md
  conventions in Reads outrank defaults).
- `/team-run` template mirrors the new workflow (README-first, gates,
  Ultra Review, changelog step); `/team-review` template selects the
  dimension with a correctness default.

### Fixed
- **Implementer fix-mode contradiction resolved:** the fix-mode instruction
  said "append to the same file" while the blackboard guarantee forbids
  appending to existing artifacts (frozen writes). Fix mode now writes a
  NEW round-suffixed file (`02-implementer-auth-r2.md`), consistent with
  the ownership model; the lead's MANIFEST.md is explicitly documented as
  the one artifact updated in place.

## [1.4.5] — 2026-08-28
- Team-as-default restored as shipped behavior: opt-OUT again
  (`defaultAgent: false` releases the slot); picker order is team, build,
  plan by default; mutual exclusion with "Team below Plan" documented both
  ways; test matrices rewritten for the `!== false` gate.

## [1.4.4] — 2026-08-27
- Shipped the working-label-1.5.0 train under the next patch slot:
  opt-in default-agent promotion (`{"defaultAgent": true}`), TTL sweeper as
  the sole board reclamation path, session-partitioned boards
  (`root/<session-key>/<task-slug>/`) with two-level sweep, team-lead
  anti-drift guardrails.

## [1.4.3] — 2026-08-2x
- Blackboard ownership model: per-agent topic files, frozen writes with
  round-suffixed revisions, ~100-line split guideline; lead-issued
  `Reads:`/`Write to:` dispatch manifest; `MANIFEST.md` Current-state
  header; triage Step-0 (question ≠ work order, propose-and-wait);
  user-stated boundaries outrank all rules.

## [1.4.1] — 2026-08-1x
- Renamed orchestrator agent `team-lead` → `team` (matches build/plan
  naming style); prompts, command binding, docs, installers, tests updated.

## [1.4.0] — 2026-08-1x
- Fixed loader contract to the ACTUAL v1 shape used by OpenCode Desktop
  1.18.x (verified by dissecting the shipped binary).

## [1.3.0] — 2026-08-1x
- Fixed Desktop 1.18.x loading (three compounding bugs in the plugin
  manifest/loader path).

## [1.2.1] — 2026-08-1x
- Specialists can write the blackboard themselves — removed the
  verbatim-transcription escape hatch.

## [1.2.0] — 2026-08-1x
- Shared blackboard coordination (file ownership, manifests) + prompt
  hardening.

## [1.0.x–1.1.x] — 2026-08
- Initial plugin: 6 agents (team / architect / implementer / reviewer /
  tester / researcher) + 6 slash commands, v2 plugin API migration,
  Chinese README, scoped package rename.

# Changelog

All notable changes to `@te-river/opencode-team-mode` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is semver, with the working-label "1.5.0" feature train shipped
under 1.4.x patch slots (the registry never saw a 1.5.0).

## [Unreleased]

## [1.5.0]

## [1.4.9] — 2026-09-06

### Fixed
- **Install scripts pin actual version**: `install.sh` and `install.ps1` now
  resolve the real latest version from the npm registry (`npm view`) and
  write `@te-river/opencode-team-mode@1.4.9` into `opencode.json(c)` instead
  of `@latest` — users can now see their installed version in the OpenCode
  Desktop plugin page.

## [1.4.8] — 2026-09-06

### Added
- **Project AGENTS.md**: the repo now ships its own AGENTS.md covering
  structure, commands, code conventions, prompt design principles, and
  development rules — so future agent sessions on this project get
  project-specific guidance out of the box.
- **Docs sync (CHANGELOG + AGENTS.md)**: delivered changes append a
  CHANGELOG.md entry when the file exists, and update AGENTS.md in place
  when a change alters what it records (build/test commands, conventions,
  project structure, agent instructions); either file is offered for
  creation when missing, and both are skipped when the user opted out.

### Changed
- **Approval gate threshold lowered from ≥3 to ≥2 planned sub-agent
  dispatches**: a two-dispatch pipeline now also presents a plan and waits
  for approval; only single-dispatch / direct-edit work runs without the
  gate. Anti-splitting (<2-dispatch sub-tasks) and mid-run upgrade (2nd
  dispatch) rules renumbered to match.
- **README/AGENTS.md reading deduplicated against the host**: opencode
  injects AGENTS.md/CLAUDE.md into context, so the lead reads the README
  itself (the host does not inject it) but uses the already-injected
  AGENTS.md/CLAUDE.md copy, opening the file only when genuinely absent;
  specialists never re-open these docs — conventions arrive distilled in
  their dispatches.

## [1.4.7] — 2026-09-04

The "subtraction" release: deterministic routing replaces free-form
scheduling deliberation, a structured reply skeleton replaces the mandatory
file blackboard, a count-based approval gate puts the user back in the loop,
verification returns to static checks, and review depth adapts to risk.
Tuned from a production run log that showed 80% of the effort going to
management and synchronization instead of problem-solving.

### Added — Team Lead
- **Deterministic routing table**: the lead picks a fixed pipeline row by
  task shape (question / docs-only / product change / multi-module feature /
  unknown external tech). Pipelines have FIXED minimums — a product change
  routed below 3 dispatches is a routing bug; splitting one request into
  sub-3-dispatch pieces to dodge the gate is a protocol violation.
- **Approval gate (count-based)**: ≥3 planned dispatches → research, present
  a ≤30-line plan, END TURN, and wait for user approval before executing
  anything. 0-2 dispatches run with a 1-2 line notice. Mid-run growth to a
  third dispatch pauses for approval. Pre-authorized sessions skip the gate.
- **Uncertainty policy**: blocking questions are batched into ONE message
  and asked immediately (never drip-fed, never guessed); non-blocking ones
  become plan assumptions.
- **No-ceremony fast path**: a root cause the lead has already verified
  (file:line evidence) goes straight to the implementer as a fix spec —
  no investigation dispatches to re-derive known answers.
- **Brevity discipline**: route selection is a table lookup; user-visible
  planning text stays ≤5 lines.
- **Reply-skeleton enforcement**: specialist replies must start with
  `STATUS: / CHANGES: / FINDINGS: / EVIDENCE: / HANDOFF:`; a missing
  skeleton is a PROTOCOL_VIOLATION → one re-dispatch with the skeleton
  inline → then downgrade and report.
- **Anti-drift tightening**: direct lead edits are now limited to
  non-product text (≤10 lines); product behavior changes are always
  dispatched.

### Changed
- **Blackboard demoted to hybrid**: the reply skeleton is the primary
  transport (≤50 lines inline, zero file I/O); board files exist only for
  oversized deliverables; `MANIFEST.md` is gone (the lead's todo list is its
  state memory); the `Reads:`/`Write to:` per-dispatch manifest requirement
  is dropped. The TTL sweeper (unchanged code) remains the sole cleanup path.
- **Adaptive review replaces fixed Ultra Review**: default is ONE reviewer
  dispatch (correctness); three parallel dimensions (completeness /
  correctness / impact) only for high-risk profiles — auth/security surface,
  cross-module data contracts, public APIs across ≥3 files.
- **Tester verifies statically**: build + typecheck + static analysis +
  API/unit tests. The UI verification mode is removed; improvised browser
  automation (headless screenshots, DOM stubs) is explicitly banned;
  user-visible frontend changes end with `UI NOT VERIFIED: <what needs
  manual checking>` unless the project already ships real browser-test
  tooling.
- **Anti-transcription rule (kept, relocated)**: specialists never hand full
  deliverables back for the lead to transcribe; the `BLACKBOARD WRITE
  FAILED` fallback is now owned by the lead.
- All six agents run at `temperature: 0.2` for format discipline.
- `/team-run` template mirrors the new workflow (routing, approval gate,
  skeleton relay, adaptive review, static verification, changelog step).
- `test-blackboard.mjs` prompt assertions updated to pin the v1.4.7
  contract (TTL sweeper tests unchanged).

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

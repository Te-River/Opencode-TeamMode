/**
 * tm_ptc_run — public contract types + the frozen engine seam.
 *
 * Design: .git/opencode-team/.../ptc-run/02-architect-ptc-run-design.md §2/§3.
 * Everything in this module is CONTRACT — frozen since M1 so M2's engines and
 * M3's registration could land without touching the driver or the tool.
 * (Split out of the former monolithic ptc.ts; behavior unchanged.)
 *
 * Governance is REUSED, never forked (D6 lock): the bridge calls the exact
 * four exported pipelines, so threshold offload, P2/P3, R6 and handle/TTL
 * semantics apply to every bridged call verbatim.  PTC is NOT a bypass layer.
 */

import type { TmPhase } from "../result.js"
import { shorten } from "../config.js"
import type { PtcBudgets } from "./budgets.js"

// ---------- statuses + bridge surface (design §2) ---------------------------

/** The six PTC run statuses (design §2; "program-error" added in the fix
 *  batch to separate PROGRAM faults — the body threw, engine healthy, no
 *  auto-degrade — from ENGINE faults). */
export const PTC_STATUS_VALUES = [
  "ok",
  "stopped-error-budget",
  "stopped-call-budget",
  "timeout",
  "engine-error",
  "program-error",
] as const
export type PtcStatus = (typeof PTC_STATUS_VALUES)[number]

export type BridgeTool =
  | "tm_read"
  | "tm_grep"
  | "tm_bash"
  | "tm_fetch"
  | "tm_search"
  | "tm_webfetch"

/**
 * Bridge allow set — read-only; tm_ptc_run itself is excluded (no nesting).
 * T6 added the two WEB bridges (tm_search / tm_webfetch): they are gated a
 * second time at the bridge layer (TM_PTC_WEB_BRIDGE=off → the bridge returns
 * an args error) and a THIRD time by the host ruleset — a bridged call runs
 * the real tm_search/tm_webfetch execute with the CALLER's per-execute ctx, so
 * ctx.ask evaluates against that agent's grant and a non-web role is denied
 * with a permission error (zero new mechanism).
 */
export const BRIDGE_ALLOW: readonly BridgeTool[] = [
  "tm_read",
  "tm_grep",
  "tm_bash",
  "tm_fetch",
  "tm_search",
  "tm_webfetch",
]

/** The web bridge tools — the subset gated behind TM_PTC_WEB_BRIDGE + role. */
export const WEB_BRIDGE_TOOLS: readonly BridgeTool[] = ["tm_search", "tm_webfetch"]

/** Phases safe to retry once (idempotent read-only bridges; design §4.2). */
// T6: tm_search / tm_webfetch issue GETs — idempotent — so their transient
// failures (client/execute/store phases) inherit the SAME one-retry policy;
// a permission/args error is never retried (the role denial must stand).
export const RETRYABLE_PHASES: readonly TmPhase[] = ["client", "execute", "store"]

/** Error body the bridge surfaces (T1.4 shape: tool/phase/message/line?). */
export interface PtcErrorBody {
  tool: string
  phase: TmPhase
  message: string
  line?: number
}

/** A single bridged-call outcome (design §2 program protocol). */
export type PtcCallResult =
  | { ok: true; data: unknown }
  | { ok: false; error: PtcErrorBody }

/** The bridge the engine drives — every call runs the gate-wrapped pipelines. */
export interface PtcBridge {
  call(tool: BridgeTool, args: Record<string, unknown>): Promise<PtcCallResult>
}

// ---- RPC message surface (the worker engine speaks exactly this) ----------

/** Parent → engine: run the program. */
export interface PtcRunRequest {
  program: string
  /** monotonic token so a caller can correlate a call with its response. */
  startDeadlineMs: number
  /** wall-clock budget in ms — the worker engine sets it as the in-engine
   *  vm script timeout (kills pre-await sync busy-loops in-engine,
   *  complementary to the driver-side abort→terminate). */
  timeoutMs?: number
}

/** Engine → driver: a single bridged call to execute under the gate. */
export interface PtcRpcRequest {
  t: "call"
  id: number
  tool: BridgeTool
  args: Record<string, unknown>
}

/** Driver → engine: the gated result of a call. */
export interface PtcRpcResponse {
  t: "result"
  id: number
  r: PtcCallResult
}

/** Driver → engine: stop the run (budget / time hit); engine must unwind. */
export interface PtcRpcAbort {
  t: "abort"
  id: number
  reason: "timeout" | "error-budget" | "call-budget"
}

export type PtcEngineMessage = PtcRpcRequest | PtcRpcResponse | PtcRpcAbort

export type PtcEngineName = "worker" | "inline"

/**
 * The engine seam — FROZEN.  InlineSequentialEngine shipped in M1,
 * WorkerEngine + InlineVmEngine in M2; a future engine implements this same
 * shape and neither the driver nor the tool changes.  (Fix batch: the
 * OPTIONAL `opts` 4th param extends the seam source-compatibly — existing
 * engines may ignore it; the worker engine turns `timeoutMs` into the
 * in-engine vm script timeout.)
 */
export interface PtcEngine {
  readonly name: PtcEngineName
  /**
   * Run `program`, driving every bridge call through `bridge` (already
   * gate-wrapped by the driver). Resolve with the program's return value;
   * reject with a `PtcStopSignal` for a budget/time stop, a
   * `PtcProgramError` for a program fault, or any other Error for an
   * engine fault. `signal` lets the driver race a timeout.
   */
  run(
    program: string,
    bridge: PtcBridge,
    signal: AbortSignal,
    opts?: PtcEngineRunOpts,
  ): Promise<unknown>
}

/** Per-run hints handed to the engine (optional, ignorable). */
export interface PtcEngineRunOpts {
  startDeadlineMs?: number
  timeoutMs?: number
}

/**
 * The stop signal unwinding a program on a budget/time hit.  Thrown by the
 * StepGate (call/error budget, pre-call deadline) and rejected through the
 * engines' abort promises (wall-clock timeout); caught by the driver, which
 * maps it to a status.  Never escapes as an engine-error.
 */
export class PtcStopSignal extends Error {
  constructor(readonly reason: "timeout" | "error-budget" | "call-budget") {
    super(`ptc-stop:${reason}`)
    this.name = "PtcStopSignal"
  }
}

/**
 * A PROGRAM fault — the program body itself threw (the worker bootstrap
 * posts kind:"program"; the inline-vm engine tags promise rejections).
 * Distinct from an engine fault: the engine is healthy, so the driver maps
 * it to status "program-error" and NEVER auto-degrades (re-running the same
 * program would just throw again).
 */
export class PtcProgramError extends Error {
  constructor(message: string, stack?: string) {
    super(message)
    this.name = "PtcProgramError"
    if (typeof stack === "string" && stack) this.stack = stack
  }
}

/** Short display code for a ref: the `steps/<id>` step segment.  Shared by
 *  the gate (success table) and the summary renderer (error refs). */
export function shortRefCode(ref: string): string {
  const m = /\/steps\/([^/]+)\/result/.exec(ref)
  return m ? m[1] : shorten(ref, 24)
}

// ---------- per-step record + run outcome ------------------------------------

export interface PtcStepRecord {
  n: number
  tool: BridgeTool
  ok: boolean
  ms: number
  /** ok rows: estimated tokens (inline text) or the offload handle's tokens. */
  tokens: number
  /** ok rows: "inline" or a short ref code for an offloaded payload. */
  dest: string
  /** ok rows: the offload ref (when the data was a handle), else null. */
  ref?: string | null
  /** err rows only. */
  phase?: TmPhase
  line?: number
  retry?: boolean
  message?: string
  errorRef?: string
}

export interface PtcRunOutcome {
  label: string
  status: PtcStatus
  steps: PtcStepRecord[]
  okCount: number
  errCount: number
  retries: number
  calls: number
  ms: number
  engine: PtcEngineName
  degraded: boolean
  returnValue: unknown
  returned: boolean
  /** set when the program or engine faulted (engine-error / program-error). */
  engineError?: PtcErrorBody
  /** budgets echo (fix batch T1): the EFFECTIVE values + which fields were
   *  user-set / clamped — rendered as the summary's budgets line so the
   *  operator sees clamping, not just the final numbers. */
  budgets?: PtcBudgets
  parentStepId: string
}

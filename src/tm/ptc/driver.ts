/**
 * tm_ptc_run — the run driver: engine selection (auto / worker / inline),
 * the static pre-scan handoff, wall-clock timeout, status mapping, and the
 * trajectory parent events.  Split out of the former monolithic ptc.ts;
 * behavior unchanged.
 */

import * as crypto from "node:crypto"
import type { TmConfig } from "../config.js"
import type { RunStore } from "../store.js"
import type { PtcBridge, PtcEngine, PtcRunOutcome, PtcStatus } from "./contract.js"
import { PtcProgramError, PtcStopSignal } from "./contract.js"
import type { GateState } from "./gate.js"
import { createGateBridge } from "./gate.js"
import { InlineVmEngine, WorkerEngine } from "./engines.js"
import { staticPscan } from "./pscan.js"
import type { PtcBudgets } from "./budgets.js"

// ---------- engine selection (auto / worker / inline) ------------------------

export interface EngineSelection {
  engine: PtcEngine
  /** true when the auto chain degraded from worker to inline. */
  degraded: boolean
}

/**
 * Select the PTC engine based on the TM_PTC_ENGINE mode.
 *  - "worker": WorkerEngine only (throws on failure → engine-error status).
 *  - "inline": InlineVmEngine only (script timeout for pre-await busy-loops).
 *  - "auto" (default): worker-first — the REAL auto-degrade happens in
 *    runPtc, which re-runs the whole program on InlineVmEngine ONLY when a
 *    worker run returns engine-error having made ZERO bridged calls (the
 *    worker could not start).  A worker that started and then crashed is
 *    reported program-error / engine-error-with-calls and is NEVER replayed
 *    on the inline realm (C1: never re-run a started program).
 */
export function selectEngine(mode: "auto" | "worker" | "inline", bridge: PtcBridge): EngineSelection {
  void bridge
  if (mode === "inline") {
    return { engine: new InlineVmEngine(), degraded: false }
  }
  // auto and worker both start on the worker engine (construction never
  // throws — no spawn until run()).
  return { engine: new WorkerEngine(), degraded: false }
}

export interface RunPtcOptions {
  program: string
  label: string
  budgets: PtcBudgets
  parentStepId: string
  cfg: TmConfig
  store?: RunStore
  bridge: PtcBridge
  engine?: PtcEngine
  now?: () => number
}

export async function runPtc(o: RunPtcOptions): Promise<PtcRunOutcome> {
  const now = o.now ?? Date.now
  const start = now()
  const deadlineAt = start + o.budgets.timeoutMs
  // engine selection — explicit override or auto/worker/inline from config.
  let engine: PtcEngine
  let degraded = false
  if (o.engine) {
    engine = o.engine
  } else {
    const sel = selectEngine(o.cfg.ptcEngine, o.bridge)
    engine = sel.engine
    degraded = sel.degraded
  }

  // static pre-scan — reject programs with banned tokens before any
  // engine runs.  Shape: engine-error with the pscan tokens listed.
  // (Design §3: "辅助手段，声明不作安全边界".)
  const pscan = staticPscan(o.program)
  if (pscan.rejected) {
    return {
      label: o.label,
      status: "engine-error",
      steps: [],
      okCount: 0,
      errCount: 0,
      retries: 0,
      calls: 0,
      ms: 0,
      engine: engine.name,
      degraded,
      returnValue: undefined,
      returned: false,
      engineError: {
        tool: "tm_ptc_run",
        phase: "args",
        message: `程序包含禁止标识符（${pscan.tokens.join(", ")}），已拒绝执行。`,
      },
      budgets: o.budgets,
      parentStepId: o.parentStepId,
    }
  }

  // Auto-degrade: if the selected engine reports an ENGINE fault (not a
  // budget stop, not a program fault), and we're in auto mode, retry with
  // InlineVmEngine.  A program fault is tagged PtcProgramError by the
  // engines and mapped to "program-error" below — it never re-runs (the
  // same program would just throw again).
  const tryRun = async (eng: PtcEngine, parentId: string = o.parentStepId): Promise<PtcRunOutcome> => {
    const state: GateState = { calls: 0, errors: 0, retries: 0, steps: [] }
    const gate = createGateBridge(o.bridge, parentId, o.budgets, state, {
      now,
      deadlineAt,
      store: o.store,
    })

    // parent call event (design §6)
    o.store?.appendTrajectory({
      tool: "tm_ptc_run",
      step_id: parentId,
      event: "call",
      label: o.label,
      program_sha256: crypto.createHash("sha256").update(o.program).digest("hex"),
      budgets: o.budgets,
    })

    const ac = new AbortController()
    const remaining = Math.max(0, deadlineAt - now())
    const timer = setTimeout(() => ac.abort(), remaining)

    let status: PtcStatus
    let returnValue: unknown
    let returned = false
    let engineError: PtcRunOutcome["engineError"]
    try {
      returnValue = await eng.run(o.program, gate, ac.signal, {
        startDeadlineMs: deadlineAt,
        timeoutMs: o.budgets.timeoutMs,
      })
      returned = true
      status = state.stopReason ? mapStop(state.stopReason) : "ok"
    } catch (err) {
      if (err instanceof PtcStopSignal) {
        status = mapStop(err.reason)
      } else if (err instanceof PtcProgramError) {
        // T5: the PROGRAM threw — distinct status, NO auto-degrade re-run.
        status = "program-error"
        const line = extractLine(err)
        engineError = {
          tool: "tm_ptc_run",
          phase: "execute",
          message: err.message,
          ...(line != null ? { line } : {}),
        }
      } else {
        status = "engine-error"
        const line = extractLine(err)
        engineError = {
          tool: "tm_ptc_run",
          phase: "execute",
          message: err instanceof Error ? err.message : String(err ?? "engine error"),
          ...(line != null ? { line } : {}),
        }
      }
    } finally {
      clearTimeout(timer)
    }

    const ms = now() - start
    const outcome: PtcRunOutcome = {
      label: o.label,
      status,
      steps: state.steps,
      okCount: state.steps.filter((s) => s.ok).length,
      errCount: state.steps.filter((s) => !s.ok).length,
      retries: state.retries,
      calls: state.calls,
      ms,
      engine: eng.name,
      degraded,
      returnValue,
      returned,
      ...(engineError ? { engineError } : {}),
      budgets: o.budgets,
      parentStepId: parentId,
    }
    o.store?.appendTrajectory({
      tool: "tm_ptc_run",
      step_id: parentId,
      event: "finish",
      status: outcome.status,
      calls: outcome.calls,
      errors: outcome.errCount,
      retries: outcome.retries,
      ms: outcome.ms,
    })
    return outcome
  }

  // Auto mode: try worker first.  C1 (never replay a started program): degrade
  // to the inline-vm engine ONLY when the worker could not START at all — an
  // ENGINE fault with ZERO bridged calls dispatched (the program never ran).
  // A worker that started and THEN crashed surfaces as `program-error` (the
  // engines tag any post-online crash a program fault) or as an `engine-error`
  // with calls > 0; in BOTH such cases we return as-is and do NOT re-run the
  // program on the more-privileged inline/ESM realm — re-running a program
  // that already executed is exactly the sandbox-escape amplification the
  // reviewer's PoC turned on.  An INJECTED engine participates too (tests
  // inject crashers); the fallback is always the real InlineVmEngine.
  if (o.cfg.ptcEngine === "auto" && engine.name === "worker") {
    const result = await tryRun(engine)
    if (result.status === "engine-error" && result.calls === 0) {
      // Degrade to inline-vm and re-run.
      const inlineEngine = new InlineVmEngine()
      const fallback = await tryRun(inlineEngine, `${o.parentStepId}.r2`)
      fallback.degraded = true
      fallback.engine = "inline"
      fallback.parentStepId = o.parentStepId
      return fallback
    }
    return result
  }

  return tryRun(engine)
}

function mapStop(reason: "timeout" | "error-budget" | "call-budget"): PtcStatus {
  if (reason === "timeout") return "timeout"
  if (reason === "error-budget") return "stopped-error-budget"
  return "stopped-call-budget"
}

/** Best-effort line extraction from a program-side thrown error stack. */
function extractLine(err: unknown): number | undefined {
  const s = err instanceof Error ? err.stack ?? "" : String(err ?? "")
  const m = /:(\d+):/.exec(s)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n)) return n
  }
  const m2 = /line[:#]?\s*(\d+)/i.exec(s)
  return m2 ? Number(m2[1]) : undefined
}

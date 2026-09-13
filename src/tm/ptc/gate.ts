/**
 * tm_ptc_run — the StepGate.  All budget/retry/step-id/trajectory logic lives
 * ONLY here (outside the engines), per design §3 ("决策进代码").  Split out
 * of the former monolithic ptc.ts; behavior unchanged.
 */

import { estimateTokens, shorten } from "../config.js"
import { buildRef } from "../refs.js"
import type { RunStore } from "../store.js"
import type { BridgeTool, PtcBridge, PtcCallResult, PtcStepRecord } from "./contract.js"
import { PtcStopSignal, RETRYABLE_PHASES, shortRefCode } from "./contract.js"
import type { PtcBudgets } from "./budgets.js"

export interface GateState {
  calls: number
  errors: number
  retries: number
  steps: PtcStepRecord[]
  stopReason?: "timeout" | "error-budget" | "call-budget"
}

/**
 * Wrap a raw bridge with the StepGate.  Every call: enforce time/call budget
 * (throw a stop that unwinds the program), assign a composite step id
 * `parent.kNN`, retry ≤1 on idempotent phases, record + persist errors, and
 * trip the error budget.
 */
export function createGateBridge(
  raw: PtcBridge,
  parent: string,
  budgets: PtcBudgets,
  state: GateState,
  opts: { now: () => number; deadlineAt: number; store?: RunStore; trajectoryParent?: string },
): PtcBridge {
  const { now, deadlineAt, store } = opts
  const ptcTag = opts.trajectoryParent ?? parent
  let seq = 0
  const traj = (e: Record<string, unknown>) => store?.appendTrajectory(e)
  return {
    async call(tool, args): Promise<PtcCallResult> {
      if (state.stopReason) throw new PtcStopSignal(state.stopReason)
      // time budget checked BEFORE the call so a run cannot start a call it
      // has no time left for.
      if (now() >= deadlineAt) {
        state.stopReason = "timeout"
        throw new PtcStopSignal("timeout")
      }
      // call budget: only `maxCalls` bridged calls may be dispatched.
      if (state.calls >= budgets.maxCalls) {
        state.stopReason = "call-budget"
        throw new PtcStopSignal("call-budget")
      }
      state.calls++
      seq++
      const composite = `${parent}.k${String(seq).padStart(2, "0")}`
      traj({ tool, step_id: composite, event: "call", ptc: ptcTag })
      const t0 = now()
      let res = await raw.call(tool, args)
      let retried = false
      // ≤1 retry on idempotent phases — but never PAST the deadline: a
      // retryable failure at the wire must not buy extra wall-clock time.
      // The retry still rides the same budget unit (one call = one unit).
      if (!res.ok && RETRYABLE_PHASES.includes(res.error.phase) && now() < deadlineAt) {
        retried = true
        state.retries++
        res = await raw.call(tool, args)
      }
      const ms = now() - t0
      if (res.ok) {
        const { tokens, dest, ref } = describeOk(res.data)
        state.steps.push({ n: seq, tool, ok: true, ms, tokens, dest, ref })
        traj({
          tool,
          step_id: composite,
          event: "result",
          offloaded: Boolean(ref),
          tokens,
          ptc: ptcTag,
          ...(ref ? { ref } : {}),
        })
        return res
      }
      // error path — full text persists to steps/sXXXX.kNN/ (design §4.1)
      state.errors++
      const err = res.error
      let errorRef: string | undefined
      if (store) {
        try {
          store.writeResult(composite, {
            tool,
            content: JSON.stringify({ error: err }, null, 2),
            tokens: estimateTokens(JSON.stringify(err)),
            contentType: "json",
            preview: shorten(err.message, 120),
            expireAt: Date.now() + 24 * 60 * 60 * 1000,
          })
          errorRef = buildRef(store.runId, composite)
        } catch {
          /* error persistence is best-effort; never mask the original error */
        }
      }
      state.steps.push({
        n: seq,
        tool,
        ok: false,
        ms,
        tokens: 0,
        dest: "err",
        phase: err.phase,
        line: err.line,
        retry: retried,
        message: err.message,
        errorRef,
      })
      traj({
        tool,
        step_id: composite,
        event: "error",
        phase: err.phase,
        ...(typeof err.line === "number" ? { line: err.line } : {}),
        retry: retried,
        ptc: ptcTag,
        ...(errorRef ? { ref: errorRef } : {}),
      })
      if (state.errors >= budgets.maxErrors) {
        state.stopReason = "error-budget"
        throw new PtcStopSignal("error-budget")
      }
      return res
    },
  }
}

/** Describe an ok bridge result for the success table (inline vs handle). */
function describeOk(data: unknown): { tokens: number; dest: string; ref: string | null } {
  if (data && typeof data === "object" && (data as { offloaded?: unknown }).offloaded === true) {
    const o = data as { tokens?: unknown; ref?: unknown }
    const ref = typeof o.ref === "string" ? o.ref : null
    return {
      tokens: typeof o.tokens === "number" ? o.tokens : 0,
      dest: ref ? `ref:${shortRefCode(ref)}` : "ref",
      ref,
    }
  }
  const text = typeof data === "string" ? data : JSON.stringify(data ?? "")
  return { tokens: estimateTokens(text), dest: "inline", ref: null }
}

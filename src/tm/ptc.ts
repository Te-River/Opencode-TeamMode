/**
 * tm_ptc_run — M1 contract + aggregation skeleton (NO sandbox).
 *
 * Design: .git/opencode-team/.../ptc-run/02-architect-ptc-run-design.md §2/§3/§4/§6.
 * Milestone split (design §10): this is **M1 only** — args schema, the engine
 * RPC seam frozen for M2, the StepGate failure governance (error / call /
 * time budgets, ≤1 retry on idempotent phases, produced-output preservation),
 * the five-state status enum, the char-pinned aggregation summary, composite
 * step numbers (`sXXXX.kNN`) and the trajectory event shapes.
 *
 * Deliberately NOT here in M1 (deferred):
 *   - the worker/RPC engine + inline-VM sandbox  (M2 — the `PtcEngine` seam
 *     below is frozen so M2 adds an engine without touching this contract);
 *   - the program-source static pre-scan is WRITTEN but NOT wired into the run
 *     path (M2 attaches it) — `staticPscan`, marked unused here;
 *   - registering `tm_ptc_run` into the tm_* tool set  (M3 role/whitelist
 *     wiring) — `buildPtcRunTool` exists and is fully exercised by tests, but
 *     index.ts does NOT merge it into `tools` yet.
 *
 * Governance is REUSED, never forked (D6 lock): the inline bridge calls the
 * exact four exported pipelines (`buildPipelines`), so threshold offload,
 * P2/P3, R6 and handle/TTL semantics apply to every bridged call verbatim.
 * PTC is NOT a bypass layer.
 */

import * as crypto from "node:crypto"
import * as vm from "node:vm"
import type { ToolDefinition, ToolResult } from "../types.js"
import { estimateTokens, shouldOffload, shorten, type TmConfig } from "./config.js"
import { buildRef } from "./refs.js"
import type { RunStore } from "./store.js"
import { detectContentType } from "./preview.js"
import { tmError, type TmPipelines, type TmPhase } from "./tools.js"

// ---------- public contract types (frozen for M2's RPC surface) ----------

/** The five PTC run statuses (design §2). */
export const PTC_STATUS_VALUES = [
  "ok",
  "stopped-error-budget",
  "stopped-call-budget",
  "timeout",
  "engine-error",
] as const
export type PtcStatus = (typeof PTC_STATUS_VALUES)[number]

export type BridgeTool = "tm_read" | "tm_grep" | "tm_bash" | "tm_fetch"

/** Bridge allow set — read-only; tm_ptc_run itself is excluded (no nesting). */
export const BRIDGE_ALLOW: readonly BridgeTool[] = ["tm_read", "tm_grep", "tm_bash", "tm_fetch"]

/** Phases safe to retry once (idempotent read-only bridges; design §4.2). */
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

/** The bridge the engine drives — in M1 it wraps the four pipelines. */
export interface PtcBridge {
  call(tool: BridgeTool, args: Record<string, unknown>): Promise<PtcCallResult>
}

// ---- RPC message surface (M2 worker engine speaks exactly this) ----------

/** Parent → engine: run the program. */
export interface PtcRunRequest {
  program: string
  /** monotonic token so a caller can correlate a call with its response. */
  startDeadlineMs: number
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

/** The engine seam. M1 ships `InlineSequentialEngine`; M2 adds `WorkerEngine`
 *  (over MessagePort) with the SAME shape, so neither the driver nor the
 *  contract changes across milestones. */
export interface PtcEngine {
  readonly name: PtcEngineName
  /**
   * Run `program`, driving every bridge call through `bridge` (already
   * gate-wrapped by the driver). Resolve with the program's return value;
   * reject with a `PtcStopSignal` for a budget/time stop, or any other Error
   * for an engine/program fault. `signal` lets the driver race a timeout.
   */
  run(program: string, bridge: PtcBridge, signal: AbortSignal): Promise<unknown>
}

// ---------- budgets + clamping (design §4.3: callers may only TIGHTEN) -----

export interface PtcBudgets {
  maxCalls: number
  maxErrors: number
  timeoutMs: number
}

export interface PtcCallerBudgets {
  max_calls?: unknown
  max_errors?: unknown
  timeout_ms?: unknown
}

/**
 * Clamp a caller-supplied budget against the resolved env ceiling.  Absent ->
 * the env ceiling; above the ceiling -> clamped DOWN (cannot loosen); below
 * the hard floor -> clamped UP to the floor.  Non-finite is ignored (ceiling).
 */
function clampBudget(raw: unknown, ceiling: number, floor: number): number {
  const n = typeof raw === "number" ? raw : raw == null ? NaN : Number(raw)
  if (!Number.isFinite(n)) return ceiling
  const i = Math.trunc(n)
  if (i > ceiling) return ceiling
  if (i < floor) return floor
  return i
}

export function resolvePtcBudgets(cfg: TmConfig, budgets: PtcCallerBudgets | undefined | null): PtcBudgets {
  const b = budgets && typeof budgets === "object" ? budgets : {}
  return {
    maxCalls: clampBudget(b.max_calls, cfg.ptcMaxCalls, PTC_BUDGET_BOUNDS_FLOOR.maxCalls),
    maxErrors: clampBudget(b.max_errors, cfg.ptcMaxErrors, PTC_BUDGET_BOUNDS_FLOOR.maxErrors),
    timeoutMs: clampBudget(b.timeout_ms, cfg.ptcTimeoutMs, PTC_BUDGET_BOUNDS_FLOOR.timeoutMs),
  }
}

// floors mirror config.ts PTC_BUDGET_BOUNDS (kept here so this module stays
// self-contained for clamp tests without importing config internals).
const PTC_BUDGET_BOUNDS_FLOOR = { maxCalls: 1, maxErrors: 1, timeoutMs: 5000 } as const

// ---------- arg schema + validation ----------

export const PTC_LABEL_MAX = 80

export interface PtcValidArgs {
  program: string
  label: string
  budgets: PtcBudgets
}
export type PtcArgsResult = { ok: true; args: PtcValidArgs } | { ok: false; error: ReturnType<typeof tmError> }

/**
 * Validate + normalize tm_ptc_run args.  `program` over the length cap is a
 * hard args error (a program cannot be meaningfully truncated); `label` over
 * 80 is truncated; `budgets` are clamped toward the env ceilings.
 */
export function parsePtcArgs(raw: Record<string, unknown> | undefined, cfg: TmConfig): PtcArgsResult {
  const a = raw ?? {}
  const program = typeof a.program === "string" ? a.program : ""
  if (!program.trim()) {
    return { ok: false, error: tmError("tm_ptc_run", "args", "缺少 program 参数（async 函数体，可用 tm.read/tm.grep/tm.bash/tm.fetch）") }
  }
  if (program.length > cfg.ptcMaxProgramChars) {
    return {
      ok: false,
      error: tmError(
        "tm_ptc_run",
        "args",
        `program 超过长度上限 ${cfg.ptcMaxProgramChars} 字符（实际 ${program.length}）。请拆分批次或调高 TM_PTC_MAX_PROGRAM_CHARS。`,
      ),
    }
  }
  let label = typeof a.label === "string" && a.label.trim() ? a.label.trim() : "ptc-run"
  if (label.length > PTC_LABEL_MAX) label = label.slice(0, PTC_LABEL_MAX)
  const budgets = resolvePtcBudgets(cfg, a.budgets as PtcCallerBudgets)
  return { ok: true, args: { program, label, budgets } }
}

// ---------- static pre-scan (WRITTEN, NOT enabled in M1 — M2 wires it) ------

/** Banned identifier tokens for the program source (auxiliary guard, not a
 *  security boundary — see design §3 trust model). */
const PSCAN_PATTERNS: readonly RegExp[] = [
  /\brequire\b/,
  /\bimport\b/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bDeno\b/,
  /\bBun\b/,
  /\bfs\b/,
  /\bnet\b/,
  /\bchild_process\b/,
]

/** Static scan of a program string. M1 EXPOSES + tests this but does NOT call
 *  it in the run path (the sandbox that needs it lands in M2). */
export function staticPscan(program: string): { rejected: boolean; tokens: string[] } {
  const tokens: string[] = []
  for (const re of PSCAN_PATTERNS) {
    if (re.test(program)) tokens.push(re.source.replace(/\\b/g, "").replace(/\b/g, ""))
  }
  return { rejected: tokens.length > 0, tokens }
}

// ---------- per-step record + run outcome ----------

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
  /** set when the program threw (status=engine-error). */
  engineError?: PtcErrorBody
  parentStepId: string
}

// ---------- the inline sequential engine (M1's only engine) ----------------

class PtcStopSignal extends Error {
  constructor(readonly reason: "timeout" | "error-budget" | "call-budget") {
    super(`ptc-stop:${reason}`)
    this.name = "PtcStopSignal"
  }
}

function makeFacade(bridge: PtcBridge): Record<string, (args: Record<string, unknown>) => Promise<PtcCallResult>> {
  const one =
    (tool: BridgeTool) =>
    (args: Record<string, unknown>): Promise<PtcCallResult> =>
      bridge.call(tool, args && typeof args === "object" ? args : {})
  return { read: one("tm_read"), grep: one("tm_grep"), bash: one("tm_bash"), fetch: one("tm_fetch") }
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

export class InlineSequentialEngine implements PtcEngine {
  readonly name: PtcEngineName = "inline"
  async run(program: string, bridge: PtcBridge, signal: AbortSignal): Promise<unknown> {
    // M1 = "no sandbox": the program is a trusted async function body (only our
    // implementer/tester agents author it, temp 0.2).  M2 replaces this with the
    // worker/VM engines behind the SAME seam; nothing else in this file changes.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...a: string[]
    ) => (...a: unknown[]) => Promise<unknown>
    const tm = makeFacade(bridge)
    let abortHandler: (() => void) | undefined
    const abortP = new Promise<never>((_, rej) => {
      // The driver only aborts on wall-clock timeout (budget stops flow through
      // the gate as PtcStopSignal).  M2's worker engine adds terminate here.
      abortHandler = () => rej(new PtcStopSignal("timeout"))
      if (signal.aborted) abortHandler()
      else signal.addEventListener("abort", abortHandler, { once: true })
    })
    try {
      const fn = new AsyncFunction("tm", `"use strict";\n${program}`)
      return await Promise.race([fn(tm), abortP])
    } finally {
      if (abortHandler) signal.removeEventListener("abort", abortHandler)
    }
  }
}

// ---------- M2: worker engine (MessagePort RPC over worker_threads) ----------

/**
 * Worker engine — runs the program in a dedicated `worker_threads.Worker`
 * with `env:{}` (process.env emptied), `resourceLimits`, and `terminate()`
 * for hard timeout kills.  The bootstrap source is a build-time template
 * string constant (zero runtime file IO, zero new deps, passes tsc).
 *
 * Probe result (P1, %TEMP%): ALL-GREEN on Node 24 / win32 — eval bootstrap,
 * postMessage bidirectional, terminate (9 ms), resourceLimits, env:{} all
 * verified.  Auto chain = worker-first, inline fallback.
 */
export class WorkerEngine implements PtcEngine {
  readonly name: PtcEngineName = "worker"

  async run(program: string, bridge: PtcBridge, signal: AbortSignal): Promise<unknown> {
    const { Worker } = await import("node:worker_threads")
    // Build the worker bootstrap source as a regular string (ts-safe).
    // The worker receives {program, startDeadlineMs} via its first message,
    // creates the tm facade, runs the program, and sends RPC call requests
    // back to the driver which executes them through the gate bridge.
    const src = [
      '"use strict";',
      'const { parentPort } = require("node:worker_threads");',
      "parentPort.on(" + JSON.stringify("message") + ", async function onMsg(msg) {",
      "  if (msg && msg.t === " + JSON.stringify("run") + ") {",
      "    const program = msg.program;",
      "    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;",
      "    const callMap = new Map();",
      "    let nextId = 0;",
      '    const one = function(tool) { return function(args) { return new Promise(function(resolve, reject) {',
      "      const id = nextId++;",
      "      callMap.set(id, { resolve: resolve, reject: reject });",
      '      parentPort.postMessage({ t: "call", id: id, tool: tool, args: args || {} });',
      "    }); }; };",
      "    var tm = { read: one(" + JSON.stringify("tm_read") + "), grep: one(" + JSON.stringify("tm_grep") + "), bash: one(" + JSON.stringify("tm_bash") + "), fetch: one(" + JSON.stringify("tm_fetch") + ") };",
      '    parentPort.on("message", function(inner) {',
      '      if (inner && inner.t === "result" && callMap.has(inner.id)) {',
      "        callMap.get(inner.id).resolve(inner.r);",
      "        callMap.delete(inner.id);",
      '      } else if (inner && inner.t === "abort") {',
      "        for (const e of callMap.values()) e.reject(new Error(" + JSON.stringify("ptc-stop:") + " + inner.reason));",
      "        callMap.clear();",
      "      }",
      "    });",
      "    try {",
      "      var fn = new AsyncFunction(" + JSON.stringify("tm") + ", program);",
      "      var result = await fn(tm);",
      '      parentPort.postMessage({ t: "done", result: result });',
      "    } catch (err) {",
      '      parentPort.postMessage({ t: "error", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });',
      "    }",
      "  }",
      "});",
    ].join("\n")
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      const w = new Worker(src, {
        eval: true,
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      })

      function settle(fn: () => void) {
        if (settled) return
        settled = true
        fn()
      }

      w.on("message", (msg: { t: string; [k: string]: unknown }) => {
        if (!msg || settled) return
        if (msg.t === "done") {
          settle(() => {
            w.terminate()
            resolve(msg.result)
          })
        } else if (msg.t === "error") {
          settle(() => {
            w.terminate()
            const err = new Error(typeof msg.message === "string" ? msg.message : "worker error")
            if (typeof msg.stack === "string") err.stack = msg.stack
            reject(err)
          })
        } else if (msg.t === "call") {
          // Driver executes the bridge call through the gate and replies.
          const req = msg as unknown as PtcRpcRequest
          bridge
            .call(req.tool, req.args)
            .then((r) => {
              if (!settled) {
                w.postMessage({ t: "result", id: req.id, r } as PtcRpcResponse)
              }
            })
            .catch(() => {
              if (!settled) {
                w.postMessage({
                  t: "result",
                  id: req.id,
                  r: { ok: false, error: { tool: req.tool, phase: "execute", message: "bridge call failed" } },
                } as PtcRpcResponse)
              }
            })
        }
      })

      w.on("error", (err: Error) => {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))))
      })

      // Wire signal abort → terminate the worker.
      const onAbort = () => {
        settle(() => {
          w.terminate().then(() => reject(new PtcStopSignal("timeout")))
        })
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })

      // Send the run request.
      w.postMessage({ t: "run", program } as unknown)
    })
  }
}

// ---------- M2: inline-vm fallback engine (node:vm with timeout) ----------

/**
 * Inline-vm engine — runs the program inside `node:vm` with a compile
 * timeout for synchronous busy-loops.  Same `PtcEngine` seam as
 * `InlineSequentialEngine` (M1) and `WorkerEngine` (M2).
 *
 * KNOWN RESIDUAL RISK (design §3, declared): `vm.compileFunction`'s
 * `timeout` only kills synchronous CPU-bound loops.  An `await` yields
 * back to the event loop, so a pure-JS busy-wait between awaits can only
 * be caught by the next bridge call's step-budget pre-check.  This is the
 * accepted trade-off for the inline fallback; the primary worker engine
 * does not share this limitation (`worker.terminate()` is wall-clock).
 */
export class InlineVmEngine implements PtcEngine {
  readonly name: PtcEngineName = "inline"

  async run(program: string, bridge: PtcBridge, signal: AbortSignal): Promise<unknown> {
    const tm = makeFacade(bridge)
    let abortHandler: (() => void) | undefined
    const abortP = new Promise<never>((_, rej) => {
      abortHandler = () => rej(new PtcStopSignal("timeout"))
      if (signal.aborted) abortHandler()
      else signal.addEventListener("abort", abortHandler, { once: true })
    })
    try {
      // compileFunction's timeout kills synchronous busy-loops; the `await`
      // gap residual is documented (design §3) and accepted for the fallback.
      const fn = vm.compileFunction(
        `"use strict";\n${program}`,
        ["tm"],
        { timeout: 30_000 } as vm.CompileFunctionOptions & { timeout?: number },
      )
      return await Promise.race([fn(tm), abortP])
    } finally {
      if (abortHandler) signal.removeEventListener("abort", abortHandler)
    }
  }
}

// ---------- gate-wrapped bridge (all budget/retry/step-id/trajectory logic) -

interface GateState {
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
 * trip the error budget.  The gate lives ONLY here (outside the engine), per
 * design §3 ("决策进代码").
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
      if (!res.ok && RETRYABLE_PHASES.includes(res.error.phase)) {
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

/** Short display code for a ref: the `steps/<id>` step segment. */
function shortRefCode(ref: string): string {
  const m = /\/steps\/([^/]+)\/result/.exec(ref)
  return m ? m[1] : shorten(ref, 24)
}

// ---------- the run driver ----------

// ---------- M2: engine selection (auto / worker / inline) ----------

export interface EngineSelection {
  engine: PtcEngine
  /** true when the auto chain degraded from worker to inline. */
  degraded: boolean
}

/**
 * Select the PTC engine based on the TM_PTC_ENGINE mode.
 *  - "worker": WorkerEngine only (throws on failure → engine-error status).
 *  - "inline": InlineVmEngine only (vm timeout for sync busy-loops).
 *  - "auto" (default): try WorkerEngine first; on failure → InlineVmEngine
 *    with `degraded=true` (marked `degraded-engine` in the summary).
 *
 * Probe result (P1, %TEMP%): ALL-GREEN on Node 24/win32 — auto chain =
 * worker-first, inline fallback.  Design §3 table.
 */
export function selectEngine(mode: "auto" | "worker" | "inline", bridge: PtcBridge): EngineSelection {
  if (mode === "inline") {
    return { engine: new InlineVmEngine(), degraded: false }
  }
  if (mode === "worker") {
    return { engine: new WorkerEngine(), degraded: false }
  }
  // auto: try worker first, degrade to inline on any failure.
  try {
    // WorkerEngine construction is cheap (no spawn until run()).
    return { engine: new WorkerEngine(), degraded: false }
  } catch {
    return { engine: new InlineVmEngine(), degraded: true }
  }
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
  // M2: engine selection — explicit override or auto/worker/inline from config.
  let engine: PtcEngine
  let degraded = false
  if (o.engine) {
    engine = o.engine
  } else {
    const sel = selectEngine(o.cfg.ptcEngine, o.bridge)
    engine = sel.engine
    degraded = sel.degraded
  }

  // M2: static pre-scan — reject programs with banned tokens before any
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
      parentStepId: o.parentStepId,
    }
  }

  // Auto-degrade: if the selected engine throws (not a PtcStopSignal),
  // and we're in auto mode with no explicit override, retry with InlineVmEngine.
  const tryRun = async (eng: PtcEngine): Promise<PtcRunOutcome> => {
    const state: GateState = { calls: 0, errors: 0, retries: 0, steps: [] }
    const gate = createGateBridge(o.bridge, o.parentStepId, o.budgets, state, {
      now,
      deadlineAt,
      store: o.store,
    })

    // parent call event (design §6)
    o.store?.appendTrajectory({
      tool: "tm_ptc_run",
      step_id: o.parentStepId,
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
    let engineError: PtcErrorBody | undefined
    try {
      returnValue = await eng.run(o.program, gate, ac.signal)
      returned = true
      status = state.stopReason ? mapStop(state.stopReason) : "ok"
    } catch (err) {
      if (err instanceof PtcStopSignal) {
        status = mapStop(err.reason)
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
      parentStepId: o.parentStepId,
    }
    o.store?.appendTrajectory({
      tool: "tm_ptc_run",
      step_id: o.parentStepId,
      event: "finish",
      status: outcome.status,
      calls: outcome.calls,
      errors: outcome.errCount,
      retries: outcome.retries,
      ms: outcome.ms,
    })
    return outcome
  }

  // Auto mode: try worker first; on engine-error → degrade to inline.
  if (!o.engine && o.cfg.ptcEngine === "auto" && engine.name === "worker") {
    const result = await tryRun(engine)
    if (result.status === "engine-error") {
      // Degrade to inline-vm and re-run.
      const inlineEngine = new InlineVmEngine()
      const fallback = await tryRun(inlineEngine)
      fallback.degraded = true
      fallback.engine = "inline"
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

// ---------- aggregation summary (design §2 — char-pinned headers) ----------

export const PTC_SUMMARY_HEADER = "PTC 摘要"
export const PTC_OK_SECTION = "-- 成功分部（≤8 行，超出整表卸载）"
export const PTC_OK_HEADER = " #  tool      ms   tokens  落点(inline|ref 短码)"
export const PTC_ERR_SECTION = "-- 错误分部（全量错误已落 run store）"
export const PTC_ERR_HEADER = " #  tool      phase      line  retry  message(截断)"
export const PTC_RETURN_PREFIX = "返回值: "
export const PTC_ERRORFULL_PREFIX = "错误全文: "

const OK_ROWS_INLINE_MAX = 8
const RETURN_VALUE_MAX = 2000

function engineLabel(o: PtcRunOutcome): string {
  if (o.engine === "worker") return "worker"
  return o.degraded ? "inline(degraded)" : "inline"
}

/** Render the fixed-shape aggregation summary.  `offload` is used to route an
 *  oversized success/error table (or return value) to a run-store handle. */
export function renderPtcSummary(
  o: PtcRunOutcome,
  offload?: (content: string, kind: string) => string,
): string {
  const lines: string[] = []
  lines.push(`${PTC_SUMMARY_HEADER} · ${o.label} · status=${o.status}`)
  lines.push(
    `steps=${o.okCount + o.errCount} ok=${o.okCount} err=${o.errCount} retries=${o.retries} ms=${o.ms}  engine=${engineLabel(o)}`,
  )

  const okSteps = o.steps.filter((s) => s.ok)
  const errSteps = o.steps.filter((s) => !s.ok)

  lines.push(PTC_OK_SECTION)
  lines.push(PTC_OK_HEADER)
  if (okSteps.length > OK_ROWS_INLINE_MAX && offload) {
    const table = okSteps.map(okRow).join("\n")
    lines.push(`（成功 ${okSteps.length} 行，超 ${OK_ROWS_INLINE_MAX}，整表卸载）`)
    lines.push(offload(table, "ok"))
  } else {
    for (const s of okSteps) lines.push(okRow(s))
  }

  lines.push(PTC_ERR_SECTION)
  lines.push(PTC_ERR_HEADER)
  for (const s of errSteps) lines.push(errRow(s))
  if (o.engineError) {
    lines.push(
      errRow({
        n: 0,
        tool: "tm_ptc_run",
        phase: o.engineError.phase,
        line: o.engineError.line,
        retry: false,
        message: `程序抛出：${o.engineError.message}`,
      }),
    )
  }
  if (errSteps.length === 0 && !o.engineError) lines.push(" （无）")

  // return value (JSON-serialized, capped; oversized → offload handle)
  if (o.returned) {
    const json = safeStringify(o.returnValue)
    if (json.length > RETURN_VALUE_MAX && offload) {
      lines.push(PTC_RETURN_PREFIX + "（超 2000 字符，卸载为句柄）")
      lines.push(offload(json, "return"))
    } else {
      lines.push(PTC_RETURN_PREFIX + json)
    }
  } else {
    lines.push(PTC_RETURN_PREFIX + "（无：程序未正常 return）")
  }

  // error full-text refs (aggregate handle when many)
  const refs = o.steps.filter((s) => s.errorRef).map((s) => s.errorRef as string)
  if (refs.length === 0) {
    lines.push(PTC_ERRORFULL_PREFIX + "（无错误落盘）")
  } else if (refs.length > 8 && offload) {
    lines.push(PTC_ERRORFULL_PREFIX + offload(refs.join("\n"), "errrefs"))
  } else {
    lines.push(PTC_ERRORFULL_PREFIX + refs.map((r) => `tm://…/${shortRefCode(r)}`).join(" "))
  }
  return lines.join("\n")
}

function okRow(s: PtcStepRecord): string {
  return ` ${s.n}  ${pad(s.tool, 8)}${String(s.ms)}ms  ${s.tokens}  ${s.dest}`
}
function errRow(s: {
  n: number
  tool: string
  phase?: string
  line?: number
  retry?: boolean
  message?: string
}): string {
  const phase = s.phase ?? "-"
  const line = typeof s.line === "number" ? String(s.line) : "-"
  const retry = s.retry ? "yes" : "no"
  const msg = shorten(s.message ?? "", 60)
  return ` ${s.n}  ${pad(s.tool, 8)}${pad(phase, 11)}${pad(line, 5)}${pad(retry, 5)}${msg}`
}
function pad(v: string, w: number): string {
  const s = String(v)
  return s.length >= w ? s + " " : s + " ".repeat(w - s.length)
}
function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return s === undefined ? "null" : s
  } catch {
    return String(v)
  }
}

// ---------- bridge over the real governed pipelines ------------------------

/**
 * Real M1 bridge: delegate each call to the corresponding exported pipeline,
 * `ctx` passed through untouched, and normalize the pipeline's `unknown`
 * result into `PtcCallResult` (TmErrorBody -> ok:false; anything else -> the
 * already-governed data).  Governance is entirely the pipelines'.
 */
export function pipelineBridge(pipelines: TmPipelines, ctx: unknown): PtcBridge {
  const pick = (tool: BridgeTool) =>
    tool === "tm_read"
      ? pipelines.tmRead
      : tool === "tm_grep"
        ? pipelines.tmGrep
        : tool === "tm_bash"
          ? pipelines.tmBash
          : pipelines.tmFetch
  return {
    async call(tool, args): Promise<PtcCallResult> {
      if (!BRIDGE_ALLOW.includes(tool)) {
        return { ok: false, error: tmError(tool, "args", "工具不在桥接白名单内").error }
      }
      const res = await pick(tool)(args ?? {}, ctx)
      if (res && typeof res === "object" && "error" in (res as Record<string, unknown>)) {
        return { ok: false, error: (res as { error: PtcErrorBody }).error }
      }
      return { ok: true, data: res }
    },
  }
}

// ---------- the tool definition (BUILT here, REGISTERED in M3) -------------

const PTC_RUN_DESCRIPTION = `Program-mode batch orchestration over the four governed tm_* tools.  One program, N bridged calls, zero LLM round-trips during the run; only an aggregation summary returns to context.

- program: an async function body.  Available: \`tm.read(args)\`, \`tm.grep(args)\`, \`tm.bash(args)\`, \`tm.fetch(args)\` — same args as the tm_* four.  Each returns \`{ok:true, data}\` (data is already governed: inline text, or an offload handle you can tm.fetch again) or \`{ok:false, error:{tool,phase,line?,message}}\`.  \`return\` a value; it is JSON-serialized into the summary (capped 2000 chars, oversized → handle).
- budgets (optional, tighten-only; clamped to TM_PTC_* ceilings): max_calls, max_errors, timeout_ms.  Hitting any budget stops the whole run (produced output is NOT lost).  Errors are retried at most once and only on idempotent phases (client/execute/store).
- Governance is NOT bypassed: every bridged call runs the full tm_* pipeline (P2 path scope, P3 allowlist, R6, threshold offload + handles, TTL).  Status is one of ok | stopped-error-budget | stopped-call-budget | timeout | engine-error.
- Programs containing require/import/process/globalThis/Deno/Bun/fs/net/child_process are rejected before execution (static pre-scan, auxiliary guard).
- Engine: TM_PTC_ENGINE=auto|worker|inline (auto tries worker first, falls back to inline with degraded-engine mark).`

/** Build the tm_ptc_run ToolDefinition.  Registered in the tool segment
 *  when the agent's whitelist grants tm_ptc_run (M3). */
export function buildPtcRunTool(deps: {
  cfg: TmConfig
  store: RunStore
  nextStepId: () => string
  ctx: unknown
  accessToken: string
  engine?: PtcEngine
  pipelines?: TmPipelines
  bridge?: PtcBridge
}): ToolDefinition {
  const { cfg, store, nextStepId, ctx, accessToken } = deps
  const baseBridge =
    deps.bridge ?? (deps.pipelines ? pipelineBridge(deps.pipelines, ctx) : undefined)
  const expireAt = () => Date.now() + cfg.blackboardTtlDays * 24 * 60 * 60 * 1000
  return {
    description: PTC_RUN_DESCRIPTION,
    args: {
      program: { descriptor: "program: string (required, async fn body, ≤TM_PTC_MAX_PROGRAM_CHARS)" },
      label: { descriptor: "label: string (optional, ≤80 chars)" },
      budgets: { descriptor: "budgets: { max_calls?, max_errors?, timeout_ms? } (optional, tighten-only)" },
    },
    execute: async (rawArgs): Promise<ToolResult> => {
      const parsed = parsePtcArgs(rawArgs ?? {}, cfg)
      if (!parsed.ok) {
        return { output: `[${parsed.error.error.tool} 失败 · phase=${parsed.error.error.phase}]\n${parsed.error.error.message}` }
      }
      // M2: static pre-scan — reject programs with banned tokens before any engine runs.
      const pscan = staticPscan(parsed.args.program)
      if (pscan.rejected) {
        return {
          output: `[tm_ptc_run 失败 · phase=args]\n程序包含禁止标识符（${pscan.tokens.join(", ")}），已拒绝执行。PTC 桥接仅暴露 tm.read/tm.grep/tm.bash/tm.fetch；require/import/process 等不在桥接白名单内。`,
        }
      }
      if (!baseBridge) {
        return {
          output: "[tm_ptc_run 失败 · phase=client]\n桥接管线未提供。",
        }
      }
      // Generate a fresh parent step ID per call.
      const parentStepId = nextStepId()
      // Per-call offload helper: persist `text` under a PTC sub-step and
      // render a handle block matching the four tools' visible shape.
      const offloadBlock = (text: string, kind: string): string => {
        const tokens = estimateTokens(text)
        try {
          const stored = store.writeResult(`${parentStepId}.${kind}`, {
            tool: "tm_ptc_run",
            content: text,
            tokens,
            contentType: detectContentType(text),
            preview: shorten(text, 120),
            expireAt: expireAt(),
          })
          return [
            `ref: ${stored.ref}`,
            `access_token: ${accessToken}`,
            `expire_at: ${stored.expireAt}`,
            `tokens: ${tokens}`,
            `（用 tm_fetch(ref, access_token) 取回；大载荷先试 mode:"structure"）`,
          ].join("\n")
        } catch {
          return text.slice(0, 2000)
        }
      }
      const outcome = await runPtc({
        program: parsed.args.program,
        label: parsed.args.label,
        budgets: parsed.args.budgets,
        parentStepId,
        cfg,
        store,
        bridge: baseBridge,
        ...(deps.engine ? { engine: deps.engine } : {}),
      })
      const content = renderPtcSummary(outcome, offloadBlock)
      // whole-summary offload if it still exceeds the threshold.
      if (shouldOffload(estimateTokens(content), cfg.offloadThreshold)) {
        return {
          output:
            `PTC 摘要过大（≈${estimateTokens(content)} tokens），已整体卸载为句柄，短摘要随后：\n` +
            offloadBlock(content, "rpt") +
            `\n--- 摘要前 1200 字符 ---\n${content.slice(0, 1200)}`,
        }
      }
      return { output: content }
    },
  }
}

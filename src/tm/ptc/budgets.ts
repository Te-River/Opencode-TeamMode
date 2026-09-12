/**
 * tm_ptc_run — caller budgets (design §4.3: callers may only TIGHTEN) and
 * the args schema/validation.  Split out of the former monolithic ptc.ts;
 * behavior unchanged.
 */

import type { TmConfig } from "../config.js"
import { tmError } from "../tools.js"

// ---------- budgets + clamping ----------------------------------------------

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

// ---------- arg schema + validation ------------------------------------------

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

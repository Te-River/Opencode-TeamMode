/**
 * tm_ptc_run — caller budgets (design §4.3: callers may only TIGHTEN) and
 * the args schema/validation.  Split out of the former monolithic ptc.ts;
 * behavior unchanged.
 */

import type { TmConfig } from "../config.js"
import { tmError } from "../result.js"

// ---------- budgets + clamping ----------------------------------------------

export interface PtcBudgets {
  maxCalls: number
  maxErrors: number
  timeoutMs: number
  /** echo provenance: caller-facing field names the caller explicitly set. */
  setByUser?: string[]
  /** echo provenance: caller-facing field names clamped to floor/ceiling. */
  clamped?: string[]
}

export interface PtcCallerBudgets {
  max_calls?: unknown
  max_errors?: unknown
  timeout_ms?: unknown
}

/** caller-facing arg key → resolved PtcBudgets key. */
const BUDGET_FIELD_MAP = [
  ["max_calls", "maxCalls"],
  ["max_errors", "maxErrors"],
  ["timeout_ms", "timeoutMs"],
] as const

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

export interface PtcBudgetResolution {
  /** plain resolved budgets — NO echo arrays attached (deepEqual-stable). */
  budgets: PtcBudgets
  /** caller-facing field names the caller explicitly set. */
  setByUser: string[]
  /** caller-facing field names clamped to the floor or ceiling. */
  clamped: string[]
}

/**
 * Resolve budgets AND track provenance for the summary echo (fix batch T1):
 * which fields the caller set, and which were clamped.  `resolvePtcBudgets`
 * (plain) stays deepEqual-stable for existing callers; the echo arrays are
 * attached by `parsePtcArgs`, never by the plain resolver.
 */
export function resolvePtcBudgetsDetailed(
  cfg: TmConfig,
  budgets: PtcCallerBudgets | undefined | null,
): PtcBudgetResolution {
  const b =
    budgets && typeof budgets === "object" && !Array.isArray(budgets)
      ? (budgets as Record<string, unknown>)
      : {}
  const ceilings: Record<string, number> = {
    maxCalls: cfg.ptcMaxCalls,
    maxErrors: cfg.ptcMaxErrors,
    timeoutMs: cfg.ptcTimeoutMs,
  }
  const floors: Record<string, number> = {
    maxCalls: PTC_BUDGET_BOUNDS_FLOOR.maxCalls,
    maxErrors: PTC_BUDGET_BOUNDS_FLOOR.maxErrors,
    timeoutMs: PTC_BUDGET_BOUNDS_FLOOR.timeoutMs,
  }
  const setByUser: string[] = []
  const clamped: string[] = []
  const out: Record<string, number> = {}
  for (const [raw, key] of BUDGET_FIELD_MAP) {
    out[key] = clampBudget(b[raw], ceilings[key], floors[key])
    const n = b[raw]
    const num = typeof n === "number" ? n : n == null ? NaN : Number(n)
    if (!Number.isFinite(num)) continue
    setByUser.push(raw)
    const i = Math.trunc(num)
    if (i !== out[key]) clamped.push(raw)
  }
  return { budgets: out as unknown as PtcBudgets, setByUser, clamped }
}

export function resolvePtcBudgets(cfg: TmConfig, budgets: PtcCallerBudgets | undefined | null): PtcBudgets {
  return resolvePtcBudgetsDetailed(cfg, budgets).budgets
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
 * 80 is truncated; `budgets` are validated LOUDLY (fix batch T1: a wrong
 * shape used to silently fall back to the ceiling — the caller never learned
 * their budgets were ignored) and clamped toward the env ceilings.
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
  // budgets — loud validation (fix batch T1)
  const rawBudgets: unknown = a.budgets
  if (rawBudgets !== undefined) {
    if (typeof rawBudgets !== "object" || rawBudgets === null || Array.isArray(rawBudgets)) {
      return {
        ok: false,
        error: tmError("tm_ptc_run", "args", "budgets 必须是 { max_calls?, max_errors?, timeout_ms? } 对象"),
      }
    }
    // Wave B Minor② — reject unknown keys.  A typo (max_call, missing the s)
    // used to pass the type + per-field checks and then silently resolve to
    // the ceiling default (T1's loud-validation goal violated: the caller
    // never learned the budget was ignored).  The zod schema layer adds
    // .strict() too, but this is the runtime backstop that always fires.
    const knownKeys = new Set<string>(BUDGET_FIELD_MAP.map(([raw]) => raw))
    const unknownKeys = Object.keys(rawBudgets as Record<string, unknown>).filter(
      (k) => !knownKeys.has(k),
    )
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        error: tmError(
          "tm_ptc_run",
          "args",
          `budgets 含未知键 [${unknownKeys.join(", ")}]；合法键仅 max_calls / max_errors / timeout_ms（拼写必须完全一致，例如 max_call 漏 s 会被拒）`,
        ),
      }
    }
    for (const [field] of BUDGET_FIELD_MAP) {
      const v = (rawBudgets as Record<string, unknown>)[field]
      if (v === undefined || v === null) continue
      if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
        return {
          ok: false,
          error: tmError("tm_ptc_run", "args", `budgets.${field} 必须是不小于 1 的数字（当前值：${JSON.stringify(v)}）`),
        }
      }
    }
  }
  const resolution = resolvePtcBudgetsDetailed(cfg, rawBudgets as PtcCallerBudgets)
  // attach the echo provenance (setByUser / clamped) for the summary line
  const budgets: PtcBudgets = {
    ...resolution.budgets,
    ...(resolution.setByUser.length ? { setByUser: resolution.setByUser } : {}),
    ...(resolution.clamped.length ? { clamped: resolution.clamped } : {}),
  }
  return { ok: true, args: { program, label, budgets } }
}

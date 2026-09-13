/**
 * tm_ptc_run — the char-pinned aggregation summary (design §2).  Verbatim
 * headers + metrics format are pinned by test-tm-tools §9h — do not reword.
 * Split out of the former monolithic ptc.ts; behavior unchanged.
 */

import { shorten } from "../config.js"
import type { PtcRunOutcome, PtcStepRecord } from "./contract.js"
import { shortRefCode } from "./contract.js"

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
  // educator line: ok bridged calls whose inline results never entered the
  // summary teach the model to `return` — the #1 adoption killer otherwise
  if (o.returned && (o.returnValue === undefined || o.returnValue === null) && okSteps.length > 0) {
    lines.push(
      `⚠️ 程序未 return 数据：${okSteps.length} 次成功桥接的内联结果未进入摘要（句柄类结果仍可经 tm.fetch 取回）。下次在程序末尾 return 聚合结果。`,
    )
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

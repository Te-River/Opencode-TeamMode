/**
 * tm_ptc_run — module facade.  The former monolithic ptc.ts (1092 lines)
 * split into: contract (frozen seam + RPC) / budgets / pscan / engines /
 * gate / driver / summary / tool.  This re-export keeps every historical
 * export name stable for `dist/tm/index.js` and any deep-path importers.
 */

export type {
  BridgeTool,
  PtcBridge,
  PtcCallResult,
  PtcEngine,
  PtcEngineMessage,
  PtcEngineName,
  PtcEngineRunOpts,
  PtcErrorBody,
  PtcRunOutcome,
  PtcRpcAbort,
  PtcRpcRequest,
  PtcRpcResponse,
  PtcRunRequest,
  PtcStatus,
  PtcStepRecord,
} from "./contract.js"
export {
  BRIDGE_ALLOW,
  PTC_STATUS_VALUES,
  PtcProgramError,
  PtcStopSignal,
  RETRYABLE_PHASES,
  shortRefCode,
} from "./contract.js"
export type { PtcArgsResult, PtcBudgets, PtcBudgetResolution, PtcCallerBudgets, PtcValidArgs } from "./budgets.js"
export { parsePtcArgs, PTC_LABEL_MAX, resolvePtcBudgets, resolvePtcBudgetsDetailed } from "./budgets.js"
export { staticPscan } from "./pscan.js"
export { InlineSequentialEngine, InlineVmEngine, WorkerEngine } from "./engines.js"
export type { GateState } from "./gate.js"
export { createGateBridge } from "./gate.js"
export type { EngineSelection, RunPtcOptions } from "./driver.js"
export { runPtc, selectEngine } from "./driver.js"
export {
  PTC_ERR_HEADER,
  PTC_ERR_SECTION,
  PTC_ERRORFULL_PREFIX,
  PTC_OK_HEADER,
  PTC_OK_SECTION,
  PTC_RETURN_PREFIX,
  PTC_SUMMARY_HEADER,
  renderPtcSummary,
} from "./summary.js"
export { buildPtcRunTool, pipelineBridge } from "./tool.js"

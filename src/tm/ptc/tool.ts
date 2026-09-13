/**
 * tm_ptc_run — the bridge over the real governed pipelines + the tool
 * definition.  Governance is REUSED, never forked (D6 lock): every bridged
 * call runs the full tm_* pipeline (P2 path scope, P3 allowlist, R6,
 * threshold offload + handles, TTL).  PTC is NOT a bypass layer.
 * Split out of the former monolithic ptc.ts; behavior unchanged.
 */

import type { ToolDefinition, ToolResult } from "../../types.js"
import { estimateTokens, shouldOffload, shorten, type TmConfig } from "../config.js"
import { detectContentType } from "../preview.js"
import { buildRef } from "../refs.js"
import type { RunStore } from "../store.js"
import { tmError } from "../result.js"
import type { TmPipelines } from "../pipelines.js"
import type { BridgeTool, PtcBridge, PtcCallResult, PtcEngine, PtcErrorBody } from "./contract.js"
import { BRIDGE_ALLOW } from "./contract.js"
import type { PtcBudgets } from "./budgets.js"
import { parsePtcArgs } from "./budgets.js"
import { staticPscan } from "./pscan.js"
import { runPtc } from "./driver.js"
import { renderPtcSummary } from "./summary.js"

// ---------- bridge over the real governed pipelines --------------------------

/**
 * Real bridge: delegate each call to the corresponding exported pipeline,
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

// ---------- the tool definition ----------------------------------------------

const PTC_RUN_DESCRIPTION = `Batch orchestration: ONE async program makes N governed tm_* calls with ZERO LLM round-trips — use it INSTEAD of chaining ≥3 tm_read / tm_grep / tm_bash calls toward the same goal (multi-file recon, bulk grep+read aggregation, cross-referencing search results).  Only a char-pinned aggregation summary returns to context, so ALWAYS \`return\` the aggregated value at the end of the program: unreturned inline results are discarded (offload handles stay retrievable via tm.fetch).

- Example: \`const out = []; for (const p of ["a.ts", "b.ts", "c.ts"]) { const f = await tm.read({ path: p }); if (f.ok) out.push({ p, head: String(f.data).slice(0, 400) }); } return out;\`
- program: an async function body.  Available: \`tm.read(args)\`, \`tm.grep(args)\`, \`tm.bash(args)\`, \`tm.fetch(args)\` — same args as the tm_* four.  Each returns \`{ok:true, data}\` (data is already governed: inline text, or an offload handle you can tm.fetch again) or \`{ok:false, error:{tool,phase,line?,message}}\`.  \`return\` a value; it is JSON-serialized into the summary (capped 2000 chars, oversized → handle).
- budgets (optional, tighten-only; clamped to TM_PTC_* ceilings): max_calls, max_errors, timeout_ms.  Hitting any budget stops the whole run (produced output is NOT lost).  Errors are retried at most once and only on idempotent phases (client/execute/store).
- Governance is NOT bypassed: every bridged call runs the full tm_* pipeline (P2 path scope, P3 allowlist, R6, threshold offload + handles, TTL).  Status is one of ok | stopped-error-budget | stopped-call-budget | timeout | engine-error.
- Programs containing require/import/process/globalThis/Deno/Bun/fs/net/child_process are rejected before execution (static pre-scan, auxiliary guard).
- Engine: TM_PTC_ENGINE=auto|worker|inline (auto tries worker first; on engine failure it re-runs the WHOLE program on inline with a degraded-engine mark — bridged calls are read-only, so a re-run is safe, and the fallback starts with fresh budgets under the same wall-clock deadline).`

/** Build the tm_ptc_run ToolDefinition.  Registered in the tool segment
 *  when the agent's whitelist grants tm_ptc_run (M3).  `deps.args` is the
 *  ZodRawShape from tools.buildPtcArgsSchema() when zod is available — the
 *  descriptor fallback below keeps the tool usable without zod. */
export function buildPtcRunTool(deps: {
  cfg: TmConfig
  store: RunStore
  nextStepId: () => string
  ctx: unknown
  accessToken: string
  args?: Record<string, unknown>
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
    args: deps.args ?? {
      program: { descriptor: "program: string (required, async fn body, ≤TM_PTC_MAX_PROGRAM_CHARS)" },
      label: { descriptor: "label: string (optional, ≤80 chars)" },
      budgets: { descriptor: "budgets: { max_calls?, max_errors?, timeout_ms? } (optional, tighten-only)" },
    },
    execute: async (rawArgs): Promise<ToolResult> => {
      const parsed = parsePtcArgs(rawArgs ?? {}, cfg)
      if (!parsed.ok) {
        return { output: `[${parsed.error.error.tool} 失败 · phase=${parsed.error.error.phase}]\n${parsed.error.error.message}` }
      }
      // static pre-scan — reject programs with banned tokens before any
      // engine runs.
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

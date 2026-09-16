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
import { tmError, type TmPhase } from "../result.js"
import { askUserForTarget, type TmAskRequest } from "../perm-ask.js"
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
 *
 * T6 web bridges: `web` carries the LIVE tm_search / tm_webfetch tool handles
 * (built over the SAME secondary pipeline instance, so their step ids share
 * the "ptc-" namespace).  A bridged `tm.search()` / `tm.webfetch()` runs that
 * tool's real execute under `ctx` — which means the host evaluates its
 * `permission.asked` (the out-of-allowlist dialog AND the caller's own
 * ruleset) against the CALLER'S session, so a non-web role is denied with a
 * permission error and the denial is recorded as a failed step.  When `web`
 * is absent (TM_PTC_WEB_BRIDGE=off, or the secondary tools were not wired)
 * the two web tools are rejected with an explicit args error.
 */
export interface PtcWebHandles {
  tm_search: { execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<ToolResult> }
  tm_webfetch: { execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<ToolResult> }
}

/**
 * Unwrap a web tool's ToolResult back into the PTC `{ok,data}`/`{ok:false,
 * error}` shape.  The governed tools return `{output}` strings; a structured
 * error renders with result.ts's pinned `[<tool> 失败 · phase=<phase>]`
 * (optionally ` · line=<n>`) header line — the only machine-readable marker
 * available at this boundary, so it is the split.  Anything else (inline
 * text, an offload handle block) is an ok result; a handle's ref is already
 * in the text for the program to feed back through tm.fetch.
 */
function unwrapToolOutput(tool: BridgeTool, output: string): PtcCallResult {
  const m = /^\[(\S+) 失败 · phase=([a-z]+)(?: · line=(-?\d+))?\]\n/.exec(output)
  if (m && m[1] === tool) {
    const phase = m[2] as TmPhase
    const body = { tool, phase, message: output.slice(m[0].length) }
    if (m[3] !== undefined) Object.assign(body, { line: Number(m[3]) })
    return { ok: false, error: body }
  }
  return { ok: true, data: output }
}

/**
 * Build the OFFICIAL permission request the bridge raises for a bridged web
 * call.  The permission name is the tool itself (`tm_search` / `tm_webfetch`),
 * so the host evaluates the CALLER'S own ruleset — exactly as a direct tool
 * call would: `deny` for a non-web role, and for a web-granted role
 * (lead/researcher) the default ruleset is `ask`, so each bridged web call
 * pops a confirmation dialog (store an `allow` rule to skip it) — NOT a
 * silent pass.  The patterns carry the target host (webfetch) / engine
 * (search) so any dialog that DOES pop is informative and no-secret.
 */
export function webBridgeAsk(tool: BridgeTool, args: Record<string, unknown>): TmAskRequest {
  if (tool === "tm_webfetch") {
    const url = typeof args.url === "string" ? args.url : ""
    let host = ""
    try {
      host = url ? new URL(url).hostname : ""
    } catch {
      host = ""
    }
    return {
      permission: "tm_webfetch",
      patterns: host ? [host, url] : ["*"],
      metadata: { tool, via: "tm_ptc_run", host },
    }
  }
  const engine = typeof args.engine === "string" ? args.engine : "auto"
  return {
    permission: "tm_search",
    patterns: [`engine:${engine}`],
    metadata: { tool, via: "tm_ptc_run", engine },
  }
}

export function pipelineBridge(pipelines: TmPipelines, ctx: unknown, web?: PtcWebHandles): PtcBridge {
  const pick = (
    tool: BridgeTool,
  ):
    | ((a: Record<string, unknown>, c: unknown) => Promise<unknown>)
    | { execute: (a: Record<string, unknown>, c: unknown) => Promise<ToolResult> }
    | undefined =>
    tool === "tm_read"
      ? pipelines.tmRead
      : tool === "tm_grep"
        ? pipelines.tmGrep
        : tool === "tm_bash"
          ? pipelines.tmBash
          : tool === "tm_fetch"
            ? pipelines.tmFetch
            : tool === "tm_search"
              ? web?.tm_search
              : web?.tm_webfetch
  return {
    async call(tool, args): Promise<PtcCallResult> {
      if (!BRIDGE_ALLOW.includes(tool)) {
        return { ok: false, error: tmError(tool, "args", "工具不在桥接白名单内").error }
      }
      const target = pick(tool)
      if (!target) {
        // a web bridge the caller's role / config never enabled
        return {
          ok: false,
          error: tmError(tool, "args", "web 桥未启用（TM_PTC_WEB_BRIDGE=off 或未装配）").error,
        }
      }
      // C2: an ACTIVE role gate for bridged web — BEFORE execute.  The bridge
      // invokes the web tool's execute() directly, BYPASSING the host tool
      // dispatch where agents.ts's `tm_search`/`tm_webfetch` = deny would
      // otherwise block a non-web role, and the tools' own ctx.ask only pops
      // for OUT-of-allowlist hosts (every default engine host is seeded).  So
      // without this the web bridge was a privilege-escalation path.  Raise the
      // SAME ruleset a direct call resolves: ctx.ask with the web permission
      // name + target host/engine.  A web-granted role hits the default `ask`
      // rule → a confirmation dialog per call (an `allow` rule skips it); a
      // non-web role's deny rule throws → a permission error step; a
      // rejection or a missing ask bridge is fail-CLOSED.
      if (tool === "tm_search" || tool === "tm_webfetch") {
        const outcome = await askUserForTarget(ctx, webBridgeAsk(tool, args ?? {}))
        if (outcome !== "approved") {
          return {
            ok: false,
            error: tmError(
              tool,
              "permission",
              outcome === "rejected"
                ? `角色无权通过 PTC 桥接使用 ${tool}（ruleset deny / 用户拒绝）；web 桥仅授予 lead/researcher。`
                : `无法通过桥接校验 ${tool} 权限（ctx.ask 不可用）——已按最小权限拒绝。`,
            ).error,
          }
        }
      }
      const res =
        typeof target === "function"
          ? await target(args ?? {}, ctx)
          : await target.execute(args ?? {}, ctx)
      if (res && typeof res === "object" && "error" in (res as Record<string, unknown>)) {
        return { ok: false, error: (res as { error: PtcErrorBody }).error }
      }
      if (tool === "tm_search" || tool === "tm_webfetch") {
        return unwrapToolOutput(tool, String((res as { output?: unknown })?.output ?? res ?? ""))
      }
      return { ok: true, data: res }
    },
  }
}

// ---------- the tool definition ----------------------------------------------

const PTC_RUN_DESCRIPTION = `Batch orchestration: ONE async program makes N governed tm_* calls with ZERO LLM round-trips — use it INSTEAD of chaining ≥3 tm_read / tm_grep / tm_bash calls toward the same goal (multi-file recon, bulk grep+read aggregation, cross-referencing search results).  Best for READ-ONLY fan-out: reading many files, aggregating many searches, or any parallel read that would otherwise cost one LLM turn per call.  Only a char-pinned aggregation summary returns to context, so ALWAYS \`return\` the aggregated value at the end of the program: unreturned inline results are discarded (offload handles stay retrievable via tm.fetch).

- Example: \`const out = []; for (const p of ["a.ts", "b.ts", "c.ts"]) { const f = await tm.read({ path: p }); if (f.ok) out.push({ p, head: String(f.data).slice(0, 400) }); } return out;\`
- program: an async function body.  Available: \`tm.read(args)\`, \`tm.grep(args)\`, \`tm.bash(args)\`, \`tm.fetch(args)\` — same args as the tm_* four — plus the WEB bridges \`await tm.search({ query, engine? })\` and \`await tm.webfetch({ url, fields? })\` (identical args to tm_search / tm_webfetch).  Each returns \`{ok:true, data}\` (data is already governed: inline text, or an offload handle you can tm.fetch again) or \`{ok:false, error:{tool,phase,line?,message}}\`.  \`return\` a value; it is JSON-serialized into the summary (capped 2000 chars, oversized → handle).
- Web bridge gating: tm.search / tm.webfetch run the REAL web tools under YOUR calling session's ctx, so the host evaluates them against YOUR agent's ruleset — a role without a web grant gets a \`permission\` error per call (bridged web is not a way around your tool whitelist), and \`TM_PTC_WEB_BRIDGE=off\` disables both.  GETs are idempotent, so a transient client/execute/store failure retries once; a permission/args error never does.
- budgets (optional, tighten-only; clamped to TM_PTC_* ceilings): max_calls, max_errors, timeout_ms.  Hitting any budget stops the whole run (produced output is NOT lost).  Floors: max_calls 1 / max_errors 1 / timeout_ms 5000 ms; the summary echoes the EFFECTIVE budgets and flags every CLAMPED field (so a silently-narrowed budget is visible, not just the final number).  Errors are retried at most once and only on idempotent phases (client/execute/store).
- Governance is NOT bypassed: every bridged call runs the full tm_* pipeline (P2 path scope, P3 allowlist, R6, threshold offload + handles, TTL).  Status is one of ok | stopped-error-budget | stopped-call-budget | timeout | engine-error | program-error (program-error = the program itself threw — no auto-degrade re-run; engine-error = engine fault — auto mode re-runs the WHOLE program on the inline engine).
- Programs whose EXECUTABLE structure contains require/import/process/globalThis/Deno/Bun/fs/net/child_process are rejected before execution (static pre-scan, an auxiliary guard — NOT a security boundary).  The pre-scan STRIPS string / template-literal / comment bodies first, so a grep pattern or log message that merely MENTIONS one of those words is fine — you do NOT need to obfuscate them; only a real \`require(...)\` / \`process.x\` call site is caught.
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
  webTools?: PtcWebHandles
}): ToolDefinition {
  const { cfg, store, nextStepId, ctx, accessToken } = deps
  // Per-call bridge factory.  The bridge MUST bind the CALLER's execute ctx,
  // not the assembly-time `{ directory }`: tm_search / tm_webfetch run their
  // `ctx.ask` permission probe against the calling agent's session ruleset, so
  // a non-web role's bridged web call is denied by the host exactly as if that
  // agent had called the tool directly.  A test-provided `deps.bridge` still
  // wins (the §9 suite injects its own mock).
  const makeBridge = (callCtx: unknown): PtcBridge | undefined =>
    deps.bridge ??
    (deps.pipelines ? pipelineBridge(deps.pipelines, callCtx ?? ctx, deps.webTools) : undefined)
  const expireAt = () => Date.now() + cfg.blackboardTtlDays * 24 * 60 * 60 * 1000
  return {
    description: PTC_RUN_DESCRIPTION,
    args: deps.args ?? {
      program: { descriptor: "program: string (required, async fn body, ≤TM_PTC_MAX_PROGRAM_CHARS)" },
      label: { descriptor: "label: string (optional, ≤80 chars)" },
      budgets: { descriptor: "budgets: { max_calls?, max_errors?, timeout_ms? } (optional, tighten-only)" },
    },
    execute: async (rawArgs, callCtx): Promise<ToolResult> => {
      const parsed = parsePtcArgs(rawArgs ?? {}, cfg)
      if (!parsed.ok) {
        return { output: `[${parsed.error.error.tool} 失败 · phase=${parsed.error.error.phase}]\n${parsed.error.error.message}` }
      }
      // static pre-scan — reject programs with banned tokens in EXECUTABLE
      // structure before any engine runs (string/comment literals are stripped
      // first, so a grep pattern that merely MENTIONS `require` is not caught).
      const pscan = staticPscan(parsed.args.program)
      if (pscan.rejected) {
        return {
          output: `[tm_ptc_run 失败 · phase=args]\n程序包含禁止标识符（${pscan.tokens.join(", ")}），已拒绝执行。PTC 桥接仅暴露 tm.read/tm.grep/tm.bash/tm.fetch/tm.search/tm.webfetch（web 两项受 TM_PTC_WEB_BRIDGE 与角色权限门控）；require/import/process 等不在桥接白名单内。`,
        }
      }
      // Re-bind the bridge to THIS call's ctx (role-gated web permission).
      const bridge = makeBridge(callCtx)
      if (!bridge) {
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
        bridge,
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

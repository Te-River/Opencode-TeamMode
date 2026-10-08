/**
 * JIT layer-2 tools — assembly of the governed retrieval tool.  The machinery
 * lives in sibling modules (one responsibility each):
 *
 *   pipelines.ts     — the shared governance seam (threshold offload) + tm_fetch
 *   result.ts        — structured errors + ToolResult rendering contract
 *   client-unwrap.ts — host client result unwrapping + text extraction
 *   shell-bridge.ts  — the host `$` shell bridge + shell error hygiene
 *   args-schema.ts   — zod raw-shape arg schemas (descriptor fallback)
 *
 * (tm_read / tm_grep / tm_bash were the v1-only governed passthroughs; they are
 * gone with the v1 personality — on v2 the host's native read / grep / shell are
 * governed by src/host/v2-offload.ts over the SAME pipeline.)
 */

import type { ToolDefinition } from "../types.js"
import { buildArgsSchemas } from "./args-schema.js"
import { buildPipelines, type TmDeps, type TmPipelines } from "./pipelines.js"
import { toToolResult } from "./result.js"

// ---------- descriptions ----------
// Deliberately explicit about governance: the model must learn the handle
// protocol from the description alone.

const TM_FETCH_DESCRIPTION = `Page through an offloaded tool result by its handle (governed tools return handles for oversized payloads).
- Args: ref (required, tm://runs/{run_id}/steps/{step_id}/result), access_token (required — from the handle; may also ride the ref fragment), offset (0-based line), limit (lines per fetch, capped at fetchMaxLines, default 2000), mode ("lines" default | "structure" — a ~100-token TOC / key-tree / error-line map; try it FIRST on big payloads).
- Handles are run-scoped and HMAC-signed: a foreign-run, tampered or expired handle (blackboardTtlDays, default 7 days) is rejected with "payload cleared or run mismatch — rerun the original tool".
- Returns the ref, a paging hint (total/returned/remaining/next offset) and the content slice. Aggregate first; fetch further slices only when needed.`

/**
 * Build the tool definitions.  Async only because of the optional zod
 * load; every pipeline itself is runtime-defensive against raw args.  Every
 * execute() funnels through toToolResult so the return value ALWAYS satisfies
 * the host ToolResult contract ({output: string}) — handles, structured
 * errors, pages and degraded warnings included.
 * `pipelines` lets the caller inject a SHARED pipeline instance (tm/index
 * reuses one instance for the tools AND tm_webfetch so their step ids
 * never collide); when omitted, a fresh instance is built from deps.
 */
export async function buildTmTools(
  deps: TmDeps,
  pipelines?: TmPipelines,
): Promise<Record<string, ToolDefinition>> {
  const pl = pipelines ?? buildPipelines(deps)
  const argsSchemas = await buildArgsSchemas()
  return {
    tm_fetch: {
      description: TM_FETCH_DESCRIPTION,
      args: argsSchemas.tm_fetch,
      execute: async (args, ctx) => toToolResult(await pl.tmFetch(args ?? {}, ctx)),
    },
  }
}

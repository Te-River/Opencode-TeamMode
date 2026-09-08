/**
 * JIT layer-2 tools — runtime assembly.
 *
 * `createTmTools(input)` is called ONCE per server() invocation and returns
 * the runtime the plugin merges into its hooks:
 *
 *   const tm = await createTmTools(input)
 *   return { config, "tool.execute.before", tool: tm.tools }
 *
 * It generates the run identity (run id + process-random HMAC key), resolves
 * the env config, sweeps expired run payloads (startup-only TTL reclamation)
 * and assembles the four statically-registered tools (T0.4-verified shape:
 * `{ tool: { tm_read: { description, args, execute(args, ctx) } } }`).
 */

import * as crypto from "node:crypto"
import type { PluginInput, ToolDefinition } from "../types.js"
import {
  parseExtraDeny,
  resolveEnvProtectMode,
  type EnvProtectMode,
} from "../envprotect.js"
import { resolveTmConfig, type TmConfig } from "./config.js"
import { hmacToken, newRunId } from "./refs.js"
import { RunStore } from "./store.js"
import { buildTmTools } from "./tools.js"

export interface TmRuntime {
  runId: string
  config: TmConfig
  store: RunStore
  tools: Record<string, ToolDefinition>
}

export interface CreateTmToolsOptions {
  /** R6 mode — pass the plugin-level resolved value to keep ONE source. */
  mode?: EnvProtectMode
  /** R6 extra deny rules — same single-source rule. */
  extra?: RegExp[]
}

export async function createTmTools(
  input: PluginInput,
  opts: CreateTmToolsOptions = {},
): Promise<TmRuntime> {
  const cfg = resolveTmConfig(process.env)
  const directory =
    typeof input?.directory === "string" && input.directory.length > 0
      ? input.directory
      : process.cwd()
  const runId = newRunId()
  const hmacKey = crypto.randomBytes(32)
  const accessToken = hmacToken(hmacKey, runId)
  const store = new RunStore({
    projectRoot: directory,
    blackboardDir: cfg.blackboardDir,
    trajectoryDir: cfg.trajectoryDir,
    runId,
    ttlDays: cfg.blackboardTtlDays,
  })
  // Startup-only TTL reclamation for expired run payloads — the sole cleanup
  // path for the tm store (mirrors blackboard.ts's sweeper philosophy).
  store.sweepExpired()
  const mode = opts.mode ?? resolveEnvProtectMode(process.env.TM_ENV_PROTECT)
  const extra = opts.extra ?? parseExtraDeny(process.env.TM_ENV_PROTECT_EXTRA_DENY)
  const expireAt = Date.now() + cfg.blackboardTtlDays * 24 * 60 * 60 * 1000
  const tools = await buildTmTools({
    client: input?.client,
    $: input?.$,
    cfg,
    store,
    runId,
    hmacKey,
    accessToken,
    expireAt,
    mode,
    extra,
  })
  return { runId, config: cfg, store, tools }
}

// ---------- re-exports (stable import surface for tests + plugin entry) ----------

export {
  DEFAULT_BASH_READONLY_ALLOWED,
  estimateTokens,
  parseAllowlistEnv,
  resolveTmConfig,
  shouldOffload,
  shorten,
  TM_CONFIG_DEFAULTS,
} from "./config.js"
export {
  buildRef,
  hmacToken,
  isExpired,
  newRunId,
  parseRef,
  REF_PATTERN,
  verifyToken,
} from "./refs.js"
export { RunStore, USAGE_JSONL_RELPATH } from "./store.js"
export {
  buildPreview,
  buildStructureSummary,
  capTokens,
  contentTypeForPath,
  detectContentType,
  sniffContentType,
} from "./preview.js"
export {
  assertReadablePath,
  classifyReadonlyCommand,
  isInsideDir,
} from "./guard.js"
export { buildTmTools, HANDLE_INVALID_MESSAGE, tmError } from "./tools.js"
export type { TmDeps, TmPhase } from "./tools.js"

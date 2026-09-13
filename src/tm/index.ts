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
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { PluginInput, ToolDefinition } from "../types.js"
import { findRepoRoot } from "../blackboard.js"
import {
  parseExtraDeny,
  resolveEnvProtectMode,
  type EnvProtectMode,
} from "../envprotect.js"
import { resolveTmConfig, type TmConfig } from "./config.js"
import { hmacToken, newRunId } from "./refs.js"
import { RunStore } from "./store.js"
import { buildTmTools } from "./tools.js"
import { buildPipelines } from "./pipelines.js"
import { buildPtcArgsSchema, buildWebfetchArgsSchema, buildMemoryArgsSchema, buildBrowserArgsSchema } from "./args-schema.js"
import { buildPtcRunTool } from "./ptc/index.js"
import { buildTmWebfetchTool } from "./webfetch.js"
export { rmForceSafe } from "../fs-safe.js"
export {
  buildTmMemoryTool,
  MEMORY_CATEGORIES,
  MEMORY_CONTENT_MAX,
  MEMORY_TITLE_MAX,
  projectSlug,
  scoreMemory,
  parseMemoryMarkdown,
  renderMemoryMarkdown,
} from "./memory.js"
export { buildTmBrowserTool, findBrowserExecutable, resolveHeadless } from "./browser.js"
import { buildTmMemoryTool } from "./memory.js"
import { buildTmBrowserTool } from "./browser.js"

export interface TmRuntime {
  runId: string
  config: TmConfig
  store: RunStore
  /** The ONE main pipeline instance (exposed for tests + tool builders). */
  pipelines: ReturnType<typeof import("./pipelines.js").buildPipelines>
  tools: Record<string, ToolDefinition>
  /** Kill any long-lived session the tools own (tm_browser child process). */
  dispose: () => void
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
  // Store roots — AUTO default resolves git-aware: under <repo>/.git, so
  // the payload/trajectory stores never pollute the user's working tree
  // (user projects never had .blackboard/.trajectory gitignore entries).
  // The .git-is-a-directory check covers worktrees where .git is a FILE
  // pointing elsewhere.  Explicit TM_BLACKBOARD_DIR / TM_TRAJECTORY_DIR
  // overrides keep the old semantics (absolute, or relative to project
  // root — RunStore handles both).
  const repo = findRepoRoot(directory)
  const gitDir = repo ? path.join(repo, ".git") : null
  const gitUsable =
    gitDir !== null &&
    (() => {
      try {
        return fs.statSync(gitDir).isDirectory()
      } catch {
        return false
      }
    })()
  const storeBase = gitUsable
    ? path.join(gitDir as string, "opencode-team")
    : path.join(os.tmpdir(), "opencode-team")
  // User-level global memory root — OUTSIDE any repo, so "global" scope
  // really follows the user across projects (repo scope stays in .git).
  const globalMemoriesDir = cfg.memoryGlobalDir || path.join(os.homedir(), ".opencode-team", "memories", "global")
  const store = new RunStore({
    projectRoot: directory,
    blackboardDir: cfg.blackboardDir || path.join(storeBase, "blackboard"),
    trajectoryDir: cfg.trajectoryDir || path.join(storeBase, "trajectory"),
    runId,
    ttlDays: cfg.blackboardTtlDays,
  })
  // Startup-only TTL reclamation for expired run payloads — the sole cleanup
  // path for the tm store (mirrors blackboard.ts's sweeper philosophy).
  store.sweepExpired()
  const mode = opts.mode ?? resolveEnvProtectMode(process.env.TM_ENV_PROTECT)
  const extra = opts.extra ?? parseExtraDeny(process.env.TM_ENV_PROTECT_EXTRA_DENY)
  const expireAt = Date.now() + cfg.blackboardTtlDays * 24 * 60 * 60 * 1000
  // Bun shell ($): try input.$ first (T0.4② verified), then Bun globals
  // (desktop loader may not pass $ through; Bun exposes it globally).
  // Resolved ONCE and shared by the main pipelines AND the PTC pipeline
  // instance below — v1.5.4 added the fallback to the main path only, so
  // PTC's tm.bash bridging died with "宿主 shell 桥（$）不可用" on desktops
  // where input.$ is absent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shellBridge: unknown = input?.$ ?? (globalThis as any).$ ?? (globalThis as any).Bun?.$
  const deps = {
    client: input?.client,
    $: shellBridge,
    cfg,
    store,
    runId,
    hmacKey,
    accessToken,
    expireAt,
    mode,
    extra,
  }
  // ONE main pipeline instance shared by the four tools AND tm_webfetch —
  // a shared step counter keeps their refs unambiguous (a second instance
  // would re-emit s0001 and cross-contaminate offloaded payloads).
  const pipelines = buildPipelines(deps)
  const tools = await buildTmTools(deps, pipelines)
  // tm_webfetch — the governed web FALLBACK channel.  Registered on the
  // host tool surface for everyone, but the AGENT PERMISSION map gates who
  // sees it: explicit allow for team + researcher only (agents.ts), explicit
  // deny for the other four (overrides the tm_* wildcard).
  const webfetchArgs = await buildWebfetchArgsSchema()
  tools.tm_webfetch = buildTmWebfetchTool({ pipelines, cfg, args: webfetchArgs })
  // tm_memory — project/global memory mirror (Markdown + frontmatter under
  // the same git-aware store base).  Available to ALL agents: memory is not
  // a network channel, it is shared project knowledge.
  const memoryArgs = await buildMemoryArgsSchema()
  tools.tm_memory = buildTmMemoryTool({
    storeBase,
    globalRoot: globalMemoriesDir,
    directory,
    cfg,
    pipelines,
    args: memoryArgs,
  })
  // tm_browser — governed interactive browser (Plan C, headful CDP pipe).
  // Network role tool: team + researcher carry the allow; the other four
  // hold an explicit deny (overrides the tm_* wildcard).  dispose() kills
  // the browser child when the host tears the plugin down.
  const browserTool = buildTmBrowserTool({ pipelines, cfg, args: await buildBrowserArgsSchema() })
  tools.tm_browser = browserTool
  // M3: build tm_ptc_run using a separate pipeline instance (governance
  // reused verbatim).  Its step counter starts at s0001 again — the
  // "ptc-" stepPrefix namespaces its step ids so offloaded payloads can
  // never collide with same-numbered main-pipeline steps in the shared
  // run store (refs ignore seq, so a collision would corrupt tm_fetch).
  const ptcDeps = {
    client: input?.client,
    $: shellBridge,
    cfg,
    store,
    runId,
    hmacKey,
    accessToken,
    expireAt,
    mode,
    extra,
    stepPrefix: "ptc-",
  }
  const ptcPipelines = buildPipelines(ptcDeps)
  const ptcTool = buildPtcRunTool({
    cfg,
    store,
    nextStepId: ptcPipelines.nextStepId,
    ctx: { directory },
    accessToken,
    args: await buildPtcArgsSchema(),
    pipelines: ptcPipelines,
  })
  tools.tm_ptc_run = ptcTool
  return { runId, config: cfg, store, pipelines, tools, dispose: () => browserTool.dispose() }
}

// ---------- re-exports (stable import surface for tests + plugin entry) ----------

export {
  DEFAULT_BASH_READONLY_ALLOWED,
  DEFAULT_WEBFETCH_DOMAINS,
  estimateTokens,
  parseAllowlistEnv,
  parseWebfetchAllowlistEnv,
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
export { buildTmTools } from "./tools.js"
export { buildPipelines } from "./pipelines.js"
export type { TmDeps, TmPipelines } from "./pipelines.js"
export { buildPtcArgsSchema, buildWebfetchArgsSchema } from "./args-schema.js"
export { toToolResult, HANDLE_INVALID_MESSAGE, tmError } from "./result.js"
export type { TmPhase } from "./result.js"
export {
  buildTmWebfetchTool,
  checkWebUrl,
  extractWebResponse,
  fetchWebText,
  hostAllowed,
  htmlToText,
} from "./webfetch.js"

// ---------- tm_ptc_run ----------
// Built here with its own pipeline instance (governance reused verbatim;
// step counter is independent — store handles any step-id overlap via
// tool-name-prefixed files) and MERGED into the registered `tools` map
// below, so all five tools ship in the `tool` segment.
export {
  BRIDGE_ALLOW,
  InlineSequentialEngine,
  InlineVmEngine,
  WorkerEngine,
  PTC_LABEL_MAX,
  PTC_STATUS_VALUES,
  RETRYABLE_PHASES,
  PTC_SUMMARY_HEADER,
  PTC_OK_SECTION,
  PTC_OK_HEADER,
  PTC_ERR_SECTION,
  PTC_ERR_HEADER,
  PTC_RETURN_PREFIX,
  PTC_ERRORFULL_PREFIX,
  buildPtcRunTool,
  createGateBridge,
  parsePtcArgs,
  pipelineBridge,
  renderPtcSummary,
  resolvePtcBudgets,
  runPtc,
  selectEngine,
  staticPscan,
} from "./ptc/index.js"
export type {
  PtcStatus,
  PtcEngine,
  PtcEngineName,
  PtcBridge,
  PtcCallResult,
  PtcErrorBody,
  PtcRunRequest,
  PtcRpcRequest,
  PtcRpcResponse,
  PtcRpcAbort,
  PtcEngineMessage,
  PtcBudgets,
  PtcStepRecord,
  PtcRunOutcome,
  RunPtcOptions,
} from "./ptc/index.js"

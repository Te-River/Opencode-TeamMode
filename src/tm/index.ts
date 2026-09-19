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
 * and assembles the governed tool surface (tm_read / tm_grep / tm_bash /
 * tm_fetch + tm_memory / tm_search / tm_webfetch / tm_browser / tm_ptc_run;
 * T0.4-verified shape: `{ tool: { tm_read: { description, args,
 * execute(args, ctx) } } }`).
 */

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { HostEvent, PluginInput, ToolDefinition } from "../types.js"
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
import { buildPtcArgsSchema, buildWebfetchArgsSchema, buildMemoryArgsSchema, buildBrowserArgsSchema, buildSearchArgsSchema } from "./args-schema.js"
import { buildPtcRunTool } from "./ptc/index.js"
import { buildStatsTool } from "./stats.js"
import { createWebCache } from "./cache.js"
import type { CapabilityRow } from "../capabilities.js"
import { buildTmWebfetchTool } from "./webfetch.js"
import { buildTmSearchTool, SEARCH_ENGINES, SEARCH_ENGINE_NAMES } from "./search.js"
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
export {
  buildTmBrowserTool,
  defaultBrowserExecutable,
  findBrowserExecutable,
  isChromiumFamily,
  isPassiveResource,
  normalizeResourceType,
  parseDesktopExec,
  parseProgId,
  parseRegCommand,
  playwrightLaunchTarget,
  rememberSite,
  resolveHeadless,
  siteOf,
  subresourcePass,
} from "./browser.js"
import { buildTmMemoryTool } from "./memory.js"
import { buildTmBrowserTool } from "./browser.js"
import { buildDispatchTools } from "./dispatch.js"
import { buildTmPtyTool } from "./pty.js"
export { ptyCommandLine, ptyCommandBlocked, ptyVerdictLine } from "./pty.js"
export type { PtyRecord, PtyDeps } from "./pty.js"
export {
  buildDispatchTools,
  DISPATCH_TARGETS,
  lastAssistantText,
  renderChildLine,
  sessionApiOf,
  summarizeStates,
} from "./dispatch.js"
export type { ChildRecord, DispatchDeps } from "./dispatch.js"

export interface TmRuntime {
  runId: string
  config: TmConfig
  store: RunStore
  /** The ONE main pipeline instance (exposed for tests + tool builders). */
  pipelines: ReturnType<typeof import("./pipelines.js").buildPipelines>
  tools: Record<string, ToolDefinition>
  /** Kill any long-lived session the tools own (tm_browser child process).
   *  ASYNC because the host's dispose hook awaits it — a fire-and-forget
   *  browser close could lose the window. */
  dispose: () => Promise<void>
  /** Host event bus slice the async dispatcher needs (session.idle /
   *  .error / .status settle the lead's children). */
  observeDispatchEvent: (event: HostEvent) => void
  /** Open async dispatches this plugin started (tests + observability). */
  dispatches: () => Array<{ sessionID: string; agent: string; label: string; state: string }>
}

export interface CreateTmToolsOptions {
  /** R6 mode — pass the plugin-level resolved value to keep ONE source. */
  mode?: EnvProtectMode
  /** R6 extra deny rules — same single-source rule. */
  extra?: RegExp[]
  /** Best-effort user notification (the host toast) — tm_browser's idle
   *  reaper uses it so an auto-closed window is announced, not silent. */
  notify?: (message: string) => void
  /** A tm_dispatch child session was created — let the approval gate
   *  register it so the sub-agent's own protected read opens the official
   *  dialog instead of hard-throwing in an unregistered session. */
  onChildSession?: (sessionID: string, agent: string) => void
  /** Live host-capability matrix, rendered by tm_stats (the probe itself
   *  lives at the plugin entry because that is where the host surfaces are
   *  handed to us). */
  capabilities?: () => CapabilityRow[]
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
  // ONE URL cache for the whole web channel — tm_webfetch, tm_search's engine
  // legs and the PTC bridge all read it, so a page fetched once in a round is
  // never paid for twice.  Lives beside the run store (under .git in AUTO
  // mode, never in the user's working tree) and OUTSIDE `runs/`, which is all
  // sweepExpired() ever deletes.
  const webCache = createWebCache({
    dir: path.join(store.blackboardRoot, "webcache"),
    ttlSec: cfg.webCacheTtlSec,
  })
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
    // fix batch T3: the ctxDir fallback — the host process cwd is the user
    // HOME on the desktop sidecar, never a valid workspace root.
    workspaceDir: directory,
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
  tools.tm_webfetch = buildTmWebfetchTool({ pipelines, cfg, args: webfetchArgs, cache: webCache })
  // tm_search — the governed search FRONT: multi-engine (bing/bing-int/
  // sogou/so/baidu/bilibili + npm/github JSON), extracted title+URL hit
  // lists, same pipeline + allowlist as tm_webfetch.  Network-role tool
  // like the other two web channels (agents.ts gates who sees it).
  tools.tm_search = buildTmSearchTool({ pipelines, cfg, args: await buildSearchArgsSchema(), cache: webCache })
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
  const browserTool = buildTmBrowserTool({
    pipelines,
    cfg,
    args: await buildBrowserArgsSchema(),
    notify: opts.notify,
  })
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
    workspaceDir: directory,
  }
  const ptcPipelines = buildPipelines(ptcDeps)
  // T6 web bridge: when TM_PTC_WEB_BRIDGE=on, PTC's tm.search / tm.webfetch
  // run SECONDARY tm_search / tm_webfetch instances over the SAME "ptc-"
  // pipeline, so their step ids stay namespaced.  They are NOT registered on
  // the host tool surface here (the main `tools.tm_search` / `tools.tm_webfetch`
  // already are) — they exist only as the bridge's call targets.  Role gating
  // is automatic: each bridged call is executed with the CALLER's per-execute
  // ctx (see buildPtcRunTool.makeBridge), so the host's permission.asked runs
  // against the calling agent's own ruleset and a non-web role is denied.
  const ptcWebTools =
    cfg.ptcWebBridge === "on"
      ? {
          tm_search: buildTmSearchTool({
            pipelines: ptcPipelines,
            cfg,
            args: await buildSearchArgsSchema(),
            cache: webCache,
          }),
          tm_webfetch: buildTmWebfetchTool({
            pipelines: ptcPipelines,
            cfg,
            args: await buildWebfetchArgsSchema(),
            cache: webCache,
          }),
        }
      : undefined
  const ptcTool = buildPtcRunTool({
    cfg,
    store,
    nextStepId: ptcPipelines.nextStepId,
    // assembly-time ctx is only the directory fallback; the bridge re-binds
    // to the real per-execute ctx inside execute(rawArgs, callCtx).
    ctx: { directory },
    accessToken,
    args: await buildPtcArgsSchema(),
    pipelines: ptcPipelines,
    webTools: ptcWebTools,
  })
  tools.tm_ptc_run = ptcTool
  // tm_dispatch / tm_join — ASYNC sub-agent dispatch for the lead (issue #7:
  // the host's `task` tool blocks the calling session, so "parallel team"
  // really meant "serial with extra steps").  Built on the official client
  // session API; both tools self-gate to the lead agent, and the five
  // specialists carry an explicit deny in agents.ts.
  const dispatch = buildDispatchTools({
    client: input?.client,
    pipelines,
    onChildSession: opts.onChildSession,
    // the two guards the built-in task tool applies and a plugin-side
    // dispatcher would otherwise skip: the user's spawn consent and the
    // host's subagent_depth ceiling
    askBeforeSpawn: cfg.dispatchAsk !== "off",
    maxDepth: cfg.subagentDepth,
  })
  tools.tm_dispatch = dispatch.tm_dispatch
  tools.tm_join = dispatch.tm_join
  // tm_pty — non-blocking command execution on the host's own terminal
  // sessions (issue #6: three serial 120 s test suites are minutes of dead
  // air inside one bash call).  Every start passes the R6 classifier AND the
  // official dialog, so this is an async lever, not a bypass channel.
  tools.tm_pty = buildTmPtyTool({ client: input?.client, pipelines, mode, max: cfg.ptyMax })
  // tm_stats — the plugin reads its OWN trajectory back (throughput numbers +
  // the host-capability matrix).  This is what makes "Team is faster" a claim
  // with a number behind it instead of a vibe, and what names the surface an
  // OpenCode upgrade removed.
  tools.tm_stats = buildStatsTool({ store, capabilities: opts.capabilities })
  return {
    runId,
    config: cfg,
    store,
    pipelines,
    tools,
    dispose: () => browserTool.dispose(),
    observeDispatchEvent: dispatch.observeEvent,
    dispatches: () => dispatch.children().map((c) => ({ sessionID: c.sessionID, agent: c.agent, label: c.label, state: c.state })),
  }
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
export { buildPtcArgsSchema, buildWebfetchArgsSchema, buildSearchArgsSchema } from "./args-schema.js"
export { toToolResult, HANDLE_INVALID_MESSAGE, tmError } from "./result.js"
export type { TmPhase } from "./result.js"
export { runShellCommand, spawnShellFallback, cleanShellError } from "./shell-bridge.js"
export {
  buildTmWebfetchTool,
  checkWebUrl,
  extractWebResponse,
  extractSearchHits,
  renderSearchHits,
  fetchWebText,
  hitDomainBlacklist,
  HIT_DOMAIN_BLACKLIST_DEFAULT,
  hostAllowed,
  htmlToText,
} from "./webfetch.js"
export type { SearchHit } from "./webfetch.js"
export {
  buildTmSearchTool,
  SEARCH_ENGINES,
  SEARCH_ENGINE_NAMES,
  renderNpmResults,
  renderGithubResults,
  renderWikiResults,
} from "./search.js"

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
  PtcProgramError,
  PtcStopSignal,
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
  resolvePtcBudgetsDetailed,
  runPtc,
  selectEngine,
  staticPscan,
} from "./ptc/index.js"
// T6 additions pulled straight from their submodules so ptc/index.ts (a
// frozen re-export facade, owned by the PTC split) is not edited: the
// literal-strip helper the pre-scan uses + the web-bridge tool subset.
export { stripNonExecutable } from "./ptc/pscan.js"
export { WEB_BRIDGE_TOOLS } from "./ptc/contract.js"
export type {
  PtcStatus,
  PtcEngine,
  PtcEngineName,
  PtcEngineRunOpts,
  PtcBridge,
  PtcCallResult,
  PtcErrorBody,
  PtcRunRequest,
  PtcRpcRequest,
  PtcRpcResponse,
  PtcRpcAbort,
  PtcEngineMessage,
  PtcBudgets,
  PtcBudgetResolution,
  PtcStepRecord,
  PtcRunOutcome,
  RunPtcOptions,
} from "./ptc/index.js"

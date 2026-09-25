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
import { buildPtcArgsSchema, buildWebfetchArgsSchema, buildMemoryArgsSchema, buildBrowserArgsSchema, buildSearchArgsSchema, buildBoardArgsSchema } from "./args-schema.js"
import { buildPtcRunTool } from "./ptc/index.js"
import { buildStatsTool } from "./stats.js"
import { buildBoardWriteTool } from "./board.js"
import { buildLedgerTool } from "./ledger.js"
import { createWebCache } from "./cache.js"
import type { CapabilityRow } from "../capabilities.js"
import { buildTmWebfetchTool } from "./webfetch.js"
import { buildTmSearchTool, SEARCH_ENGINES, SEARCH_ENGINE_NAMES } from "./search.js"
import { rmForceSafe } from "../fs-safe.js"
export { rmForceSafe }
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
  buildLedgerTool,
  createStorageLedgerStore,
  normalizeLedger,
  emptyLedger,
  addItem,
  markItem,
  openItems,
  renderLedger,
  ledgerGoalLine,
  LEDGER_STATUSES,
  type Ledger,
  type LedgerItem,
  type LedgerStore,
} from "./ledger.js"
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
  /** A sub-agent child session entered our registry (adopted from the host's
   *  session tree, or claimed by an id the lead named) — let the approval gate
   *  register it so the sub-agent's own protected read opens the official
   *  dialog instead of hard-throwing in an unregistered session. */
  onChildSession?: (sessionID: string, agent: string) => void
  /** Live host-capability matrix, rendered by tm_stats (the probe itself
   *  lives at the plugin entry because that is where the host surfaces are
   *  handed to us). */
  capabilities?: () => CapabilityRow[]
  /** Environment to resolve the tool config from.  Defaults to `process.env`,
   *  and exists so the two personalities can fork a DEFAULT without mutating the
   *  host process's env (v1 keeps its shipped behaviour byte-exactly while v2
   *  opens the domain allowlist, which is a personality decision, not a global
   *  one).  Anything the user actually set always wins. */
  env?: Record<string, string | undefined>
  /** Where the lead's LEDGER lives.  v2 passes a `ctx.storage` adapter because
   *  that host has no `todowrite` for the mandate to attach to; v1 passes nothing
   *  and therefore registers no `tm_ledger` at all — its tool surface stays the
   *  one the v1 personality was frozen with. */
  ledgerStore?: import("./ledger.js").LedgerStore
  /** What the v2 `ctx.session` bridge saw (attempted shapes, last host error), so
   *  `tm_join` can report WHY a named id could not be claimed. */
  sessionReaderReport?: () => { attempted: number; resolved: number; usedShape?: string; failedShapes: string[]; lastError?: string }
}

/** Collision-free shard key for a workspace path.  It is a HASH rather than a
 *  sanitized basename because the CJK paths this plugin actually meets strip
 *  to nothing useful — `D:\扒取数据` and `D:\文档` both slug to "d", and a store
 *  shard that collides is the exact bug this exists to kill. */
export function workspaceStoreKey(directory: string): string {
  const norm = path
    .resolve(String(directory ?? "").trim() || process.cwd())
    .replace(/[\\/]+$/g, "")
    .toLowerCase()
  return crypto.createHash("sha256").update(path.normalize(norm)).digest("hex").slice(0, 10)
}

/** The shard dir is created lazily, one per non-git workspace — so a machine
 *  that runs this plugin's own test suite a hundred times grows a `w-*`
 *  directory per throwaway temp dir (64 after a single dev session).  Prune
 *  the siblings that have produced nothing inside the TTL, never the live
 *  one, and never with a bare rmSync (win32 silently no-ops on non-ASCII
 *  paths, which would leave the directory in place and the loop lying about
 *  what it removed). */
export function pruneStaleStoreShards(
  base: string,
  /** the live shard to protect; `null` when this workspace has no shard (a git
   *  workspace stores at the base itself), which means every stale sibling is fair
   *  game — the TTL, not the identity of the current workspace, is what keeps a
   *  session's data alive */
  keep: string | null,
  ttlMs: number,
  now: number = Date.now(),
): string[] {
  const removed: string[] = []
  let names: string[]
  try {
    names = fs.readdirSync(base)
  } catch {
    return removed
  }
  const keepName = keep ? path.basename(keep) : ""
  for (const name of names) {
    if (!/^w-[0-9a-f]{10}$/.test(name) || name === keepName) continue
    const dir = path.join(base, name)
    let newest = 0
    try {
      newest = fs.statSync(dir).mtimeMs
    } catch {
      continue
    }
    for (const sub of ["trajectory/runs", "blackboard/runs"]) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(dir, sub)).mtimeMs)
      } catch {
        /* absent — no evidence of life either way */
      }
    }
    if (now - newest > ttlMs) {
      rmForceSafe(dir, { recursive: true })
      if (!fs.existsSync(dir)) removed.push(name)
    }
  }
  return removed
}

/** A layout nothing reads is still a layout the user paid disk for.  Sharding
 *  moved the run/trajectory trees under `w-<hash>/`, which silently orphaned
 *  the pre-shard `blackboard/` (runs + webcache) and `trajectory/` at the
 *  shared tmpdir base — measured 503 MB and 2654 run dirs on one machine, and
 *  no sweeper points there any more, so an upgrade would never reclaim it.
 *  Drain them under the SAME TTL rule the live store uses: expired is
 *  deletable, fresh is not (a session started before the upgrade may still be
 *  writing there), and the empty shells go last.  `memories/` and the team
 *  blackboard's date-named dirs are still live at that base and are not
 *  touched here. */
export function reclaimLegacyStoreBuckets(
  base: string,
  ttlMs: number,
  now: number = Date.now(),
): string[] {
  const removed: string[] = []
  const emptyTree = (dir: string): boolean => {
    // A FILE is not "empty" — it is an entry that exists.  Treating the
    // readdir throw as true once deleted a live run dir along with its shell.
    if (!fs.existsSync(dir)) return true
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return false
    }
    return names.every((n) => emptyTree(path.join(dir, n)))
  }
  let top: string[]
  try {
    top = fs.readdirSync(base)
  } catch {
    return removed
  }
  if (!top.includes("blackboard") && !top.includes("trajectory")) return removed
  for (const name of ["blackboard", "trajectory"]) {
    const dir = path.join(base, name)
    let containers: string[]
    try {
      containers = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const container of containers) {
      if (container !== "runs" && container !== "webcache") continue
      const cdir = path.join(dir, container)
      let kids: string[]
      try {
        kids = fs.readdirSync(cdir)
      } catch {
        continue
      }
      for (const kid of kids) {
        const p = path.join(cdir, kid)
        let mtime = 0
        try {
          mtime = fs.statSync(p).mtimeMs
        } catch {
          continue
        }
        if (now - mtime > ttlMs) {
          rmForceSafe(p, { recursive: true })
          if (!fs.existsSync(p)) removed.push(`${name}/${container}/${kid}`)
        }
      }
    }
    if (emptyTree(dir)) {
      rmForceSafe(dir, { recursive: true })
      if (!fs.existsSync(dir)) removed.push(name)
    }
  }
  return removed
}

export async function createTmTools(
  input: PluginInput,
  opts: CreateTmToolsOptions = {},
): Promise<TmRuntime> {
  const cfg = resolveTmConfig(opts.env ?? process.env)
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
  const sharedBase = gitUsable
    ? path.join(gitDir as string, "opencode-team")
    : path.join(os.tmpdir(), "opencode-team")
  // A non-git workspace used to share ONE tmpdir bucket with every other
  // non-git workspace — and with this plugin's own test runs.  tm_stats then
  // reported somebody else's session: a user's read-only self-check printed
  // "窗口 10 个 run · 墙钟 81370s" of traffic that belonged to neither their
  // session nor their project.  The run/trajectory/blackboard trees are
  // therefore sharded per workspace.  `memories/` deliberately stays on the
  // shared base — its project tier is already keyed by project slug, and
  // moving it would strand memories the user already wrote.
  const storeBase = gitUsable ? sharedBase : path.join(sharedBase, `w-${workspaceStoreKey(directory)}`)
  // Boot-time reclamation of what an upgrade leaves behind.  Both passes are
  // TTL-gated (expired is deletable, fresh is not — a session started before
  // the upgrade may still be writing), and TM_STORE_RECLAIM=off exists so the
  // test runner never reaches into the developer's real Temp.
  if (cfg.storeReclaim !== "off") {
    const ttlMs = cfg.blackboardTtlDays * 24 * 60 * 60 * 1000
    // Shards live in the TMPDIR bucket and nowhere else — a git workspace's store
    // is inside its own `.git`, which never contains a `w-*`.  So the prune has to
    // name that bucket explicitly rather than reuse `sharedBase`: passing sharedBase
    // meant a git boot swept a directory that can only ever be empty of shards, and
    // the pass was additionally gated on `!gitUsable`.  Two independent reasons why
    // one machine accumulated 2,067 orphaned shards while its owner worked mostly
    // inside repositories.  A git workspace therefore protects no live shard
    // (`keep: null`), and the TTL — not the current workspace's identity — is what
    // spares a session running in another window.
    const shardBucket = path.join(os.tmpdir(), "opencode-team")
    try {
      pruneStaleStoreShards(shardBucket, gitUsable ? null : storeBase, ttlMs)
    } catch {
      /* cleanup only — a failed prune must never cost the session its tools */
    }
    // The pre-shard layout lives at the TMPDIR base and nowhere else: inside a
    // repo, `blackboard/`+`trajectory/` ARE the live store.
    try {
      reclaimLegacyStoreBuckets(shardBucket, ttlMs)
    } catch {
      /* same: reclamation is never worth failing a session over */
    }
  }
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
    storeBase: sharedBase,
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
  // tm_join — the collect side of sub-agent work (see src/tm/dispatch.ts for
  // the whole story).  tm_dispatch is NOT registered: a plugin-spawned child is
  // a session the user can neither open from a card nor stop from the UI, so
  // delegation has exactly one route left — the host's own `task` (governed,
  // visible, killable).  The dispatcher object stays because tm_join needs its
  // registry: children dispatched before the removal are still adopted,
  // collected and cancelled through it, and it self-gates to the lead agent.
  const dispatch = buildDispatchTools({
    client: input?.client,
    pipelines,
    onChildSession: opts.onChildSession,
    maxWaitMs: cfg.joinMaxWaitMs,
    // #80: tm_join reports a child that settled while still holding a browser
    // window.  One shared instance already owns the lease table, so this is a
    // read of a fact, not a second source of truth.
    browserLeases: () => browserTool.leases(),
    // The goal tripwire prefers the HOST's todo list; when there is none (v2),
    // the plugin's own LEDGER is the list that can actually be checked.
    ledgerStore: opts.ledgerStore,
    sessionReaderReport: opts.sessionReaderReport,
  })
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
  // tm_board_write — the blackboard's write side.  The board layout the
  // workspace note publishes is <root>/<session-key>/<task>/NN-<role>-<topic>,
  // and reaching it used to require a file tool: architect and researcher carry
  // none (no write, no edit, not even bash to stamp the session folder), so
  // every oversized deliverable from those roles came back as
  // BLACKBOARD WRITE FAILED + the whole document pasted inline.  This writer is
  // scoped to that one path shape under the SAME root the note advertises —
  // sharedBase, which is teamRootFor(directory) in every mode.
  tools.tm_board_write = buildBoardWriteTool({
    pipelines,
    boardRoot: sharedBase,
    cfg: { boardMaxChars: cfg.boardMaxChars, boardMaxFiles: cfg.boardMaxFiles },
    args: await buildBoardArgsSchema(),
  })
  // tm_ledger — registered ONLY when a store was handed in, which today means
  // v2.  v1 has the host's own `todowrite` for the LEDGER mandate, and the v1
  // personality is frozen: an extra tool in this record would be a v1 tool-
  // surface change smuggled in through a v2 feature.
  if (opts.ledgerStore) {
    tools.tm_ledger = buildLedgerTool({ store: opts.ledgerStore, onlyAgent: "team", env: opts.env ?? process.env })
  }
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

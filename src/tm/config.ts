/**
 * JIT layer-2 tools (T1.2 + T1.3) — configuration surface.
 *
 * Every knob resolves from the process environment with a typed default;
 * invalid values never crash plugin startup, they fall back to the default
 * (same fail-soft philosophy as blackboard.resolveTtlMs and
 * envprotect.resolveEnvProtectMode).
 *
 * Token 口径 (estimate basis): CJK-range code points ≈ one token each,
 * everything else tokens ≈ chars/4, ceil.  Pure chars/4 under-counted CJK
 * up to 4× — the LESS-governed direction for CJK-heavy payloads — so CJK
 * now counts as a full token (offload earlier, the safe direction).  Two
 * design choices keep the estimate honest: the conservative boundary
 * (estimate == threshold still offloads) and the hard preview cap.  This
 * 口径 is pinned by test-tm-tools.mjs.
 *
 * Naming note: TM_BLACKBOARD_DIR (this module, run-payload store, default
 * AUTO = `<repo>/.git/opencode-team/blackboard`) is a DIFFERENT artifact
 * from the team blackboard in blackboard.ts (`.git/opencode-team/`,
 * plugin options).  They share a root philosophy (TTL sweeper is the sole
 * cleanup path), not code.
 */

/** Default tm_bash read-only allowlist (P3, command-level).  The PS
 *  -Object entries are pure pipeline formatters — no write capability. */
export const DEFAULT_BASH_READONLY_ALLOWED: readonly string[] = [
  "ls", "cat", "head", "tail", "grep", "rg", "find", "awk", "sort", "uniq",
  "wc", "cut", "dir", "Get-Content", "Get-ChildItem", "Select-String",
  "Measure-Object", "Select-Object", "Where-Object", "Sort-Object",
  "Group-Object", "Test-Path",
]

/**
 * Seeded tm_webfetch / tm_search domain allowlist — every host the search
 * engines and data sources ride (all reachable from mainland China without
 * API keys): wiki term / bilibili search / bing CN + international / baidu /
 * sogou / 360, the npm registry (JSON search + package metadata) and the
 * GitHub (search API + repo pages + raw/gist content), its ghproxy.net
 * mainland mirror, and PARENT domains for baidu/moegirl so every sibling
 * subdomain (baike./tieba./mzh./mobile.) is covered — real sessions showed
 * agents bouncing off baike.baidu.com and mzh.moegirl.org.cn (the agent-install flow points
 * agents at the installation guide on exactly these hosts).  Subdomains of
 * an entry are included;
 * TM_WEBFETCH_ALLOWED_DOMAINS overrides the list (comma/semicolon
 * separated; a lone "*" opens every host — keep the engine hosts or
 * tm_search's engines lose their targets).
 */
export const DEFAULT_WEBFETCH_DOMAINS: readonly string[] = [
  // CN search engines + content (parent domains cover every sibling subdomain)
  "baidu.com", // www. search / baike. encyclopedia / tieba. — real sessions hit baike.baidu.com
  "moegirl.org.cn", // mobile. term / mzh. main site — real sessions hit mzh
  "bilibili.com", // search. / www. video pages / space.
  "www.sogou.com",
  "www.so.com",
  "cn.bing.com",
  "www.bing.com",
  "zhihu.com", // CN Q&A
  "juejin.cn", // CN dev community
  "csdn.net", // CN dev blogs
  "cnblogs.com", // CN dev blogs
  "gitee.com", // CN code hosting
  // international dev sources (reachable from CN, no API keys)
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "ghproxy.net", // mainland mirror for github raw
  "stackoverflow.com",
  "npmjs.org", // registry. + www. package pages
  "pypi.org",
  "learn.microsoft.com",
]

export interface TmConfig {
  /** Offload boundary in estimated tokens (estimate == threshold offloads). */
  offloadThreshold: number
  /** Raw lines a preview builder may scan before summarizing. */
  previewLines: number
  /** Hard preview cap in estimated tokens — preview bloat is an R4 regression. */
  previewMaxTokens: number
  /** Single tm_fetch segment cap in lines. */
  fetchMaxLines: number
  /** Run-payload store dir.  Empty = AUTO (<repo>/.git/opencode-team/blackboard,
   *  tmpdir fallback); explicit value = absolute, or relative to project root. */
  blackboardDir: string
  /** Trajectory store dir.  Empty = AUTO (<repo>/.git/opencode-team/trajectory,
   *  tmpdir fallback); explicit value = absolute, or relative to project root. */
  trajectoryDir: string
  /** Handle TTL in days (expire_at + physical sweep of expired run dirs). */
  blackboardTtlDays: number
  /** P3 read-only command allowlist for tm_bash. */
  bashReadonlyAllowed: string[]
  /** tm_webfetch domain allowlist (subdomains included; "*" = any host). */
  webfetchAllowedDomains: string[]
  /** tm_memory GLOBAL scope dir.  Empty = auto (~/.opencode-team/memories/global
   *  — user-level, follows the user across projects). */
  memoryGlobalDir: string
  // ---- tm_ptc_run (M1 contract) — see design 02-architect-ptc-run-design §2/§4.3 ----
  /** Hard cap on a PTC program source string length (chars). */
  ptcMaxProgramChars: number
  /** Ceiling for per-run bridge-call budget (callers may only tighten). */
  ptcMaxCalls: number
  /** Ceiling for per-run error budget (callers may only tighten). */
  ptcMaxErrors: number
  /** Ceiling for per-run wall-clock timeout in ms (callers may only tighten). */
  ptcTimeoutMs: number
  /** Engine selection: auto (worker→inline fallback) | worker | inline. */
  ptcEngine: "auto" | "worker" | "inline"

  // ---- TeamMode upgrade P0 knobs (design 20260915 §② contract) ----
  // Declared HERE, consumed by their owning packages downstream (T1-T6);
  // P0 is the single landing point so parallel packages never edit this file.
  /** tm_memory session-scope entry TTL in minutes (lazy + boot sweep).
   *  Consumed by memory.ts (T1). */
  memorySessionTtlMin: number
  /** tm_memory max entries per scope (project / global); over the cap,
   *  add fails with a compact/forget hint.  Consumed by memory.ts (T1). */
  memoryMaxEntries: number
  /** tm_memory staleness marker age in days; 0 disables `[stale Nd]`
   *  tagging on search hits.  Consumed by memory.ts (T1). */
  memoryStaleDays: number
  /** tm_memory session persistence: "" (default) = ephemeral in-process
   *  Map only; "1" = also write under <storeBase>/memories/sessions/<sid>/.
   *  Consumed by memory.ts (T1). */
  memorySessionPersist: string
  /** tm_search default engine when no explicit `engine` arg is given
   *  ("auto" = current first-engine behavior).  Consumed by search.ts (T4). */
  searchDefaultEngine: string
  /** Offload boundary (estimated tokens) for the markdown/text/log prose
   *  class.  Defaults to 4000 when NOTHING is set; but if the user only set
   *  the global `TM_OFFLOAD_THRESHOLD` (no `TM_OFFLOAD_THRESHOLD_TEXT`),
   *  this tier INHERITS the global so a prose-heavy session that raised the
   *  boundary is not silently capped back to 4000.  An explicit
   *  `TM_OFFLOAD_THRESHOLD_TEXT` always wins.  Consumed by pipelines.ts
   *  `offloadThresholdFor` (T4 tiering — now live). */
  offloadThresholdText: number
  /** Offload boundary for the json/csv/code/binary data class.  Defaults to
   *  2000 (= the historical global baseline) when NOTHING is set; inherits
   *  an explicitly-set `TM_OFFLOAD_THRESHOLD` exactly like the text tier; an
   *  explicit `TM_OFFLOAD_THRESHOLD_DATA` always wins.  Consumed by
   *  pipelines.ts `offloadThresholdFor` (T4 tiering — now live). */
  offloadThresholdData: number
  /** tm_browser engine: "playwright" (default; a failed playwright-core
   *  import degrades to legacy CDP at runtime) | "cdp-legacy".
   *  Consumed by browser.ts (T5). */
  browserEngine: "playwright" | "cdp-legacy"
  /** Hard cap (estimated tokens) for tm_browser snapshot payloads.
   *  Consumed by browser.ts (T5). */
  browserSnapshotMaxTokens: number
  /** tm_ptc_run web bridge: "on" (default) exposes tm.search/tm.webfetch
   *  facades to PTC programs; "off" removes them from the bridge set.
   *  Consumed by ptc/* (T6). */
  ptcWebBridge: "on" | "off"
  /** Floor (minutes) for the approval-gate ask timeout.  LIVE (Wave A/T2):
   *  approval-gate.ts `resolveAskTimeoutMs` clamps the reply with
   *  `Math.max(min, resolveTmConfig(env).askTimeoutFloorMin)` — this knob
   *  drives the floor, replacing the old hardcoded MIN_ASK_TIMEOUT_MIN=3.
   *  DEFAULTED TO 1 (user directive): a reject that lands on an already-
   *  closed request is classified benign `already-closed` by T2's
   *  classifyReplyFailure, so the ~120s replied-event bus lag no longer
   *  forces a 3-min floor — an unanswered dialog auto-rejects after 1 min. */
  askTimeoutFloorMin: number
}

export const TM_CONFIG_DEFAULTS = {
  offloadThreshold: 2000,
  previewLines: 20,
  previewMaxTokens: 80,
  fetchMaxLines: 2000,
  // Empty string = AUTO: resolve git-aware at runtime —
  // <repo>/.git/opencode-team/{blackboard,trajectory} (tmpdir fallback for
  // non-git workspaces).  Keeps the payload/trajectory stores out of the
  // user's working tree (user projects never had .blackboard/.trajectory
  // gitignore entries).  An explicit TM_BLACKBOARD_DIR / TM_TRAJECTORY_DIR
  // keeps the old semantics: absolute, or relative to the project root.
  blackboardDir: "",
  trajectoryDir: "",
  blackboardTtlDays: 7,
  ptcMaxProgramChars: 4000,
  ptcMaxCalls: 20,
  ptcMaxErrors: 3,
  ptcTimeoutMs: 60000,
  ptcEngine: "auto",
  // ---- P0 upgrade knobs (see TmConfig doc comments for ownership) ----
  memorySessionTtlMin: 240,
  memoryMaxEntries: 200,
  memoryStaleDays: 30,
  memorySessionPersist: "",
  searchDefaultEngine: "auto",
  // Literal fallbacks used ONLY when the global TM_OFFLOAD_THRESHOLD is
  // unset.  When the global IS set and a tier env is not, resolveTmConfig
  // derives that tier from the global (inherit — Wave B M1) instead of
  // applying these.
  offloadThresholdText: 4000,
  offloadThresholdData: 2000,
  browserEngine: "playwright",
  browserSnapshotMaxTokens: 1200,
  ptcWebBridge: "on",
  // Consumed by approval-gate.ts resolveAskTimeoutMs (Math.max floor, Wave A).
  // 1 min since the T2 benign already-closed split (user directive).
  askTimeoutFloorMin: 1,
} as const

/** Inclusive ceilings/floors for the PTC budgets (design §4.3). */
export const PTC_BUDGET_BOUNDS = {
  maxCalls: { min: 1, max: 200 },
  maxErrors: { min: 1, max: 50 },
  timeoutMs: { min: 5000, max: 600000 },
  programChars: { min: 200, max: 200000 },
} as const

type EnvLike = Record<string, string | undefined>

function envInt(env: EnvLike, key: string, def: number, min: number, max: number): number {
  const raw = env[key]
  if (typeof raw !== "string" || raw.trim() === "") return def
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return def
  const i = Math.trunc(n)
  if (i < min || i > max) return def
  return i
}

function envStr(env: EnvLike, key: string, def: string): string {
  const raw = env[key]
  if (typeof raw !== "string") return def
  const v = raw.trim()
  return v === "" ? def : v
}

/**
 * Parse a comma/semicolon-separated allowlist env var.  Unset/absent -> null
 * (caller applies the default).  An explicitly EMPTY string parses to []
 * (deny-all) — an explicit user choice is respected.  Shared by
 * TM_BASH_READONLY_ALLOWED and TM_WEBFETCH_ALLOWED_DOMAINS.
 */
export function parseAllowlistEnv(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
}

/** Historical alias — identical grammar to parseAllowlistEnv. */
export const parseWebfetchAllowlistEnv = parseAllowlistEnv

/** Resolve the full tm-tools config from an env-like record (default: process.env). */
export function resolveTmConfig(env: EnvLike = process.env): TmConfig {
  const allowlist = parseAllowlistEnv(env.TM_BASH_READONLY_ALLOWED)
  const globalOffload = envInt(env, "TM_OFFLOAD_THRESHOLD", TM_CONFIG_DEFAULTS.offloadThreshold, 0, 10_000_000)
  // Wave B M1 fix — TIER INHERITANCE.  The TEXT/DATA classes inherit the
  // global boundary when the user set TM_OFFLOAD_THRESHOLD but left a tier
  // env UNSET: a user who raised the global to 8000 to save tokens must not
  // have prose silently capped back to 4000 (and json to 2000).  With the
  // global ALSO unset the documented per-class defaults stand (4000 text /
  // 2000 data — data equals the old baseline so the no-env behavior is the
  // T4 tiering the §6m-t tests pin).  An explicit tier env always wins.
  const globalOffloadSet = typeof env.TM_OFFLOAD_THRESHOLD === "string" && env.TM_OFFLOAD_THRESHOLD.trim() !== ""
  const textTierDefault = globalOffloadSet ? globalOffload : TM_CONFIG_DEFAULTS.offloadThresholdText
  const dataTierDefault = globalOffloadSet ? globalOffload : TM_CONFIG_DEFAULTS.offloadThresholdData
  return {
    offloadThreshold: globalOffload,
    previewLines: envInt(env, "TM_PREVIEW_LINES", TM_CONFIG_DEFAULTS.previewLines, 1, 1000),
    previewMaxTokens: envInt(env, "TM_PREVIEW_MAX_TOKENS", TM_CONFIG_DEFAULTS.previewMaxTokens, 10, 100_000),
    fetchMaxLines: envInt(env, "TM_FETCH_MAX_LINES", TM_CONFIG_DEFAULTS.fetchMaxLines, 1, 1_000_000),
    blackboardDir: envStr(env, "TM_BLACKBOARD_DIR", TM_CONFIG_DEFAULTS.blackboardDir),
    trajectoryDir: envStr(env, "TM_TRAJECTORY_DIR", TM_CONFIG_DEFAULTS.trajectoryDir),
    blackboardTtlDays: envInt(env, "TM_BLACKBOARD_TTL", TM_CONFIG_DEFAULTS.blackboardTtlDays, 1, 365),
    bashReadonlyAllowed: allowlist ?? [...DEFAULT_BASH_READONLY_ALLOWED],
    webfetchAllowedDomains:
      parseAllowlistEnv(env.TM_WEBFETCH_ALLOWED_DOMAINS) ?? [...DEFAULT_WEBFETCH_DOMAINS],
    memoryGlobalDir: envStr(env, "TM_MEMORY_GLOBAL_DIR", ""),
    ptcMaxProgramChars: envInt(env, "TM_PTC_MAX_PROGRAM_CHARS", TM_CONFIG_DEFAULTS.ptcMaxProgramChars, PTC_BUDGET_BOUNDS.programChars.min, PTC_BUDGET_BOUNDS.programChars.max),
    ptcMaxCalls: envInt(env, "TM_PTC_MAX_CALLS", TM_CONFIG_DEFAULTS.ptcMaxCalls, PTC_BUDGET_BOUNDS.maxCalls.min, PTC_BUDGET_BOUNDS.maxCalls.max),
    ptcMaxErrors: envInt(env, "TM_PTC_MAX_ERRORS", TM_CONFIG_DEFAULTS.ptcMaxErrors, PTC_BUDGET_BOUNDS.maxErrors.min, PTC_BUDGET_BOUNDS.maxErrors.max),
    ptcTimeoutMs: envInt(env, "TM_PTC_TIMEOUT_MS", TM_CONFIG_DEFAULTS.ptcTimeoutMs, PTC_BUDGET_BOUNDS.timeoutMs.min, PTC_BUDGET_BOUNDS.timeoutMs.max),
    ptcEngine: resolveEngine(env.TM_PTC_ENGINE),
    // ---- P0 upgrade knobs (fail-soft like the rest: invalid -> default) ----
    memorySessionTtlMin: envInt(env, "TM_MEMORY_SESSION_TTL_MIN", TM_CONFIG_DEFAULTS.memorySessionTtlMin, 1, 100_000),
    memoryMaxEntries: envInt(env, "TM_MEMORY_MAX_ENTRIES", TM_CONFIG_DEFAULTS.memoryMaxEntries, 1, 100_000),
    memoryStaleDays: envInt(env, "TM_MEMORY_STALE_DAYS", TM_CONFIG_DEFAULTS.memoryStaleDays, 0, 3650),
    memorySessionPersist: envStr(env, "TM_MEMORY_SESSION_PERSIST", TM_CONFIG_DEFAULTS.memorySessionPersist),
    searchDefaultEngine: envStr(env, "TM_SEARCH_DEFAULT_ENGINE", TM_CONFIG_DEFAULTS.searchDefaultEngine),
    offloadThresholdText: envInt(env, "TM_OFFLOAD_THRESHOLD_TEXT", textTierDefault, 0, 10_000_000),
    offloadThresholdData: envInt(env, "TM_OFFLOAD_THRESHOLD_DATA", dataTierDefault, 0, 10_000_000),
    browserEngine: resolveBrowserEngine(env.TM_BROWSER_ENGINE),
    browserSnapshotMaxTokens: envInt(env, "TM_BROWSER_SNAPSHOT_MAX_TOKENS", TM_CONFIG_DEFAULTS.browserSnapshotMaxTokens, 10, 100_000),
    ptcWebBridge: resolveOnOff(env.TM_PTC_WEB_BRIDGE),
    askTimeoutFloorMin: envInt(env, "TM_ASK_TIMEOUT_FLOOR_MIN", TM_CONFIG_DEFAULTS.askTimeoutFloorMin, 1, 1440),
  }
}

function resolveEngine(raw: unknown): "auto" | "worker" | "inline" {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  return v === "worker" || v === "inline" ? v : "auto"
}

/** TM_BROWSER_ENGINE — anything not exactly "cdp-legacy" resolves to the
 *  playwright default (runtime import failure degrades to legacy inside
 *  browser.ts, T5 — the config layer only parses the preference). */
function resolveBrowserEngine(raw: unknown): "playwright" | "cdp-legacy" {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  return v === "cdp-legacy" ? v : "playwright"
}

/** TM_PTC_WEB_BRIDGE — off only on an explicit off-ish value; unset or
 *  invalid keeps the bridge on (fail-soft toward the newer default). */
function resolveOnOff(raw: unknown): "on" | "off" {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  return v === "off" || v === "0" || v === "false" ? "off" : "on"
}
/** Token cost of ONE code point — CJK-range ≈ 1 token (kana / Hangul /
 *  fullwidth / CJK punctuation all sit above U+2E80), everything else ≈ 0.25
 *  (chars/4).  Shared by estimateTokens and preview.capTokens so the two
 *  can never drift apart (a chars/4 cap would under-count CJK bodies 4×). */
export function tokenCostOf(cp: number): number {
  return cp >= 0x2e80 ? 1 : 0.25
}

/**
 * Token estimate — CJK-aware: CJK-range code points count ≈ one token each,
 * everything else chars/4, ceil.  The pure chars/4 basis under-counted CJK
 * up to 4× (one CJK char ≈ one token), which let CJK-heavy payloads ride
 * inline PAST the threshold — a mis-estimate in the LESS-governed
 * direction.  Counting CJK as a full token errs the other way (offload
 * earlier), the safe direction for context size.  The conservative
 * boundary (estimate == threshold still offloads) is unchanged.  Empty
 * input = 0.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cost = 0
  for (const ch of text) cost += tokenCostOf(ch.codePointAt(0) ?? 0)
  return Math.ceil(cost)
}

/**
 * Offload decision.  estimate == threshold ALSO offloads — the conservative
 * boundary (HUMAN-pinned spec: "等于阈值也卸载").
 */
export function shouldOffload(tokens: number, threshold: number): boolean {
  return tokens >= threshold
}

/** Collapse whitespace and hard-cap a string for messages / clue lines. */
export function shorten(text: unknown, max: number): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim()
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…"
}

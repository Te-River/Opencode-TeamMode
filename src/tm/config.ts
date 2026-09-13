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
  "Group-Object",
]

/**
 * Seeded tm_webfetch domain allowlist — the lookup hosts the design names
 * (wiki term / bilibili search / bing / baidu) plus the npm registry (JSON
 * package-metadata queries).  Subdomains of an entry are included;
 * TM_WEBFETCH_ALLOWED_DOMAINS overrides the list (comma/semicolon
 * separated; a lone "*" opens every host).
 */
export const DEFAULT_WEBFETCH_DOMAINS: readonly string[] = [
  "mobile.moegirl.org.cn",
  "search.bilibili.com",
  "cn.bing.com",
  "www.baidu.com",
  "registry.npmjs.org",
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
  return {
    offloadThreshold: envInt(env, "TM_OFFLOAD_THRESHOLD", TM_CONFIG_DEFAULTS.offloadThreshold, 0, 10_000_000),
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
  }
}

function resolveEngine(raw: unknown): "auto" | "worker" | "inline" {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  return v === "worker" || v === "inline" ? v : "auto"
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

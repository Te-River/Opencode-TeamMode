/**
 * JIT layer-2 tools (T1.2 + T1.3) — configuration surface.
 *
 * `team-mode.jsonc` is the ONLY configuration source.  The registry in
 * `config-layers.ts` carries each key's default and doc; `resolveConfig`
 * validates, clamps and fills defaults from it.  There is no `TM_*` config
 * env var any more (the three internal/test switches — TM_STORE_RECLAIM,
 * TM_V2_PROBE, TM_CONFIG_AUTOCREATE — are read where they are used, not here).
 *
 * Invalid values never crash plugin startup: a non-numeric number falls back to
 * its default, an out-of-range number is CLAMPED to `min`/`max`, a wrong
 * type falls back to the default (same fail-soft philosophy as
 * blackboard.resolveTtlMs and envprotect.resolveEnvProtectMode).
 *
 * Token 口径 (estimate basis): CJK-range code points ≈ one token each,
 * everything else tokens ≈ chars/4, ceil.  Pure chars/4 under-counted CJK
 * up to 4× — the LESS-governed direction for CJK-heavy payloads — so CJK
 * now counts as a full token (offload earlier, the safe direction).  Two
 * design choices keep the estimate honest: the conservative boundary
 * (estimate == threshold still offloads) and the hard preview cap.  This
 * 口径 is pinned by test-tm-tools.mjs.
 *
 * Naming note: `blackboardDir` (this module, run-payload store, default
 * AUTO = `<repo>/.git/opencode-team/blackboard`) is a DIFFERENT artifact
 * from the team blackboard in blackboard.ts (`.git/opencode-team/`,
 * plugin options).  They share a root philosophy (TTL sweeper is the sole
 * cleanup path), not code.
 */

import {
  CONFIG_KEYS,
  DEFAULT_BASH_READONLY_ALLOWED,
  DEFAULT_WEBFETCH_DOMAINS,
  isPlainObject,
  type ConfigKeySpec,
} from "./config-layers.js"

export { DEFAULT_BASH_READONLY_ALLOWED, DEFAULT_WEBFETCH_DOMAINS }

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

  // ---- TeamMode upgrade P0 knobs (design 20260915 §② contract) ----
  /** tm_memory session-scope entry TTL in minutes (lazy + boot sweep). */
  memorySessionTtlMin: number
  /** tm_memory max entries per scope (project / global); over the cap,
   *  add fails with a compact/forget hint. */
  memoryMaxEntries: number
  /** tm_memory staleness marker age in days; 0 disables `[stale Nd]`. */
  memoryStaleDays: number
  /** tm_memory session persistence: "" (default) = ephemeral in-process
   *  Map only; "1" = also write under <storeBase>/memories/sessions/<sid>/. */
  memorySessionPersist: string
  /** tm_search default engine when no explicit `engine` arg is given. */
  searchDefaultEngine: string
  /** Hits kept per engine leg AND in the final fused list. */
  searchMaxHits: number
  /** Per-engine fusion weight overrides (`bing=0.2,hn=0.3`). */
  searchWeights: Record<string, number>
  /** Engines removed from the roster AND from every auto route. */
  searchDisabledEngines: string[]
  /** Weight multiplier applied to a ZERO-overlap hit. */
  searchRelevanceFloor: number
  /** Offload boundary (estimated tokens) for the markdown/text/log prose
   *  class.  Inherits an explicitly-set `offloadThreshold` when this key is
   *  not set; an explicit value always wins. */
  offloadThresholdText: number
  /** Offload boundary for the json/csv/code/binary data class.  Inherits the
   *  global exactly like the text tier. */
  offloadThresholdData: number
  /** URL-level cache TTL in seconds (0 disables). */
  webCacheTtlSec: number
  /** The ceiling on tm_join's bounded wait (ms). */
  joinMaxWaitMs: number
  /** tm_board_write: one board file's character cap and one session folder's file cap. */
  boardMaxChars: number
  boardMaxFiles: number
  /** Keep the HOST's own background sub-agent reply inside our context budget. */
  taskOffload: "on" | "off"
  /** Reclaim the store layout an upgrade left behind. */
  storeReclaim: "on" | "off"
  /** Floor (minutes) for the (v1) approval-gate ask timeout.  ORPHANED. */
  askTimeoutFloorMin: number
  /** Ceiling (ms) forced onto the built-in bash tool's `timeout` ARG. */
  bashTimeoutMaxMs: number
  /** Ceiling (ms) for a bash command the P3 read-only allowlist accepts. */
  bashTimeoutProbeMs: number

  // ---- knobs that used to be read straight from process.env ----
  /** JIT governance over the HOST's own tools (read/grep/shell…). */
  nativeOffload: "on" | "off"
  /** (v1-only) tm_ptc_run's web bridge. */
  ptcWebBridge: "on" | "off"
  /** Extra hit-domain blacklist entries (merged with the built-in default). */
  hitBlacklist: string[]
  /** R6 extra deny rules (raw `K=V;K2=V2`-style string). */
  envProtectExtraDeny: string
  /** (v1-only) shell env passthrough. */
  shellEnv: string
  /** (v1-only) per-agent temperature overrides. */
  agentTemperature: string
  /** (v1-only) compaction survival list. */
  compactionContext: "on" | "off"
  /** R6 mode (strict/standard/off). */
  envProtect: string
  /** R6 fine-grained ask policy; "off" = every shell command asks. */
  r6FineAsk: string
  /** Private-space policy (allow/deny/ask). */
  privateSpace: string

  // ---- v2 request layers (were read straight from process.env) ----
  /** Concurrency cap on `subagent`; 0 disables. */
  maxConcurrentSubagents: number
  /** v2 tool delivery: "direct" sends options.codemode=false; "" = catalog. */
  v2CodeMode: string
  /** Context pruning (settled messages → pointers). */
  prune: "on" | "off"
  /** Percent of the window at which pruning starts. */
  pruneAtPercent: number
  /** Percent of the window kept verbatim at the tail. */
  pruneKeepTailPercent: number
  /** Retry governor (recognise throttle + inject wait + cooldown). */
  retry: "on" | "off"
  retryBaseMs: number
  retryMaxMs: number
  retryJitter: number
  retryBreakAfter: number
  retryCooldownMs: number
  /** Split advice when a dispatch brief is oversized. */
  splitAdvice: "on" | "off"
  splitBriefTokens: number
  splitMaxCriteria: number
  /** Code Mode adoption hint after a run of native calls. */
  probeChain: "on" | "off"
  probeChainAfter: number
  /** Token budget a native browser snapshot keeps (addressing lines). */
  nativeSnapshotMaxTokens: number
  /** Token budget a native report keeps (tables). */
  nativeReportMaxTokens: number
  /** The native `browser_*` catalog gate. */
  v2BrowserGate: "on" | "off"
  /** tm_ledger per-session item cap. */
  ledgerMaxItems: number
}

/** The registry's defaults, keyed by canonical key.  Derived from
 *  `CONFIG_KEYS` so a default can never drift from its spec. */
export const TM_CONFIG_DEFAULTS: Record<string, unknown> = Object.fromEntries(
  CONFIG_KEYS.map((k) => [k.key, k.default]),
)

/** TM_SEARCH_WEIGHTS — `bing=0.2,hn=0.3` into a partial weight table.  A
 *  malformed pair is dropped (not the whole var), so one typo cannot silently
 *  flatten every custom weight back to the built-in table.  Kept for the
 *  string form; a file value is native JSON and skips this. */
export function parseWeightsEnv(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof raw !== "string") return out
  for (const part of raw.split(/[,;]/)) {
    const m = /^\s*([A-Za-z0-9_-]{1,30})\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(part)
    if (!m) continue
    const w = Number(m[2])
    if (Number.isFinite(w) && w > 0 && w <= 10) out[m[1].toLowerCase()] = w
  }
  return out
}

/**
 * Parse a comma/semicolon-separated allowlist string.  Unset/absent -> null
 * (caller applies the default).  An explicitly EMPTY string parses to []
 * (deny-all) — an explicit user choice is respected.  Kept for the string
 * form; a file value is native JSON and skips this.
 */
export function parseAllowlistEnv(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
}

/** Historical alias — identical grammar to parseAllowlistEnv. */
export const parseWebfetchAllowlistEnv = parseAllowlistEnv

/** TM_PTC_WEB_BRIDGE — off only on an explicit off-ish value; unset or
 *  invalid keeps the bridge on (fail-soft toward the newer default). */
export function resolveOnOff(raw: unknown): "on" | "off" {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  return v === "off" || v === "0" || v === "false" ? "off" : "on"
}

/**
 * Coerce ONE raw value against its spec.  `undefined`/`null` -> the default.
 * A `number` is truncated when the default is an integer, then clamped to
 * `min`/`max`; a non-numeric value falls back to the default.  A `string`
 * with an `enum` must match (case-insensitively; on/off also accept the
 * 0/1/false/true/no/yes spellings); otherwise the default.  A `string[]`
 * must be an array of strings; a `record` a plain object of numbers.
 */
export function coerceValue(spec: ConfigKeySpec, raw: unknown): unknown {
  if (raw === undefined || raw === null) return spec.default
  switch (spec.type) {
    case "number": {
      if (typeof raw === "string" && raw.trim() === "") return spec.default
      const n = typeof raw === "number" ? raw : Number(String(raw).trim())
      if (!Number.isFinite(n)) return spec.default
      let v = Number.isInteger(spec.default) ? Math.trunc(n) : n
      if (spec.min !== undefined) v = Math.max(spec.min, v)
      if (spec.max !== undefined) v = Math.min(spec.max, v)
      return v
    }
    case "string": {
      // A non-string raw (a number, a boolean) is a wrong TYPE, not a value
      // to stringify: `searchDefaultEngine: 5` must fall back to the default,
      // not become the string "5".
      if (typeof raw !== "string") return spec.default
      const s = raw.trim()
      if (spec.enum) {
        const hit = spec.enum.find((e) => e.toLowerCase() === s.toLowerCase())
        if (hit) return hit
        if (spec.enum.includes("on") && spec.enum.includes("off")) {
          if (/^(0|false|no)$/i.test(s)) return "off"
          if (/^(1|true|yes)$/i.test(s)) return "on"
        }
        return spec.default
      }
      return s === "" ? spec.default : s
    }
    case "string[]": {
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return spec.default
      return raw.map((x) => x)
    }
    case "record": {
      if (!isPlainObject(raw) || !Object.values(raw).every((x) => typeof x === "number")) return spec.default
      return { ...raw }
    }
  }
}

/**
 * Resolve the full tm-tools config from an already-merged JSON value record
 * (the file layers, plus any programmatic `configDefaults`).  Registry-driven:
 * every key gets its coerced value or its default.  The two offload tiers
 * INHERIT an explicitly-set `offloadThreshold` when they are not set
 * themselves (Wave B M1) — a user who raised the global to save tokens must
 * not have prose silently capped back to 4000.
 */
export function resolveConfig(values: Record<string, unknown> = {}): TmConfig {
  const out: Record<string, unknown> = {}
  for (const spec of CONFIG_KEYS) out[spec.key] = coerceValue(spec, values[spec.key])
  if (values.offloadThreshold !== undefined) {
    if (values.offloadThresholdText === undefined) out.offloadThresholdText = out.offloadThreshold
    if (values.offloadThresholdData === undefined) out.offloadThresholdData = out.offloadThreshold
  }
  return out as unknown as TmConfig
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

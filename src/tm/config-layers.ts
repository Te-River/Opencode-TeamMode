/**
 * Layered `team-mode` configuration — the PURE layer (package ①, 2026-10-06).
 *
 * Two file layers only, per the user's decision (2026-10-06): the host's own
 * config has NO session layer (opencode.ai/v2/docs/config), so neither do we.
 *
 *   env  <  global  <  project
 *
 * A file WINS over env for the same key.  Within the project layer the
 * `.opencode/` file wins over the direct one, mirroring the host's own
 * discovery order (direct files merged farthest→closest, then `.opencode/`
 * dirs in the same order — every discovered `.opencode` config overrides
 * every direct config).
 *
 * This module is deliberately IO-free: it takes raw JSONC text (or null when
 * a file does not exist) and returns a resolved view.  Reading the files,
 * the scope gate and the trajectory line are package ②'s job.
 *
 * Three rules the design pins, each implemented here:
 *   - a layer that fails to PARSE is skipped WHOLE and reported — never a
 *     half-applied config (a syntax error in a project file must not take the
 *     global layer down with it, and must not apply "the keys that happened to
 *     parse");
 *   - a single key with the WRONG TYPE is dropped from that layer only, and
 *     the next layer down answers for it;
 *   - a RED-LINE key written in a file is IGNORED outright and always resolves
 *     from env/default (see RED_LINE_EXEMPT_KEYS).
 */

/** Env-like record — kept local so this module has no import cycle with config.ts. */
export type EnvLike = Record<string, string | undefined>

export type ConfigValueType = "number" | "string" | "string[]" | "record"

/** One honored knob: its canonical file key, the env var it mirrors, and the
 *  JSON type a file value must have.  The registry IS the "known key" set —
 *  a key absent here is reported as unknown (warned, never applied). */
export interface ConfigKeySpec {
  /** Canonical file key (camelCase; matches the TmConfig field where one exists). */
  key: string
  /** The env var this key mirrors. */
  env: string
  type: ConfigValueType
  /** Red-line: a file value is ignored, the key always resolves from env/default. */
  redLine?: boolean
  /** Why the file may not override it (shown in the ignored-key report). */
  redLineReason?: string
}

/**
 * The honored-key registry.  Extend it when a new knob is wired — an
 * unlisted real knob would be reported as "unknown", a false positive.
 *
 * The first block mirrors `resolveTmConfig` (src/tm/config.ts) one-for-one;
 * the red-line block adds the three knobs that live OUTSIDE TmConfig
 * (envProtect / r6FineAsk / privateSpace) plus the four the design names as
 * file-overridable but that are read directly from process.env.
 */
export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  // ---- resolveTmConfig surface (src/tm/config.ts:379) ----
  { key: "offloadThreshold", env: "TM_OFFLOAD_THRESHOLD", type: "number" },
  { key: "previewLines", env: "TM_PREVIEW_LINES", type: "number" },
  { key: "previewMaxTokens", env: "TM_PREVIEW_MAX_TOKENS", type: "number" },
  { key: "fetchMaxLines", env: "TM_FETCH_MAX_LINES", type: "number" },
  { key: "blackboardDir", env: "TM_BLACKBOARD_DIR", type: "string" },
  { key: "trajectoryDir", env: "TM_TRAJECTORY_DIR", type: "string" },
  { key: "blackboardTtlDays", env: "TM_BLACKBOARD_TTL", type: "number" },
  { key: "bashReadonlyAllowed", env: "TM_BASH_READONLY_ALLOWED", type: "string[]" },
  { key: "webfetchAllowedDomains", env: "TM_WEBFETCH_ALLOWED_DOMAINS", type: "string[]" },
  { key: "memoryGlobalDir", env: "TM_MEMORY_GLOBAL_DIR", type: "string" },
  { key: "memorySessionTtlMin", env: "TM_MEMORY_SESSION_TTL_MIN", type: "number" },
  { key: "memoryMaxEntries", env: "TM_MEMORY_MAX_ENTRIES", type: "number" },
  { key: "memoryStaleDays", env: "TM_MEMORY_STALE_DAYS", type: "number" },
  { key: "memorySessionPersist", env: "TM_MEMORY_SESSION_PERSIST", type: "string" },
  { key: "searchDefaultEngine", env: "TM_SEARCH_DEFAULT_ENGINE", type: "string" },
  { key: "searchMaxHits", env: "TM_SEARCH_MAX_HITS", type: "number" },
  { key: "searchWeights", env: "TM_SEARCH_WEIGHTS", type: "record" },
  { key: "searchDisabledEngines", env: "TM_SEARCH_DISABLED_ENGINES", type: "string[]" },
  { key: "searchRelevanceFloor", env: "TM_SEARCH_RELEVANCE_FLOOR", type: "number" },
  { key: "offloadThresholdText", env: "TM_OFFLOAD_THRESHOLD_TEXT", type: "number" },
  { key: "offloadThresholdData", env: "TM_OFFLOAD_THRESHOLD_DATA", type: "number" },
  { key: "webCacheTtlSec", env: "TM_WEB_CACHE_TTL_SEC", type: "number" },
  { key: "joinMaxWaitMs", env: "TM_JOIN_MAX_WAIT_MS", type: "number" },
  { key: "boardMaxChars", env: "TM_BOARD_MAX_CHARS", type: "number" },
  { key: "boardMaxFiles", env: "TM_BOARD_MAX_FILES", type: "number" },
  { key: "taskOffload", env: "TM_TASK_OFFLOAD", type: "string" },
  { key: "storeReclaim", env: "TM_STORE_RECLAIM", type: "string" },
  { key: "askTimeoutFloorMin", env: "TM_ASK_TIMEOUT_FLOOR_MIN", type: "number" },
  { key: "bashTimeoutMaxMs", env: "TM_BASH_TIMEOUT_MAX_MS", type: "number" },
  { key: "bashTimeoutProbeMs", env: "TM_BASH_TIMEOUT_PROBE_MS", type: "number" },
  // ---- knobs read directly from process.env (design §4 names them file-overridable) ----
  { key: "nativeOffload", env: "TM_NATIVE_OFFLOAD", type: "string" },
  { key: "ptcWebBridge", env: "TM_PTC_WEB_BRIDGE", type: "string" },
  { key: "hitBlacklist", env: "TM_HIT_BLACKLIST", type: "string[]" },
  { key: "envProtectExtraDeny", env: "TM_ENV_PROTECT_EXTRA_DENY", type: "string" },
  { key: "shellEnv", env: "TM_SHELL_ENV", type: "string" },
  { key: "agentTemperature", env: "TM_AGENT_TEMPERATURE", type: "string" },
  { key: "compactionContext", env: "TM_COMPACTION_CONTEXT", type: "string" },
  // ---- RED-LINE knobs: a file value is ignored, always env/default ----
  {
    key: "envProtect",
    env: "TM_ENV_PROTECT",
    type: "string",
    redLine: true,
    redLineReason: "R6 判定模式，off 即关掉环境防护；项目文件可被提交共享，不得关掉红线",
  },
  {
    key: "r6FineAsk",
    env: "TM_R6_FINE_ASK",
    type: "string",
    redLine: true,
    redLineReason: "R6 ask 策略，决定每条命令是否走细粒度判定；文件不得放宽",
  },
  {
    key: "privateSpace",
    env: "TM_PRIVATE_SPACE",
    type: "string",
    redLine: true,
    redLineReason: "地址红线门，allow 会放开整段私网；文件不得放宽",
  },
  {
    key: "webfetchAllowedDomains",
    env: "TM_WEBFETCH_ALLOWED_DOMAINS",
    type: "string[]",
    redLine: true,
    redLineReason: "网络出网白名单；项目文件可被提交共享，不得放宽",
  },
  {
    key: "bashReadonlyAllowed",
    env: "TM_BASH_READONLY_ALLOWED",
    type: "string[]",
    redLine: true,
    redLineReason: "P3 只读门；放宽即扩大可执行命令面",
  },
]

/** The red-line keys, derived from the registry (single source of truth). */
export const RED_LINE_EXEMPT_KEYS: readonly string[] = CONFIG_KEYS.filter((k) => k.redLine).map((k) => k.key)

const KEY_BY_NAME = new Map(CONFIG_KEYS.map((k) => [k.key, k]))

/** Standard layer names, low→high. */
export type LayerSource = "env" | "global" | "project" | "project:.opencode"

export interface SkippedLayer {
  name: string
  reason: string
}

export interface IgnoredRedLineKey {
  key: string
  layer: string
  value: unknown
}

export interface UnknownKey {
  key: string
  layer: string
}

export interface LayeredConfigResult {
  /** Final merged value per canonical key.  An env-sourced value is the raw
   *  env STRING; a file-sourced value is the parsed JSON value.  Keys absent
   *  everywhere are not listed (the caller applies its own defaults). */
  values: Record<string, unknown>
  /** For every key present in env or a file layer: which layer it came from. */
  perKeySource: Record<string, LayerSource>
  /** Layers dropped whole because they failed to parse. */
  skippedLayers: SkippedLayer[]
  /** Red-line keys a file tried to set (ignored; env/default still answers). */
  ignoredRedLineKeys: IgnoredRedLineKey[]
  /** Keys not in the registry (warned, never applied). */
  unknownKeys: UnknownKey[]
  /** True when TM_CONFIG_ENV_ONLY removed every file layer. */
  envOnlyActive: boolean
}

export interface ResolveLayeredConfigInput {
  env: EnvLike
  /** Global file raw JSONC, or null/undefined when it does not exist. */
  globalLayer?: string | null
  /** Project file(s).  A single raw text, or an array ordered low→high
   *  (`[direct, .opencode]`) so the `.opencode/` file wins. */
  projectLayer?: string | null | Array<string | null>
  /** Override the red-line exempt set (defaults to RED_LINE_EXEMPT_KEYS). */
  exempt?: readonly string[]
  /** Override the env-only escape valve (defaults to env.TM_CONFIG_ENV_ONLY). */
  envOnly?: boolean
}

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/**
 * Mask `//` and block comments to spaces at IDENTICAL offsets, so a
 * commented-out key can never be mistaken for a live one.  String contents
 * (including a `//` inside a string) are preserved byte-for-byte.  Ported
 * from scripts/lib/config-surgery.cjs:19 — deliberately re-implemented here
 * rather than imported, so the pure layer carries no CJS dependency.
 */
export function maskJsoncComments(src: string): string {
  let out = ""
  let i = 0
  let inStr = false
  let esc = false
  while (i < src.length) {
    const c = src[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " "
        i++
      }
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " "
        i++
      }
      out += "  "
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** Drop a comma that is followed (past whitespace) by `}` or `]`, outside
 *  strings.  The host tolerates a trailing comma; JSON.parse does not. */
function stripTrailingCommas(masked: string): string {
  let out = ""
  let i = 0
  let inStr = false
  let esc = false
  while (i < masked.length) {
    const c = masked[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === ",") {
      let j = i + 1
      while (j < masked.length && /\s/.test(masked[j])) j++
      if (masked[j] === "}" || masked[j] === "]") {
        i++ // drop the trailing comma
        continue
      }
    }
    out += c
    i++
  }
  return out
}

/** Parse JSONC (comments + trailing commas) into a value.  Throws on a real
 *  syntax error — the caller turns that into a whole-layer skip. */
export function parseJsonc(src: string): unknown {
  return JSON.parse(stripTrailingCommas(maskJsoncComments(src)))
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function typeOk(type: ConfigValueType, v: unknown): boolean {
  switch (type) {
    case "number":
      return typeof v === "number" && Number.isFinite(v)
    case "string":
      return typeof v === "string"
    case "string[]":
      return Array.isArray(v) && v.every((x) => typeof x === "string")
    case "record":
      return isPlainObject(v) && Object.values(v).every((x) => typeof x === "number")
  }
}

/** `TM_CONFIG_ENV_ONLY` is truthy on 1/true/on/yes (case-insensitive). */
function envOnlyFromEnv(env: EnvLike): boolean {
  const raw = env.TM_CONFIG_ENV_ONLY
  return typeof raw === "string" && /^(1|true|on|yes)$/i.test(raw.trim())
}

function projectLayerList(projectLayer: ResolveLayeredConfigInput["projectLayer"]): Array<{ name: string; text: string }> {
  if (projectLayer == null) return []
  const texts = Array.isArray(projectLayer) ? projectLayer : [projectLayer]
  const out: Array<{ name: string; text: string }> = []
  texts.forEach((text, i) => {
    if (typeof text !== "string") return
    out.push({ name: i === 0 ? "project" : "project:.opencode", text })
  })
  return out
}

/**
 * Resolve the layered config.  Pure: no IO, no globals read except the `env`
 * record handed in.  See the module header for the three rules.
 */
export function resolveLayeredConfig(input: ResolveLayeredConfigInput): LayeredConfigResult {
  const { env } = input
  const exempt = new Set(input.exempt ?? RED_LINE_EXEMPT_KEYS)
  const envOnlyActive = input.envOnly ?? envOnlyFromEnv(env)

  // Ordered low→high.  envOnly removes every file layer BEFORE any parse.
  const fileLayers: Array<{ name: string; text: string }> = []
  if (!envOnlyActive) {
    if (typeof input.globalLayer === "string") fileLayers.push({ name: "global", text: input.globalLayer })
    fileLayers.push(...projectLayerList(input.projectLayer))
  }

  const skippedLayers: SkippedLayer[] = []
  const ignoredRedLineKeys: IgnoredRedLineKey[] = []
  const unknownKeys: UnknownKey[] = []
  // key -> {value, source}; later layers overwrite earlier ones.
  const fileValues = new Map<string, { value: unknown; source: LayerSource }>()

  for (const layer of fileLayers) {
    let obj: unknown
    try {
      obj = parseJsonc(layer.text)
    } catch (e) {
      skippedLayers.push({ name: layer.name, reason: e instanceof Error ? e.message : String(e) })
      continue
    }
    if (!isPlainObject(obj)) {
      skippedLayers.push({ name: layer.name, reason: "顶层不是 JSON 对象" })
      continue
    }
    for (const [key, value] of Object.entries(obj)) {
      if (exempt.has(key)) {
        ignoredRedLineKeys.push({ key, layer: layer.name, value })
        continue
      }
      const spec = KEY_BY_NAME.get(key)
      if (!spec) {
        unknownKeys.push({ key, layer: layer.name })
        continue
      }
      if (!typeOk(spec.type, value)) continue // drop this key from THIS layer only
      fileValues.set(key, { value, source: layer.name as LayerSource })
    }
  }

  // env is the lowest layer; files override it.
  const values: Record<string, unknown> = {}
  const perKeySource: Record<string, LayerSource> = {}
  for (const spec of CONFIG_KEYS) {
    const raw = env[spec.env]
    if (typeof raw === "string" && raw.trim() !== "") {
      values[spec.key] = raw
      perKeySource[spec.key] = "env"
    }
  }
  for (const [key, { value, source }] of fileValues) {
    values[key] = value
    perKeySource[key] = source
  }

  return { values, perKeySource, skippedLayers, ignoredRedLineKeys, unknownKeys, envOnlyActive }
}

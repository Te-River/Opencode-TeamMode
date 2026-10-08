/**
 * Layered `team-mode` configuration — the PURE layer (package ①, 2026-10-06).
 *
 * `team-mode.jsonc` is the ONLY configuration source.  There is no `TM_*`
 * config env var any more: the registry below carries each key's default and
 * its one-line doc, and the template generator (`config-template.ts`) renders
 * the global file straight from it, so a comment and a key can never drift.
 *
 * Two file layers only, per the user's decision (2026-10-06): the host's own
 * config has NO session layer (opencode.ai/v2/docs/config), so neither do we.
 *
 *   global  <  project
 *
 * Within the project layer the `.opencode/` file wins over the direct one,
 * mirroring the host's own discovery order (direct files merged
 * farthest→closest, then `.opencode/` dirs in the same order — every
 * discovered `.opencode` config overrides every direct config).
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
 *   - a RED-LINE key is honored ONLY in the GLOBAL file (D1).  Written in a
 *     project file it is IGNORED outright and reported (see RED_LINE_EXEMPT_KEYS).
 */

/** Env-like record — kept local so this module has no import cycle with config.ts. */
export type EnvLike = Record<string, string | undefined>

export type ConfigValueType = "number" | "string" | "string[]" | "record"

/** One honored knob: its canonical file key, the JSON type a file value must
 *  have, its default, and the one-line doc the template renders.  The registry
 *  IS the "known key" set — a key absent here is reported as unknown (warned,
 *  never applied). */
export interface ConfigKeySpec {
  /** Canonical file key (camelCase; matches the TmConfig field). */
  key: string
  type: ConfigValueType
  /** The default value — the ONLY default source.  `resolveConfig` fills it. */
  default: unknown
  /** One-line Chinese doc — the template comment's only source. */
  doc: string
  /** Red-line: honored ONLY in the global file; a project value is ignored. */
  redLine?: boolean
  /** Why a project file may not override it (shown in the ignored-key report). */
  redLineReason?: string
  /** Clamp floor for a `number` value. */
  min?: number
  /** Clamp ceiling for a `number` value. */
  max?: number
  /** Legal values for a `string` (e.g. on/off). */
  enum?: readonly string[]
}

/** Default tm_bash read-only allowlist (P3, command-level).  The PS
 *  -Object entries are pure pipeline formatters — no write capability. */
export const DEFAULT_BASH_READONLY_ALLOWED: readonly string[] = [
  "ls", "cat", "head", "tail", "grep", "rg", "find", "awk", "sort", "uniq",
  "wc", "cut", "dir", "Get-Content", "Get-ChildItem", "Select-String",
  "Measure-Object", "Select-Object", "Where-Object", "Sort-Object",
  "Group-Object", "Test-Path",
  // Process LISTING, read-only and write-free.  An agent verifying that a
  // process really exited (a leftover browser, a stray server) had no allowed
  // way to ask the OS, and a claim the user cannot check is worth less than one
  // they can.  findstr joins it for the same reason: `tasklist | findstr /i
  // msedge` is the natural Windows spelling of that check, and refusing it only
  // turned one call into two (live evidence: refused, then re-run with
  // Select-String).
  "tasklist", "ps", "findstr",
]

/**
 * Seeded tm_webfetch / tm_search domain allowlist — every host the search
 * engines and data sources ride (all reachable from mainland China without
 * API keys): wiki term / bilibili search / bing CN + international / baidu /
 * sogou / 360, the npm registry (JSON search + package metadata) and the
 * GitHub (search API + repo pages + raw/gist content), its ghproxy.net
 * mainland mirror, and PARENT domains for baidu/moegirl so every sibling
 * subdomain (baike./tieba./mzh./mobile.) is covered.  A site's OWN asset CDN
 * on a brand-unrelated domain has to be seeded too — same-site cannot infer it,
 * and blocking it is what makes a page render blank (bdimg.com below is that
 * case, measured).  Subdomains of an entry are included; a lone "*" opens
 * every host.
 */
export const DEFAULT_WEBFETCH_DOMAINS: readonly string[] = [
  // CN search engines + content (parent domains cover every sibling subdomain)
  "baidu.com", // www. search / baike. encyclopedia / tieba. — real sessions hit baike.baidu.com
  // Baidu's OWN static + anti-spam CDN.  Not a subdomain of baidu.com, so a
  // same-site subresource policy can never infer it, and a page whose own
  // bundle we block is a blank page we then report as "no content" — that is
  // the bug this seed closes (measured 2026-09-23: baike.baidu.com/ rendered 0
  // addressable nodes while the identical client with this host allowed
  // rendered 260).
  "bdimg.com", // bkssl. challenge scripts / resource. / static. asset bundles
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

/**
 * The honored-key registry — the single source of truth for keys, types,
 * defaults and docs.  Extend it when a new knob is wired: an unlisted real
 * knob would be reported as "unknown" (a false positive), and a key missing
 * here is missing from the generated template too.
 *
 * `default` is the ONLY default source; `resolveConfig` (src/tm/config.ts)
 * fills it and clamps `number` values to `min`/`max`.  A `number` whose
 * default is an integer is truncated to an integer; a fractional default
 * (searchRelevanceFloor, retryJitter) keeps its fraction.
 */
export const CONFIG_KEYS: readonly ConfigKeySpec[] = [
  // ---- offload / preview / store ----
  { key: "offloadThreshold", type: "number", default: 2000, min: 0, max: 10_000_000, doc: "卸载阈值（估算 token；等于阈值也卸载）。" },
  { key: "previewLines", type: "number", default: 20, min: 1, max: 1000, doc: "预览构建器最多扫描的原始行数。" },
  { key: "previewMaxTokens", type: "number", default: 80, min: 10, max: 100_000, doc: "预览的硬上限（估算 token）。" },
  { key: "fetchMaxLines", type: "number", default: 2000, min: 1, max: 1_000_000, doc: "tm_fetch 单段最多返回的行数。" },
  { key: "blackboardDir", type: "string", default: "", doc: "运行载荷存储目录；空 = 自动（<repo>/.git/opencode-team/blackboard）。" },
  { key: "trajectoryDir", type: "string", default: "", doc: "轨迹存储目录；空 = 自动（<repo>/.git/opencode-team/trajectory）。" },
  { key: "blackboardTtlDays", type: "number", default: 7, min: 1, max: 365, doc: "句柄 TTL（天），也是过期运行目录的清理周期。" },
  { key: "memoryGlobalDir", type: "string", default: "", doc: "tm_memory 全局作用域目录；空 = 自动（~/.opencode-team/memories/global）。" },
  { key: "memorySessionTtlMin", type: "number", default: 240, min: 1, max: 100_000, doc: "tm_memory 会话作用域条目 TTL（分钟）。" },
  { key: "memoryMaxEntries", type: "number", default: 200, min: 1, max: 100_000, doc: "tm_memory 每个作用域的最大条目数；超限时 add 报错并提示 compact/forget。" },
  { key: "memoryStaleDays", type: "number", default: 30, min: 0, max: 3650, doc: "tm_memory 陈旧标记天数；0 = 关闭 [stale Nd] 标记。" },
  { key: "memorySessionPersist", type: "string", default: "", doc: "tm_memory 会话持久化：空 = 仅进程内；\"1\" = 同时落盘。" },
  // ---- search ----
  { key: "searchDefaultEngine", type: "string", default: "auto", doc: "tm_search 默认引擎；auto = 按查询分类并行扇出。" },
  { key: "searchMaxHits", type: "number", default: 10, min: 3, max: 30, doc: "每个引擎腿与最终融合列表保留的命中数。" },
  { key: "searchWeights", type: "record", default: {}, doc: "按引擎覆盖融合权重，如 {\"bing\": 0.2}；未列出的沿用内置表。" },
  { key: "searchDisabledEngines", type: "string[]", default: [], doc: "从引擎名册与所有 auto 路由中移除的引擎名。" },
  { key: "searchRelevanceFloor", type: "number", default: 0.35, min: 0, max: 1, doc: "零重叠命中的权重系数（降权保留，不删除）。" },
  { key: "hitBlacklist", type: "string[]", default: [], doc: "搜索结果里额外屏蔽的域名（与内置 maimai.cn 合并）。" },
  // ---- offload tiering / web cache ----
  { key: "offloadThresholdText", type: "number", default: 4000, min: 0, max: 10_000_000, doc: "文本/日志类卸载阈值；全局阈值显式设置且本键未设时继承全局。" },
  { key: "offloadThresholdData", type: "number", default: 2000, min: 0, max: 10_000_000, doc: "json/csv/代码/二进制类卸载阈值；继承规则同上。" },
  { key: "webCacheTtlSec", type: "number", default: 300, min: 0, max: 86_400, doc: "URL 级缓存 TTL（秒）；0 = 关闭。" },
  // ---- join / board ----
  { key: "joinMaxWaitMs", type: "number", default: 60_000, min: 0, max: 600_000, doc: "tm_join 单次有界等待的上限（毫秒）。" },
  { key: "boardMaxChars", type: "number", default: 200_000, min: 1_000, max: 2_000_000, doc: "tm_board_write 单个文件的字符上限。" },
  { key: "boardMaxFiles", type: "number", default: 200, min: 4, max: 2_000, doc: "tm_board_write 每个会话目录的文件数上限。" },
  // ---- task offload / store reclaim ----
  { key: "taskOffload", type: "string", default: "on", enum: ["on", "off"], doc: "宿主后台子代理的大回复是否卸载为预览 + tm_join 指针；off = 原样注入。" },
  { key: "storeReclaim", type: "string", default: "on", enum: ["on", "off"], doc: "启动时回收升级遗留的存储分片；off = 保留磁盘现状（测试用）。" },
  // ---- bash timeout ----
  { key: "bashTimeoutMaxMs", type: "number", default: 0, min: 0, max: 3_600_000, doc: "内置 shell 工具 timeout 参数的全局上限（毫秒）；0 = 不限。" },
  { key: "bashTimeoutProbeMs", type: "number", default: 60_000, min: 0, max: 600_000, doc: "只读探针命令的 timeout 上限（毫秒）；0 = 关闭。" },
  // ---- orphaned (kept so an existing config still parses) ----
  { key: "askTimeoutFloorMin", type: "number", default: 1, min: 1, max: 1440, doc: "（已孤儿）v1 审批门 ask 超时的下限（分钟）；保留以便旧配置继续解析。" },
  // ---- v1-only knobs (listed + parseable; no v2 reader) ----
  { key: "agentTemperature", type: "string", default: "", doc: "（v1-only）按角色覆盖 temperature，如 reviewer=0.05;team=0.4。" },
  { key: "compactionContext", type: "string", default: "on", enum: ["on", "off"], doc: "（v1-only）压缩时推送必须存活的上下文清单。" },
  { key: "shellEnv", type: "string", default: "", doc: "（v1-only）注入 shell 的 K=V;K2=V2 白名单透传。" },
  { key: "ptcWebBridge", type: "string", default: "on", enum: ["on", "off"], doc: "（v1-only）tm_ptc_run 的 web 桥。" },
  // ---- native offload / probe chain ----
  { key: "nativeOffload", type: "string", default: "on", enum: ["on", "off"], doc: "宿主原生工具（read/grep/shell…）的大结果是否按 JIT 治理卸载；off = 原样进上下文。" },
  { key: "nativeSnapshotMaxTokens", type: "number", default: 1200, min: 100, max: 20_000, doc: "原生浏览器快照按寻址行保留的 token 预算。" },
  { key: "nativeReportMaxTokens", type: "number", default: 1600, min: 200, max: 20_000, doc: "原生报告形结果按表格保留的 token 预算。" },
  { key: "probeChain", type: "string", default: "on", enum: ["on", "off"], doc: "连续原生 read/grep/glob/shell 后追加一行 Code Mode 采用提示；off = 关闭。" },
  { key: "probeChainAfter", type: "number", default: 3, min: 0, max: 1000, doc: "连续多少次原生调用后开始提示；0 = 关闭。" },
  // ---- v2 request layers ----
  { key: "maxConcurrentSubagents", type: "number", default: 3, min: 0, max: 100, doc: "并发 subagent 上限；0 = 不限（关闭）；负数按 0 处理。" },
  { key: "v2CodeMode", type: "string", default: "", doc: "v2 工具交付：direct = 发送 options.codemode=false；空 = 目录模式。" },
  { key: "prune", type: "string", default: "on", enum: ["on", "off"], doc: "上下文裁剪（已结算消息替换为指针）；off = 关闭。" },
  { key: "pruneAtPercent", type: "number", default: 70, min: 40, max: 90, doc: "上下文裁剪启动的窗口占比（%）。" },
  { key: "pruneKeepTailPercent", type: "number", default: 40, min: 0, max: 90, doc: "裁剪时尾部逐字保留的窗口占比（%）。" },
  { key: "retry", type: "string", default: "on", enum: ["on", "off"], doc: "错峰重试（识别限流 + 注入等待 + 冷却）；off = 关闭。" },
  { key: "retryBaseMs", type: "number", default: 5000, min: 1, max: 3_600_000, doc: "重试退避基数（毫秒）。" },
  { key: "retryMaxMs", type: "number", default: 60_000, min: 1, max: 3_600_000, doc: "重试退避上限（毫秒）。" },
  { key: "retryJitter", type: "number", default: 0.3, min: 0, max: 0.95, doc: "重试退避抖动比例。" },
  { key: "retryBreakAfter", type: "number", default: 5, min: 1, max: 1000, doc: "连续多少次错误后触发断路器。" },
  { key: "retryCooldownMs", type: "number", default: 60_000, min: 0, max: 3_600_000, doc: "断路器冷却时长（毫秒）。" },
  { key: "splitAdvice", type: "string", default: "on", enum: ["on", "off"], doc: "派发 brief 过大时注入拆分建议；off = 关闭。" },
  { key: "splitBriefTokens", type: "number", default: 4000, min: 200, max: 200_000, doc: "触发拆分建议的 brief token 阈值。" },
  { key: "splitMaxCriteria", type: "number", default: 3, min: 1, max: 50, doc: "拆分建议里每条交付的验收标准上限。" },
  { key: "v2BrowserGate", type: "string", default: "on", enum: ["on", "off"], doc: "原生 browser_* 目录的域名/地址/R6 门禁；off = 关闭。" },
  { key: "ledgerMaxItems", type: "number", default: 200, min: 10, max: 100_000, doc: "tm_ledger 每个会话的最大条目数。" },
  // ---- RED-LINE knobs: honored ONLY in the global file (D1) ----
  {
    key: "envProtect",
    type: "string",
    default: "strict",
    redLine: true,
    redLineReason: "R6 判定模式，off 即关掉环境防护；项目文件可被提交共享，不得关掉红线",
    doc: "R6 环境防护模式（strict/standard/off）。",
  },
  {
    key: "r6FineAsk",
    type: "string",
    default: "",
    redLine: true,
    redLineReason: "R6 ask 策略，决定每条命令是否走细粒度判定；文件不得放宽",
    doc: "R6 细粒度 ask 策略；off = 每条 shell 命令都升为 ask。",
  },
  {
    key: "privateSpace",
    type: "string",
    default: "deny",
    redLine: true,
    redLineReason: "地址红线门，allow 会放开整段私网；文件不得放宽",
    doc: "私网地址策略（allow/deny/ask）。",
  },
  {
    key: "webfetchAllowedDomains",
    type: "string[]",
    default: DEFAULT_WEBFETCH_DOMAINS,
    redLine: true,
    redLineReason: "网络出网白名单；项目文件可被提交共享，不得放宽",
    doc: "网络出网白名单（含子域；\"*\" = 任意主机）。",
  },
  {
    key: "bashReadonlyAllowed",
    type: "string[]",
    default: DEFAULT_BASH_READONLY_ALLOWED,
    redLine: true,
    redLineReason: "P3 只读门；放宽即扩大可执行命令面",
    doc: "P3 只读命令白名单（tm_bash / shell 探针）。",
  },
]

/** The red-line keys, derived from the registry (single source of truth). */
export const RED_LINE_EXEMPT_KEYS: readonly string[] = CONFIG_KEYS.filter((k) => k.redLine).map((k) => k.key)

const KEY_BY_NAME = new Map(CONFIG_KEYS.map((k) => [k.key, k]))

/** Standard layer names, low→high. */
export type LayerSource = "global" | "project" | "project:.opencode"

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
  /** Final merged value per canonical key, from the FILE layers only.  A value
   *  is the parsed JSON value.  Keys absent everywhere are not listed (the
   *  caller applies the registry defaults). */
  values: Record<string, unknown>
  /** For every key present in a file layer: which layer it came from. */
  perKeySource: Record<string, LayerSource>
  /** Layers dropped whole because they failed to parse. */
  skippedLayers: SkippedLayer[]
  /** Red-line keys a PROJECT file tried to set (ignored; global/default answers). */
  ignoredRedLineKeys: IgnoredRedLineKey[]
  /** Keys not in the registry (warned, never applied). */
  unknownKeys: UnknownKey[]
  /** True when the caller removed every file layer (test injection). */
  envOnlyActive: boolean
}

export interface ResolveLayeredConfigInput {
  /** Global file raw JSONC, or null/undefined when it does not exist. */
  globalLayer?: string | null
  /** Project file(s).  A single raw text, or an array ordered low→high
   *  (`[direct, .opencode]`) so the `.opencode/` file wins. */
  projectLayer?: string | null | Array<string | null>
  /** Override the red-line exempt set (defaults to RED_LINE_EXEMPT_KEYS). */
  exempt?: readonly string[]
  /** Remove every file layer (test injection). */
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

export function isPlainObject(v: unknown): v is Record<string, unknown> {
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
 * Resolve the layered config.  Pure: no IO, no globals.  See the module
 * header for the three rules.
 */
export function resolveLayeredConfig(input: ResolveLayeredConfigInput): LayeredConfigResult {
  const exempt = new Set(input.exempt ?? RED_LINE_EXEMPT_KEYS)
  const envOnlyActive = input.envOnly ?? false

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
      const spec = KEY_BY_NAME.get(key)
      if (!spec) {
        unknownKeys.push({ key, layer: layer.name })
        continue
      }
      // D1: a red-line key is honored ONLY in the global file.
      if (spec.redLine && layer.name !== "global") {
        ignoredRedLineKeys.push({ key, layer: layer.name, value })
        continue
      }
      if (!typeOk(spec.type, value)) continue // drop this key from THIS layer only
      fileValues.set(key, { value, source: layer.name as LayerSource })
    }
  }

  const values: Record<string, unknown> = {}
  const perKeySource: Record<string, LayerSource> = {}
  for (const [key, { value, source }] of fileValues) {
    values[key] = value
    perKeySource[key] = source
  }

  return { values, perKeySource, skippedLayers, ignoredRedLineKeys, unknownKeys, envOnlyActive }
}

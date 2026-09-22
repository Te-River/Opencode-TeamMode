/**
 * tm layer — zod arg schemas (ZodRawShape) with descriptor fallback.
 * Split out of the former tools.ts hub; behavior unchanged.
 *
 * Per-tool `args` — a ZodRawShape (plain `{key: validator}` object, official
 * tool.d.ts:47-50), NOT a z.object(): the host serializes the raw shape into
 * the LLM parameter spec.  Wrapping it in z.object produced `{def:{command:
 * ...}}` garbage args in real sessions (the model wrapped its args 3/3
 * times), even though flat args reached execute fine.
 */

import { resolveTmConfig } from "./config.js"

/**
 * Load zod when the host environment provides it (opencode ships it as a
 * peer); fall back to plain arg descriptors so the plugin never hard-depends
 * on it.  execute() is defensive either way — it coerces raw args itself.
 */
async function loadZod(): Promise<Record<string, unknown> | null> {
  try {
    const spec = "zod"
    const mod: unknown = await import(spec)
    const z =
      (mod as { z?: unknown })?.z ??
      (mod as { default?: { z?: unknown } })?.default?.z ??
      null
    return z && typeof (z as { object?: unknown }).object === "function"
      ? (z as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function describe(
  z: Record<string, unknown> | null,
  schema: unknown,
  fallback: string,
): Record<string, unknown> {
  if (z && typeof (z as { string?: unknown }).string === "function") {
    return schema as Record<string, unknown>
  }
  return { descriptor: fallback }
}

async function buildArgsSchemas(): Promise<Record<string, Record<string, unknown>>> {
  const z = await loadZod()
  if (!z) {
    return {
      tm_read: describe(null, null, "path: string (required)"),
      tm_grep: describe(null, null, "pattern: string (required), path: string (optional)"),
      tm_bash: describe(null, null, "command: string (required, read-only allowlisted)"),
      tm_fetch: describe(null, null, "ref: string (required), access_token: string, offset: int, limit: int, mode: lines|structure, fields: dot-path (json handle projection)"),
    }
  }
  interface ZodChainable {
    describe: (d: string) => ZodChainable
    optional: () => { describe: (d: string) => unknown }
  }
  interface ZodNumberLike {
    int: () => ZodNumberLike
    min: (n: number) => ZodNumberLike
    describe: (d: string) => ZodNumberLike
    optional: () => { describe: (d: string) => unknown }
  }
  const zz = z as unknown as {
    string: () => ZodChainable
    number: () => ZodNumberLike
    object: (shape: Record<string, unknown>) => unknown
    enum: (values: string[]) => {
      describe: (d: string) => unknown
      optional: () => { describe: (d: string) => unknown }
    }
  }
  // RAW SHAPES — no zz.object() wrapper (BUG#3).
  return {
    tm_read: {
      path: zz
        .string()
        .describe(
          "File path, relative to the project root (or absolute within it). Env files (.env, *.env, .bashrc family) are rejected — same R6 source as the built-in read.",
        ),
    },
    tm_grep: {
      pattern: zz.string().describe("Regex to search (ripgrep syntax)."),
      // describe-LAST on every optional chain — zod v4 drops a description
      // applied before .optional() when the shape is serialized (see
      // buildMemoryArgsSchema); a required field's describe stays first.
      path: zz
        .string()
        .optional()
        .describe("Optional directory scope, relative to the project root."),
    },
    tm_bash: {
      command: zz
        .string()
        .describe(
          "Read-only shell command (allowlisted heads only). bash on POSIX, PowerShell-like on Windows.",
        ),
    },
    tm_fetch: {
      ref: zz
        .string()
        .describe("Offload handle ref: tm://runs/{run_id}/steps/{step_id}/result"),
      access_token: zz
        .string()
        .optional()
        .describe("HMAC token from the offload handle (may also ride the ref fragment)."),
      offset: zz
        .number()
        .int()
        .min(0)
        .optional()
        .describe("0-based line offset of the first line to return."),
      limit: zz
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max lines per fetch, capped at TM_FETCH_MAX_LINES (default 2000)."),
      mode: zz
        .enum(["lines", "structure"])
        .optional()
        .describe("structure = ~100-token TOC / key tree / error-line map; try it first."),
      fields: zz
        .string()
        .optional()
        .describe(
          "Dot-path projection over a JSON handle (T4): e.g. items[].name or user.email; returns ONLY the matched values. Ignored on a non-JSON handle.",
        ),
    },
  }
}

export { buildArgsSchemas }

/**
 * tm_ptc_run args — same ZodRawShape treatment (BUG#3 class): a raw shape
 * when zod is available, descriptors otherwise.  Kept separate from
 * buildArgsSchemas because buildPtcRunTool is sync; tm/index awaits this
 * once and passes the result in as `deps.args`.
 */
export async function buildPtcArgsSchema(): Promise<Record<string, unknown>> {
  const z = await loadZod()
  if (!z) {
    return {
      program: { descriptor: "program: string (required, async fn body, ≤TM_PTC_MAX_PROGRAM_CHARS)" },
      label: { descriptor: "label: string (optional, ≤80 chars)" },
      budgets: { descriptor: "budgets: { max_calls?, max_errors?, timeout_ms? } (optional, tighten-only; any other key is rejected)" },
    }
  }
  const zz = z as unknown as {
    string: () => {
      optional: () => { describe: (d: string) => unknown }
      describe: (d: string) => unknown
    }
    number: () => {
      int: () => {
        min: (n: number) => {
          optional: () => { describe: (d: string) => unknown }
          describe: (d: string) => unknown
        }
      }
    }
    object: (shape: Record<string, unknown>) => {
      strict: () => {
        optional: () => { describe: (d: string) => unknown }
        describe: (d: string) => unknown
      }
      optional: () => { describe: (d: string) => unknown }
      describe: (d: string) => unknown
    }
  }
  return {
    program: zz
      .string()
      .describe(
        "Async function body. Available: tm.read(args), tm.grep(args), tm.bash(args), tm.fetch(args) — each returns {ok:true, data} or {ok:false, error:{tool,phase,line?,message}}. `return` a value for the aggregation summary.",
      ),
    // Wave B Minor③: zod v4 DROPS a description set before .optional() when
    // the shape is serialized, so every optional chain here is describe-LAST
    // (matches buildMemoryArgsSchema / buildBrowserArgsSchema).
    label: zz.string().optional().describe("Optional run label (≤80 chars)."),
    // Fix batch T1: an EXPLICIT zod object — z.any() let host-side arg
    // handling mangle the budgets value so parsePtcArgs never saw it and
    // the caller's budgets silently fell back to the defaults.
    // Wave B Minor②: .strict() rejects unknown budget keys (a typo like
    // max_call silently read as an omitted default before — now it fails
    // loudly).  parsePtcArgs enforces the same at the runtime layer.
    budgets: zz
      .object({
        max_calls: zz.number().int().min(1).optional().describe("Max bridged tm_* calls (tighten-only)."),
        max_errors: zz.number().int().min(1).optional().describe("Max failed bridged calls (tighten-only)."),
        timeout_ms: zz.number().int().min(1).optional().describe("Wall-clock budget in ms (floor 5000, tighten-only)."),
      })
      .strict()
      .optional()
      .describe(
        "Optional budgets object { max_calls?, max_errors?, timeout_ms? } — tighten-only, clamped to the TM_PTC_* ceilings. Unknown keys are rejected.",
      ),
  }
}

/**
 * tm_webfetch args — same ZodRawShape treatment (BUG#3 class); descriptor
 * fallback when zod is absent.  tm/index awaits this and passes the result
 * into buildTmWebfetchTool as `deps.args`.
 */
export async function buildWebfetchArgsSchema(): Promise<Record<string, unknown>> {
  const z = await loadZod()
  if (!z) {
    return {
      url: { descriptor: "url: string (required, absolute https URL on an allowlisted host, query URL-encoded)" },
      fields: { descriptor: "fields: string (optional, dot-path projection over a JSON response, e.g. items[].name; ignored on non-JSON)" },
      fresh: { descriptor: "fresh: true (optional — bypass the URL cache and hit the network)" },
    }
  }
  // describe-LAST on the optional `fields` chain (zod v4 drops a
  // description set before .optional(); see buildMemoryArgsSchema).
  const zz = z as unknown as {
    string: () => {
      describe: (d: string) => unknown
      optional: () => { describe: (d: string) => unknown }
    }
    boolean: () => {
      optional: () => { describe: (d: string) => unknown }
    }
  }
  return {
    url: zz
      .string()
      .describe(
        "Absolute https URL on an allowlisted host (seeded: mobile.moegirl.org.cn, search.bilibili.com, cn.bing.com, www.baidu.com, www.sogou.com, www.so.com, registry.npmjs.org, api.github.com, api.stackexchange.com, hn.algolia.com). URL-encode the query (CJK terms too).",
      ),
    fields: zz
      .string()
      .optional()
      .describe(
        "Dot-path projection over a JSON response body (Wave B M2): e.g. items[].name or user.email — returns ONLY the matched values, mirroring tm_fetch's `fields`. Ignored when the response is not JSON.",
      ),
    // The cache is a throughput win with a freshness cost, so the escape hatch
    // has to be on the model-visible surface: "the page changed" is a claim
    // only a real fetch can settle.
    fresh: zz
      .boolean()
      .optional()
      .describe(
        "Bypass the URL cache (TM_WEB_CACHE_TTL_SEC) and fetch the network again — use when you specifically need the page as it is NOW, e.g. you expect it changed since a cached read.",
      ),
  }
}

/**
 * tm_search args — same ZodRawShape treatment (BUG#3 class); descriptor
 * fallback when zod is absent.  tm/index awaits this and passes the result
 * into buildTmSearchTool as `deps.args`.
 *
 * Wave B M1 — the engine list is DERIVED from search.ts's live
 * `SEARCH_ENGINE_NAMES` + `AUTO_ENGINE_KEY`, never hand-written: a static
 * copy here once drifted to a dead roster (bing-int/sogou/so/baidu kept,
 * stackoverflow/hn/auto missing, default lied "bing").  Because
 * buildTmSearchTool uses `deps.args ?? fallback`, this schema IS the
 * model-visible surface in production (the search.ts fallback never fires),
 * so it must not go stale.  `defaultEngine` falls back to
 * resolveTmConfig().searchDefaultEngine so the descriptor states the real
 * default (auto) — callers may pass cfg.searchDefaultEngine explicitly.
 * The §6m-s anti-drift test asserts the descriptor names every
 * SEARCH_ENGINE_NAMES entry and none of the removed engines.
 */
export async function buildSearchArgsSchema(
  defaultEngine?: string,
): Promise<Record<string, unknown>> {
  const { AUTO_ENGINE_KEY, SEARCH_ENGINE_NAMES } = await import("./search.js")
  const defEngine =
    (defaultEngine && defaultEngine.trim()) || resolveTmConfig().searchDefaultEngine || AUTO_ENGINE_KEY
  const engineList = `${AUTO_ENGINE_KEY}|${SEARCH_ENGINE_NAMES.join("|")}`
  const engineDesc =
    `engine: ${engineList} (optional, default ${defEngine}). ` +
    `"${AUTO_ENGINE_KEY}" classifies the query and fans the matching engines out in parallel ` +
    `(weighted-RRF fused top-10); an explicit name runs that single engine ` +
    `(bing = the live CN HTML SERP; stackoverflow/hn/npm/github/moegirl/bilibili = structured JSON).`
  const z = await loadZod()
  if (!z) {
    return {
      query: { descriptor: "query: string (required, raw text — CJK fine, encoded here)" },
      engine: { descriptor: engineDesc },
    }
  }
  const zz = z as unknown as {
    string: () => {
      describe: (d: string) => unknown
      optional: () => { describe: (d: string) => unknown }
    }
  }
  return {
    query: zz.string().describe("Raw search query — pass text as-is; the tool URL-encodes it (CJK included)."),
    engine: zz.string().optional().describe(engineDesc),
  }
}

/**
 * tm_memory args — same ZodRawShape treatment (BUG#3 class); descriptor
 * fallback when zod is absent.
 */
export async function buildMemoryArgsSchema(): Promise<Record<string, unknown>> {
  const z = await loadZod()
  if (!z) {
    return {
      action: { descriptor: "action: add|search|list|forget|compact (required)" },
      title: { descriptor: "title: string (add/forget)" },
      content: { descriptor: "content: string (add, ≤4000 chars)" },
      category: { descriptor: "category: string (add, optional)" },
      keywords: { descriptor: "keywords: string[] or comma string (add, optional)" },
      usage_scenario: { descriptor: "usage_scenario: string[] or comma string (add, optional)" },
      query: { descriptor: "query: string (search)" },
      scope: { descriptor: 'scope: project|global|session (optional, default project; compact also accepts "all")' },
      apply: { descriptor: "apply: boolean (compact only; absent = dry-run, true performs the merges)" },
    }
  }
  // `.optional().describe(...)` — the description MUST be applied to the
  // FINAL wrapper: zod (v4 confirmed) drops a description set before
  // .optional() when the host serializes the shape, so describe-first would
  // leave the model blind to the very text this descriptor exists to carry.
  const zz = z as unknown as {
    string: () => {
      describe: (d: string) => unknown
      optional: () => { describe: (d: string) => unknown }
    }
    boolean: () => { optional: () => { describe: (d: string) => unknown } }
  }
  return {
    action: zz.string().describe("add | search | list | forget | compact."),
    title: zz.string().optional().describe("Memory title (add/forget)."),
    content: zz.string().optional().describe("One condensed fact, ≤4000 chars (add)."),
    category: zz.string().optional().describe("Category slug, e.g. project_tech_stack (add, optional)."),
    keywords: zz.string().optional().describe("Comma-separated keywords (add, optional)."),
    usage_scenario: zz.string().optional().describe("Comma-separated when-to-use scenarios (add, optional)."),
    query: zz.string().optional().describe("Search query (search)."),
    scope: zz
      .string()
      .optional()
      .describe('project (default) | global | session (transient, this conversation only); compact also accepts "all".'),
    // memory.ts execute() reads args.apply (truthy gate on compact); the raw
    // shape IS the model-visible param surface (the host serializes it into
    // the LLM parameter spec), so an undeclared key is unreachable — declare
    // it here or the model can never request a real compaction.
    apply: zz
      .boolean()
      .optional()
      .describe("compact only: absent = dry-run (report planned merges), true = perform them (originals backed up under memories/.compact-backup/)."),
  }
}

/**
 * tm_browser args — same ZodRawShape treatment (BUG#3 class); descriptor
 * fallback when zod is absent.
 *
 * STRIP BEHAVIOR / WHY EVERY FIELD IS DECLARED: this is a RAW shape, never
 * wrapped in z.object() (BUG#3), so no zod-level .strip()/.passthrough()
 * applies and execute() reads rawArgs verbatim.  But the host serializes
 * exactly these keys into the LLM parameter spec — an undeclared field is
 * invisible to the model and never reaches browser.ts, i.e. the shape is a
 * CLOSED param surface in effect.  T5's 16 playwright verbs
 * (BROWSER_PLAYWRIGHT_ACTIONS, browser.ts:505) + the 5 compat verbs consume
 * 19 fields across execute/act (args.uid/selector/targetUid/targetSelector/
 * text/key/function/expression/filePath/files/index/timeoutMs/dialogAction/
 * promptText/clear/fullPage/image, browser.ts act() + execute()) — every one
 * is declared below, or the corresponding verb silently loses its input.
 *
 * `headless` is DELIBERATELY not declared (2026-09-18): it used to be a model
 * arg, `Boolean("false")` read as true, and one such call pinned the whole
 * host process to a headless browser that every anti-bot gate then rejected.
 * Mode is an operator setting (TM_BROWSER_HEADLESS) — a closed surface here
 * is the fix, not a validation layer.
 */
export async function buildBrowserArgsSchema(): Promise<Record<string, unknown>> {
  const z = await loadZod()
  const ACTION_LIST =
    "navigate_page | take_snapshot | click | fill | hover | drag | press_key | select_page | new_page | close_page | upload_file | wait_for | evaluate_script | list_console_messages | list_network_requests | list_pages | take_screenshot | handle_dialog (18 playwright verbs) | open | navigate | read | screenshot | close (compat verbs)."
  if (!z) {
    return {
      action: { descriptor: `action: ${ACTION_LIST} (required)` },
      url: { descriptor: "url: string (open/navigate/navigate_page/new_page, allowlisted https)" },
      image: { descriptor: "image: true with take_screenshot — inline the PNG pixels in this result" },
      uid: { descriptor: "uid: snapshot [uid=eN] token (click/fill/hover/drag/upload_file/wait_for)" },
      selector: { descriptor: "selector: CSS/text locator escape hatch (only when a snapshot cannot express the node)" },
      targetUid: { descriptor: "targetUid: drag destination uid" },
      targetSelector: { descriptor: "targetSelector: drag destination selector" },
      text: { descriptor: "text: fill value / wait_for visible text" },
      key: { descriptor: "key: press_key chord, e.g. Enter|Control+A" },
      function: { descriptor: "function: JS function source for evaluate_script" },
      expression: { descriptor: "expression: alias of function (evaluate_script)" },
      filePath: { descriptor: "filePath: local file path for upload_file" },
      files: { descriptor: "files: alias of filePath — single path or array of paths" },
      index: { descriptor: "index: select_page target tab index from list_pages" },
      timeoutMs: { descriptor: "timeoutMs: wait_for budget in ms (default 3000, clamped 100..30000)" },
      dialogAction: { descriptor: "dialogAction: accept|dismiss for handle_dialog (default accept)" },
      promptText: { descriptor: "promptText: prompt-dialog reply text for handle_dialog accept" },
      clear: { descriptor: "clear: drain the console buffer after list_console_messages" },
      fullPage: { descriptor: "fullPage: take_screenshot captures the full page (default viewport only)" },
    }
  }
  // describe-LAST on every optional chain — zod v4 drops a description set
  // before .optional() when the shape is serialized (see buildMemoryArgsSchema).
  const zz = z as unknown as {
    string: () => {
      describe: (d: string) => unknown
      optional: () => { describe: (d: string) => unknown }
    }
    boolean: () => { optional: () => { describe: (d: string) => unknown } }
    number: () => {
      int: () => { min: (n: number) => { optional: () => { describe: (d: string) => unknown } } }
    }
    // upload_file accepts a single path OR an array — any() keeps the host
    // spec from narrowing (and rejecting) the array shape.
    any: () => { optional: () => { describe: (d: string) => unknown } }
  }
  const str = (d: string) => zz.string().optional().describe(d)
  const bool = (d: string) => zz.boolean().optional().describe(d)
  return {
    action: zz.string().describe(ACTION_LIST),
    url: str("Absolute https URL on an allowlisted host (open/navigate/navigate_page). URL-encode the query (CJK terms too)."),
    image: bool("take_screenshot only: inline the PNG pixels into this tool result (default false = path only; pixels cost context, so ask only when the screenshot IS the evidence)."),
    uid: str("Snapshot [uid=eN] token from the LATEST take_snapshot (click/fill/hover/drag source/upload_file/wait_for)."),
    selector: str("CSS/text locator escape hatch — only for a node the snapshot cannot express; never guess locators."),
    targetUid: str("drag destination uid from the latest take_snapshot."),
    targetSelector: str("drag destination selector escape hatch."),
    text: str("fill value, or the visible text to wait for with wait_for (uid or text — one of them)."),
    key: str('press_key chord, e.g. "Enter" or "Control+A".'),
    function: str("JS function/expression source for evaluate_script (returns the JSON-serialized value)."),
    expression: str("Alias of function for evaluate_script."),
    filePath: str("Local file path for upload_file (must exist on disk)."),
    files: zz.any().optional().describe("Alias of filePath for upload_file — a single path or an array of paths."),
    index: zz.number().int().min(0).optional().describe("select_page target tab index (0-based, from list_pages)."),
    timeoutMs: zz.number().int().min(100).optional().describe("wait_for visibility budget in ms (engine default 3000, clamped to 30000)."),
    dialogAction: str("handle_dialog verdict: accept (default) | dismiss."),
    promptText: str("Reply text when handle_dialog accepts a prompt()-type dialog."),
    clear: bool("Drain the buffered console messages after list_console_messages."),
    fullPage: bool("take_screenshot captures the full page (default: viewport only)."),
  }
}
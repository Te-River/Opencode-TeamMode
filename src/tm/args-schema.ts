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
      tm_fetch: describe(null, null, "ref: string (required), access_token: string, offset: int, limit: int, mode: lines|structure"),
    }
  }
  interface ZodChainable {
    describe: (d: string) => ZodChainable
    optional: () => unknown
  }
  interface ZodNumberLike {
    int: () => ZodNumberLike
    min: (n: number) => ZodNumberLike
    describe: (d: string) => ZodNumberLike
    optional: () => unknown
  }
  const zz = z as unknown as {
    string: () => ZodChainable
    number: () => ZodNumberLike
    object: (shape: Record<string, unknown>) => unknown
    enum: (values: string[]) => ZodChainable
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
      path: zz
        .string()
        .describe("Optional directory scope, relative to the project root.")
        .optional(),
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
        .describe("HMAC token from the offload handle (may also ride the ref fragment).")
        .optional(),
      offset: zz
        .number()
        .int()
        .min(0)
        .describe("0-based line offset of the first line to return.")
        .optional(),
      limit: zz
        .number()
        .int()
        .min(1)
        .describe("Max lines per fetch, capped at TM_FETCH_MAX_LINES (default 2000).")
        .optional(),
      mode: zz
        .enum(["lines", "structure"])
        .describe("structure = ~100-token TOC / key tree / error-line map; try it first.")
        .optional(),
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
      budgets: { descriptor: "budgets: { max_calls?, max_errors?, timeout_ms? } (optional, tighten-only)" },
    }
  }
  const zz = z as unknown as {
    string: () => {
      describe: (d: string) => { optional: () => unknown }
    }
    any: () => {
      describe: (d: string) => { optional: () => unknown }
    }
  }
  return {
    program: zz
      .string()
      .describe(
        "Async function body. Available: tm.read(args), tm.grep(args), tm.bash(args), tm.fetch(args) — each returns {ok:true, data} or {ok:false, error:{tool,phase,line?,message}}. `return` a value for the aggregation summary.",
      ),
    label: zz.string().describe("Optional run label (≤80 chars).").optional(),
    budgets: zz
      .any()
      .describe(
        "Optional budgets object { max_calls?, max_errors?, timeout_ms? } — tighten-only, clamped to the TM_PTC_* ceilings.",
      )
      .optional(),
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
    }
  }
  const zz = z as unknown as {
    string: () => { describe: (d: string) => unknown }
  }
  return {
    url: zz
      .string()
      .describe(
        "Absolute https URL on an allowlisted host (seeded: mobile.moegirl.org.cn, search.bilibili.com, cn.bing.com, www.baidu.com, www.sogou.com, www.so.com, registry.npmjs.org, api.github.com). URL-encode the query (CJK terms too).",
      ),
  }
}

/**
 * tm_search args — same ZodRawShape treatment (BUG#3 class); descriptor
 * fallback when zod is absent.  tm/index awaits this and passes the result
 * into buildTmSearchTool as `deps.args`.
 */
export async function buildSearchArgsSchema(): Promise<Record<string, unknown>> {
  const z = await loadZod()
  if (!z) {
    return {
      query: { descriptor: "query: string (required, raw text — CJK fine, encoded here)" },
      engine: { descriptor: "engine: bing|bing-int|sogou|so|baidu|bilibili|npm|github (optional, default bing)" },
    }
  }
  const zz = z as unknown as {
    string: () => { describe: (d: string) => { optional: () => unknown } }
  }
  return {
    query: zz.string().describe("Raw search query — pass text as-is; the tool URL-encodes it (CJK included)."),
    engine: zz
      .string()
      .describe(
        "bing (default) | bing-int (international results) | sogou | so (360) | baidu | bilibili | moegirl (wiki search API, structured) | npm (registry search, structured) | github (repo search API, structured).",
      )
      .optional(),
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
      action: { descriptor: "action: add|search|list|forget (required)" },
      title: { descriptor: "title: string (add/forget)" },
      content: { descriptor: "content: string (add, ≤4000 chars)" },
      category: { descriptor: "category: string (add, optional)" },
      keywords: { descriptor: "keywords: string[] or comma string (add, optional)" },
      usage_scenario: { descriptor: "usage_scenario: string[] or comma string (add, optional)" },
      query: { descriptor: "query: string (search)" },
      scope: { descriptor: "scope: project|global (optional, default project)" },
    }
  }
  const zz = z as unknown as {
    string: () => { describe: (d: string) => { optional: () => unknown } }
  }
  return {
    action: zz.string().describe("add | search | list | forget."),
    title: zz.string().describe("Memory title (add/forget).").optional(),
    content: zz.string().describe("One condensed fact, ≤4000 chars (add).").optional(),
    category: zz.string().describe("Category slug, e.g. project_tech_stack (add, optional).").optional(),
    keywords: zz.string().describe("Comma-separated keywords (add, optional).").optional(),
    usage_scenario: zz.string().describe("Comma-separated when-to-use scenarios (add, optional).").optional(),
    query: zz.string().describe("Search query (search).").optional(),
    scope: zz.string().describe("project (default) | global.").optional(),
  }
}

/**
 * tm_browser args — same ZodRawShape treatment (BUG#3 class); descriptor
 * fallback when zod is absent.
 */
export async function buildBrowserArgsSchema(): Promise<Record<string, unknown>> {
  const z = await loadZod()
  if (!z) {
    return {
      action: { descriptor: 'action: open|navigate|read|screenshot|close (required)' },
      url: { descriptor: 'url: string (open/navigate, allowlisted https)' },
      headless: { descriptor: 'headless: boolean (open, optional — default auto)' },
    }
  }
  const zz = z as unknown as {
    string: () => { describe: (d: string) => { optional: () => unknown } }
    boolean: () => { describe: (d: string) => { optional: () => unknown } }
  }
  return {
    action: zz.string().describe('open | navigate | read | screenshot | close.'),
    url: zz.string().describe('Absolute https URL on an allowlisted host (open/navigate). URL-encode the query (CJK terms too).').optional(),
    headless: zz.boolean().describe('Force headless/headful on open (optional — default auto by display availability).').optional(),
  }
}
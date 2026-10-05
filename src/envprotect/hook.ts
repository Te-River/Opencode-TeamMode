/**
 * R6 — file-tool path classification and tool-call level routing
 * (tm_* aliasing = anti-backdoor).  Split out of the former monolithic
 * envprotect.ts; behavior unchanged.
 *
 * The `tool.execute.before` HOOK FACTORY that used to live here
 * (`createEnvProtectHook`, with its `auditInterception` and its deferral to the
 * approval gate) was deleted with the v1 personality: v2 has no plugin-raised
 * dialog to defer to, and the enforcement that remains on v2 is the per-command
 * classifier at `src/host/v2-guard.ts` (`shellGuard`) riding
 * `permission.hook("evaluate")`.  What stays in this file is the CLASSIFIER
 * SURFACE both personalities' tests pin — the matchers are the product, the
 * v1 hook was only one way to call them.
 */

import { CATEGORY_ENV_FILE_PATH, CATEGORY_EXTRA_DENY, type EnvProtectMode } from "./patterns.js"
import { classifyBashCommand } from "./bash-classify.js"
import { isEnvFilePath } from "./path-classify.js"

// ---------- file-tool path classification ----------

/**
 * Path-class argument keys scanned defensively across read / grep / glob /
 * list (read uses `filePath`; the others historically use `path`, and
 * `pattern` / `include` select files for glob / grep).  Keys outside this
 * set (descriptions, notes) are never scanned.
 */
const PATH_LIKE_KEYS = /^(filepath|path|file|dir|directory|pattern|include)$/i

/**
 * Classify the path-class arguments of a file tool.  Returns the pattern
 * category when the call must be blocked, null when it may pass.
 */
export function classifyPathFields(
  args: Record<string, unknown> | undefined,
  mode: EnvProtectMode,
  extra: RegExp[] = [],
): string | null {
  if (!args || typeof args !== "object") return null
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || !value) continue
    if (!PATH_LIKE_KEYS.test(key)) continue
    for (const rule of extra) {
      if (rule.test(value)) return CATEGORY_EXTRA_DENY
    }
    if (isEnvFilePath(value)) return CATEGORY_ENV_FILE_PATH
  }
  return null
}

// ---------- tool-call level routing ----------

/** File tools whose path-class arguments are scanned for env files. */
const PATH_SCAN_TOOLS = new Set(["read", "grep", "glob", "list"])

/**
 * TeamMode's own tm_* tools alias onto the built-in surface so the SAME
 * interception applies to them (anti-backdoor: tm_read/tm_grep/tm_bash must
 * never become an R6 bypass by virtue of a different tool name).  The tools
 * ALSO re-check with the same matchers inside their own pipelines — this
 * hook-level alias is the outer defense layer.
 */
const TM_TOOL_ALIASES: Record<string, string> = {
  tm_read: "read",
  tm_grep: "grep",
  tm_bash: "bash",
}

/**
 * Top routing: tool name + tool args -> category to block, or null to pass.
 * `off` always passes (the hook stays installed but is a no-op).
 */
export function inspectToolCall(
  tool: string,
  args: Record<string, unknown> | undefined,
  mode: EnvProtectMode,
  extra: RegExp[] = [],
): string | null {
  if (mode === "off") return null
  const rawName = String(tool ?? "").trim().toLowerCase()
  const name = TM_TOOL_ALIASES[rawName] ?? rawName
  if (name === "bash") {
    const command = (args as { command?: unknown } | undefined)?.command
    return classifyBashCommand(String(command ?? ""), mode, extra)
  }
  if (PATH_SCAN_TOOLS.has(name)) {
    return classifyPathFields(args, mode, extra)
  }
  return null
}


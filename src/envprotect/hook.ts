/**
 * R6 — the `tool.execute.before` hook: file-tool path classification,
 * tool-call level routing (tm_* aliasing = anti-backdoor), and the hook
 * factory with the privacy-red-line audit.  Split out of the former
 * monolithic envprotect.ts; behavior unchanged.
 */

import {
  CATEGORY_ENV_FILE_PATH,
  CATEGORY_EXTRA_DENY,
  ENV_PROTECT_SERVICE,
  envProtectError,
  type EnvProtectMode,
} from "./patterns.js"
import { classifyBashCommand } from "./bash-classify.js"
import { isEnvFilePath } from "./path-classify.js"
import { isAskGatedEnvCommand } from "./gate-predicates.js"

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

// ---------- hook factory ----------

/** Structural subset of the opencode SDK client used for audit logging. */
interface AuditClient {
  app?: {
    log?: (request: unknown) => unknown | Promise<unknown>
  }
}

/**
 * Best-effort audit of one interception.  Records ONLY the tool name and
 * the pattern category (privacy red line: never command text, paths,
 * variable names or values); the message embeds the service id itself so
 * file-backed log sinks that drop the `service` field stay greppable.  A
 * failing audit endpoint must never turn a block into a pass-through, so
 * every failure is swallowed after the call attempt.
 */
async function auditInterception(
  client: unknown,
  tool: string,
  category: string,
): Promise<void> {
  try {
    // Call the method THROUGH the app object.  Destructuring `app.log`
    // first would drop the SDK's `this` binding, so every real call died
    // inside the SDK and was silently swallowed here — zero audit entries.
    const app = (client as AuditClient | null | undefined)?.app
    if (!app || typeof app.log !== "function") return
    await app.log({
      body: {
        level: "warn",
        service: ENV_PROTECT_SERVICE,
        message: `${ENV_PROTECT_SERVICE} :: ${tool} :: ${category}`,
      },
    })
  } catch {
    /* audit is best-effort; the block below still takes effect */
  }
}

/**
 * Build the `tool.execute.before` hook.  The hook is installed in every
 * mode; with mode "off" it returns immediately and everything passes.
 * When a block triggers, the audit entry is written first, then the fixed
 * structured error is thrown so opencode surfaces it to the model as the
 * failed tool result.
 *
 * `options.deferToApproval` (the unified approval gate) — called with the
 * tool call's `input.sessionID`; when it reports `true`, a built-in-bash
 * environment read in an EXACT ask-glob form is passed through WITHOUT
 * throwing, because the official confirmation dialog is the live gate for
 * it (approve → runs, reject or timeout → the host blocks it).  The signal
 * is SESSION-SCOPED on purpose: the gate registers only sessions carrying
 * our injected bash ask set (exec-role chat.message, or an R6-env-classified
 * `permission.asked`), so a stock build/plan session — where no dialog would
 * ever open for `printenv` — keeps the hard throw instead of slipping the
 * read through a global arm flag.  Reaching the deferral point at all
 * additionally requires the command to match the config globs byte-exactly,
 * so the dialog is GUARANTEED to fire wherever deferral happens.  A failed
 * auto-reject flips the gate back to `false` everywhere, restoring the hard
 * throw (fail-closed).  tm_* channels are never deferred (no dialog opens
 * for them).
 */
export function createEnvProtectHook(
  client: unknown,
  mode: EnvProtectMode,
  extra: RegExp[] = [],
  options: { deferToApproval?: (sessionID?: string) => boolean; envApproved?: (sessionID?: string) => boolean } = {},
): (input: unknown, output: unknown) => Promise<void> {
  return async (input: unknown, output: unknown): Promise<void> => {
    if (mode === "off") return
    const tool = String((input as { tool?: unknown } | null)?.tool ?? "")
    const rawSid = (input as { sessionID?: unknown } | null)?.sessionID
    const sessionID = typeof rawSid === "string" && rawSid.trim() !== "" ? rawSid.trim() : undefined
    const args = (output as { args?: Record<string, unknown> } | null)?.args
    const category = inspectToolCall(tool, args, mode, extra)
    if (!category) return
    // Session-wide env approval ("always" on first env ask) — pass silently;
    // the "always" event itself was already audited by the approval gate.
    // The blanket NEVER covers env-FILE reads (CATEGORY_ENV_FILE_PATH):
    // files on disk (.env, shell rc family) never open a dialog of their
    // own (they are not in the ask-pattern set), so no "always" verdict can
    // have consented to them — they keep hard-throwing even in an
    // env-approved session.
    if (
      sessionID &&
      options.envApproved?.(sessionID) &&
      category !== CATEGORY_ENV_FILE_PATH
    ) {
      return
    }
    // Defer ONLY the built-in bash tool (never its tm_bash alias), ONLY in a
    // registered session, for the exact forms the config escalates to `ask`.
    if (tool.trim().toLowerCase() === "bash" && sessionID && options.deferToApproval?.(sessionID)) {
      const command = (args as { command?: unknown } | undefined)?.command
      if (isAskGatedEnvCommand(String(command ?? ""), mode, extra)) return
    }
    await auditInterception(client, tool, category)
    throw envProtectError(category)
  }
}

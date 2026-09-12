/**
 * R6 — code-level environment-variable read protection for Team mode.
 *
 * MODULE FACADE: the implementation lives in ./envprotect/ (patterns,
 * bash-classify, path-classify, gate-predicates, hook).  This file only
 * re-exports the historical surface so every existing import specifier
 * (`../envprotect.js`, `./envprotect.js`) and the dist path keep working.
 *
 * HUMAN-approved feature: in Team mode, EVERY path the model can use to
 * read environment variables / env files is intercepted in code, before
 * the tool runs, independent of prompt compliance. This hook throws inside
 * `tool.execute.before`, which opencode (verified live on 1.18.29) turns
 * into a failed tool call whose error text is returned to the model — so
 * the block is hard, not advisory.
 *
 * Configuration (plugin options + env, read at startup):
 *   - plugin option `envProtect` (v1.5.4, default FALSE) gates the whole
 *     feature: without opting in, nothing intercepts, no gate arms, no
 *     audit lines are written.  When opted in:
 *   - `TM_ENV_PROTECT`       = "strict" (default) | "standard" | "off";
 *     unknown values fail closed into strict.
 *   - `TM_ENV_PROTECT_EXTRA_DENY` = semicolon-separated user regexes,
 *     applied to every scanned string in any non-off mode.
 *
 * Audit red line (HUMAN privacy constraint): every interception is logged
 * via `client.app.log()` recording ONLY the tool name and the pattern
 * category. Command text, paths, variable names and values are NEVER
 * logged.
 */

export {
  CATEGORY_BASH_ENV_COMMAND,
  CATEGORY_BASH_ENV_EXPANSION,
  CATEGORY_ENV_FILE_PATH,
  CATEGORY_EXTRA_DENY,
  R2_DANGER_BASH_ASK,
  R2_DANGER_BASH_ASK_PATTERNS,
  R6_ENV_BASH_ASK,
  R6_ENV_BASH_ASK_PATTERNS,
  ENV_PROTECT_SERVICE,
  ENV_PROTECT_MESSAGE,
  bashAskPatterns,
  envProtectError,
  parseExtraDeny,
  resolveEnvProtectMode,
} from "./envprotect/patterns.js"
export type { EnvProtectMode } from "./envprotect/patterns.js"

export { isEnvFilePath } from "./envprotect/path-classify.js"

export { classifyBashCommand } from "./envprotect/bash-classify.js"

export {
  categorizePermission,
  commandMatchesAnyAskPattern,
  isAskGatedEnvCommand,
} from "./envprotect/gate-predicates.js"

export { classifyPathFields, createEnvProtectHook, inspectToolCall } from "./envprotect/hook.js"

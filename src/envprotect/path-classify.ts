/**
 * R6 — env-file path matching (.env family, shell rc files) for both path
 * arguments and bash tokens.  Split out of the former monolithic
 * envprotect.ts; behavior unchanged.
 */

// ---------- env-file path matching ----------

/** Shell/rc basenames whose content is effectively an env dump. */
const ENV_FILE_BASENAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zshrc",
  ".zprofile",
  ".zshenv",
])

/** Checked-in template suffixes — documentation copies, not real secrets. */
const ENV_TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist)$/

/**
 * Code identifiers that merely end in ".env" and name an object, not a
 * file (`process.env`, `import.meta.env`, ...).  The escaped form is
 * listed too because a grep pattern like `process\.env` survives
 * tokenization with its backslash.
 */
const ENV_IDENTIFIER = /^(?:process|deno|bun|os|import\.meta)\.env$/i

/**
 * True when the value points at an env file.  Matches on the BASENAME with
 * both separators handled; URL query/fragment tails are cut first so
 * `https://x/.env?raw=1` matches the same basename as a plain path, and
 * asterisks are stripped so glob patterns like "*.env" or a recursive deep
 * form of ".env.local" are caught by the same matcher as real paths.
 * (Note: glob spellings are written without backticks here — a double-star
 * + slash inside JSDoc would close the comment block early.)
 */
export function isEnvFilePath(raw: string): boolean {
  const value = String(raw ?? "")
    // one percent-decode pass FIRST, so URL-encoded names like
    // `https://x/%2Eenv` land on the same basename as the plain path
    // (single pass only: `%252E` decodes to `%2E` and stays encoded)
    .replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/[?#].*$/, "")
    .replace(/\*/g, "")
    .trim()
  if (!value) return false
  // A code identifier like `process.env` is not a file path, however it is
  // segmented.  The unescaped form matters because a grep pattern spelled
  // `process\.env` would otherwise split at the backslash into path +
  // basename `.env` and slip past the identifier check below.
  if (ENV_IDENTIFIER.test(value) || ENV_IDENTIFIER.test(value.replace(/\\/g, ""))) {
    return false
  }
  const segments = value.split(/[\\/]/)
  const base = (segments[segments.length - 1] || "").toLowerCase()
  if (!base) return false
  if (base === ".env") return true
  if (base.startsWith(".env.")) {
    // `.env.example` and friends are safe checked-in documentation
    if (ENV_TEMPLATE_SUFFIX.test(base)) return false
    return true
  }
  if (base.endsWith(".env")) {
    if (ENV_IDENTIFIER.test(base) || ENV_IDENTIFIER.test(base.replace(/\\/g, ""))) {
      return false
    }
    return true
  }
  return ENV_FILE_BASENAMES.has(base)
}

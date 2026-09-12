/**
 * Shared shell statement segmentation — the ONE implementation of "split a
 * command into shell segments" (compound statements and pipelines are
 * checked at every boundary).  Previously duplicated between
 * envprotect/bash-classify.ts and tm/guard.ts; behavior identical in both.
 */

/**
 * Split a command into shell segments so compound statements like
 * `cd /x && printenv` are checked at every statement boundary.
 * NOTE: quoted `|`/`;` are literal text — callers that must not split on
 * them blank quoted spans FIRST (see tm/guard.ts blankQuoted).
 */
export function splitShellSegments(command: string): string[] {
  return command.split(/&&|\|\||[;\n|&]/)
}

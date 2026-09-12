/**
 * tm_ptc_run — static pre-scan: the FIRST gate.  runPtc and buildPtcRunTool
 * both reject a rejected program before any engine runs.  Auxiliary guard,
 * not a security boundary (design §3 trust model).  Split out of the former
 * monolithic ptc.ts; behavior unchanged.
 */

/** Banned identifier tokens for the program source. */
const PSCAN_PATTERNS: readonly RegExp[] = [
  /\brequire\b/,
  /\bimport\b/,
  /\bprocess\b/,
  /\bglobalThis\b/,
  /\bDeno\b/,
  /\bBun\b/,
  /\bfs\b/,
  /\bnet\b/,
  /\bchild_process\b/,
]

export function staticPscan(program: string): { rejected: boolean; tokens: string[] } {
  const tokens: string[] = []
  for (const re of PSCAN_PATTERNS) {
    if (re.test(program)) tokens.push(re.source.replace(/\\b/g, "").replace(/\b/g, ""))
  }
  return { rejected: tokens.length > 0, tokens }
}

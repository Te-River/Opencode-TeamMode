/**
 * fs-safe — deletion that actually deletes, everywhere.
 *
 * Observed on Node 24.12 / win32: `fs.rmSync` on a path containing non-ASCII
 * characters (CJK titles are the norm for memory/board artifacts) can resolve
 * WITHOUT deleting anything — no throw, file still on disk.  `fs.unlinkSync`
 * does not share the defect.  Every destructive call site in the plugin
 * (blackboard sweeper, run-store sweep, tm_memory forget) goes through
 * rmForceSafe: rmSync first, then an existence check with a manual
 * depth-first unlink fallback.  A deletion that silently failed must never
 * look like success.
 */

import * as fs from "node:fs"
import * as path from "node:path"

function unlinkDirect(p: string): void {
  try {
    fs.unlinkSync(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e
  }
}

export function rmForceSafe(target: string, opts: { recursive?: boolean } = {}): void {
  try {
    fs.rmSync(target, { recursive: opts.recursive, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* fall through — the existence check below decides */
  }
  if (!fs.existsSync(target)) return
  // rmSync silently failed (or raced): manual depth-first removal.
  let st: fs.Stats
  try {
    st = fs.lstatSync(target)
  } catch {
    return // gone after all
  }
  if (st.isDirectory() && opts.recursive !== false) {
    for (const entry of fs.readdirSync(target)) {
      rmForceSafe(path.join(target, entry), { recursive: true })
    }
    try {
      fs.rmdirSync(target)
    } catch {
      /* best effort — a locked child must not mask the rest */
    }
  } else {
    unlinkDirect(target)
  }
}

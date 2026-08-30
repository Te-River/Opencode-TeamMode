/**
 * Shared blackboard for sub-agent coordination + automatic maintenance.
 *
 * Sub-agents cannot message each other live (platform limitation), so
 * TeamMode uses a file blackboard under `<repo>/.git/opencode-team/<task>/`:
 *  - each agent writes its full deliverable to a designated file;
 *  - the team lead relays summaries + file paths in every dispatch;
 *  - the team lead deletes the task directory when the workflow ends.
 *
 * This module is the code-level safety net independent of the model:
 * a sweeper removes task directories whose last activity is older than
 * the TTL, at plugin startup and hourly in-process.  Placing the board
 * inside `.git/` guarantees the user's working tree and commits are never
 * polluted; for non-git workspaces we fall back to the OS temp dir.
 *
 * TTL is user-configurable via plugin options:
 *   "plugin": [["@te-river/opencode-team-mode", { "ttlDays": 7 }]]
 * Default: 5 days.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Default idle time before a task directory is swept: 5 days. */
export const DEFAULT_TTL_DAYS = 5
export const DEFAULT_TTL_MS = DEFAULT_TTL_DAYS * 24 * 60 * 60 * 1000

/** In-process sweep cadence. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** Board root directory name (under .git/, or under tmpdir as fallback). */
const ROOT_NAME = "opencode-team"

/** Walk upward from `start` to find the git repository root, if any. */
export function findRepoRoot(start: string): string | null {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Absolute blackboard root for a workspace. */
export function teamRootFor(directory: string): string {
  const repo = findRepoRoot(directory)
  const base = repo ? path.join(repo, ".git") : os.tmpdir()
  return path.join(base, ROOT_NAME)
}

/**
 * Resolve the TTL from plugin options.  Accepts `ttlDays` (or the more
 * explicit `blackboardTtlDays`) as a finite number in (0, 365]; anything
 * else silently falls back to the 5-day default.
 */
export function resolveTtlMs(options: Record<string, unknown> = {}): number {
  const raw = options.ttlDays ?? options.blackboardTtlDays
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 365) {
    return raw * 24 * 60 * 60 * 1000
  }
  return DEFAULT_TTL_MS
}

/** Latest mtime among a directory and its immediate entries. */
function lastActivity(dir: string): number {
  try {
    let latest = fs.statSync(dir).mtimeMs
    for (const entry of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, entry))
        if (st.mtimeMs > latest) latest = st.mtimeMs
      } catch {
        /* raced deletion — ignore */
      }
    }
    return latest
  } catch {
    return 0
  }
}

/**
 * Remove idle task directories under `root`.
 * Returns the number of directories deleted; never throws.
 */
export function sweepStale(root: string, ttlMs = DEFAULT_TTL_MS): number {
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return 0 // root does not exist yet — nothing to sweep
  }
  const now = Date.now()
  let removed = 0
  for (const entry of entries) {
    const dir = path.join(root, entry)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      const seen = lastActivity(dir)
      if (seen === 0) continue
      if (now - seen > ttlMs) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed++
      }
    } catch {
      /* stat/race failure on a single entry — skip it */
    }
  }
  return removed
}

let maintenanceStarted = false

/**
 * Start blackboard maintenance (idempotent within the process) and return
 * the resolved board root.  Runs a startup sweep (catches leftovers from
 * crashes / force-kills) plus an unref'd hourly interval so the timer never
 * keeps the process alive on its own.
 */
export function startBlackboardMaintenance(
  directory: string,
  ttlMs = DEFAULT_TTL_MS,
): string {
  const root = teamRootFor(directory)
  if (!maintenanceStarted) {
    maintenanceStarted = true
    sweepStale(root, ttlMs)
    const timer = setInterval(() => sweepStale(root, ttlMs), SWEEP_INTERVAL_MS)
    if (typeof timer.unref === "function") timer.unref()
  }
  return root
}

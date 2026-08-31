/**
 * Shared blackboard for sub-agent coordination + automatic maintenance.
 *
 * Sub-agents cannot message each other live (platform limitation), so
 * TeamMode uses a file blackboard under
 * `<repo>/.git/opencode-team/<session-key>/<task>/`:
 *  - <session-key> is a compact timestamp folder, one per conversation —
 *    a fresh conversation can never collide with a not-yet-swept board
 *    from an earlier one;
 *  - each agent writes its full deliverable to a designated file;
 *  - the team lead relays summaries + file paths in every dispatch;
 *  - nobody deletes task directories by hand; the sweeper below reclaims
 *    them once idle past the TTL (sole cleanup path, by design).
 *
 * This module is the code-level reclamation path, independent of the model:
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

/**
 * Latest mtime within `dir`, looking through up to `levels` sub-directory
 * layers (artifacts live one level below a task dir, so 1 suffices per
 * task and 2 from the session/root level).
 */
function lastActivity(dir: string, levels = 0): number {
  try {
    let latest = fs.statSync(dir).mtimeMs
    for (const entry of fs.readdirSync(dir)) {
      try {
        const child = path.join(dir, entry)
        const st = fs.statSync(child)
        const seen =
          st.isDirectory() && levels > 0 ? lastActivity(child, levels - 1) : st.mtimeMs
        if (seen > latest) latest = seen
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
 * True when a directory tree shows no activity within the TTL.
 * `levels` must reach down to the artifact files: 1 for a task directory
 * (files sit directly inside), 2 for a session directory (task dirs are
 * one level deeper — depth 1 here would miss in-place rewrites and let a
 * whole live session be reclaimed; regression-pinned by test fixture).
 */
function isStale(dir: string, now: number, ttlMs: number, levels: number): boolean {
  const seen = lastActivity(dir, levels)
  return seen !== 0 && now - seen > ttlMs
}

/**
 * Remove idle boards under `root`.  Understands both layouts:
 *  - session-partitioned `<root>/<session-key>/<task>/`: stale tasks are
 *    pruned individually under a live session; an entirely idle session
 *    folder goes as a whole;
 *  - legacy flat `<root>/<task>/`: unchanged semantics — and if such a dir
 *    unexpectedly contains sub-directories, idle ones are pruned by the
 *    same rule (harmless hygiene, though counted as task dirs).
 * Returns the number of task directories reclaimed; a wholesale session
 * removal counts its task dirs (min 1, so a ghost empty stale session dir
 * also counts 1).  Never throws.
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
      if (isStale(dir, now, ttlMs, 2)) {
        // Entire tree idle: legacy flat task dir, or a finished session.
        let tasks = 0
        for (const child of fs.readdirSync(dir)) {
          try {
            if (fs.statSync(path.join(dir, child)).isDirectory()) tasks++
          } catch {
            /* raced — ignore */
          }
        }
        fs.rmSync(dir, { recursive: true, force: true })
        removed += Math.max(1, tasks)
        continue
      }
      // Live tree: prune per-task dirs (session layout; legacy dirs have
      // no directory children, so this loop is a no-op for them).
      for (const child of fs.readdirSync(dir)) {
        const task = path.join(dir, child)
        try {
          if (!fs.statSync(task).isDirectory()) continue
          if (!isStale(task, now, ttlMs, 1)) continue
          fs.rmSync(task, { recursive: true, force: true })
          removed++
        } catch {
          /* raced — skip this task */
        }
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

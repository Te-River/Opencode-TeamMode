/**
 * JIT layer-2 tools — run-payload store + trajectory.
 *
 * Blackboard layout (under TM_BLACKBOARD_DIR, default `<project>/.blackboard/`):
 *   runs/{run_id}/steps/{step_id}/{seq:03d}-{tool}.md   full offloaded result
 *   runs/{run_id}/index.jsonl                            one append per result
 *     entry = { ts, run_id, step_id, seq, tool, ref, file, tokens,
 *               content_type, expire_at, preview }
 *
 * Trajectory layout (under TM_TRAJECTORY_DIR, default `<project>/.trajectory/`):
 *   runs/{run_id}/steps.jsonl    append-only, one line per event — NO code
 *                                path may rewrite, truncate or delete lines;
 *                                the TTL sweep of whole expired run dirs is
 *                                the sanctioned reclamation path.
 *   runs/{run_id}/usage.jsonl    RESERVED for T2.2 (constant below, unused).
 *
 * Reclamation philosophy mirrors blackboard.ts: a startup sweep removes run
 * dirs idle past the TTL — idleness measured across the whole run-dir tree
 * (file appends must count as activity; only this sweep is destructive).
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { buildRef } from "./refs.js"
import { rmForceSafe } from "../fs-safe.js"

/** Reserved for T2.2 usage accounting — path constant only in this phase. */
export const USAGE_JSONL_RELPATH = "usage.jsonl"

/** Offloaded result files follow `{seq:03d}-{tool}.md` inside a step dir. */
const STEP_FILE = /^\d{3}-[\w.-]+\.md$/

export interface OffloadMeta {
  tool: string
  content: string
  tokens: number
  contentType: string
  preview: string
  expireAt: number
}

export interface StoredRef {
  stepId: string
  seq: number
  file: string
  ref: string
  expireAt: number
}

export interface IndexEntry {
  ts: string
  run_id: string
  step_id: string
  seq: number
  tool: string
  ref: string
  file: string
  tokens: number
  content_type: string
  expire_at: number
  preview: string
}

export interface RunStoreOptions {
  projectRoot: string
  blackboardDir: string
  trajectoryDir: string
  runId: string
  ttlDays: number
}

export class RunStore {
  readonly blackboardRoot: string
  readonly trajectoryRoot: string
  private readonly _runId: string
  private readonly _ttlMs: number

  constructor(opts: RunStoreOptions) {
    this._runId = opts.runId
    this._ttlMs = opts.ttlDays * 24 * 60 * 60 * 1000
    this.blackboardRoot = path.isAbsolute(opts.blackboardDir)
      ? opts.blackboardDir
      : path.join(opts.projectRoot, opts.blackboardDir)
    this.trajectoryRoot = path.isAbsolute(opts.trajectoryDir)
      ? opts.trajectoryDir
      : path.join(opts.projectRoot, opts.trajectoryDir)
  }

  get runId(): string {
    return this._runId
  }

  private runDir(): string {
    return path.join(this.blackboardRoot, "runs", this._runId)
  }

  stepsRoot(): string {
    return path.join(this.runDir(), "steps")
  }

  trajectoryFile(): string {
    return path.join(this.trajectoryRoot, "runs", this._runId, "steps.jsonl")
  }

  /**
   * Write one offloaded result: step file (single write, never rewritten) +
   * index.jsonl append.  Throws on store failures — the caller degrades
   * (governance failures must not fail the task).
   */
  writeResult(stepId: string, meta: OffloadMeta): StoredRef {
    const stepDir = path.join(this.stepsRoot(), stepId)
    fs.mkdirSync(stepDir, { recursive: true })
    const seq =
      fs.readdirSync(stepDir).filter((f) => STEP_FILE.test(f)).length + 1
    const safeTool = meta.tool.replace(/[^\w-]/g, "_")
    const name = `${String(seq).padStart(3, "0")}-${safeTool}.md`
    const file = path.join(stepDir, name)
    fs.writeFileSync(file, meta.content, "utf8")
    const ref = buildRef(this._runId, stepId)
    const entry: IndexEntry = {
      ts: new Date().toISOString(),
      run_id: this._runId,
      step_id: stepId,
      seq,
      tool: meta.tool,
      ref,
      file: `${stepId}/${name}`,
      tokens: meta.tokens,
      content_type: meta.contentType,
      expire_at: meta.expireAt,
      preview: meta.preview,
    }
    fs.appendFileSync(
      path.join(this.runDir(), "index.jsonl"),
      JSON.stringify(entry) + "\n",
      "utf8",
    )
    return { stepId, seq, file, ref, expireAt: meta.expireAt }
  }

  /**
   * Append one trajectory event.  Append-only by contract; best-effort
   * (trajectory failures are swallowed — the blackboard failure path is the
   * one that degrades upstream).
   */
  appendTrajectory(event: Record<string, unknown>): void {
    try {
      const file = this.trajectoryFile()
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const line =
        JSON.stringify({ ts: new Date().toISOString(), run_id: this._runId, ...event }) + "\n"
      fs.appendFileSync(file, line, "utf8")
    } catch {
      /* trajectory is best-effort */
    }
  }

  /** Latest index entry for a ref (last append wins), or null. */
  findIndexEntry(ref: string): IndexEntry | null {
    try {
      const text = fs.readFileSync(path.join(this.runDir(), "index.jsonl"), "utf8")
      let found: IndexEntry | null = null
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as IndexEntry
          if (entry && entry.ref === ref) found = entry
        } catch {
          /* skip torn/bad line — append-only logs can have them on crash */
        }
      }
      return found
    } catch {
      return null
    }
  }

  /** Read the offloaded payload file of a step; null when gone/unreadable.
   *  With multiple seq files in one step (defensive re-entry), the LATEST
   *  seq wins — consistent with findIndexEntry's last-append-wins. */
  readStepFile(stepId: string): { content: string } | null {
    try {
      const dir = path.join(this.stepsRoot(), stepId)
      const files = fs.readdirSync(dir).filter((f) => STEP_FILE.test(f)).sort()
      if (files.length === 0) return null
      return { content: fs.readFileSync(path.join(dir, files[files.length - 1]), "utf8") }
    } catch {
      return null
    }
  }

  /**
   * Startup-only reclamation: remove run dirs (both stores) whose last tree
   * activity is older than the TTL.  This is the ONLY destructive path in
   * this module.  Returns the number of run dirs removed.  Never throws.
   */
  sweepExpired(now: number = Date.now()): number {
    let removed = 0
    for (const root of [this.blackboardRoot, this.trajectoryRoot]) {
      const runsDir = path.join(root, "runs")
      let entries: string[]
      try {
        entries = fs.readdirSync(runsDir)
      } catch {
        continue // store not created yet — nothing to sweep
      }
      for (const entry of entries) {
        const dir = path.join(runsDir, entry)
        try {
          if (!fs.statSync(dir).isDirectory()) continue
          // Activity = max mtime across the run-dir TREE (M2, mirrors
          // blackboard.ts): appending to steps.jsonl / step files does NOT
          // refresh the parent dir's mtime, so a dir-mtime check deleted
          // live runs (review probe E1).  lastActivityMs returning 0 (stat
          // failure) keeps the dir — fail-closed.
          const last = lastActivityMs(dir)
          if (last !== 0 && now - last > this._ttlMs) {
            rmForceSafe(dir, { recursive: true })
            removed++
          }
        } catch {
          /* raced entry — skip */
        }
      }
    }
    return removed
  }
}

/**
 * Latest mtime within `dir`, recursing the whole tree (M2 — mirrors
 * blackboard.ts's lastActivity, which is regression-pinned there).  A
 * directory's own mtime only changes when direct children are created/
 * removed/renamed — NOT when a file inside is appended or rewritten in
 * place — so the sweep must look at file activity.
 *
 * The depth difference vs blackboard.ts's lastActivity (capped `levels`
 * recursion) is DELIBERATE: blackboard trees can be user-managed and
 * arbitrarily deep, so they cap defensively; the run-dir tree here is
 * plugin-owned and bounded by what the plugin itself wrote.  Even a
 * pathological cycle terminates naturally — fs.statSync on a symlink loop
 * fails with ELOOP and is swallowed by the catch below.
 */
function lastActivityMs(dir: string): number {
  let latest: number
  try {
    latest = fs.statSync(dir).mtimeMs
  } catch {
    return 0
  }
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return latest // unreadable dir: its own mtime is all we know
  }
  for (const entry of entries) {
    const child = path.join(dir, entry)
    try {
      const st = fs.statSync(child)
      const seen = st.isDirectory() ? lastActivityMs(child) : st.mtimeMs
      if (seen > latest) latest = seen
    } catch {
      /* raced deletion — ignore */
    }
  }
  return latest
}

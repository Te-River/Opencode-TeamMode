/**
 * Parallel test runner for this repo (2026-09-19, item 7).
 *
 * `npm test` was one `&&` chain over seven suites, so the wall clock was the
 * SUM of all seven — and the slowest part of a change cycle was waiting for
 * suites that cannot interfere with each other: every one of them builds its
 * own store under `fs.mkdtemp(os.tmpdir())`, and each runs as its own process,
 * so `process.env` mutation in one cannot leak into another.
 *
 * What stays serial on purpose:
 *   - `tsc` first, always. The suites import from `dist/`, so a parallel run
 *     against a stale build produces phantom failures (this bit us repeatedly).
 *   - the real-browser suites, via a named lock: test-tm-tools §6o and
 *     test-browser both launch an actual Edge. Each uses its own isolated
 *     profile, but two browsers at once on a laptop is a latency contest, not
 *     a speedup, and a flaky screenshot run is worse than a slow one.
 *
 * Output is buffered PER SUITE and printed as a block when that suite ends, so
 * interleaving can never garble a failure report. The tail is a markdown table
 * — the shape the host (and the user) reads fastest.
 *
 * Usage:
 *   node scripts/run-tests.mjs                 # build, then run everything
 *   node scripts/run-tests.mjs browser stats   # only suites whose name matches
 *   node scripts/run-tests.mjs --serial        # one at a time (debugging)
 *   node scripts/run-tests.mjs --no-build      # skip tsc (dist already fresh)
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const SERIAL = argv.includes("--serial")
const NO_BUILD = argv.includes("--no-build")
const FILTERS = argv.filter((a) => !a.startsWith("--"))

/** Suites that launch a REAL browser — never two at once. */
const BROWSER_SUITES = new Set(["test-tm-tools.mjs", "test-browser.mjs"])

/**
 * One throwaway store root for the whole run.
 *
 * Every suite boots a real runtime, and a runtime in a NON-git workspace
 * creates a per-workspace shard (`w-<hash>/…`) under the developer's SHARED
 * tmpdir base.  Hundreds piled up there, because `TM_STORE_RECLAIM=off` (rightly
 * — boot-time reclamation is product behaviour for the user's machine, not a
 * test fixture) means nothing ever prunes them.  Pointing the two store roots at
 * Redirecting the two store roots at one throwaway directory moves the bulk of
 * what a run writes out of the shared bucket, and it goes away when the run ends.
 *
 * NOT YET SOLVED, stated rather than assumed: a full run still leaves new
 * `w-<hash>/` shards behind (measured +16 per run on 2026-09-25), so at least
 * one path derives the auto store base without consulting these two knobs —
 * the `memories/` tier lives under the shared BASE by design, not under either
 * directory.  Until that is traced this is the honest record: the redirect
 * reduces the litter, it does not prevent it.
 *
 * §6q is unaffected: it exercises pruneStaleStoreShards()/
 * reclaimLegacyStoreBuckets() against its own synthetic base rather than by
 * booting a runtime, and the few tests that set TM_BLACKBOARD_DIR themselves
 * still override this default.
 */
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tm-test-store-"))
// Children get storeRoot AS THEIR TMPDIR, which is what actually stops the leak:
// a non-git workspace's store lives at `<os.tmpdir()>/opencode-team/w-<hash>`, so
// overriding TM_BLACKBOARD_DIR / TM_TRAJECTORY_DIR alone still grew one shard in
// the developer's real Temp per throwaway workspace (2,067 had accumulated, 74 of
// them inside the last hour).  Redirecting the tmp root puts EVERYTHING a test
// writes under the directory we already delete at exit — run stores, shards,
// browser profiles, memory mirrors — not just the two trees an env override
// reaches.  (Verified that `os.tmpdir()` reads TMPDIR/TEMP/TMP per call rather
// than caching, so this takes effect in the child without a Node flag.)
const childTmp = path.join(storeRoot, "tmp")
fs.mkdirSync(childTmp, { recursive: true })
process.on("exit", () => {
  try {
    fs.rmSync(storeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch {
    /* swallowed below — the existence check is the part that has to be honest */
  }
  // win32 fs.rmSync can silently no-op on non-ASCII paths, so say where the
  // directory is if it is still there rather than claiming it was cleaned.
  if (fs.existsSync(storeRoot)) console.log(`（测试 store 目录未能删除，可手动清理：${storeRoot}）`)
})

const allSuites = fs
  .readdirSync(REPO)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .sort()

if (allSuites.length === 0) {
  console.error("no test-*.mjs suites found")
  process.exit(1)
}

const suites = FILTERS.length
  ? allSuites.filter((f) => FILTERS.some((needle) => f.toLowerCase().includes(needle.toLowerCase())))
  : allSuites

if (!suites.length) {
  console.error(`filter ${JSON.stringify(FILTERS)} matched none of: ${allSuites.join(", ")}`)
  process.exit(1)
}

const run = (file) =>
  new Promise((resolve) => {
    const started = Date.now()
    // TM_STORE_RECLAIM=off: cleanup at boot is product behaviour for the user's
    // machine, not a test fixture, and the reclamation itself is covered by
    // calling its functions directly.  With the child tmp root redirected (below)
    // this is now belt-and-braces — the bucket it would reach is ours — but a
    // mid-suite sweep of a SANDBOX still has no reason to run, so it stays off.
    const child = spawn(process.execPath, [file], {
      cwd: REPO,
      windowsHide: true,
      env: {
        ...process.env,
        TMPDIR: childTmp,
        TEMP: childTmp,
        TMP: childTmp,
        TM_STORE_RECLAIM: "off",
        TM_BLACKBOARD_DIR: path.join(storeRoot, "blackboard"),
        TM_TRAJECTORY_DIR: path.join(storeRoot, "trajectory"),
      },
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += String(d)))
    child.stderr.on("data", (d) => (err += String(d)))
    child.on("close", (code) => resolve({ file, code, ms: Date.now() - started, out, err }))
    child.on("error", (e) => resolve({ file, code: 1, ms: Date.now() - started, out, err: String(e?.message ?? e) }))
  })

const report = (r) => {
  const okRun = r.code === 0
  const label = okRun ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"
  console.log(`\n──── ${r.file} · ${label} · ${(r.ms / 1000).toFixed(1)}s ────`)
  // a passing suite prints only its own summary lines; a failing one prints
  // everything, because the assertion message IS the report
  const text = (r.out + (r.err ? `\n[stderr]\n${r.err}` : "")).trimEnd()
  const lines = text.split(/\r?\n/)
  console.log(okRun ? lines.slice(-6).join("\n") : text)
}

const build = () =>
  new Promise((resolve) => {
    // tsc directly, not `npm run build`: no shell, no npm CLI path guessing,
    // and the suites import from dist/ so this must succeed first
    const child = spawn(process.execPath, [path.join(REPO, "node_modules", "typescript", "bin", "tsc")], {
      cwd: REPO,
      windowsHide: true,
      stdio: "inherit",
    })
    child.on("close", (code) => resolve(code ?? 1))
    child.on("error", () => resolve(1))
  })

const main = async () => {
  if (!NO_BUILD) {
    const code = await build()
    if (code !== 0) {
      console.error("\nBUILD FAILED — suites not run (they import from dist/)")
      process.exit(code)
    }
  }
  const cap = SERIAL ? 1 : Math.min(4, Math.max(1, (os.cpus()?.length || 4) - 1))
  console.log(`running ${suites.length} suites, concurrency ${cap}${NO_BUILD ? " (build skipped)" : ""}`)
  const wallStart = Date.now()

  const queue = [...suites]
  const done = []
  let browserBusy = false
  const waitingForBrowser = new Set()

  const worker = async () => {
    for (;;) {
      // take the first runnable suite; a browser suite waits for the lock
      let idx = queue.findIndex((f) => !BROWSER_SUITES.has(f) || !browserBusy)
      if (idx === -1) {
        if (!waitingForBrowser.size && !queue.some((f) => BROWSER_SUITES.has(f))) return
        // nothing but browser suites left and one is running: wait for it
        const idxB = queue.findIndex((f) => BROWSER_SUITES.has(f))
        if (idxB === -1) return
        if (browserBusy) {
          await new Promise((res) => setTimeout(res, 250))
          continue
        }
        idx = idxB
      }
      const file = queue.splice(idx, 1)[0]
      const isBrowser = BROWSER_SUITES.has(file)
      if (isBrowser) browserBusy = true
      waitingForBrowser.add(file)
      const r = await run(file)
      waitingForBrowser.delete(file)
      if (isBrowser) browserBusy = false
      report(r)
      done.push(r)
    }
  }

  await Promise.all(Array.from({ length: Math.min(cap, suites.length) }, worker))

  const failed = done.filter((r) => r.code !== 0)
  const wallMs = Date.now() - wallStart
  const sumMs = done.reduce((a, r) => a + r.ms, 0)
  console.log("\n## 测试汇总\n")
  console.log("| 套件 | 结果 | 耗时 |")
  console.log("|---|---|---:|")
  for (const r of [...done].sort((a, b) => b.ms - a.ms)) {
    console.log(`| \`${r.file}\` | ${r.code === 0 ? "✅" : `❌ exit ${r.code}`} | ${(r.ms / 1000).toFixed(1)}s |`)
  }
  console.log(
    `\n${done.length - failed.length}/${done.length} 通过 · 墙钟 ${(wallMs / 1000).toFixed(0)}s` +
      `（串行需 ${(sumMs / 1000).toFixed(0)}s）` +
      (failed.length ? ` · 失败：${failed.map((f) => f.file).join(", ")}` : ""),
  )
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

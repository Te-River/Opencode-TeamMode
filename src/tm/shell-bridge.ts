/**
 * tm layer — the host `$` shell bridge + shell error hygiene.  Split out of
 * the former tools.ts hub.
 */

/**
 * Run a command through the host `$` bridge.  The REAL host `$` is a
 * Bun-shell tagged template (probed keys: Shell/ShellPromise/ShellError/
 * braces/escape) — both `$(["cmd"])` and `$("cmd")` are rejected with
 * "Please use '$' as a tagged template function", which failed every
 * tm_bash call at phase=execute.  A tagged-template call desugars to
 * `$(Object.assign([command], { raw: [command] }))` — tester-verified OK on
 * the real host — so that shape goes FIRST; the legacy call shapes stay as
 * fallbacks for other hosts and the test fakes (which only need *some*
 * call to return `{text}`).  Returns stdout text.
 *
 * `cwd` (fix batch T3): the workspace root the command is pinned to — the
 * platform-shell fallback inherits the HOST process cwd without it (the
 * user HOME on the desktop sidecar), so relative paths in commands
 * resolved outside the workspace.
 */
export async function runShellCommand($: unknown, command: string, cwd?: string): Promise<string> {
  if (typeof $ !== "function") {
    // Desktop sidecar reality (1.18.30 probed): the plugin runs in a
    // worker_threads worker on Electron's Node — neither input.$ nor Bun
    // globals exist there.  Go straight to the platform-shell spawn
    // (governance already classified the command before this call).  This is
    // ALSO the C3 path on those hosts: the spawn is the only executor, and it
    // pins `cwd`, so relative paths resolve to the workspace, never HOME.
    return spawnShellFallback(command, cwd)
  }
  let shell = $ as (...a: unknown[]) => unknown
  // T6/C3: the `$` call shapes below never carry a cwd, so on a host whose
  // `$` is a plain function (no `.cwd()` capability) a relative path resolved
  // against the HOST process cwd — the user HOME on the sidecar.  A Bun Shell
  // DOES expose `.cwd(dir)` (returns a dir-bound shell, still tagged-template
  // callable), so when BOTH a cwd is required and the host `$` can bind it,
  // bind first and run the bound shell.  When `$` has no `.cwd` (test fakes,
  // exotic hosts) we KEEP using it — the spawn would otherwise fire a real
  // shell where a working `$` bridge exists (and §6k pins that bridge path),
  // so the safe move is to honor `$` and let the caller's command be absolute.
  if (cwd) {
    const cwdCapable = $ as { cwd?: unknown }
    if (typeof cwdCapable.cwd === "function") {
      try {
        const bound = (cwdCapable.cwd as (dir: string) => unknown)(cwd)
        if (typeof bound === "function") shell = bound as (...a: unknown[]) => unknown
      } catch {
        /* binding failed — fall through to the unbound $ shapes */
      }
    }
  }
  let proc: unknown
  let lastErr: unknown
  for (const attempt of [
    () => shell(Object.assign([command], { raw: [command] })), // tagged-template desugar: $`command`
    () => shell([command]), // plain-array host variant
    () => shell(command), // plain-string host variant
  ]) {
    try {
      proc = attempt()
      // a call shape may return undefined WITHOUT throwing — keep trying the
      // next shape instead of breaking with lastErr still undefined
      if (proc != null) break
    } catch (err) {
      lastErr = err
    }
  }
  if (proc == null) {
    // a $ shape that THREW carries the real shell error (stderr/stdout) —
    // rethrow it so cleanShellError can extract the line; only a $ that is
    // absent entirely (or returned nothing) falls back to the platform shell
    if (lastErr != null) throw lastErr
    // Desktop sidecar reality (1.18.30 probed): the plugin runs in a
    // worker_threads worker on Electron's Node — neither input.$ nor Bun
    // globals exist there, so every $ shape fails.  Fall back to spawning
    // the platform shell directly (PowerShell on win32 / bash elsewhere).
    // Governance (P3 allowlist + R6) already classified the command BEFORE
    // this call — the fallback runs only cleared commands.
    return await spawnShellFallback(command, cwd)
  }
  const p = proc as { text?: () => unknown; stdout?: unknown }
  if (typeof p.text === "function") return String(await p.text())
  if (p.stdout !== undefined) return String(p.stdout)
  throw new Error("shell 结果不可读")
}

/** Strip ANSI + empty-line noise, cap length, best-effort line number. */
export function cleanShellError(err: unknown): { message: string; line?: number } {
  const e = err as { message?: unknown; stderr?: unknown; stdout?: unknown } | null
  const raw = [e?.stderr, e?.message, e?.stdout]
    .filter((v) => typeof v === "string" && (v as string).length > 0)
    .join("\n")
  let msg = String(raw || e?.message || String(err))
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, 6)
    .join("\n")
  if (msg.length > 400) msg = msg.slice(0, 400) + " …"
  const m = /(?:line|行)\s*[:#]?\s*(\d+)/i.exec(raw)
  return { message: msg || "shell 执行失败", line: m ? Number(m[1]) : undefined }
}

// ---------- platform-shell fallback (Desktop sidecar has no $ bridge) -----

/**
 * Spawn the platform shell directly.  `cwd` pins the command to the
 * workspace root (fix batch T3/C3): without it the child inherits the HOST
 * process cwd — the user HOME on the desktop sidecar — so every relative
 * path in a command resolved against the wrong directory.  A spawn failure
 * names the cwd explicitly; there is no silent fallback to another cwd.
 */
export async function spawnShellFallback(command: string, cwd?: string): Promise<string> {
  const { spawn } = await import("node:child_process")
  const isWin = process.platform === "win32"
  const exe = isWin ? "powershell.exe" : (process.env.SHELL || "bash")
  // UTF-8 (fix batch m4): Windows PowerShell 5.1 pipes output in the legacy
  // console codepage (GBK on zh-CN hosts), mojibake'ing CJK in results AND
  // error paths.  Force UTF-8 for the session before the payload runs.
  const payload = isWin
    ? "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + command
    : command
  const args = isWin
    ? ["-NoProfile", "-NonInteractive", "-Command", payload]
    : ["-c", command]
  const cwdNote = cwd ? `（工作目录 ${cwd}）` : ""
  return await new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        timeout: 60_000,
        ...(cwd ? { cwd } : {}),
      })
    } catch (e) {
      reject(new Error(`平台 shell 回退启动失败${cwdNote}：${(e as Error).message}`))
      return
    }
    let out = ""
    let err = ""
    child.stdout?.on("data", (d: Buffer) => { out += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { err += d.toString() })
    child.on("error", (e: Error) =>
      reject(new Error(`平台 shell 执行失败${cwdNote}：${e.message}`)),
    )
    child.on("close", (code) => {
      if (code === 0) resolve(out)
      else {
        const wrapped = new Error(err.trim() || `exit code ${code}`) as Error & {
          stderr?: string
          stdout?: string
        }
        wrapped.stderr = err
        wrapped.stdout = out
        reject(wrapped)
      }
    })
  })
}

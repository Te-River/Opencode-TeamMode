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
 */
export async function runShellCommand($: unknown, command: string): Promise<string> {
  if (typeof $ !== "function") {
    // Desktop sidecar reality (1.18.30 probed): the plugin runs in a
    // worker_threads worker on Electron's Node — neither input.$ nor Bun
    // globals exist there.  Go straight to the platform-shell spawn
    // (governance already classified the command before this call).
    return spawnShellFallback(command)
  }
  const shell = $ as (...a: unknown[]) => unknown
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
    return await spawnShellFallback(command)
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

async function spawnShellFallback(command: string): Promise<string> {
  const { spawn } = await import("node:child_process")
  const isWin = process.platform === "win32"
  const exe = isWin ? "powershell.exe" : (process.env.SHELL || "bash")
  const args = isWin
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command]
  return await new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(exe, args, { windowsHide: true, timeout: 60_000 })
    } catch (e) {
      reject(new Error(`平台 shell 回退启动失败：${(e as Error).message}`))
      return
    }
    let out = ""
    let err = ""
    child.stdout?.on("data", (d: Buffer) => { out += d.toString() })
    child.stderr?.on("data", (d: Buffer) => { err += d.toString() })
    child.on("error", (e: Error) => reject(e))
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

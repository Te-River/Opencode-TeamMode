/**
 * tm layer — the host `$` shell bridge + shell error hygiene.  Split out of
 * the former tools.ts hub; behavior unchanged.
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
    throw new Error("宿主 shell 桥（$）不可用")
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
    // rethrow the ORIGINAL error (Error or shell-error object) — wrapping it
    // through String() would destroy stderr/stdout before cleanShellError
    // can extract line numbers
    throw lastErr ?? new Error("shell 桥调用失败")
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

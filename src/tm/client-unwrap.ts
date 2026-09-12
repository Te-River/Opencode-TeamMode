/**
 * tm layer — client result unwrapping + best-effort text extraction.
 * Split out of the former tools.ts hub; behavior unchanged.
 */

export type Unwrapped = { ok: true; data: unknown } | { ok: false; message: string }

/**
 * Client result unwrapping — TWO live shapes + the legacy test shape:
 *   - 1.18.x REAL host (tester-probed): `{ data: <payload>, request, response }`
 *     with NO `ok` field — file.read data = {type:"text", content},
 *     find.text data = Match[].  Absent `ok` is NOT a failure; `data`
 *     presence decides success.
 *   - T0.4 legacy: `{ ok: true, data }` (what the fake clients in tests emit).
 * RequestResult hygiene: ok === true can STILL carry the error envelope
 * {error: {name, data: {message, ref}}} — self-check `data.error`.  A
 * top-level error / ok===false fails even when a data payload rides along.
 */
export function unwrapClientResult(res: unknown): Unwrapped {
  if (!res || typeof res !== "object") {
    return { ok: false, message: "客户端返回为空或格式异常" }
  }
  const r = res as { ok?: unknown; data?: unknown; error?: unknown }
  if (r.ok === false || r.error != null) {
    const e = r.error as
      | { message?: unknown; name?: unknown; data?: { message?: unknown } }
      | null
      | undefined
    const msg = e?.message ?? e?.data?.message ?? e?.name
    return { ok: false, message: msg ? String(msg) : `客户端返回 ok=${String(r.ok)}` }
  }
  if ("data" in r) {
    const data = r.data
    if (data && typeof data === "object") {
      const errVal = (data as Record<string, unknown>).error
      if (errVal != null) {
        if (typeof errVal === "string") return { ok: false, message: errVal }
        const envelope = errVal as { name?: unknown; data?: { message?: unknown } }
        const msg = envelope?.data?.message ?? envelope?.name ?? "unknown client error envelope"
        return { ok: false, message: String(msg) }
      }
    }
    return { ok: true, data }
  }
  if (r.ok === true) return { ok: true, data: undefined }
  return { ok: false, message: "客户端返回格式异常（缺少 data 字段）" }
}

/**
 * One client.find.text match object -> ripgrep-style `path:line: text` lines.
 * Key table (live-probed shape; tester re-verifies each key against real
 * host data):
 *   path  — file path of the hit (aliases: file, file_path, filePath)
 *   lines — matched lines, string[] (aliases: text, content, match, line_text,
 *           line-as-string)
 *   line  — 1-based line number (aliases: line_number, lineNumber; must be
 *           numeric — a textual `line` value falls through to the text keys)
 * Returns null when neither a path nor any hit text is found.
 */
export function matchObjectText(m: Record<string, unknown>): string | null {
  const p = [m.path, m.file, m.file_path, m.filePath].find(
    (v) => typeof v === "string" && (v as string).length > 0,
  ) as string | undefined
  let texts: string[] = []
  for (const key of ["lines", "text", "content", "match", "line_text", "line"]) {
    const v = m[key]
    if (Array.isArray(v)) {
      texts = v.filter((x): x is string => typeof x === "string")
      if (texts.length > 0) break
    } else if (typeof v === "string" && v.length > 0) {
      texts = [v]
      break
    }
  }
  const numKeys = ["line_number", "lineNumber", "line"]
    .map((k) => Number(m[k]))
    .find((n) => Number.isInteger(n) && Number.isFinite(n))
  if (!p && texts.length === 0) return null
  const prefix = p ? (typeof numKeys === "number" ? `${p}:${numKeys}` : p) : ""
  if (texts.length === 0) return prefix
  return texts.map((t) => (prefix ? `${prefix}: ${t}` : t)).join("\n")
}

/** Best-effort text extraction from verified client payloads. */
export function extractText(data: unknown): string {
  if (typeof data === "string") return data
  if (data == null) return ""
  if (Array.isArray(data)) {
    // find.text real-host shape: an array of match objects.  Render each as
    // `path:line: text` so path/line/hit structure survives into previews
    // (the log branch lifts file:line retrieval clues) and aggregation.
    if (data.length > 0 && data.every((x) => x !== null && typeof x === "object" && !Array.isArray(x))) {
      const rendered = data.map((x) => matchObjectText(x as Record<string, unknown>))
      if (rendered.some((s) => s !== null)) {
        return rendered.filter((s): s is string => s !== null).join("\n")
      }
      // Key-table mismatch — fall back to JSON so nothing is silently dropped.
    } else {
      return data.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n")
    }
  }
  const o = data as Record<string, unknown>
  for (const key of ["content", "text", "output", "stdout"]) {
    if (typeof o[key] === "string") return o[key] as string
  }
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}

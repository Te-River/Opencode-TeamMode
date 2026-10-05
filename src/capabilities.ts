/**
 * Host-capability matrix — the "fail loud, not silent" seam (2026-09-19).
 *
 * This file holds the SHARED row contract and the markdown renderer.  The v1
 * probe that used to live here (a static SEAMS list classified by watching
 * hooks fire and events arrive) was removed in 1.7.0 with the rest of v1
 * support; the v2 rows are built from what THIS session observed in
 * `src/host/v2-capabilities.ts`, because a 2.x host is moving under us and a
 * row that says "declared" because a type file mentions a name is worth
 * nothing when the host never calls it.
 *
 * Row states (the vocabulary both sides share):
 *   - `missing`   — the surface is gone; the named feature is off.
 *   - `declared`  — the surface exists but nothing has exercised it yet.
 *   - `ok`        — observed working in this process (a hook fired, an event
 *                   arrived, an ask bridge was handed to a tool).
 *   - `not-seen`  — the host has not called/fired it since startup; the
 *                   feature is armed and waiting (NOT evidence of a break).
 *   - `unverified`— we emit the contract; only a human can see the result
 *                   (the `attachments` screenshot — the host either paints it
 *                   or ignores it, and we cannot observe which).
 *
 * `tm_stats` renders the live matrix; nothing here ever throws and nothing
 * probes the network.
 */

/** How each row was decided — kept as data so a test can pin the reasoning. */
export type CapState = "ok" | "declared" | "missing" | "not-seen" | "unverified"

export type CapEvidence = "static" | "hook" | "event" | "runtime" | "human"

export interface CapabilityRow {
  /** The host surface, spelled the way the user reads it in a toast. */
  seam: string
  /** What we lose if it is gone. */
  feature: string
  state: CapState
  evidence: CapEvidence
  note?: string
}

/** Markdown table for tm_stats — the shape the host renders fastest. */
export function renderCapabilityMatrix(rows: readonly CapabilityRow[]): string {
  const badge = (s: CapState): string =>
    s === "ok" ? "✓ 已验证" : s === "declared" ? "◦ 存在未用" : s === "missing" ? "✗ 缺失" : s === "not-seen" ? "… 待观察" : "? 需人眼"
  const lines = ["| 宿主接口 | 影响的能力 | 状态 |", "|---|---|---|"]
  for (const r of rows) {
    lines.push(`| \`${r.seam}\` | ${r.feature} | ${badge(r.state)}${r.note ? ` — ${r.note}` : ""} |`)
  }
  return lines.join("\n")
}

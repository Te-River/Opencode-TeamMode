/**
 * Host-capability probe — the "fail loud, not silent" seam (2026-09-19).
 *
 * Everything this plugin does interesting leans on a host surface that is NOT
 * part of a stability promise: `ctx.ask`, the `permission.asked` event,
 * `client.session.create/promptAsync/children`, `client.pty.*`, `tui.showToast`,
 * and the handful of hooks the host agrees to call (`tool.definition`,
 * `chat.params`, `shell.env`, the compaction pair).  Each of our features
 * already degrades gracefully when one of those disappears — which is exactly
 * the problem: an OpenCode upgrade can quietly take `tm_pty` and every web
 * dialog out of the build, and the only symptom is the agent working around
 * something the user never agreed to lose.
 *
 * So the plugin records what it ACTUALLY sees and says it out loud once:
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
 * `tm_stats` renders the live matrix; a missing REQUIRED surface also raises
 * one toast at startup, so a host upgrade is reported instead of discovered
 * mid-task.  Nothing here ever throws and nothing probes the network.
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

interface SeamSpec {
  seam: string
  feature: string
  evidence: CapEvidence
  /** Static: which client path must exist (dot-separated). Absent => the row
   *  starts `missing`; present => `declared`. */
  path?: string
  /** Dynamic: the observed name(s) that flip declared/not-seen -> ok. */
  observed?: string[]
  /** Losing this one is worth a toast (the plugin's advertised surface breaks). */
  required?: boolean
  note?: string
  /** Fixed state for surfaces no plugin-side observation can settle. */
  state?: CapState
}

const SEAMS: SeamSpec[] = [
  {
    seam: "ToolContext.ask",
    feature: "out-of-allowlist web fetch/search/browser + every tm_pty start",
    evidence: "runtime",
    observed: ["ask-bridge"],
    required: true,
    note: "first observed by whichever tm_* tool runs",
  },
  { seam: "client.session.create+promptAsync", feature: "tm_dispatch (non-blocking lead)", evidence: "static", path: "session.promptAsync", required: true },
  { seam: "client.session.children", feature: "tm_join recovery after a restart", evidence: "static", path: "session.children" },
  { seam: "client.session.status", feature: "tm_join bounded wait", evidence: "static", path: "session.status" },
  { seam: "client.session.abort", feature: "tm_join cancel:true", evidence: "static", path: "session.abort" },
  { seam: "client.pty.create", feature: "tm_pty (non-blocking commands)", evidence: "static", path: "pty.create", required: true },
  { seam: "client.permission.reply", feature: "the approval gate's auto-reject timer", evidence: "static", path: "permission.reply", required: true },
  { seam: "tui.showToast", feature: "a toast when a dialog is waiting", evidence: "static", path: "tui.showToast" },
  { seam: "input.$ (shell bridge)", feature: "tm_bash via the host shell (else spawn fallback)", evidence: "static", path: "$" },
  {
    seam: "event permission.asked",
    feature: "R6/R2 dialog observation + the unanswered-ask timer",
    evidence: "event",
    observed: ["permission.asked"],
    note: "only arrives once something asks — absence so far is not a break",
  },
  { seam: "hook tool.execute.before", feature: "bash timeout clamp + R6 deferral", evidence: "hook", observed: ["hook:tool.execute.before"], required: true },
  { seam: "hook tool.definition", feature: "TM_TOOL_HINTS on built-in bash/task", evidence: "hook", observed: ["hook:tool.definition"] },
  { seam: "hook chat.params", feature: "TM_AGENT_TEMPERATURE", evidence: "hook", observed: ["hook:chat.params"] },
  { seam: "hook shell.env", feature: "NO_COLOR / TM_SHELL_ENV passthrough", evidence: "hook", observed: ["hook:shell.env"] },
  { seam: "hook experimental.session.compacting", feature: "the must-survive compaction context", evidence: "hook", observed: ["hook:session.compacting"] },
  {
    seam: "ToolResult.attachments",
    feature: "tm_browser take_screenshot { image:true }",
    evidence: "human",
    state: "unverified",
    note: "we emit the official shape; whether the desktop paints it is only visible to you",
  },
]

/** Read a dot path off the live client without assuming any of it exists. */
function pathPresent(client: unknown, dotted: string): boolean {
  if (dotted === "$") return false // resolved by the caller — not a client path
  let cur: unknown = client
  for (const seg of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return false
    cur = (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === "function"
}

export interface CapabilityProbe {
  observeAskBridge(present: boolean): void
  observeEvent(type: string): void
  observeHook(name: string): void
  /** Live matrix for tm_stats. */
  snapshot(): CapabilityRow[]
  /** Rows the plugin considers load-bearing and did NOT find. */
  missingRequired(): CapabilityRow[]
  /** One trajectory line + (when something required is gone) one toast. */
  report(): { rows: CapabilityRow[]; missing: string[] }
}

export function createCapabilityProbe(deps: {
  client: unknown
  /** `input.$` — the host shell bridge, handed outside the client object. */
  hasShellBridge?: boolean
  /** Already-resolved R6 reply capability (index.ts owns that decision). */
  hasPermissionReply?: boolean
  trajectory?: (event: Record<string, unknown>) => void
  notify?: (message: string) => void
}): CapabilityProbe {
  const ok = new Set<string>()
  if (deps.hasShellBridge) ok.add("$")
  if (deps.hasPermissionReply) ok.add("permission.reply")

  const presentOf = (spec: SeamSpec): boolean | null => {
    if (!spec.path) return null
    if (spec.path === "$") return !!deps.hasShellBridge
    if (spec.path === "permission.reply") return !!deps.hasPermissionReply
    return pathPresent(deps.client, spec.path)
  }

  const rowFor = (spec: SeamSpec): CapabilityRow => {
    const observed = (spec.observed ?? []).some((name) => ok.has(name))
    const present = presentOf(spec)
    const row: CapabilityRow = { seam: spec.seam, feature: spec.feature, evidence: spec.evidence, state: "not-seen" }
    if (spec.state === "unverified") row.state = "unverified"
    else if (observed) row.state = "ok"
    else if (present === false) row.state = "missing"
    else if (spec.evidence === "static") row.state = "declared"
    else row.state = "not-seen"
    if (spec.note) row.note = spec.note
    return row
  }

  let reported = false

  const report = (): { rows: CapabilityRow[]; missing: string[] } => {
    const rows = SEAMS.map(rowFor)
    const missing = rows.filter((r) => r.state === "missing").map((r) => r.seam)
    if (reported) return { rows, missing }
    reported = true
    try {
      deps.trajectory?.({ tool: "capabilities", step_id: "boot", event: "probe", rows: rows.map((r) => `${r.seam}=${r.state}`) })
    } catch {
      /* observability only */
    }
    const required = SEAMS.filter((s, i) => s.required && rows[i].state === "missing").map((s) => s.feature)
    if (required.length) {
      try {
        deps.notify?.(
          `检测到宿主接口缺失，本进程已降级：${required.join("；")}。` +
            `（OpenCode 升级后常见。用 tm_stats 看完整能力矩阵。）`,
        )
      } catch {
        /* notification is best-effort */
      }
    }
    return { rows, missing }
  }

  return {
    observeAskBridge(present: boolean) {
      if (present) ok.add("ask-bridge")
    },
    observeEvent(type: string) {
      const t = String(type ?? "")
      if (t === "permission.asked" || t === "permission.updated") ok.add("permission.asked")
    },
    observeHook(name: string) {
      const n = String(name ?? "")
      if (n) ok.add(`hook:${n}`)
    },
    snapshot: () => SEAMS.map(rowFor),
    missingRequired: () =>
      SEAMS.map(rowFor).filter((r, i) => SEAMS[i].required && r.state === "missing"),
    report,
  }
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

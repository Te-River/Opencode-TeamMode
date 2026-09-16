/**
 * Unified approval gate — Layer 2 (timeout auto-reject) + Layer 3 (SDK
 * fallback) of the R6 + R2 approval flow.
 *
 * The host only shows its official confirmation dialog for command patterns
 * declared `ask` in an agent's permission config (Layer 1, envprotect.ts).
 * When a dialog opens it SUSPENDS the tool call and waits for a human; on the
 * OpenCode DESKTOP that human is present, but a request can also be left
 * unanswered.  This module owns ONE timer that watches the host permission
 * events and closes abandoned requests on the safe side.
 *
 * REAL host contract (1.18.29, probed live via SSE + the plugin event hook —
 * see gate-test report-p5):
 *   permission.asked   → properties = { id, sessionID, permission: "bash",
 *                        patterns: [<concrete command segment>, …], metadata:
 *                        { command }, always: [<host's "always" generalization
 *                        proposal>], tool: { messageID, callID } } — the props
 *                        carry NO `type` field, and the tool name sits in
 *                        `permission`.  A props matching one of OUR injected
 *                        bash ask sets means the dialog is ours: audit "ask",
 *                        arm the timeout, and — for the R6 env face — mark
 *                        the session deferrable (canDefer, see below).
 *   permission.replied → properties = { sessionID, requestID, reply } on the
 *                        wire, but the plugin-side observer has also seen it
 *                        with ONLY { sessionID }.  The gate therefore cancels
 *                        EVERY pending timer of that session on a reply: an
 *                        already-approved command left on a live timer would
 *                        get a second reject after the timeout, the SDK call
 *                        would hit a dead id (4xx) and flip the gate
 *                        permanently degraded.
 *
 * Older/typed spellings (`permission.updated`, `pattern`, `permissionID`,
 * `response`) keep being accepted — the shipped SDK d.ts still names the
 * events that way, and some builds omit the reply id entirely (a short
 * ghost-suppression window per session then absorbs late/duplicate `asked`
 * replays instead of re-arming a ghost timer).
 *
 * Hard rules (HUMAN-approved):
 *   - the plugin NEVER self-allows: `reply` is fixed to "reject".  The only
 *     way a gated command runs is a human approving the dialog;
 *   - on `TM_ENV_PROTECT=off` the gate is not armed (index.ts decides);
 *   - deferral is SESSION-SCOPED (canDefer): only sessions registered as
 *     carrying our injected ask set may have env reads passed through —
 *     registration comes from an exec-role user prompt (the live-proven
 *     `message.updated` UserMessage{role,agent,sessionID} signal, plus the
 *     documented `chat.message` hook) or from an R6-env-classified asked
 *     event.  Stock build/plan sessions never register, so the global R6
 *     hook keeps hard-throwing there — closing the R6 bypass the global
 *     `isArmed()` deferral allowed;
 *   - if the SDK reply FAILS (network/host — including the v1
 *     `throwOnError:false` envelope resolving with `{ error }`), we cannot
 *     close the dialog, so the gate flips itself permanently "degraded" —
 *     the R6 hook stops deferring env reads and hard-throws them again
 *     (fail-closed), and the event is audited "degraded".
 *
 * SDK surface (probed live on 1.18.x): the plugin's `input.client` is the v1
 * `OpencodeClient`, which has NO `permission` namespace and NO list/create
 * endpoint; the reply path is the top-level
 * `postSessionIdPermissionsPermissionId({ path: { id: sessionID,
 * permissionID }, body: { response } })`.  `client.permission.reply` /
 * `client.permission.list` are still tried first so a richer host build is
 * supported, but on v1 they are simply absent and the poll fallback is a
 * no-op (events are the sole pending signal there).
 */

import type { PermissionEvent } from "./types.js"
import { ENV_PROTECT_SERVICE, categorizePermission } from "./envprotect.js"
import { resolveTmConfig } from "./tm/config.js"

/** Default timeout, in minutes, before an unanswered dialog is auto-rejected.
 *  1 min (user directive) — an unanswered dialog no longer hangs for 10.
 *  A short timer is safe because a reject that lands on an already-closed
 *  request is benign; see `MIN_ASK_TIMEOUT_MIN` for the full rationale. */
export const DEFAULT_ASK_TIMEOUT_MIN = 1

/**
 * Hard floor (minutes) for the auto-reject timeout.  The HISTORIC 3-min
 * floor existed to dodge the measured ~120s `permission.replied` bus lag:
 * a shorter timer would fire before the cancel arrives and auto-reject a
 * just-approved request.  That lag, though, is the HOST DELIVERING the
 * replied event to the plugin over the bus — NOT the host resolving the
 * user's click: an approval takes effect instantly host-side, so the
 * plugin's late reject simply targets an already-closed request id → 404.
 * T2's `classifyReplyFailure` maps that outcome to the benign
 * `already-closed` verdict (it never flips the gate to `degraded`, and the
 * approved command runs either way); `onReplied` records a reply landing
 * after the auto-reject as `late-<verdict>` for observability.  With that
 * classification in place a short timeout no longer disables the gate, so
 * the floor drops to 1 minute (user directive).  Trade-off: an UNANSWERED
 * dialog auto-rejects after 1 min — a user who stepped away re-triggers
 * the command.  In-range values below the floor still clamp UP to it.
 *
 * This is the FALLBACK default of the floor.  The live floor comes from the
 * P0 config knob `TM_ASK_TIMEOUT_FLOOR_MIN`
 * (`resolveTmConfig().askTimeoutFloorMin`, itself defaulted to 1).
 */
export const MIN_ASK_TIMEOUT_MIN = 1

/** Poll cadence (ms) that re-scans pending permissions in case an event was
 *  missed — only meaningful when the client exposes a list capability. */
const POLL_INTERVAL_MS = 60 * 1000

/** Suppression window (ms) for late/duplicate `permission.asked` replays
 *  after a `permission.replied` that carried NO permission id.  Ghost timers
 *  are the degraded-flip poison (dead id → 4xx → permanent degraded); the
 *  window only sacrifices the timeout for brand-new asks of the same session
 *  for this short period, never a self-allow. */
const GHOST_ASK_WINDOW_MS = 60 * 1000

/** Cap on the closed-permission-id tombstone LRU (ids are unique, so it is
 *  purely an anti-ghost cache + late-verdict provenance store — pruning the
 *  oldest is sufficient). */
const MAX_TOMBSTONES = 500

/** The verdict vocabulary recorded in the audit trail (privacy: no command
 *  text, path, variable name or value is ever logged).  `already-closed` /
 *  `rejected-shape-bug` split the old blanket `degraded` on a failed reply by
 *  `classifyReplyFailure`; a late reply past the auto-reject is recorded as a
 *  dynamic `late-<verdict>` string (observability only — never re-runs or
 *  revives the command). */
export type ApprovalVerdict =
  | "ask"
  | "allowed-once"
  | "allowed-always"
  | "rejected"
  | "timeout-rejected"
  | "already-closed"
  | "rejected-shape-bug"
  | "degraded"

/**
 * Resolve `TM_ASK_TIMEOUT_MIN`.  Unset / blank / non-numeric / <1 / >1440
 * (24h) fall back to the 1-minute default — a mistyped value can never
 * disable the timeout or make it absurdly long.  Valid values below the
 * floor clamp UP to it — the floor is the P0 config knob
 * `TM_ASK_TIMEOUT_FLOOR_MIN` (`resolveTmConfig().askTimeoutFloorMin`,
 * default 1).  The historic ~120s bus-lag reason for a 3-min floor is
 * obsolete: a late reject on an already-closed id is benign
 * `already-closed`, not a degraded flip (see `MIN_ASK_TIMEOUT_MIN`).
 */
export function resolveAskTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TM_ASK_TIMEOUT_MIN
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_ASK_TIMEOUT_MIN * 60 * 1000
  const n = Number(raw.trim())
  if (!Number.isFinite(n)) return DEFAULT_ASK_TIMEOUT_MIN * 60 * 1000
  const min = Math.trunc(n)
  if (min < 1 || min > 1440) return DEFAULT_ASK_TIMEOUT_MIN * 60 * 1000
  // Floor read from the config knob (bounded to [1,1440] by envInt) so a
  // stricter posture can raise it WITHOUT a source change; default is 1.
  const floorMin = resolveTmConfig(env).askTimeoutFloorMin
  return Math.max(min, floorMin) * 60 * 1000
}

type TimerHandle = unknown

export interface GateTimers {
  setTimeoutFn: (cb: () => void, ms: number) => TimerHandle
  clearTimeoutFn: (handle: TimerHandle) => void
}

export interface ApprovalGateDeps {
  client: unknown
  timeoutMs: number
  /** Injectable timers (default: real global timers) for deterministic tests. */
  timers?: GateTimers
  /** Injectable clock (default: Date.now) for deterministic window tests. */
  now?: () => number
  /** Best-effort attention hook — fired on EVERY permission.asked (all
   *  dialogs: bash R2/R6 asks AND the tm_* ctx.ask web dialogs) so a user
   *  not staring at the screen learns a confirmation is waiting.  index.ts
   *  wires this to the host's `tui.showToast`.  Never throws into the gate. */
  notify?: (message: string) => void
}

export interface ApprovalGate {
  /** Handle one host event (permission.asked/updated / permission.replied). */
  handleEvent(event: PermissionEvent): void
  /** Start the poll fallback (no-op on v1 where no list endpoint exists). */
  start(): void
  /** Stop the poll + every pending timer. */
  dispose(): void
  /** Global gate health: armed, not degraded, and the client can reply. */
  isArmed(): boolean
  /**
   * The R6 hook's deferral query: TRUE only when this exact session is
   * registered as carrying our injected ask set AND the gate is healthy.
   * Replaces the old global `isArmed()` deferral (which let stock build/plan
   * sessions pass env reads silently with no dialog in front of them).
   */
  canDefer(sessionID?: string): boolean
  /** True once a session registered (exec-role prompt seen on
   *  message.updated / chat.message by index.ts, or an R6-env-classified
   *  asked event).  Introspection for tests/diagnostics. */
  hasLiveAsk(sessionID?: string): boolean
  /** Mark a session as carrying the injected ask set (index.ts calls this
   *  when a user prompt routes to an agent we injected the escalated bash
   *  ask object into — proven live: `message.updated` UserMessage carries
   *  { sessionID, role:"user", agent } and fires BEFORE the session's first
   *  tool call, while permission.asked fires AFTER tool.execute.before). */
  registerExecSession(sessionID?: string): void
  /**
   * Drop a session's exec-role registration (index.ts calls this when a user
   * prompt routes to an agent that does NOT carry our injected ask set).
   * The verified host passes {tool, sessionID, callID} with NO agent to
   * tool.execute.before (desktop binary: `plugin.trigger("tool.execute.before",
   * { tool, sessionID, callID }, { args })`), so the per-turn agent signal
   * can only come from message.updated/chat.message.  Without revocation a
   * session that once ran a team prompt stayed deferrable forever — even
   * after the user switched the picker to a stock agent whose dialogs would
   * never fire, silently passing env reads (canDefer true + no dialog).
   * A later env-classified permission.asked re-registers on real dialog
   * evidence, and the next exec-role prompt re-registers again — both paths
   * re-arm from fresh evidence, so revocation only ever closes a stale
   * window (fail-closed direction).
   */
  revokeExecSession(sessionID?: string): void
  /** True after the user picked "always" on an env-related ask in this session
   *  — subsequent env reads pass silently (the approval event itself is audited). */
  isEnvApproved(sessionID?: string): boolean
  /** Number of pending requests currently being timed (tests / introspection). */
  pendingSize(): number
}

/** Best-effort structured audit; a failing log endpoint never breaks the gate. */
function auditAsk(client: unknown, tool: string, category: string, verdict: string): void {
  try {
    // `app.log({...})` is a METHOD call on `app` — casting the fetched
    // function and invoking it plain (`(app.log as Fn)({...})`) drops the
    // SDK `this` exactly like the historic R6 audit bug did, silently
    // killing every gate audit line (pinned by the this-bound §7 mocks).
    const app = (client as { app?: { log?: (req: unknown) => unknown } } | null | undefined)?.app
    if (!app || typeof app.log !== "function") return
    void app.log({
      body: {
        level: "warn",
        service: ENV_PROTECT_SERVICE,
        message: `${ENV_PROTECT_SERVICE} :: ${tool} :: ${category} :: ${verdict}`,
      },
    })
  } catch {
    /* audit is best-effort */
  }
}

/**
 * v1 SDK default is `throwOnError:false` (types/sdk.gen contract): an HTTP
 * failure — e.g. a 4xx on an already-closed permission id — RESOLVES with an
 * `{ error }` envelope instead of rejecting.  Unwrapping it into a throw is
 * what makes the Layer-3 degraded flip actually fire on the real host.
 */
function unwrapSdkEnvelope(res: unknown): unknown {
  if (res && typeof res === "object" && "error" in res) {
    const err = (res as { error?: unknown }).error
    if (err) {
      // Carry the HTTP status ONTO the thrown error.  On the real v1 host the
      // status sits at `res.response.status` (NOT on the error body), and
      // `classifyReplyFailure` needs it to tell a benign 404 (dialog already
      // closed — the D4 late-reply race) from a shape-bug 400 / a transport
      // failure.  Falls back to an error-body status, then undefined.
      const status =
        (res as { response?: { status?: unknown } }).response?.status ??
        (err as { status?: unknown }).status
      throw Object.assign(err as object, { status })
    }
  }
  return res
}

/**
 * Non-privacy diagnostic appended to a `degraded` audit verdict: the error
 * CLASS name and host status code only — never message text, request params
 * or paths (privacy red line).  Handles both thrown Errors and v1 envelope
 * bodies (`{ error: { name, status | status_code } }`); the name passes an
 * identifier whitelist so hostile/echoed text can never ride into the log.
 */
function errorDiagnostic(err: unknown): string {
  const e = err as {
    name?: unknown
    status?: unknown
    statusCode?: unknown
    status_code?: unknown
  } | null | undefined
  const name =
    typeof e?.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(e.name)
      ? e.name
      : "Error"
  const rawStatus = [e?.status, e?.statusCode, e?.status_code].find(
    (v) => typeof v === "number" && Number.isFinite(v),
  )
  return ` err=${name}${rawStatus !== undefined ? ` status=${rawStatus}` : ""}`
}

/** How a FAILED permission-reply call should be treated by the gate. */
export type ReplyFailureClass = "benign-closed" | "param-shape" | "transport"

/**
 * Classify a reply-call failure so the gate no longer flips permanently
 * `degraded` on a harmless close.  `unwrapSdkEnvelope` has already hoisted the
 * HTTP status onto the thrown envelope error; a genuine `Promise.reject`
 * arrives as a plain Error with no status.
 *   - `benign-closed`: 404, or a NotFound/PermissionNotFound name/_tag — the
 *     dialog was ALREADY closed on the host (the D4 late-reply race): our
 *     reject was a no-op, so the popup path stays trustworthy.
 *   - `param-shape`: 400, or a BadRequest/InvalidRequest name/_tag — our
 *     reply body/params are wrong for this host: a real integration bug.
 *   - `transport`: everything else — a genuine Error, a 5xx, or an empty /
 *     status-less body — we could not reach or close the dialog.
 * Reads only the error CLASS + status number (privacy: never message text).
 */
export function classifyReplyFailure(err: unknown): ReplyFailureClass {
  const e = err as {
    status?: unknown
    statusCode?: unknown
    status_code?: unknown
    name?: unknown
    _tag?: unknown
  } | null | undefined
  const rawStatus = [e?.status, e?.statusCode, e?.status_code].find(
    (v) => typeof v === "number" && Number.isFinite(v),
  )
  const tag =
    `${typeof e?.name === "string" ? e.name : ""} ${typeof e?._tag === "string" ? e._tag : ""}`.trim()
  if (rawStatus === 404 || /NotFound|PermissionNotFound/.test(tag)) return "benign-closed"
  if (rawStatus === 400 || /BadRequest|InvalidRequest/.test(tag)) return "param-shape"
  return "transport"
}

/** A recognized human reply word -> its audit verdict; null for anything the
 *  out-of-vocabulary path keeps silent about (used by the LATE-verdict audit
 *  so an unknown late word can never fabricate a verdict or a `late-degraded`). */
function lateVerdictWord(
  lower: string,
): "rejected" | "allowed-always" | "allowed-once" | null {
  if (lower === "reject") return "rejected"
  if (lower === "always") return "allowed-always"
  if (lower === "once") return "allowed-once"
  return null
}

/**
 * Build the reject closure.  CRITICAL: every SDK endpoint is invoked as a
 * METHOD (`perm.reply({...})` / `c.post...({...})` — property-access call
 * sites keep the receiver binding).  Fetching the function first
 * (`const post = c.post...` then `await post({...})`) drops the SDK `this`,
 * so EVERY outbound reply died synchronously on the real host — the timer
 * fired at ask+timeout yet the dialog stayed open and the gate flipped
 * `degraded` (same regression class as the historic app.log audit bug; the
 * §7 test mocks now require the binding so it can never come back).
 */
function replyCapableFn(client: unknown): ((sid: string, pid: string) => Promise<unknown>) | null {
  const c = client as {
    permission?: { reply?: (opts: unknown) => unknown }
    postSessionIdPermissionsPermissionId?: (opts: unknown) => unknown
  } | null | undefined
  if (!c) return null
  const perm = c.permission
  if (perm && typeof perm.reply === "function") {
    return async (sid, pid) => {
      // richest host first (permission.reply), reject-only, both param shapes
      return unwrapSdkEnvelope(
        // `!` + property-access call site: binding survives, compiler stays happy
        await perm.reply!({ path: { sessionID: sid, id: pid }, body: { response: "reject" } }),
      )
    }
  }
  if (typeof c.postSessionIdPermissionsPermissionId === "function") {
    return async (sid, pid) =>
      unwrapSdkEnvelope(
        await c.postSessionIdPermissionsPermissionId!({
          path: { id: sid, permissionID: pid },
          body: { response: "reject" },
        }),
      )
  }
  return null
}

function listCapableFn(client: unknown): (() => Promise<unknown>) | null {
  const c = client as { permission?: { list?: (opts?: unknown) => unknown } } | null | undefined
  const perm = c?.permission
  if (perm && typeof perm.list === "function") {
    // method call on `perm` — `this` must survive (see replyCapableFn note)
    return async () => await perm.list!({})
  }
  return null
}

/** True when the client exposes a permission-reply path at all.  index.ts
 *  arms the gate ONLY for such a client — fail-closed otherwise (no armed
 *  auto-reject ⇒ the R6 hook keeps hard-throwing every env read). */
export function hasPermissionReplyCapability(client: unknown): boolean {
  return replyCapableFn(client) !== null
}

interface PendingEntry {
  sid: string
  cat: "env" | "danger"
  timer: TimerHandle
}

/** A closed permission id's provenance, held in the `closed` LRU so a LATE
 *  `permission.replied` (arriving past the auto-reject) can be audited with
 *  its real category.  { sid, cat, at } only — never command text/path/value. */
interface ClosedEntry {
  sid: string
  cat: "env" | "danger"
  at: number
}

/** First string-ish value among the host's several id/response spellings. */
function str(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v.trim()
  }
  return undefined
}

/**
 * Create the approval gate.  It is intentionally pure about timing +
 * replying + session registration; the caller (index.ts) decides whether to
 * arm it (mode != off AND the client is reply-capable), feeds events in, and
 * wires `canDefer(sessionID)` into the R6 hook.
 */
export function createApprovalGate(deps: ApprovalGateDeps): ApprovalGate {
  const { client, timeoutMs } = deps
  const timers: GateTimers = deps.timers ?? {
    // unref() so a pending timeout never, on its own, keeps the host process
    // alive (same philosophy as the blackboard sweeper's unref'd interval)
    setTimeoutFn: (cb, ms) => {
      const t = setTimeout(cb, ms)
      if (typeof t?.unref === "function") t.unref()
      return t
    },
    clearTimeoutFn: (h) => clearTimeout(h as NodeJS.Timeout),
  }
  const nowMs: () => number = deps.now ?? (() => Date.now())
  const notify = deps.notify
  const reply = replyCapableFn(client)
  const list = listCapableFn(client)
  const pending = new Map<string, PendingEntry>()
  /** Sessions known to carry our injected ask set (deferral whitelist). */
  const liveAsk = new Set<string>()
  /** Permission ids already closed (replied / timed out): a late or
   *  duplicated `asked` replay for one must never re-arm a ghost timer.
   *  Upgraded from a bare Set to a small LRU map — R1#8 — so a LATE
   *  `permission.replied` (the human's decision reaching the plugin AFTER the
   *  timer already auto-rejected) can be audited with its real category.
   *  Bounded at MAX_TOMBSTONES with the oldest evicted. */
  const closed = new Map<string, ClosedEntry>()
  /** Sessions whose reply carried NO permission id → suppress fresh asks of
   *  that session briefly (map sid → expiry ms). */
  const repliedNoId = new Map<string, number>()
  /** Sessions blanket-approved for env reads ("always" on an env ask). */
  const envApprovedSessions = new Set<string>()
  let armed = true
  let degraded = false
  let pollHandle: TimerHandle = null

  function remove(id: string): PendingEntry | undefined {
    const rec = pending.get(id)
    if (rec) {
      timers.clearTimeoutFn(rec.timer)
      pending.delete(id)
    }
    return rec
  }

  function tombstone(id: string, sid?: string, cat?: "env" | "danger"): void {
    // LRU touch: delete+set moves the id to the newest end.  Re-inserting a
    // known id preserves its recorded cat/sid when THIS call omits them, so a
    // late/duplicate reply never overwrites the real category a prior close
    // (fireReject / first reply) recorded.
    const prev = closed.get(id)
    closed.delete(id)
    closed.set(id, {
      sid: sid ?? prev?.sid ?? "",
      cat: cat ?? prev?.cat ?? "danger",
      at: nowMs(),
    })
    while (closed.size > MAX_TOMBSTONES) {
      const oldest = closed.keys().next().value as string | undefined
      if (oldest === undefined) break
      closed.delete(oldest)
    }
  }

  /** True while sid is inside the no-id-reply ghost window. */
  function ghostSuppressed(sid: string): boolean {
    const expiry = repliedNoId.get(sid)
    if (expiry === undefined) return false
    if (expiry <= nowMs()) {
      repliedNoId.delete(sid)
      return false
    }
    return true
  }

  async function fireReject(id: string, cat: "env" | "danger"): Promise<void> {
    const rec = pending.get(id)
    if (!rec) return
    pending.delete(id)
    tombstone(id, rec.sid, rec.cat)
    let ok = false
    let errDiag = ""
    let failClass: ReplyFailureClass | null = null
    try {
      if (reply) {
        // unwrapSdkEnvelope inside `reply` turns the v1 {error} envelope into a
        // throw (carrying the hoisted HTTP status); a rejecting transport
        // lands in the same catch.
        await reply(rec.sid, id)
        ok = true
      }
    } catch (err) {
      ok = false
      failClass = classifyReplyFailure(err)
      errDiag = errorDiagnostic(err)
    }
    // Classify a failed reply instead of a blanket degraded flip:
    //   benign-closed (404 / NotFound) — the dialog was ALREADY closed on the
    //     host (the D4 late-reply race): our reject was a harmless no-op, NOT
    //     an integration fault, so the popup path stays trustworthy.  Do NOT
    //     flip degraded — one dead-id reject must never poison the whole gate.
    //   param-shape (400 / BadRequest) — our reply shape is wrong for this
    //     host: a real bug, fail closed.
    //   transport (a real Error / 5xx / status-less body) — we could not reach
    //     or close the dialog: fail closed (the historic behaviour).
    if (!ok && failClass !== "benign-closed") {
      // Layer 3 fallback: stop trusting the popup path; the hook reverts to
      // hard-throwing env reads.
      degraded = true
    }
    const verdict = ok
      ? "timeout-rejected"
      : failClass === "benign-closed"
        ? "already-closed"
        : failClass === "param-shape"
          ? "rejected-shape-bug"
          : "degraded"
    // every failure verdict carries the non-privacy error class/status tail
    // (see errorDiagnostic) so a live-host failure is diagnosable from the log
    auditAsk(client, "bash", cat, verdict + errDiag)
  }

  function arm(id: string, sid: string, cat: "env" | "danger"): void {
    if (pending.has(id)) return
    const timer = timers.setTimeoutFn(() => void fireReject(id, cat), timeoutMs)
    pending.set(id, { sid, cat, timer })
  }

  /** Single registration funnel for both event and poll discovery. */
  function registerAsk(
    id: string | undefined,
    sid: string | undefined,
    cat: "env" | "danger",
  ): void {
    if (!id || !sid) return
    if (closed.has(id)) return // ghost replay of a closed request
    if (ghostSuppressed(sid)) return // replied-without-id; assume a replay
    if (pending.has(id)) return
    // The R6 ENV face is the deferral proof: only sessions whose dialogs
    // actually carry our injected env-ask patterns (or an exec-role
    // chat.message, see registerExecSession) may defer env reads.  Danger
    // faces never register — stock hosts that ask on `rm` by default must
    // not gain env deferral.
    if (cat === "env") liveAsk.add(sid)
    auditAsk(client, "bash", cat, "ask")
    arm(id, sid, cat)
  }

  async function pollOnce(): Promise<void> {
    if (!list || !armed) return
    try {
      const res = await list()
      const data = Array.isArray(res) ? res : (res as { data?: unknown })?.data
      if (Array.isArray(data)) {
        for (const item of data) {
          const props = (item as { properties?: unknown })?.properties ?? item
          const cat = categorizePermission(props as Parameters<typeof categorizePermission>[0])
          if (!cat) continue
          const p = props as { id?: string; permissionID?: string; requestID?: string; sessionID?: string }
          registerAsk(str(p.id, p.permissionID, p.requestID), str(p.sessionID), cat)
        }
      }
    } catch {
      /* poll is best-effort */
    }
  }

  function schedulePoll(): void {
    pollHandle = timers.setTimeoutFn(() => {
      void pollOnce().finally(() => {
        // dispose() during an in-flight poll must not re-arm a zombie chain
        if (armed) schedulePoll()
      })
    }, POLL_INTERVAL_MS)
  }

  /** Toasted request ids (cap-bounded) — duplicate `asked` replays for one
   *  dialog must not spam notifications. */
  const notified = new Set<string>()

  function onAsked(props: NonNullable<PermissionEvent["properties"]>): void {
    // attention hook FIRST, for EVERY dialog (not just our categorized asks):
    // the user asked to be notified wherever a confirmation window pops
    const id = str(props.id, props.permissionID, props.requestID)
    if (notify) {
      if (!id || !notified.has(id)) {
        if (id) {
          notified.add(id)
          if (notified.size > 256) {
            // keep the set bounded; ids are tombstoned on reply anyway
            const first = notified.values().next().value
            if (first !== undefined) notified.delete(first)
          }
        }
        try {
          const perm = String(props.permission ?? props.permissionID ?? "permission")
          const patterns = Array.isArray(props.patterns) ? props.patterns.map(String) : []
          const detail = patterns.length > 0 ? patterns[0] : perm
          notify(`等待你的批准：${detail}（${Math.round(timeoutMs / 60000)} 分钟无应答将自动拒绝）`)
        } catch {
          /* notification is best-effort — never break the gate */
        }
      }
    }
    if (degraded) return // auto-reject is broken — do not open new timers
    const cat = categorizePermission(props)
    if (!cat) return // not one of our injected bash asks → leave it to the human
    registerAsk(str(props.id, props.permissionID, props.requestID), str(props.sessionID), cat)
  }

  function onReplied(props: NonNullable<PermissionEvent["properties"]>): void {
    const sid = str(props.sessionID)
    const id = str(props.requestID, props.permissionID, props.id)
    const resp = str(props.reply, props.response)
    // Capture prior-closed state BEFORE this reply tombstones the id: the
    // late-verdict audit must fire only for a reply that arrives AFTER the id
    // was already closed (a timeout auto-reject / an earlier reply), not for
    // the first-ever reply we happen to be tombstoning right now.
    const wasClosed = id ? closed.has(id) : false
    const prec = id ? pending.get(id) : undefined
    if (id) tombstone(id, sid ?? prec?.sid, prec?.cat)
    // Real 1.18.29 replied props identify the request via `requestID` — and
    // the plugin-side observer has seen builds carrying ONLY { sessionID }.
    // Cancel EVERY pending timer of the session either way: an approved
    // command left timed would fire a reject on a dead id (4xx) and flip the
    // gate permanently degraded.
    const affected: Array<PendingEntry> = []
    let removed: PendingEntry | undefined
    if (id) {
      removed = remove(id)
      if (removed) affected.push(removed)
    }
    for (const [pid, rec] of [...pending]) {
      if (sid && rec.sid === sid) {
        pending.delete(pid)
        timers.clearTimeoutFn(rec.timer)
        tombstone(pid, rec.sid, rec.cat)
        affected.push(rec)
      }
    }
    if (!id && sid) repliedNoId.set(sid, nowMs() + GHOST_ASK_WINDOW_MS)
    // R1#8 — LATE VERDICT OBSERVABILITY: the id was ALREADY closed (remove()
    // found nothing, and it was closed before this reply — `wasClosed`), yet a
    // real reply word rode in afterwards: the human's decision reached the
    // plugin past the auto-reject (the D4 race the timeout floor guards).  The
    // reject already landed, so this is OBSERVABILITY ONLY — it never re-arms a
    // timer, never revives the command, and sends NO SDK reply, so it cannot
    // breach "the plugin only ever rejects".  The category comes from the
    // original close, so the audit line stays well-formed with no command text.
    if (id && !removed && wasClosed && resp) {
      const entry = closed.get(id)
      const late = entry ? lateVerdictWord(resp.toLowerCase()) : null
      if (entry && late) auditAsk(client, "bash", entry.cat, `late-${late}`)
    }
    for (const rec of affected) {
      if (!resp) continue // outcome unknown: cancel silently, never invent a verdict
      const lower = resp.toLowerCase()
      const verdict: ApprovalVerdict =
        lower === "reject" ? "rejected"
        : lower === "always" ? "allowed-always"
        : lower === "once" ? "allowed-once"
        : "degraded" // out-of-vocabulary word: record it honestly, not as "rejected"
      auditAsk(client, "bash", rec.cat, verdict)
      // "always" on an env-related ask → blanket-approve all env reads for
      // this session (the host's pattern generalization is too broad, so we
      // interpret "always" as a session-scoped env approval).  The hook
      // still hard-throws env-FILE reads (CATEGORY_ENV_FILE_PATH) in an
      // env-approved session: files on disk never open a dialog of their
      // own, so no "always" verdict can have consented to them.
      if (verdict === "allowed-always" && sid && /^(bash-)?env/.test(rec.cat)) {
        envApprovedSessions.add(sid)
      }
    }
  }

  /** Global gate health: armed, not degraded, and the client can reply. */
  function healthy(): boolean {
    return armed && !degraded && reply !== null
  }

  return {
    handleEvent(event: PermissionEvent): void {
      if (!armed) return // disposed
      const type = String(event?.type ?? "")
      const props = event?.properties
      if (!props) return
      // live host 1.18.29 emits `permission.asked`; the shipped d.ts spells
      // the same signal `permission.updated` — accept both open spellings
      if (type === "permission.asked" || type === "permission.updated") onAsked(props)
      else if (type === "permission.replied") onReplied(props)
    },
    start(): void {
      // v1 has no list endpoint (`list` is null) — events are the only
      // pending signal there, so start() is a deliberate no-op on v1.
      if (!list || !armed) return
      schedulePoll()
    },
    dispose(): void {
      armed = false
      if (pollHandle != null) timers.clearTimeoutFn(pollHandle)
      pollHandle = null
      for (const id of [...pending.keys()]) remove(id)
    },
    isArmed(): boolean {
      return healthy()
    },
    canDefer(sessionID?: string): boolean {
      // bound-method-safe (no `this`): destructure-able by the R6 hook
      return healthy() && !!sessionID && liveAsk.has(sessionID)
    },
    hasLiveAsk(sessionID?: string): boolean {
      return sessionID ? liveAsk.has(sessionID) : false
    },
    registerExecSession(sessionID?: string): void {
      if (sessionID) liveAsk.add(sessionID)
    },
    revokeExecSession(sessionID?: string): void {
      if (sessionID) liveAsk.delete(sessionID)
    },
    isEnvApproved(sessionID?: string): boolean {
      return !!sessionID && envApprovedSessions.has(sessionID)
    },
    pendingSize(): number {
      return pending.size
    },
  }
}

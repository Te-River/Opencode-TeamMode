/**
 * tm layer — the shared governance pipeline + tm_fetch retrieval.  Split out of
 * the former tools.ts hub.  Assembly lives in tools.ts.
 *
 *   tm_fetch — paged/structured retrieval of offloaded payloads (handles)
 *
 * (tm_read / tm_grep / tm_bash were the v1-only governed passthroughs and are
 * gone with the v1 personality: on v2 the host's native read / grep / shell are
 * governed by src/host/v2-offload.ts through the SAME `govern` seam below.)
 *
 * Shared governance (every tool): threshold offload (per content class:
 * TM_OFFLOAD_THRESHOLD_TEXT for markdown/text/log prose,
 * TM_OFFLOAD_THRESHOLD_DATA for json/csv/code/binary; an unknown/absent
 * class falls back to the global TM_OFFLOAD_THRESHOLD — backward
 * compatible), R6 reuse (same envprotect matchers as the global hook —
 * anti-backdoor), structured errors (never a bare throw), and store
 * failure degradation (governance faults never fail the task).
 */

import type * as crypto from "node:crypto"
import type { EnvProtectMode } from "../envprotect.js"
import { estimateTokens, shouldOffload, shorten, type TmConfig } from "./config.js"
import { isExpired, parseRef as parseTmRef, verifyToken } from "./refs.js"
import type { RunStore } from "./store.js"
import {
  buildPreview,
  buildStructureSummary,
  detectContentType,
} from "./preview.js"
import { HANDLE_INVALID_MESSAGE, tmError } from "./result.js"
import { cleanShellError } from "./shell-bridge.js"

// ---------- args coercion (pipelines are runtime-defensive) ------------------

function strArg(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v)
}

function intArg(v: unknown, def: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10)
  return Number.isFinite(n) ? Math.trunc(n) : def
}

// ---------- dependencies ------------------------------------------------------

export interface TmDeps {
  client: unknown
  $: unknown
  cfg: TmConfig
  store: RunStore
  runId: string
  /** Store-persisted HMAC key — used to VERIFY handle tokens in tm_fetch.
   *  Persisted at the store root so a handle survives a plugin restart. */
  hmacKey: crypto.BinaryLike
  accessToken: string
  expireAt: number
  mode: EnvProtectMode
  extra: RegExp[]
  /**
   * Step-id namespace prefix for SECONDARY pipeline instances.  A second
   * buildPipelines instance (PTC's) starts its counter at s0001 again —
   * without a distinct prefix its offloaded payloads would collide with
   * the main pipeline's same-numbered steps inside the shared run store
   * (refs ignore seq, so tm_fetch's last-append-wins would return the
   * WRONG payload).  PTC passes "ptc-"; the main instance stays "".
   */
  stepPrefix?: string
  /**
   * Workspace root (the server() directory).  Fix batch T3: the ctxDir
   * fallback when the execute ctx carries no directory — the desktop
   * sidecar's process cwd is the user HOME, NOT the workspace, so a
   * HOME-cwd would misresolve every relative path.
   */
  workspaceDir?: string
}

// ---------- pipelines ----------------------------------------------------------

interface GovernOptions {
  contentType: ReturnType<typeof detectContentType>
  clue?: string
}

/**
 * T4 threshold tiering — content class → offload boundary.
 *   PROSE class (markdown / HTML already stripped to text / line logs)
 *     → offloadThresholdText (literal default 4000): prose is cheap to
 *       skim, the old 2000 boundary offloaded whole readable pages into a
 *       handle.
 *   DATA class (json / csv / code / binary)
 *     → offloadThresholdData (literal default 2000 == the historical
 *       global baseline).
 *   Absent / unrecognized class → the global offloadThreshold (defensive
 *   fallback; every govern call site passes a known detectContentType
 *   result, so this branch is belt-and-braces).
 * Wave B M1 — the global TM_OFFLOAD_THRESHOLD is NOT dead here: config.ts
 * resolveTmConfig makes both tiers INHERIT it when it is explicitly set and
 * the tier env is not, so a user who raised the global is honored on every
 * class (an explicit tier env still wins).  See config.ts offloadThreshold*.
 */
function offloadThresholdFor(cfg: TmConfig, contentType: string | undefined): number {
  switch (contentType) {
    case "text":
    case "log":
      return cfg.offloadThresholdText
    case "json":
    case "csv":
    case "code":
    case "binary":
      return cfg.offloadThresholdData
    default:
      return cfg.offloadThreshold
  }
}

// ---------- tm_fetch json field projection (T4) ----------

/**
 * Dot-path projection over an offloaded JSON payload.  Grammar (the
 * deliberately small jq subset): segments split on ".", each `name`,
 * `name[]` (map into the array) or `[]` (expand the current arrays) —
 * e.g. `items[].name`, `[].stargazers_count`, `query.pages`.  Returns null
 * when the body is not valid JSON (the caller then IGNORES `fields` and
 * serves the normal paged mode — non-JSON handles keep the old behavior).
 */
export function projectJsonFields(
  body: string,
  path: string,
  cap: number,
): { values: string[]; matched: number; truncated: boolean } | null {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return null
  }
  let cur: unknown[] = [data]
  for (const seg of path.split(".")) {
    const s = seg.trim()
    if (!s) continue
    const m = /^([^[\]]*)(\[\])?$/.exec(s)
    if (!m) return { values: [], matched: 0, truncated: false } // malformed → empty projection
    const prop = m[1]
    const iterate = Boolean(m[2])
    const next: unknown[] = []
    for (const v of cur) {
      let picked: unknown
      if (prop) {
        if (v == null || typeof v !== "object") continue
        picked = (v as Record<string, unknown>)[prop]
      } else {
        picked = v
      }
      if (iterate) {
        if (Array.isArray(picked)) next.push(...picked)
      } else {
        next.push(picked)
      }
    }
    cur = next
  }
  const values: string[] = []
  let matched = 0
  let truncated = false
  for (const v of cur) {
    if (v === undefined) continue
    matched++
    if (values.length >= cap) {
      truncated = true
      continue
    }
    values.push(typeof v === "string" ? v : JSON.stringify(v) ?? String(v))
  }
  return { values, matched, truncated }
}

export function buildPipelines(deps: TmDeps) {
  const { cfg, store } = deps
  // CONCURRENCY INVARIANT: the step counter advances in a single
  // synchronous expression on the single-threaded event loop, so parallel
  // tool calls (the host may Promise.all a batch of tm_search / tm_webfetch
  // / tm_fetch executes) always receive DISTINCT step ids — and since every
  // store write is keyed by step id (per-step payload files, append-only
  // trajectory), parallel batches can never cross-contaminate.  Never make
  // this async or defer the increment behind an await.
  let stepCounter = 0
  const nextStepId = () => `${deps.stepPrefix ?? ""}s${String(++stepCounter).padStart(4, "0")}`

  function ctxDir(ctx: unknown): string {
    const d = (ctx as { directory?: unknown } | null | undefined)?.directory
    if (typeof d === "string" && d) return d
    // fix batch T3: prefer the workspace root the runtime knows over the
    // HOST process cwd (HOME on the desktop sidecar)
    return deps.workspaceDir ?? process.cwd()
  }

  /**
   * Threshold governance.  Inline under the content-class threshold;
   * otherwise store full content + append trajectory and return the
   * handle.  A store failure degrades to truncated content + warning
   * (never fails the task).
   */
  function govern(stepId: string, tool: string, content: string, opts: GovernOptions): unknown {
    const tokens = estimateTokens(content)
    const threshold = offloadThresholdFor(cfg, opts.contentType)
    if (!shouldOffload(tokens, threshold)) {
      store.appendTrajectory({ tool, step_id: stepId, event: "result", offloaded: false, tokens })
      return content
    }
    const preview = buildPreview(content, opts.contentType, {
      lines: cfg.previewLines,
      maxTokens: cfg.previewMaxTokens,
      clue: opts.clue,
    })
    try {
      const stored = store.writeResult(stepId, {
        tool,
        content,
        tokens,
        contentType: opts.contentType,
        preview,
        expireAt: deps.expireAt,
      })
      store.appendTrajectory({
        tool,
        step_id: stepId,
        seq: stored.seq,
        event: "result",
        offloaded: true,
        tokens,
        // what DID reach the context window — tm_stats nets this against
        // `tokens` to report the saving rather than the payload size
        preview_tokens: estimateTokens(preview),
        ref: stored.ref,
      })
      return {
        offloaded: true,
        ref: stored.ref,
        access_token: deps.accessToken,
        expire_at: stored.expireAt,
        content_type: opts.contentType,
        tokens,
        preview,
      }
    } catch (err) {
      return {
        offloaded: false,
        degraded: true,
        truncated: true,
        warning:
          `结果治理（黑板卸载）失败，已降级为截断返回：${shorten((err as Error)?.message ?? err, 120)}。` +
          `治理故障不使任务失败；需要全文请重跑原工具或缩小查询范围。`,
        content: content.slice(0, Math.max(0, threshold) * 4),
        tokens_estimate: tokens,
      }
    }
  }

  // ---------- tm_fetch ----------

  async function tmFetch(rawArgs: Record<string, unknown>, _ctx: unknown): Promise<unknown> {
    const tool = "tm_fetch"
    try {
      const args = rawArgs ?? {}
      const ref = strArg(args.ref).trim()
      if (!ref) return tmError(tool, "args", "缺少 ref 参数（offload 句柄中的 ref）")
      const parsed = parseTmRef(ref)
      if (!parsed) {
        return tmError(tool, "args", "ref 格式无效，期望 tm://runs/{run_id}/steps/{step_id}/result")
      }
      let token = strArg(args.access_token).trim()
      if (!token && parsed.token) token = parsed.token
      // A handle's token is a RUN constant, not a per-handle secret.  A real
      // session was observed re-typing the same 64 hex chars into every
      // tm_fetch and every PTC program — ~70 output tokens a pop and a typo
      // waiting to happen — so an omitted token means "this run's".  On a
      // ref from another run the default cannot verify (it is HMAC over a
      // different run id), so the omission never widens authority.
      if (!token) token = deps.accessToken
      if (!token) return tmError(tool, "args", "缺少 access_token（offload 句柄中携带）")
      // Auth: the token is HMAC(key, runId) — verifying it against the ref's
      // OWN run id proves the handle was issued by a process holding this
      // store's key.  The old `parsed.runId !== deps.runId` gate is gone: it
      // tied a handle's life to its issuing process, so every offload died
      // the moment the plugin restarted even though the payload was still on
      // disk (live: a command that reloaded the plugin, then tm_fetch).
      if (!verifyToken(deps.hmacKey, parsed.runId, token)) {
        return tmError(tool, "permission", `句柄校验失败（token 校验失败）。${HANDLE_INVALID_MESSAGE}`)
      }
      // The payload is read from the run the REF names, not from this process's
      // run — that is what makes a pre-restart handle fetchable.
      const entry = store.findIndexEntry(ref, parsed.runId)
      const now = Date.now()
      // User's semantic call (2026-10-05): a handle lives exactly as long as its
      // payload FILE does.  `expire_at` is INFORMATION, never a reason to refuse —
      // refusing a fetch of bytes that are sitting right there is the very
      // "offloaded it and cannot get it back" failure this pipeline exists to
      // prevent.  The TTL sweep is the only reaper, so past `expire_at` the reply
      // says so and urges aggregating now, while the payload is still readable.
      const ttlPast = entry ? isExpired(entry.expire_at, now) : false
      const loaded = store.readStepFile(parsed.stepId, parsed.runId)
      if (!loaded) {
        return tmError(tool, "store", `找不到载荷文件。${HANDLE_INVALID_MESSAGE}`)
      }
      // T4 json field projection — `fields: "<dot-path>"` on a json handle
      // returns ONLY the projected values.  A non-json handle IGNORES the
      // arg (normal paged/structure serving); a json-indexed body that no
      // longer parses (e.g. byte-capped truncation) likewise falls through.
      const fields = strArg(args.fields).trim()
      const isJsonHandle = entry ? entry.content_type === "json" : true
      if (fields && isJsonHandle) {
        const proj = projectJsonFields(loaded.content, fields, cfg.fetchMaxLines)
        if (proj) {
          store.appendTrajectory({ tool, step_id: parsed.stepId, event: "fetch", ref, mode: "fields", fields })
          // rendered as a plain string: result.ts has no "fields" branch
          // (out of this package's scope) and JSON.stringify would escape
          // the projected lines into one unreadable blob.
          const head = [
            `ref: ${ref}`,
            `mode: fields | fields: ${fields} | matched: ${proj.matched}${
              proj.truncated ? ` | 仅前 ${cfg.fetchMaxLines} 个值（已截断）` : ""
            }`,
            proj.matched === 0
              ? `投影无匹配值（路径不存在或全为 undefined）——先 mode:"structure" 看键树。`
              : `只回投影结果；取原始行用 mode:"lines"。`,
            "--- 投影 ---",
          ].join("\n")
          return proj.values.length ? `${head}\n${proj.values.join("\n")}` : head
        }
      }
      const lines = loaded.content.split(/\r?\n/)
      const mode = strArg(args.mode).trim() === "structure" ? "structure" : "lines"
      store.appendTrajectory({ tool, step_id: parsed.stepId, event: "fetch", ref, mode })
      if (mode === "structure") {
        return {
          ref,
          mode: "structure",
          total_lines: lines.length,
          summary: buildStructureSummary(loaded.content, entry?.content_type ?? "text"),
          expire_at: entry?.expire_at ?? null,
          ...(ttlPast
            ? { ttl_expired: true, ttl_note: "已过 TTL 时点：下一次清扫可能回收此载荷，本轮请尽快聚合，别继续分页。" }
            : {}),
        }
      }
      let offset = intArg(args.offset, 0)
      if (offset < 0) offset = 0
      let limit = intArg(args.limit, cfg.fetchMaxLines)
      if (limit <= 0) limit = cfg.fetchMaxLines
      if (limit > cfg.fetchMaxLines) limit = cfg.fetchMaxLines
      const slice = lines.slice(offset, offset + limit)
      // offset past EOF must not produce a negative remaining (#9)
      const remaining = Math.max(0, lines.length - (offset + slice.length))
      return {
        ref,
        mode: "lines",
        offset,
        limit,
        total_lines: lines.length,
        returned_lines: slice.length,
        remaining_lines: remaining,
        next_offset: remaining > 0 ? offset + slice.length : null,
        hint:
          (remaining > 0
            ? `共 ${lines.length} 行，已返回 ${slice.length} 行（offset=${offset}），剩余 ${remaining} 行；继续取回用 offset=${offset + slice.length}；先聚合再决定是否翻页。`
            : `共 ${lines.length} 行，已返回 ${slice.length} 行（offset=${offset}），已到末尾。`) +
          (ttlPast ? " 注意：此载荷已过 TTL 时点，下一次清扫可能回收它——本轮请尽快聚合，别继续翻页。" : ""),
        expire_at: entry?.expire_at ?? null,
        ...(ttlPast ? { ttl_expired: true } : {}),
        content: slice.join("\n"),
      }
    } catch (err) {
      const info = cleanShellError(err)
      return tmError(tool, "execute", info.message, info.line)
    }
  }

  return { nextStepId, govern, tmFetch, store }
}

/** The shared governance seam + tm_fetch retrieval (v2 native-offload + every
 *  governed tool's offload path call `govern`; PTC's separate instance is gone
 *  with the v1 personality). */
export type TmPipelines = ReturnType<typeof buildPipelines>

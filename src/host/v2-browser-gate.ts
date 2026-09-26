import type { V2Registration } from "./v2-types.js"
import type { TeamScope } from "./v2-scope.js"
import { checkWebUrl } from "../tm/webfetch.js"
import { isEnvFilePath } from "../envprotect.js"

/**
 * The native browser catalog, put behind OUR gate.
 *
 * The host ships 45 `browser_*` tools and renders them in its own side panel, which
 * is why they are the attractive option (docs/research/browser-pane.md). The cost is
 * that they are the one part of the surface we did not police: `permission.evaluate`
 * was observed NOT firing for them in a live 2.0.16 session, so the domain list, the
 * address red line and the R6 env-file rule all had a working bypass the length of a
 * tool name. This module closes it at the only seam that is left — `tool.hook
 * ("execute.before")`, whose `input` is mutable and which sees the exact URL the
 * model is about to navigate to.
 *
 * TWO enforcement layers, because the before-hook's power to abort is a host promise
 * nobody has made to us:
 *
 *  1. refuse at the door: throw with the governance sentence, which is how v1's
 *     governed tools already answer an out-of-policy target.
 *  2. if the call happens anyway, take the ANSWER away: an `execute.after` for the
 *     same tool and session right after our refusal means the throw did not stop it,
 *     so the page content is replaced by the same refusal. The request may still have
 *     left the machine (we cannot un-spawn the host's browser from here), but the
 *     private page never reaches the context window, the run store or the trajectory.
 *
 * Layer 2 is also the measurement: `leaked` is the count of refusals the host walked
 * past. Zero after a session of browser work is the evidence the gate has teeth; a
 * non-zero number says so in `tm_stats` instead of letting us claim a block we did not
 * perform — which is the product rule, not a logging nicety.
 *
 * Scope discipline (#22) applies first: a non-Team session's browser calls are the
 * user's own configuration's business, and an unattributable one is treated as NOT
 * ours. Only Team roles get this rule injected, and only they get the stricter one.
 */

/** How long after a refusal we still credit the call to it. Generous on purpose: a
 *  host that queues the tool and then answers is the case we are measuring. */
const LEAK_WINDOW_MS = 30_000

/** The four host-vs-tm_browser differences that cost rounds in the user's real task log,
 *  said once per session at the result where each one bites. */
export const NATIVE_BROWSER_NOTE =
  "（宿主原生浏览器的读法，本会话只说一次：① snapshot/find 的结果是 {tab, content, truncated}，" +
  "可寻址记号写成 `@e8 [link]`，不是 tm_browser 的 `[ref=e12]`；② evaluate 的参数名是 `script`（不是 fn），" +
  "而且它求值的是表达式：传 `() => …` 这种函数源文本不会被调用，结果同样是 {} —— 要么写成表达式，" +
  "要么自己写成 `(()=>{…})()`，返回对象也要自己 JSON.stringify 成标量；③ screenshot 需要一个真正可见且聚焦的" +
  "桌面标签页，宿主在后台窗口下必定失败，别为它反复 focus；④ wait 的 state 取值不是 playwright 那一套" +
  "（实测 `load` 和 `text` 在 2.0.18 上直接 error，宿主不给原因），别拿它当渲染完成的判据；" +
  "⑤ SPA 首帧常是空 content：先重拍再猜，或者直接用站方自己的搜索接口/搜索框，而不是猜 URL 路径。）"

export interface BrowserGateReport {
  /** browser_* execute.before events we looked at (Team sessions only) */
  seen: number
  /** of those, how many carried a URL or local path we could classify */
  classified: number
  /** refusals raised at the door */
  refused: number
  /** of those refusals, how many the host walked past anyway (layer 2 fired) */
  leaked: number
  /** sessions that got the one-time native browser_* reading note */
  annotated: number
  /** refusals that produced no following result within the window — the door held */
  held: number
  /** refusals raised against a Code Mode program (`execute`), which reaches the same
   *  browser through `tools.browser.*` and would otherwise bypass this file entirely */
  codeModeRefused: number
  /** out-of-scope calls left completely alone, counted rather than invisible */
  foreignSkipped: number
  /** per-tool refusal counts, so "which verb is the hole" is answerable */
  byTool: Record<string, { seen: number; refused: number; leaked: number }>
}

export interface BrowserGate {
  registrations: V2Registration[]
  report: BrowserGateReport
  /** The hook bodies are exported through this seam so a test can drive both halves
   *  (a host that honours the throw, and one that does not) without a live desktop. */
  fireBefore: (event: unknown) => void
  fireAfter: (event: unknown) => void
}

type V2ToolPart = { type?: unknown; text?: unknown }

function locatableText(result: unknown): { parts: unknown[]; index: number; text: string } | null {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return null
  const index = content.findIndex((p) => p && typeof p === "object" && (p as V2ToolPart).type === "text" && typeof (p as V2ToolPart).text === "string")
  if (index < 0) return null
  const part = content[index] as V2ToolPart
  return { parts: content, index, text: String(part.text ?? "") }
}

/** The host spells its browser tools `browser_snapshot` on the direct surface and
 *  `browser.snapshot` as a Code Mode catalog path — the user's own desktop log shows both,
 *  and a matcher that knows only one of them silently governs nothing. */
function isNativeBrowserTool(name: string): boolean {
  return name.startsWith("browser_") || name.startsWith("browser.")
}

/** Did this `execute` program actually drive the browser? Read from the host's own
 *  `result.metadata.toolCalls[]` (the exported desktop session carries it), because the
 *  program TEXT only tells us what was written, not what ran. */
function droveBrowser(result: unknown): boolean {
  const calls = (result as { metadata?: { toolCalls?: unknown } } | null | undefined)?.metadata?.toolCalls
  if (!Array.isArray(calls)) return false
  return calls.some((c) => isNativeBrowserTool(String((c as { tool?: unknown })?.tool ?? "")))
}

/** The three verbs whose result shape a model gets wrong without being told (the snapshot's
 *  `content` vs `text`, `find`'s empty answer, `evaluate`'s non-scalar return). Matched on the
 *  suffix so BOTH host spellings count — `browser_snapshot` on the direct surface and
 *  `browser.snapshot` as a catalog path — because a note that fires for the spelling nobody
 *  uses is the same dead code as a gate that returns before its own branch. */
const NOTE_VERBS = ["snapshot", "find", "evaluate"]
function wantsReadingNote(tool: string): boolean {
  return NOTE_VERBS.includes(tool.replace(/^browser[._]/, ""))
}

/** The addresses a browser call can carry. `url` on navigate / tabs.open, `path` on
 *  preview and the file verbs, and nothing on the pure-input verbs (click, fill),
 *  which are governed by whatever page is already open. */
function targetOf(input: unknown): { kind: "url" | "path"; value: string } | null {
  const rec = input as { url?: unknown; path?: unknown; targetUrl?: unknown } | null | undefined
  if (!rec || typeof rec !== "object") return null
  for (const key of ["url", "targetUrl"] as const) {
    const v = rec[key]
    if (typeof v === "string" && v.trim()) return { kind: "url", value: v.trim() }
  }
  if (typeof rec.path === "string" && rec.path.trim()) return { kind: "path", value: rec.path.trim() }
  return null
}

/** Every http(s) host named in a Code Mode program that is refused WITHOUT consent by
 *  the address red line. Only the hostname is read out and reported — never the program
 *  text, which is the user's code and may carry a token in its query string. */
function hardUrlHosts(program: string): string[] {
  const hits: string[] = []
  for (const m of program.matchAll(/https?:\/\/([^\s"'`)<>,\\]+)/gi)) {
    const raw = m[1] ?? ""
    let host = ""
    try {
      host = new URL("http://" + raw.replace(/^[^@]*@/, "")).hostname
    } catch {
      continue
    }
    if (!host) continue
    const v = checkWebUrl("http://" + host + "/", [])
    if (!v.ok && !v.askable) hits.push(host)
  }
  return hits
}

export function applyV2BrowserGate(
  ctx: unknown,
  opts: {
    allowlist: readonly string[]
    scope?: TeamScope
    env?: Record<string, string | undefined>
  },
): BrowserGate {
  const report: BrowserGateReport = { seen: 0, classified: 0, refused: 0, codeModeRefused: 0, leaked: 0, held: 0, annotated: 0, foreignSkipped: 0, byTool: {} }
  const registrations: V2Registration[] = []
  /** key = `${tool}\n${sessionID}` → the refusal we owe that call's answer */
  const annotated = new Set<string>()
  const pending = new Map<string, { message: string; at: number }>()
  const off = /^(0|false|no|off)$/i.test(String(opts.env?.TM_V2_BROWSER_GATE ?? "").trim())

  const keyOf = (tool: string, sessionID: unknown) => `${tool}\n${String(sessionID ?? "")}`

  const decide = (target: { kind: "url" | "path"; value: string }): string | null => {
    if (target.kind === "path") {
      // R6, applied to the one native verb that reads from the server's own disk.
      return isEnvFilePath(target.value)
        ? `原生浏览器要预览的路径 ${target.value} 是环境文件家族（R6 红线），不放行：这类读取没有任何"看起来对不对"可判断，也不存在可批准的窗口。`
        : null
    }
    const verdict = checkWebUrl(target.value, opts.allowlist)
    return verdict.ok ? null : verdict.message
  }

  const fireBefore = (raw: unknown): void => {
    const event = raw as { tool?: unknown; name?: unknown; input?: unknown; agent?: unknown; sessionID?: unknown } | null
    const tool = String(event?.tool ?? event?.name ?? "")
    // `execute` is checked in the same breath as the direct verbs, NOT after a
    // `browser_*` early return: the code-mode leg used to sit BELOW that return, so the
    // whole branch was unreachable and a navigate inside a program was gated by nothing
    // but the model's own memory. Proven by reading the compiled hook, not by reasoning.
    const isExecute = tool === "execute"
    if (!isExecute && !isNativeBrowserTool(tool)) return
    if (opts.scope && opts.scope.count(opts.scope.decide(event as { agent?: unknown; sessionID?: unknown })) !== "ours") {
      report.foreignSkipped++
      return
    }
    report.seen++
    if (off) return
    // Code Mode reaches the SAME browser through `tools.browser.tabs.open(...)`, and an
    // inner call may never surface as its own execute.before event — so a gate that only
    // reads `input.url` can be walked around by putting the navigate inside a program.
    // The address red line is the part worth defending there: a program is source text,
    // and the hosts it names are judgement-free metadata ranges.
    if (isExecute) {
      const program = (event?.input as { program?: unknown } | undefined)?.program
      if (typeof program === "string" && /browser[._]|browser_/.test(program)) {
        for (const host of hardUrlHosts(program)) {
          report.classified++
          report.refused++
          report.codeModeRefused++
          const message =
            `你放进 execute 程序里的浏览器调用指向 ${host}，那是不容路由 / 元数据地址段——R6 同级红线，任何配置都不能批准，` +
            `所以我没有让这个程序跑起来。要本机服务请用有头浏览器自己开，要公网内容请给公开主机名。`
          pending.set(keyOf(tool, event?.sessionID), { message, at: Date.now() })
          throw new Error(message)
        }
      }
      return
    }
    const target = targetOf(event?.input)
    if (!target) return
    report.classified++
    report.byTool[tool] ??= { seen: 0, refused: 0, leaked: 0 }
    report.byTool[tool].seen++
    const message = decide(target)
    if (!message) return
    report.refused++
    report.byTool[tool].refused++
    pending.set(keyOf(tool, event?.sessionID), { message, at: Date.now() })
    // Layer 1. Thrown rather than returned: the input is mutable, but silently
    // rewriting a URL the model chose is the guesswork this product refuses — the
    // model has to see the refusal, and the host has to be the one that surfaces it.
    throw new Error(message)
  }

  const fireAfter = (raw: unknown): void => {
    const event = raw as { tool?: unknown; name?: unknown; result?: unknown; agent?: unknown; sessionID?: unknown } | null
    const tool = String(event?.tool ?? event?.name ?? "")
    const isExecute = tool === "execute"
    if (!isExecute && !isNativeBrowserTool(tool)) return
    if (off) return
    // No scope re-check here: the owner question was answered at the door, and a
    // foreign session never has a pending refusal for this lookup to match.
    const key = keyOf(tool, event?.sessionID)
    const owed = pending.get(key)
    let stripped = false
    if (owed) {
      pending.delete(key)
      const now = Date.now()
      if (now - owed.at > LEAK_WINDOW_MS) {
        report.held++
      } else {
        // Layer 2: the host produced an answer to a call we refused. Take the content out
        // and put the refusal in its place — the model must never read a page our policy
        // says it may not, and a silent pass would be the exact claim we cannot make.
        report.leaked++
        if (report.byTool[tool]) report.byTool[tool].leaked++
        const found = locatableText(event?.result)
        stripped = !!found
        if (found) {
          found.parts[found.index] = {
            type: "text",
            text: `${owed.message}

（这道门禁本来是在请求前生效的：${tool} 的调用被宿主放过去了，所以我把它的返回换成了这段拒绝语。这个页面的内容没有进入上下文、run store 或轨迹；请求本身已经发生，这一条我没有能力撤回。）`,
          }
          for (let i = found.index + 1; i < found.parts.length; i++) {
            const p = found.parts[i] as V2ToolPart | null
            if (p && typeof p === "object" && p.type === "text" && typeof p.text === "string") found.parts[i] = { type: "text", text: "" }
          }
        }
      }
    }
    // Once per session, at the result where the confusion actually happened: the host's
    // browser surface differs from tm_browser's in ways that each cost a round in the
    // user's real-task log (a guessed `snap.text`, an `fn` argument that is really
    // `script`, a function source that reads as `{}`, a screenshot retried after `focus`,
    // a `wait` state the host rejects, a MediaWiki URL guessed instead of the site's own
    // search). This is the cheapest place to say it — the tool description is the host's,
    // and the prompt would charge every role for text only the browsing ones use. The
    // Code Mode shape is why `execute` is included: the model drives the browser through
    // `tools.browser.*` there and never sees a `browser_*` tool call at all.
    if (stripped) return
    const sid = String(event?.sessionID ?? "")
    const wantsNote = isExecute
      ? droveBrowser(event?.result)
      : wantsReadingNote(tool)
    if (!sid || annotated.has(sid) || !wantsNote) return
    const found = locatableText(event?.result)
    if (!found) return
    annotated.add(sid)
    report.annotated++
    found.parts[found.index] = { type: "text", text: `${found.text}\n\n${NATIVE_BROWSER_NOTE}` }
  }

  const toolDomain = (ctx as { tool?: { hook?: unknown } } | null | undefined)?.tool
  if (typeof toolDomain?.hook === "function") {
    const hook = toolDomain.hook as (name: string, cb: (e: unknown) => void) => Promise<V2Registration>
    for (const [name, cb] of [
      ["execute.before", fireBefore],
      ["execute.after", fireAfter],
    ] as const) {
      try {
        const reg = hook(name, cb)
        // The host's transform/hook registrars are async; hold the promise so teardown
        // can await it rather than disposing a registration that never landed.
        registrations.push({
          dispose: async () => {
            try {
              await (reg as Promise<V2Registration>).then?.((r) => r?.dispose?.())
            } catch {
              /* a host that already tore down its registry has nothing left to free */
            }
          },
        })
      } catch {
        /* a host that refuses the hook is reported by the capability probe, not here */
      }
    }
  }

  // Sweep refusals that never saw an answer: the door held (the call was aborted and
  // nothing came back), which is the good case and still has to be counted.
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of pending) {
      if (now - v.at > LEAK_WINDOW_MS) {
        pending.delete(k)
        report.held++
      }
    }
  }, LEAK_WINDOW_MS)
  if (typeof sweeper === "object" && sweeper && "unref" in sweeper) (sweeper as { unref?: () => void }).unref?.()
  // The host reloads plugins IN THIS PROCESS, so an interval that outlives teardown is
  // not a harmless one: every boot would add another sweeper counting the same
  // refusals. Clearing it is part of releasing the registration, not a nicety.
  registrations.push({
    dispose: async () => {
      clearInterval(sweeper)
    },
  })

  return {
    registrations,
    report,
    fireBefore,
    fireAfter,
  }
}

export function browserGateSummary(r: BrowserGateReport): string {
  if (!r.seen) return "原生 browser_* 没被调用过（门禁在场，没数据）"
  const teeth = r.refused === 0 ? "没有拒绝发生过" : r.leaked === 0 ? `${r.refused} 次拒绝全部拦停在门口` : `${r.refused} 次拒绝中 ${r.leaked} 次被宿主放过去（已在返回处换成拒绝语）`
  return `原生 browser_*/Code Mode：看过 ${r.seen} 次调用（其中 Code Mode 程序拒绝 ${r.codeModeRefused} 次） · 可判定目标 ${r.classified} 次 · 拒绝 ${r.refused} 次（${teeth}）· 拦下后无返回 ${r.held} 次 · 非 Team 跳过 ${r.foreignSkipped} 次 · 原生读法提示发了 ${r.annotated} 个会话`
}

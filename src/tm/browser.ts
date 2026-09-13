/**
 * tm_browser — governed interactive browser (Plan C: the user's own
 * Chromium-family browser driven headful over the CDP pipe protocol).
 *
 * Feasibility proven by smoke (Edge + --remote-debugging-pipe + JSON/NUL
 * framing over fds 3/4 — zero deps, no WebSocket implementation).  Qoder's
 * hardening ideas are ported where the plugin can reach them:
 *   - isolated temp user-data-dir (never the user's real profile);
 *   - per-navigation allowlist enforced at the NETWORK layer via CDP
 *     Fetch.requestPaused (non-allowlisted hosts get BlockedByClient —
 *     the per-hop re-check analog);
 *   - hardened webPreferences are the spawn's own flags (no-first-run,
 *     no-extensions, mute);
 *   - hard per-command timeout + explicit close; dispose kills the child.
 *
 * Environment adaptivity (different OpenCode hosts):
 *   - headful by default (Plan C); display-less Linux (no DISPLAY/
 *     WAYLAND_DISPLAY) automatically falls back to headless; TM_BROWSER_
 *     HEADLESS=1|0 forces either way;
 *   - browser discovery: TM_BROWSER_PATH override, then the USER'S DEFAULT
 *     browser (Windows registry / Linux xdg-settings) when it is
 *     Chromium-family — CDP's pipe protocol is Chromium-only, so Firefox as
 *     default falls through — then per-OS candidate paths (Edge first on
 *     Windows; Chrome/Chromium elsewhere).  No browser → structured error,
 *     the agent falls back to tm_webfetch / user MCP tools.
 *
 * Role access mirrors tm_webfetch: network roles (team + researcher) only.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { checkWebUrl } from "./webfetch.js"
import { askUserForTarget } from "./perm-ask.js"
import type { ToolResult } from "../types.js"
import { tmError, toToolResult } from "./result.js"
import type { TmConfig } from "./config.js"
import type { TmPipelines } from "./pipelines.js"
import { rmForceSafe } from "../fs-safe.js"

/** Per-OS browser candidates, in preference order (first hit wins). */
const BROWSER_CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ],
}

/** Subprocess runner for the shell/registry probes; injectable for tests. */
export type CommandRunner = (cmd: string, args: string[]) => string

const defaultRunner: CommandRunner = (cmd, args) =>
  String(
    execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }),
  )

/** Chromium-family binaries only — --remote-debugging-pipe is a Chromium
 *  protocol; Firefox/WebKit as the default browser cannot drive tm_browser. */
const CHROMIUM_FAMILY_RE = /(?:^|[\\/])(?:chrome|msedge|brave|vivaldi|chromium|chromium-browser|opera|yandex)(?:\.exe)?$/i

export function isChromiumFamily(exePath: string): boolean {
  return CHROMIUM_FAMILY_RE.test(String(exePath ?? "").trim())
}

/** Parse `reg query "...UrlAssociations\http\UserChoice" /v ProgId` output. */
export function parseProgId(stdout: string): string | null {
  const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(String(stdout ?? ""))
  return m ? m[1] : null
}

/** Parse `reg query "...\shell\open\command" /ve` output → exe path. */
export function parseRegCommand(stdout: string): string | null {
  const m = /REG_SZ\s+(?:"([^"]+)"|(\S+))/i.exec(String(stdout ?? ""))
  return m ? (m[1] ?? m[2]) : null
}

/** Parse the Exec= line of an xdg .desktop file. */
export function parseDesktopExec(text: string): string | null {
  const m = /^Exec\s*=\s*(?:"([^"]+)"|(\S+))/m.exec(String(text ?? ""))
  return m ? (m[1] ?? m[2]) : null
}

/** The user's DEFAULT browser, when it is Chromium-family and present.
 *  null → the caller falls back to the per-OS probe list (detection is
 *  best-effort and must never throw into tool discovery). */
export function defaultBrowserExecutable(
  env: Record<string, string | undefined> = process.env,
  run: CommandRunner = defaultRunner,
): string | null {
  try {
    if (process.platform === "win32") {
      const choice = run("reg", [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
        "/v",
        "ProgId",
      ])
      const progId = parseProgId(choice)
      if (!progId) return null
      const cmd = run("reg", ["query", `HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, "/ve"])
      const exe = parseRegCommand(cmd)
      return exe && isChromiumFamily(exe) && fs.existsSync(exe) ? exe : null
    }
    if (process.platform === "linux") {
      const desk = run("xdg-settings", ["get", "default-web-browser"]).trim()
      if (!desk) return null
      const name = desk.endsWith(".desktop") ? desk : desk + ".desktop"
      const dirs = [
        "/usr/share/applications",
        "/usr/local/share/applications",
        path.join(String(env.HOME ?? ""), ".local/share/applications"),
      ]
      for (const dir of dirs) {
        const f = path.join(dir, name)
        if (!fs.existsSync(f)) continue
        const exe = parseDesktopExec(fs.readFileSync(f, "utf8"))
        if (exe && isChromiumFamily(exe) && fs.existsSync(exe)) return exe
      }
    }
  } catch {
    /* best-effort — the probe list takes over */
  }
  return null
}

/** Resolve the browser executable: TM_BROWSER_PATH override → the user's
 *  DEFAULT browser (Chromium-family only) → per-OS candidate paths.
 *  %LOCALAPPDATA% style vars are expanded on win32. */
export function findBrowserExecutable(env: Record<string, string | undefined> = process.env): string | null {
  const override = String(env.TM_BROWSER_PATH ?? "").trim()
  const tryPath = (p: string): string | null => {
    const expanded = p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => env[name] ?? "")
    try {
      return fs.existsSync(expanded) ? expanded : null
    } catch {
      return null
    }
  }
  if (override) return tryPath(override)
  const def = defaultBrowserExecutable(env)
  if (def) return def
  for (const c of BROWSER_CANDIDATES[process.platform] ?? []) {
    const hit = tryPath(c)
    if (hit) return hit
  }
  return null
}

/**
 * Headless resolution (Plan C = headful by default):
 *   TM_BROWSER_HEADLESS=1|true|force  → headless (servers/CI)
 *   TM_BROWSER_HEADLESS=0|false|never → headful
 *   auto (default)                    → headless ONLY when there is no
 *   display possible (Linux without DISPLAY/WAYLAND_DISPLAY).
 */
export function resolveHeadless(env: Record<string, string | undefined> = process.env): boolean {
  const raw = String(env.TM_BROWSER_HEADLESS ?? "auto").trim().toLowerCase()
  if (["1", "true", "force", "yes"].includes(raw)) return true
  if (["0", "false", "never", "no"].includes(raw)) return false
  if (process.platform === "linux") return !env.DISPLAY && !env.WAYLAND_DISPLAY
  return false
}

// ---------- pipe CDP client (JSON + NUL framing over fds 3/4) ----------------

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: Record<string, unknown>
  error?: { message?: string }
}

class PipeCdp {
  private nextId = 1
  private pending = new Map<number, (m: CdpMessage) => void>()
  private buf = Buffer.alloc(0)
  private events: CdpMessage[] = []
  readonly onEvent = (handler: (m: CdpMessage) => void) => this.eventHandler = handler
  private eventHandler: (m: CdpMessage) => void = () => {}

  constructor(private readonly child: ChildProcess) {
    const inp = child.stdio[4] as NodeJS.ReadableStream | null
    inp?.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk])
      for (;;) {
        const i = this.buf.indexOf(0)
        if (i === -1) break
        const line = this.buf.subarray(0, i).toString("utf8")
        this.buf = this.buf.subarray(i + 1)
        try {
          const m = JSON.parse(line) as CdpMessage
          if (m.id && this.pending.has(m.id)) {
            this.pending.get(m.id)!(m)
            this.pending.delete(m.id)
          } else if (m.method) {
            this.events.push(m)
            this.eventHandler(m)
          }
        } catch {
          /* partial frame */
        }
      }
    })
  }

  call(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const pipe = this.child.stdio[3] as NodeJS.WritableStream | null
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
        }
      }, timeoutMs)
      this.pending.set(id, (m) => {
        clearTimeout(timer)
        m.error ? rej(new Error(`CDP ${method} -> ${JSON.stringify(m.error)}`)) : res(m.result ?? {})
      })
      pipe?.write(Buffer.from(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"))
    })
  }

  async waitEvent(method: string, sessionId: string | undefined, timeoutMs = 15_000): Promise<CdpMessage> {
    const t0 = Date.now()
    for (;;) {
      const i = this.events.findIndex((e) => e.method === method && (!sessionId || e.sessionId === sessionId))
      if (i >= 0) return this.events.splice(i, 1)[0]
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待 CDP 事件 ${method} 超时`)
      await new Promise((r) => setTimeout(r, 80))
    }
  }
}

// ---------- session state -----------------------------------------------------

interface BrowserSession {
  child: ChildProcess
  cdp: PipeCdp
  sessionId: string
  profileDir: string
  currentUrl: string
}

const SPAWN_TIMEOUT_MS = 15_000
const NAVIGATE_EVENT_TIMEOUT_MS = 15_000

// ---------- tool ----------------------------------------------------------------

export function buildTmBrowserTool(deps: {
  pipelines: TmPipelines
  cfg: TmConfig
  env?: Record<string, string | undefined>
  args?: Record<string, unknown>
}): {
  description: string
  args: Record<string, unknown>
  execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>
  dispose: () => void
} {
  const { pipelines } = deps
  const env = deps.env ?? process.env
  const tool = "tm_browser"
  const traj = (e: Record<string, unknown>) => pipelines.store.appendTrajectory({ tool, ...e })
  let session: BrowserSession | null = null
  const allowlist = (deps.cfg as { webfetchAllowedDomains?: readonly string[] }).webfetchAllowedDomains
    ?? ["*"]
  // hosts approved through the OFFICIAL dialog this plugin lifetime — the
  // CDP network-layer block consults this in addition to the static allowlist
  const approvedHosts = new Set<string>()

  async function ensureSession(headless: boolean): Promise<BrowserSession> {
    if (session) return session
    const executable = findBrowserExecutable(env)
    if (!executable) {
      throw new Error(
        "本机未找到可用的浏览器（按 Edge/Chrome/Chromium 顺序探测失败）。" +
          "设置 TM_BROWSER_PATH 指向浏览器可执行文件，或改用 tm_webfetch / 用户 MCP 工具。",
      )
    }
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-browser-"))
    const child = spawn(
      executable,
      [
        headless ? "--headless=new" : "--start-maximized",
        "--remote-debugging-pipe",
        `--user-data-dir=${profileDir}`,
        // real-Chrome UA even under --headless=new (which some sites detect
        // via the "HeadlessChrome" token otherwise) + zh-CN Accept-Language
        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "--accept-lang=zh-CN,zh;q=0.9,en;q=0.8",
        "--no-first-run", "--no-default-browser-check", "--disable-extensions",
        "--disable-background-networking", "--mute-audio",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true },
    )
    const cdp = new PipeCdp(child)
    const t0 = Date.now()
    // ready loop: the pipe is not immediately writable-to-a-live-target
    for (;;) {
      try {
        await cdp.call("Target.getTargets", {}, undefined, 3000)
        break
      } catch (e) {
        if (Date.now() - t0 > SPAWN_TIMEOUT_MS || (child as { exitCode?: number | null }).exitCode !== null) {
          child.kill()
          fs.rmSync(profileDir, { recursive: true, force: true })
          throw new Error(`浏览器启动失败：${(e as Error).message}`)
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    const targets = await cdp.call("Target.getTargets")
    const page = (targets.targetInfos as Array<{ type: string; targetId: string }>).find((t) => t.type === "page")
    if (!page) throw new Error("浏览器启动后未找到 page target")
    const { sessionId } = await cdp.call("Target.attachToTarget", { targetId: page.targetId, flatten: true }) as { sessionId: string }
    await cdp.call("Page.enable", {}, sessionId)
    // network-layer allowlist enforcement (Qoder's per-hop re-check analog)
    await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId)
    cdp.onEvent((m) => {
      if (m.method !== "Fetch.requestPaused" || m.sessionId !== sessionId) return
      const requestId = String((m.params as { requestId?: string }).requestId ?? "")
      const url = String((m.params as { request?: { url?: string } }).request?.url ?? "")
      const verdict = checkWebUrl(url, allowlist as readonly string[])
      let pass = verdict.ok
      if (!pass) {
        // an approved-via-dialog host passes the network layer too
        try {
          pass = approvedHosts.has(new URL(url).hostname)
        } catch {
          pass = false
        }
      }
      if (pass) {
        void cdp.call("Fetch.continueRequest", { requestId }, sessionId, 5000).catch(() => {})
      } else {
        traj({ step_id: "browser", event: "blocked", url: url.slice(0, 200) })
        void cdp.call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId, 5000).catch(() => {})
      }
    })
    child.on("exit", () => {
      session = null
      // best-effort: the profile may still be file-locked during shutdown —
      // a leftover temp dir is reclaimed by the OS, never an error for the task
      try {
        rmForceSafe(profileDir, { recursive: true })
      } catch {
        /* ignore */
      }
    })
    session = { child, cdp, sessionId, profileDir, currentUrl: "about:blank" }
    return session
  }

  async function closeSession(): Promise<string> {
    if (!session) return "没有打开的浏览器会话。"
    const { child, cdp, profileDir } = session
    session = null
    await cdp.call("Browser.close", {}, undefined, 3000).catch(() => {})
    if ((child as { exitCode?: number | null }).exitCode === null) {
      child.kill()
    }
    // wait briefly for the process to release the profile (Windows file
    // locks linger while the browser is still shutting down)
    await new Promise<void>((res) => {
      if ((child as { exitCode?: number | null }).exitCode !== null) return res()
      const t = setTimeout(res, 3000)
      child.once("exit", () => {
        clearTimeout(t)
        res()
      })
    })
    try {
      rmForceSafe(profileDir, { recursive: true })
    } catch {
      /* a locked leftover temp dir is reclaimed by the OS — never fail close */
    }
    return "浏览器会话已关闭，临时配置目录已清理。"
  }

  const execute = async (rawArgs: Record<string, unknown>, ctx: unknown): Promise<ToolResult> => {
    try {
      const args = rawArgs ?? {}
      const action = String(args.action ?? "").trim()
      const url = String(args.url ?? "").trim()
      // allowlist FIRST — an out-of-allowlist URL only proceeds after the
      // OFFICIAL dialog approves it (then the host passes the network layer
      // too); hard red lines (scheme / env-file) reject with no dialog
      if ((action === "open" || action === "navigate") && url) {
        const verdict = checkWebUrl(url, allowlist as readonly string[])
        if (!verdict.ok) {
          if (!verdict.askable || !verdict.url) {
            return toToolResult(tmError(tool, "permission", verdict.message))
          }
          const outcome = await askUserForTarget(ctx, {
            permission: tool,
            patterns: [verdict.url.toString()],
            metadata: { tool, url: url.slice(0, 200) },
          })
          if (outcome !== "approved") {
            return toToolResult(
              tmError(
                tool,
                "permission",
                verdict.message +
                  (outcome === "rejected" ? "。用户未批准。" : "。宿主无法弹出确认窗口（旧版协议）。"),
              ),
            )
          }
          approvedHosts.add(verdict.url.hostname)
        }
      }
      if (action === "open") {
        if (!url) return toToolResult(tmError(tool, "args", "缺少 url 参数"))
        if (session) {
          // already open: navigate instead of spawning a second browser
          return toToolResult(await navigateTo(url))
        }
        const headless = args.headless != null ? Boolean(args.headless) : resolveHeadless(env)
        const s = await ensureSession(headless)
        const out = await navigateTo(url)
        traj({ step_id: "browser", event: "open", headless })
        return toToolResult(
          `浏览器已启动（${headless ? "无头" : "有头窗口"}，隔离临时配置）。${out}`,
        )
      }
      if (action === "navigate") {
        if (!url) return toToolResult(tmError(tool, "args", "缺少 url 参数"))
        if (!session) return toToolResult(tmError(tool, "args", "没有打开的浏览器会话——先用 action:\"open\""))
        return toToolResult(await navigateTo(url))
      }
      if (action === "read") {
        if (!session) return toToolResult(tmError(tool, "args", "没有打开的浏览器会话——先用 action:\"open\""))
        const stepId = pipelines.nextStepId()
        traj({ step_id: stepId, event: "call", url: session.currentUrl.slice(0, 200) })
        const ev = await session.cdp.call(
          "Runtime.evaluate",
          { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
          session.sessionId,
        )
        const text = String((ev.result as { value?: unknown })?.value ?? "")
        traj({ step_id: stepId, event: "result", tokens: Math.ceil(text.length / 4) })
        return toToolResult(
          `页面文本（${session.currentUrl}）：\n${text.slice(0, 20000)}${text.length > 20000 ? "\n…(截断)" : ""}`,
        )
      }
      if (action === "screenshot") {
        if (!session) return toToolResult(tmError(tool, "args", "没有打开的浏览器会话——先用 action:\"open\""))
        const stepId = pipelines.nextStepId()
        traj({ step_id: stepId, event: "call", kind: "screenshot", url: session.currentUrl.slice(0, 200) })
        const shot = await session.cdp.call("Page.captureScreenshot", { format: "png" }, session.sessionId)
        const data = String((shot as { data?: string }).data ?? "")
        const png = Buffer.from(data, "base64")
        const dir = path.join(pipelines.store.stepsRoot(), stepId)
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, "screenshot.png")
        fs.writeFileSync(file, png)
        traj({ step_id: stepId, event: "result", bytes: png.length })
        return toToolResult(
          `截图已保存（${png.length} bytes）：${file}\n（PNG 已落 run store；上下文只携带路径，不携带像素。）`,
        )
      }
      if (action === "close") {
        traj({ step_id: "browser", event: "close" })
        return toToolResult(await closeSession())
      }
      return toToolResult(tmError(tool, "args", `未知 action "${String(action).slice(0, 30)}"——可用: open | navigate | read | screenshot | close`))
    } catch (err) {
      const e = err as { name?: string; message?: unknown }
      return toToolResult(tmError(tool, "execute", String(e?.message ?? err ?? "browser 操作失败")))
    }
  }

  async function navigateTo(url: string): Promise<string> {
    const s = session!
    await s.cdp.call("Page.navigate", { url }, s.sessionId)
    await s.cdp.waitEvent("Page.loadEventFired", s.sessionId, NAVIGATE_EVENT_TIMEOUT_MS).catch(() => {})
    s.currentUrl = url
    return `已导航：${url}`
  }

  const DESCRIPTION = `Interactive browser (governed, Plan C): drives the user's own Chromium-family browser HEADFUL via CDP pipe — a visible window opens on desktops; display-less Linux hosts automatically run headless (TM_BROWSER_HEADLESS=1|0 forces either way).  Actions:
- open: { url } — launch (or reuse) the session and navigate.  Uses your DEFAULT browser (Chromium-family; TM_BROWSER_PATH overrides; falls back to Edge/Chrome probes when the default is Firefox — CDP is Chromium-only).  Isolated temp profile (never your real profile); per-request DOMAIN ALLOWLIST enforced at the network layer (seeded = tm_webfetch's hosts; extend via TM_WEBFETCH_ALLOWED_DOMAINS).
- navigate: { url } · read: extract page text (threshold-governed like tm_read) · screenshot: save PNG into the run store, only the path enters context · close: kill + cleanup.
- Fixed priority ladder: ① tm_* governed tools → ② user MCP/plugin tools → ③ reasoning (never fabricate).  If no browser is installed (TM_BROWSER_PATH override exists), a structured error tells you to fall back to tm_webfetch / MCP.
- Network roles: team + researcher full grant, tester browser-only (UI verification).  Out-of-allowlist open/navigate routes through the OFFICIAL confirmation dialog (approved hosts pass the network layer for the session); env-file URLs and non-http(s) schemes hard-reject.`

  return {
    description: DESCRIPTION,
    args: deps.args ?? {
      action: { descriptor: "action: open|navigate|read|screenshot|close (required)" },
      url: { descriptor: "url: string (open/navigate, allowlisted https)" },
      headless: { descriptor: "headless: boolean (open, optional — default auto)" },
    },
    execute,
    dispose: () => {
      void closeSession().catch(() => {})
    },
  }
}

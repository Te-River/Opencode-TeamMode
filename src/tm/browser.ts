/**
 * tm_browser — governed interactive browser (Plan C: the user's own
 * Chromium-family browser, headful by default on desktops).
 *
 * T5 engine split (design board ② "TM_BROWSER_ENGINE" + R2 verdict):
 *   - PRIMARY engine: playwright-core — dynamic import ONLY (the package is
 *     declared in dependencies but NOT installed at build time; a static
 *     import would break tsc).  A failed import or node < 20 degrades the
 *     session to the cdp-legacy engine automatically, per plugin instance.
 *   - cdp-legacy engine: the original hand-rolled CDP pipe transport
 *     (JSON + NUL framing over fds 3/4, zero deps — smoke-proven) kept
 *     verbatim as the fallback.  On cdp-legacy only the core subset works
 *     (open/navigate/read/screenshot/close + navigate_page/take_screenshot/
 *     list_pages/evaluate_script aliases); the snapshot-first actions
 *     (take_snapshot + uid addressing, 16-verb chrome-devtools-mcp surface)
 *     require the playwright engine.
 *
 * Action surface aligns with chrome-devtools-mcp's 16 verbs (R2 mapping):
 *   navigate_page · take_snapshot · click · fill · hover · drag ·
 *   press_key · select_page · upload_file · wait_for · evaluate_script ·
 *   list_console_messages · list_network_requests · list_pages ·
 *   take_screenshot · handle_dialog
 * plus the legacy compatibility verbs open / navigate / read /
 * screenshot / close.  Snapshot-first discipline: take_snapshot returns
 * the ariaSnapshot YAML with an INJECTED [uid=eN] per node (playwright has
 * no uid concept — SnapshotIndex below is our own snapshot→locator
 * registry); follow-up actions address nodes by that uid (or an explicit
 * selector escape hatch) instead of guessed locators.
 *
 * Hardening (unchanged from the CDP era, ported to both engines):
 *   - isolated temp profile (never the user's real browser profile);
 *     persistent login is ONLY via an explicit TM_BROWSER_USER_DATA_DIR;
 *   - domain allowlist enforced at the NETWORK layer: playwright
 *     context.route() abort / CDP Fetch.requestPaused fail — every request
 *     and every redirect hop re-checked (per-hop analog);
 *   - out-of-allowlist open/navigate routes through the OFFICIAL dialog
 *     BEFORE any spawn; approved hosts also pass the network layer;
 *   - hardened context: real-Chrome UA + zh-CN Accept-Language,
 *     no-first-run / no-extensions / mute launch flags, 3 s default action
 *     timeout (the prompt's "3000 ms budget" is the tool's default, not an
 *     aspiration), no networkidle waits anywhere;
 *   - dispose kills the child / closes the browser.
 *
 * Environment adaptivity (different OpenCode hosts):
 *   - headful by default (Plan C); display-less Linux (no DISPLAY/
 *     WAYLAND_DISPLAY) automatically falls back to headless; TM_BROWSER_
 *     HEADLESS=1|0 forces either way;
 *   - browser discovery (SHARED by both engines): TM_BROWSER_PATH
 *     override, then the USER'S DEFAULT browser (Windows registry / Linux
 *     xdg-settings) when it is Chromium-family — CDP is Chromium-proprietary
 *     and playwright channels only speak Chromium too, so a Firefox default
 *     falls through — then per-OS candidate paths (Edge first on Windows;
 *     Chrome/Chromium elsewhere).  No browser → structured error, the agent
 *     falls back to tm_webfetch / user MCP tools.
 *
 * Role access mirrors tm_webfetch: network roles (team + researcher) only,
 * tester browser-only (UI verification).
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { checkWebUrl, seedWebfetchDomains } from "./webfetch.js"
import { askUserForTarget } from "./perm-ask.js"
import { assertReadablePath } from "./guard.js"
import { isEnvFilePath } from "../envprotect.js"
import type { ToolResult } from "../types.js"
import { tmError, toToolResult } from "./result.js"
import type { TmConfig } from "./config.js"
import { estimateTokens } from "./config.js"
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

/** Parse `reg query "...\shell\open\command" /ve` output → exe path.
 *  The quoted capture stops at the closing quote, so the `" -- %1"` style
 *  URL-template tail never leaks into the returned path. */
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
  readonly onEvent = (handler: (m: CdpMessage) => void) => (this.eventHandler = handler)
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

// ---------- engine selection (T5) ---------------------------------------------

export type BrowserEngineKind = "playwright" | "cdp-legacy"

/** playwright-core 1.63 targets node >= 20; on anything older we refuse the
 *  engine up-front and stay on the zero-dependency CDP pipe (the node>=18
 *  package floor keeps the plugin itself loadable — only the playwright
 *  PRIMARY is gated here, cdp-legacy carries node 18/19 hosts). */
export const PLAYWRIGHT_MIN_NODE_MAJOR = 20

/** "v22.3.1" / "20" -> major number; unparseable -> 0 (fail toward the
 *  always-available cdp-legacy engine). */
export function nodeMajorOf(version: string): number {
  const m = /^v?(\d+)/.exec(String(version ?? "").trim())
  return m ? Number(m[1]) : 0
}

export interface EngineSelection {
  kind: BrowserEngineKind
  /** The imported playwright-core namespace (present iff kind=playwright). */
  pw?: PwModule
  /** Why this kind was chosen (preference / node gate / import failure). */
  reason?: string
}

/** The REAL loader — a VARIABLE specifier so tsc never tries to resolve
 *  "playwright-core" at build time (types ship inside the package, which may
 *  be absent from node_modules).  Under ESM, import(variable) yields the
 *  module namespace typed as any. */
export async function defaultImportPlaywright(): Promise<unknown> {
  const specifier = "playwright-core"
  return await import(specifier)
}

/** Pure engine-selection seam (exported for test-browser.mjs):
 *  cdp-legacy preference → legacy WITHOUT ever importing; node < 20 →
 *  legacy without importing; playwright preference → import, verify the
 *  chromium.launch shape, degrade to legacy on ANY failure. */
export async function selectBrowserEngine(opts: {
  preference: string | undefined
  nodeMajor: number
  importPlaywright: () => Promise<unknown>
}): Promise<EngineSelection> {
  const preference: BrowserEngineKind = opts.preference === "cdp-legacy" ? "cdp-legacy" : "playwright"
  if (preference === "cdp-legacy") {
    return { kind: "cdp-legacy", reason: "TM_BROWSER_ENGINE=cdp-legacy 偏好" }
  }
  if (opts.nodeMajor < PLAYWRIGHT_MIN_NODE_MAJOR) {
    return {
      kind: "cdp-legacy",
      reason: `node ${opts.nodeMajor || "?"} < ${PLAYWRIGHT_MIN_NODE_MAJOR} — playwright-core 不受支持，自动降级 cdp-legacy`,
    }
  }
  try {
    const mod = (await opts.importPlaywright()) as PwModule | null | undefined
    if (!mod || typeof mod.chromium?.launch !== "function") {
      throw new Error("playwright-core 模块形状异常（缺 chromium.launch）")
    }
    return { kind: "playwright", pw: mod }
  } catch (e) {
    return {
      kind: "cdp-legacy",
      reason: `playwright-core 加载失败：${(e as Error)?.message ?? String(e)} — 自动降级 cdp-legacy（快照类动作不可用）`,
    }
  }
}

// ---------- playwright structural seam ----------------------------------------
/* Minimal hand-rolled interfaces for the playwright-core APIs tm_browser
 * uses.  They exist so OUR call sites are type-checked; playwright's own
 * types stay unresolvable at build time by design (the package is not
 * installed).  Mocks in test-browser.mjs satisfy the same shapes. */

export interface PwModule {
  chromium: {
    launch(opts: Record<string, unknown>): Promise<PwBrowser>
    launchPersistentContext(userDataDir: string, opts: Record<string, unknown>): Promise<PwBrowserContext>
  }
}
export interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwBrowserContext>
  close(): Promise<void>
}
export interface PwBrowserContext {
  route(pattern: string, handler: (route: PwRoute, request: PwRequestInfo) => Promise<void> | void): Promise<void> | void
  pages(): PwPage[]
  newPage(): Promise<PwPage>
  close(): Promise<void>
}
export interface PwPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>
  locator(selector: string): PwLocator
  getByRole(role: string, opts?: Record<string, unknown>): PwLocator
  getByText(text: string): PwLocator
  keyboard: { press(key: string): Promise<unknown> }
  evaluate(pageFunction: string): Promise<unknown>
  screenshot(opts?: Record<string, unknown>): Promise<Uint8Array>
  on(event: string, handler: (...args: any[]) => void): void
  url(): string
  title?(): Promise<string>
  bringToFront?(): Promise<void>
}
export interface PwLocator {
  ariaSnapshot(): Promise<string>
  click(): Promise<unknown>
  fill(value: string): Promise<unknown>
  hover(): Promise<unknown>
  pressKey(key: string): Promise<unknown>
  setInputFiles(files: string | string[]): Promise<unknown>
  waitFor(opts?: Record<string, unknown>): Promise<unknown>
  nth(index: number): PwLocator
  dragTo(target: PwLocator): Promise<unknown>
}
export interface PwRoute {
  continue(): Promise<unknown>
  abort(): Promise<unknown>
}
export interface PwRequestInfo {
  url(): string
  method?(): string
}
export interface PwConsoleMessage {
  type(): string
  text(): string
}
export interface PwResponseInfo {
  url(): string
  status(): number
  request(): PwRequestInfo
}
export interface PwDialog {
  type(): string
  message(): string
  accept(promptText?: string): Promise<unknown>
  dismiss(): Promise<unknown>
}

// ---------- snapshot→locator uid registry (T5, closes the playwright gap) ----

export interface SnapshotEntry {
  role: string
  name?: string
  nth: number
}

/** ariaSnapshot yields plain YAML with NO addressable id, while the
 *  chrome-devtools-mcp muscle memory this tool aligns to is uid-addressed.
 *  The missing layer is built here: each take_snapshot re-indexes every YAML
 *  node (`- <role> "<name>" …`), injects `[uid=eN]` inline, and remembers
 *  (role, name, nth-of-kind); later actions resolve uid →
 *  `page.getByRole(role, { name, exact: true }).nth(nth)`.  Uids are
 *  renumbered on every snapshot (one action, one observation); an
 *  unknown/stale uid errors back to take_snapshot instead of falling back
 *  to guessed locators. */
export class SnapshotIndex {
  private entries = new Map<string, SnapshotEntry>()
  private next = 0

  get size(): number {
    return this.entries.size
  }

  /** Reset + parse + annotate the ariaSnapshot YAML in one pass. */
  annotate(yaml: string): string {
    this.entries.clear()
    this.next = 0
    const counters = new Map<string, number>()
    const out: string[] = []
    for (const line of String(yaml ?? "").split(/\r?\n/)) {
      // `- role`, `- role "name"`, `- role:`, `- role "name" [attrs]` …
      // the `text` pseudo-role carries no interactive semantics: skip it.
      const m = /^(\s*-\s+)([A-Za-z][\w-]*)((?:"[^"]*"|.)*?)$/.exec(line)
      if (!m || m[2] === "text") {
        out.push(line)
        continue
      }
      const role = m[2]
      const rest = m[3]
      const uid = `e${++this.next}`
      const rawName = /"((?:[^"\\]|\\.)*)"/.exec(rest)?.[1]
      const name = rawName === undefined ? undefined : unescapeAriaName(rawName)
      const key = `${role}\u0000${name ?? ""}`
      const nth = counters.get(key) ?? 0
      counters.set(key, nth + 1)
      this.entries.set(uid, { role, name, nth })
      // container lines (`- list:`) get the uid BEFORE the colon so the
      // YAML `key:` child-anchor semantics stay intact; names may contain
      // colons, hence the startsWith check instead of a split.
      out.push(rest.startsWith(":") ? `${m[1]}${role} [uid=${uid}]${rest}` : `${line} [uid=${uid}]`)
    }
    return out.join("\n")
  }

  get(uid: string): SnapshotEntry | undefined {
    return this.entries.get(String(uid ?? "").trim())
  }

  /** uid → playwright locator; null = unknown uid / role the engine cannot
   *  address (the caller renders the take_snapshot-first guidance). */
  locatorFor(page: PwPage, uid: string): PwLocator | null {
    const entry = this.get(uid)
    if (!entry) return null
    try {
      const base = entry.name !== undefined ? page.getByRole(entry.role, { name: entry.name, exact: true }) : page.getByRole(entry.role)
      return base.nth(entry.nth)
    } catch {
      return null
    }
  }
}

/** ariaSnapshot escapes whitespace/quotes inside names (\s \n \t \" \\). */
export function unescapeAriaName(raw: string): string {
  return String(raw).replace(/\\(.)/g, (_, c: string) => (c === "s" ? " " : c === "n" ? "\n" : c === "t" ? "\t" : c))
}

// ---------- action surface (R2: chrome-devtools-mcp 16-verb alignment) --------

/** The 16 canonical verbs, named byte-identical to chrome-devtools-mcp. */
export const BROWSER_PLAYWRIGHT_ACTIONS = [
  "navigate_page",
  "take_snapshot",
  "click",
  "fill",
  "hover",
  "drag",
  "press_key",
  "select_page",
  "upload_file",
  "wait_for",
  "evaluate_script",
  "list_console_messages",
  "list_network_requests",
  "list_pages",
  "take_screenshot",
  "handle_dialog",
] as const

/** Legacy compat verbs that ride on top of the 16 (both engines). */
export const BROWSER_COMPAT_ACTIONS = ["open", "navigate", "read", "screenshot", "close"] as const

/** What the cdp-legacy fallback can still do (R2: degradation must keep the
 *  §6o behavior; everything snapshot-shaped is playwright-only). */
export const BROWSER_LEGACY_ACTIONS = [
  "open",
  "navigate",
  "navigate_page",
  "read",
  "screenshot",
  "take_screenshot",
  "list_pages",
  "evaluate_script",
  "close",
] as const

/** Default action/wait budget — the prompt's "3000 ms" discipline is the
 *  ENGINE default, so agents that forget a timeout still fail fast. */
const PW_DEFAULT_TIMEOUT_MS = 3000
const OBSERVE_BUFFER_CAP = 200

const HARDENED_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const SPAWN_TIMEOUT_MS = 15_000
const NAVIGATE_EVENT_TIMEOUT_MS = 15_000

// ---------- tool ----------------------------------------------------------------

interface ActiveSession {
  kind: BrowserEngineKind
  currentUrl: string
  /** Engine action dispatch; throws Error with an agent-actionable message
   *  (the execute() catch renders it as phase=execute). */
  act(action: string, args: Record<string, unknown>, stepId: string): Promise<string>
  close(): Promise<string>
}

export function buildTmBrowserTool(deps: {
  pipelines: TmPipelines
  cfg: TmConfig
  env?: Record<string, string | undefined>
  args?: Record<string, unknown>
  /** Test seam: replace the dynamic playwright-core import. */
  importPlaywright?: () => Promise<unknown>
  /** Test seam: pretend node major version for the engine gate. */
  nodeMajor?: number
}): {
  description: string
  args: Record<string, unknown>
  execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>
  dispose: () => void
  engineInfo: () => { kind: BrowserEngineKind | null; reason: string | null }
} {
  const { pipelines } = deps
  const env = deps.env ?? process.env
  const tool = "tm_browser"
  const traj = (e: Record<string, unknown>) => pipelines.store.appendTrajectory({ tool, ...e })
  let session: ActiveSession | null = null
  // m2 (fix round): SAME seed policy as tm_webfetch / tm_search — the
  // built-in default list gains the T4 engine home hosts (api.stackexchange
  // .com, hn.algolia.com) so jump-reading a search hit stops re-popping the
  // dialog; a narrowed TM_WEBFETCH_ALLOWED_DOMAINS is never widened.
  const allowlist = seedWebfetchDomains(
    (deps.cfg as { webfetchAllowedDomains?: readonly string[] }).webfetchAllowedDomains ?? ["*"],
  )
  // hosts approved through the OFFICIAL dialog this plugin lifetime — the
  // network layer (both engines) consults this in addition to the static allowlist
  const approvedHosts = new Set<string>()
  const snapshotBudget = Math.max(10, Number(deps.cfg?.browserSnapshotMaxTokens) || 1200)

  // ---------- engine selection (cached per plugin instance) ----------
  let selPromise: Promise<EngineSelection> | null = null
  let lastSel: EngineSelection | null = null
  const preference = String((deps.cfg as { browserEngine?: string })?.browserEngine ?? "playwright")
  const selection = (): Promise<EngineSelection> => {
    if (!selPromise) {
      selPromise = selectBrowserEngine({
        preference,
        nodeMajor: deps.nodeMajor ?? nodeMajorOf(process.versions.node),
        importPlaywright: deps.importPlaywright ?? defaultImportPlaywright,
      }).then((sel) => {
        lastSel = sel
        traj({ step_id: "browser", event: "engine", kind: sel.kind, reason: (sel.reason ?? "").slice(0, 200) })
        return sel
      })
    }
    return selPromise
  }

  /** Observe-payload cap shared by snapshot / console / network / eval. */
  function capTokens(text: string, note: string): string {
    if (estimateTokens(text) <= snapshotBudget) return text
    const lines = text.split("\n")
    let acc = 0
    let i = 0
    for (; i < lines.length; i++) {
      const cost = estimateTokens(lines[i]) + 1
      if (acc + cost > snapshotBudget) break
      acc += cost
    }
    return `${lines.slice(0, i).join("\n")}\n${note}`
  }

  function saveShotPng(bytes: Uint8Array, stepId: string): { file: string; png: Buffer } {
    const png = Buffer.from(bytes)
    const dir = path.join(pipelines.store.stepsRoot(), stepId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "screenshot.png")
    fs.writeFileSync(file, png)
    traj({ step_id: stepId, event: "result", bytes: png.length })
    return { file, png }
  }

  function shotOutput(file: string, bytes: number): string {
    return `截图已保存（${bytes} bytes）：${file}\n（PNG 已落 run store；上下文只携带路径，不携带像素。）`
  }

  function pageTextOutput(url: string, text: string): string {
    return `页面文本（${url}）：\n${text.slice(0, 20000)}${text.length > 20000 ? "\n…(截断)" : ""}`
  }

  function discoveryError(): Error {
    return new Error(
      "本机未找到可用的浏览器（按 Edge/Chrome/Chromium 顺序探测失败）。" +
        "设置 TM_BROWSER_PATH 指向浏览器可执行文件，或改用 tm_webfetch / 用户 MCP 工具。",
    )
  }

  /**
   * M1 (upload_file exfil): the domain allowlist constrains the network
   * DESTINATION but never the local SOURCE — an unguarded filePath could
   * upload .env / key files to a whitelisted host's form. Reuses the read
   * pipeline's P2 containment verbatim (workspace root + blackboard +
   * trajectory; realpath-verified, fail-closed on unresolvable paths) and
   * then applies the R6 env-file classifier, so *.env / shell-rc files are
   * refused INSIDE the root too. The env refusal echoes no path (R6 privacy
   * line); the scope verdict keeps the tm_read/tm_grep message shape.
   */
  function uploadExfilGuard(args: Record<string, unknown>, ctx: unknown): string | null {
    const raw = (args.filePath ?? (args as { files?: unknown }).files) as unknown
    const files = (Array.isArray(raw) ? raw : [raw]).map((f) => String(f ?? "").trim()).filter(Boolean)
    if (!files.length) return null // "缺少 filePath" stays act()'s own args error
    const d = (ctx as { directory?: unknown } | null | undefined)?.directory
    const root = typeof d === "string" && d ? d : process.cwd()
    const extra = [pipelines.store.blackboardRoot, pipelines.store.trajectoryRoot].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    )
    for (const f of files) {
      if (isEnvFilePath(f)) return "拒绝上传（R6 红线：.env / shell rc 家族文件永不离开本机）"
      const scope = assertReadablePath(root, f, extra)
      if (!scope.ok) return scope.message
    }
    return null
  }

  // ================= cdp-legacy engine (原手写 CDP 管道，保留不删) =============

  async function openLegacySession(headless: boolean): Promise<ActiveSession> {
    const executable = findBrowserExecutable(env)
    if (!executable) throw discoveryError()
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "tm-browser-"))
    const child = spawn(
      executable,
      [
        headless ? "--headless=new" : "--start-maximized",
        "--remote-debugging-pipe",
        `--user-data-dir=${profileDir}`,
        // real-Chrome UA even under --headless=new (which some sites detect
        // via the "HeadlessChrome" token otherwise) + zh-CN Accept-Language
        `--user-agent=${HARDENED_UA}`,
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
    const { sessionId } = (await cdp.call("Target.attachToTarget", { targetId: page.targetId, flatten: true })) as { sessionId: string }
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

    const sess: ActiveSession = {
      kind: "cdp-legacy",
      currentUrl: "about:blank",
      async act(action, args, stepId) {
        if (action === "navigate" || action === "navigate_page") {
          const url = String(args.url ?? "").trim()
          await cdp.call("Page.navigate", { url }, sessionId)
          await cdp.waitEvent("Page.loadEventFired", sessionId, NAVIGATE_EVENT_TIMEOUT_MS).catch(() => {})
          sess.currentUrl = url
          return `已导航：${url}`
        }
        if (action === "read") {
          traj({ step_id: stepId, event: "call", url: sess.currentUrl.slice(0, 200) })
          const ev = await cdp.call(
            "Runtime.evaluate",
            { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
            sessionId,
          )
          const text = String((ev.result as { value?: unknown })?.value ?? "")
          traj({ step_id: stepId, event: "result", tokens: Math.ceil(text.length / 4) })
          return pageTextOutput(sess.currentUrl, text)
        }
        if (action === "screenshot" || action === "take_screenshot") {
          traj({ step_id: stepId, event: "call", kind: "screenshot", url: sess.currentUrl.slice(0, 200) })
          const shot = await cdp.call("Page.captureScreenshot", { format: "png" }, sessionId)
          const png = Buffer.from(String((shot as { data?: string }).data ?? ""), "base64")
          const { file } = saveShotPng(new Uint8Array(png), stepId)
          return shotOutput(file, png.length)
        }
        if (action === "list_pages") {
          const t = await cdp.call("Target.getTargets")
          const pages = (t.targetInfos as Array<{ type: string; url?: string; title?: string }>).filter((x) => x.type === "page")
          const lines = pages.map((p, i) => `${i}: ${String(p.url ?? "")} ${String(p.title ?? "")}`.trimEnd())
          return `标签页（${pages.length}）：\n${lines.join("\n") || "（无）"}`
        }
        if (action === "evaluate_script") {
          const src = String(args.function ?? args.expression ?? "").trim()
          if (!src) throw new Error('缺少 expression/function 参数（evaluate_script 需要一个 JS 表达式）')
          traj({ step_id: stepId, event: "call", kind: "evaluate" })
          const ev = await cdp.call("Runtime.evaluate", { expression: src, returnByValue: true }, sessionId)
          const value = (ev.result as { value?: unknown })?.value
          return capTokens(
            `执行结果：${JSON.stringify(value ?? null)}`,
            "…(结果超长已截断)",
          )
        }
        throw new Error(
          `action "${action}" 需要 playwright 引擎（当前为 cdp-legacy 降级：playwright-core 未安装或 node<20）。` +
            `cdp-legacy 可用: ${BROWSER_LEGACY_ACTIONS.filter((a) => a !== "open" && a !== "close").join(" | ")}`,
        )
      },
      async close() {
        child.off?.("exit", onExit)
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
      },
    }
    const onExit = () => {
      if (session === sess) session = null
      // best-effort: the profile may still be file-locked during shutdown —
      // a leftover temp dir is reclaimed by the OS, never an error for the task
      try {
        rmForceSafe(profileDir, { recursive: true })
      } catch {
        /* ignore */
      }
    }
    child.on("exit", onExit)
    return sess
  }

  // ================= playwright engine (primary) ==============================

  async function openPlaywrightSession(pw: PwModule, headless: boolean): Promise<ActiveSession> {
    const executable = findBrowserExecutable(env)
    if (!executable) throw discoveryError()
    const launchArgs = [
      "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      "--disable-background-networking", "--mute-audio",
      ...(headless ? [] : ["--start-maximized"]),
    ]
    const contextOpts: Record<string, unknown> = {
      userAgent: HARDENED_UA,
      locale: "zh-CN",
      extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      // the 3000 ms observation budget is the engine default (see header)
      timeout: PW_DEFAULT_TIMEOUT_MS,
      // headful: honor --start-maximized (null viewport = the OS window size)
      viewport: headless ? undefined : null,
    }
    const persistentDir = String(env.TM_BROWSER_USER_DATA_DIR ?? "").trim()
    // R2: channel launches are cross-version-fragile (official warning), so
    // they are a SMOKE-ONLY attempt; any failure retries with the explicit
    // executablePath from our own discovery layer.
    const channel = /msedge/i.test(executable) ? "msedge" : /chrome/i.test(executable) ? "chrome" : undefined
    let browser: PwBrowser | null = null
    let context: PwBrowserContext
    let via = "executablePath"
    if (persistentDir) {
      context = await pw.chromium.launchPersistentContext(persistentDir, {
        ...contextOpts,
        ...(channel ? { channel } : { executablePath: executable }),
        headless,
        args: launchArgs,
      })
      via = `persistent(${channel ?? "executablePath"})`
    } else {
      try {
        browser = await pw.chromium.launch({ ...(channel ? { channel } : { executablePath: executable }), headless, args: launchArgs })
        via = channel ? `channel(${channel})` : "executablePath"
      } catch (e1) {
        if (!channel) throw e1
        browser = await pw.chromium.launch({ executablePath: executable, headless, args: launchArgs })
        via = "executablePath(channel 回退)"
      }
      context = await browser.newContext(contextOpts)
    }

    const snapIndex = new SnapshotIndex()
    const state = {
      page: context.pages()[0] ?? (await context.newPage()),
      dialogs: [] as PwDialog[],
      consoleBuf: [] as Array<{ type: string; text: string }>,
      netBuf: [] as Array<{ method: string; url: string; status?: number; failure?: string; blocked?: boolean }>,
    }
    const attached = new WeakSet<PwPage>()
    const attach = (p: PwPage): void => {
      if (attached.has(p)) return // select_page may bounce back to an already-hooked tab
      attached.add(p)
      p.on("console", (msg: PwConsoleMessage) => {
        state.consoleBuf.push({ type: String(msg?.type?.() ?? "log"), text: String(msg?.text?.() ?? "") })
        if (state.consoleBuf.length > OBSERVE_BUFFER_CAP) state.consoleBuf.shift()
      })
      p.on("pageerror", (err: unknown) => {
        state.consoleBuf.push({ type: "pageerror", text: String((err as Error)?.message ?? err) })
        if (state.consoleBuf.length > OBSERVE_BUFFER_CAP) state.consoleBuf.shift()
      })
      p.on("request", (req: PwRequestInfo) => {
        state.netBuf.push({ method: req?.method?.() ?? "?", url: String(req?.url?.() ?? "").slice(0, 300) })
        if (state.netBuf.length > OBSERVE_BUFFER_CAP) state.netBuf.shift()
      })
      p.on("response", (res: PwResponseInfo) => {
        state.netBuf.push({
          method: res?.request?.()?.method?.() ?? "?",
          url: String(res?.url?.() ?? "").slice(0, 300),
          status: Number(res?.status?.() ?? 0) || undefined,
        })
        if (state.netBuf.length > OBSERVE_BUFFER_CAP) state.netBuf.shift()
      })
      p.on("requestfailed", (req: PwRequestInfo) => {
        state.netBuf.push({ method: req?.method?.() ?? "?", url: String(req?.url?.() ?? "").slice(0, 300), failure: "requestfailed" })
        if (state.netBuf.length > OBSERVE_BUFFER_CAP) state.netBuf.shift()
      })
      // dialogs are HELD for handle_dialog (registering the handler opts us
      // out of playwright's implicit auto-dismiss)
      p.on("dialog", (d: PwDialog) => {
        state.dialogs.push(d)
        if (state.dialogs.length > 8) state.dialogs.shift()
      })
    }
    attach(state.page)

    // ---- network-layer allowlist: context.route() (CDP Fetch 的迁移面) ----
    const routeHandler = async (route: PwRoute, request: PwRequestInfo): Promise<void> => {
      const u = String(request.url?.() ?? "")
      // data:/blob:/about: never reach playwright's route anyway; keep the
      // non-http hard-reject semantics identical to the CDP-era behavior
      if (/^(about|data|blob):/i.test(u)) {
        await route.continue().catch(() => {})
        return
      }
      const verdict = checkWebUrl(u, allowlist as readonly string[])
      let pass = verdict.ok
      if (!pass) {
        try {
          pass = approvedHosts.has(new URL(u).hostname)
        } catch {
          pass = false
        }
      }
      if (pass) {
        await route.continue().catch(() => {})
      } else {
        // per-hop re-check lands here for every redirect hop too
        traj({ step_id: "browser", event: "blocked", url: u.slice(0, 200) })
        state.netBuf.push({ method: request.method?.() ?? "?", url: u.slice(0, 300), blocked: true })
        await route.abort().catch(() => {})
      }
    }
    // M2 (fix round) fail-closed: the route gate is playwright's analog of
    // the CDP leg's AWAITED Fetch.enable — if registration fails the session
    // would browse with NO network whitelist. Close the context (persistent:
    // the only handle; launched: plus the browser) and surface an execute
    // error; a swallowed .catch(()=>{}) was a fail-open hole.
    try {
      await Promise.resolve(context.route("**/*", routeHandler))
    } catch (e) {
      await Promise.resolve(context.close()).catch(() => {})
      if (browser) await Promise.resolve(browser.close()).catch(() => {})
      traj({ step_id: "browser", event: "gate_register_failed", reason: String((e as Error)?.message ?? e).slice(0, 200) })
      throw new Error(
        `网络白名单闸注册失败（context.route）——已 fail-closed 关闭浏览器会话，不会留下无白名单的窗口。` +
          `原因：${String((e as Error)?.message ?? e)}`,
      )
    }

    /** uid → locator with the snapshot-first guidance errors (R2: 禁猜
     *  locator — only uid addressing or an explicit selector escape). */
    const targetOf = (uidKey: string, selKey: string, args: Record<string, unknown>): PwLocator => {
      const uid = String(args[uidKey] ?? "").trim()
      if (uid) {
        const loc = snapIndex.locatorFor(state.page, uid)
        if (!loc) {
          throw new Error(
            `uid "${uid}" 不在当前快照中（快照会重新编号）——先 action:"take_snapshot" 再用返回的 [uid=...] 寻址`,
          )
        }
        return loc
      }
      const sel = String(args[selKey] ?? "").trim()
      if (sel) return state.page.locator(sel)
      throw new Error(
        `缺少 ${uidKey}/selector——tm_browser 快照优先：先 action:"take_snapshot"，动作只按快照里的 [uid=...] 寻址（或显式 selector 逃生舱），禁止猜 locator`,
      )
    }

    /** Human-readable addressing echo for action results (no full locators
     *  into context — uid tokens only). */
    const describeTarget = (args: Record<string, unknown>, uidKey = "uid"): string => {
      const uid = String(args[uidKey] ?? "").trim()
      if (uid) return `uid "${uid}"`
      const sel = String(args[uidKey === "uid" ? "selector" : "targetSelector"] ?? "").trim()
      return sel ? `selector "${sel.slice(0, 60)}"` : "目标"
    }

    const sess: ActiveSession = {
      kind: "playwright",
      currentUrl: "about:blank",
      async act(action, args, stepId) {
        if (action === "navigate" || action === "navigate_page") {
          const url = String(args.url ?? "").trim()
          // domcontentloaded ONLY — networkidle is banned (prompt discipline)
          await state.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 })
          sess.currentUrl = state.page.url?.() || url
          return `已导航：${url}`
        }
        if (action === "read") {
          traj({ step_id: stepId, event: "call", url: sess.currentUrl.slice(0, 200) })
          const text = String((await state.page.evaluate("document.body ? document.body.innerText : ''")) ?? "")
          traj({ step_id: stepId, event: "result", tokens: Math.ceil(text.length / 4) })
          return pageTextOutput(sess.currentUrl, text)
        }
        if (action === "screenshot" || action === "take_screenshot") {
          traj({ step_id: stepId, event: "call", kind: "screenshot", url: sess.currentUrl.slice(0, 200) })
          const bytes = await state.page.screenshot({ type: "png", fullPage: Boolean(args.fullPage) })
          const { file, png } = saveShotPng(bytes, stepId)
          return shotOutput(file, png.length)
        }
        if (action === "take_snapshot") {
          traj({ step_id: stepId, event: "call", kind: "snapshot", url: sess.currentUrl.slice(0, 200) })
          let yaml: string
          try {
            yaml = await state.page.locator("body").ariaSnapshot()
          } catch (e) {
            throw new Error(
              `ariaSnapshot 不可用（playwright-core 版本过旧或缺失）：${(e as Error).message} —— 升级 playwright-core（需 ≥1.65 才有 locator.ariaSnapshot）`,
            )
          }
          const annotated = snapIndex.annotate(yaml)
          traj({ step_id: stepId, event: "result", tokens: estimateTokens(annotated), nodes: snapIndex.size })
          const body = capTokens(annotated, `…(快照超过 browserSnapshotMaxTokens=${snapshotBudget}，后续行已截断——用 read 拿原文或先滚动再快照)`)
          const hint = state.dialogs.length ? `\n注意：有 ${state.dialogs.length} 个未处理对话框——先 handle_dialog` : ""
          return `ARIA 快照（${sess.currentUrl} · ${snapIndex.size} 个可寻址节点）——后续动作按行内 [uid=eN] 寻址：\n${body}${hint}`
        }
        if (action === "click") {
          const loc = targetOf("uid", "selector", args)
          await loc.click()
          return `已点击 ${describeTarget(args)}${state.dialogs.length ? "；有未处理对话框——handle_dialog（同轮观察，勿另起动作）" : ""}`
        }
        if (action === "fill") {
          const loc = targetOf("uid", "selector", args)
          const text = String(args.text ?? "")
          await loc.fill(text)
          return `已填充 ${describeTarget(args)}（${text.length} 字符）`
        }
        if (action === "hover") {
          const loc = targetOf("uid", "selector", args)
          await loc.hover()
          return `已悬停 ${describeTarget(args)}`
        }
        if (action === "drag") {
          const from = targetOf("uid", "selector", args)
          const to = targetOf("targetUid", "targetSelector", args)
          await from.dragTo(to)
          return `已拖拽 ${describeTarget(args, "uid")} → ${describeTarget(args, "targetUid")}`
        }
        if (action === "press_key") {
          const key = String(args.key ?? "").trim()
          if (!key) throw new Error('缺少 key 参数（如 "Enter"、"Control+A"）')
          await state.page.keyboard.press(key)
          return `已按键：${key}`
        }
        if (action === "upload_file") {
          const loc = targetOf("uid", "selector", args)
          const raw = args.filePath ?? args.files
          const files = (Array.isArray(raw) ? raw : [raw]).map((f) => String(f ?? "").trim()).filter(Boolean)
          if (!files.length) throw new Error("缺少 filePath 参数（文件或文件数组，本机路径）")
          for (const f of files) {
            if (!fs.existsSync(f)) throw new Error(`上传文件不存在：${f.slice(0, 200)}`)
          }
          await loc.setInputFiles(files)
          return `已上传 ${files.length} 个文件到 ${describeTarget(args)}`
        }
        if (action === "wait_for") {
          const uid = String(args.uid ?? "").trim()
          const text = String(args.text ?? "").trim()
          const timeout = Math.min(30_000, Math.max(100, Number(args.timeoutMs) || PW_DEFAULT_TIMEOUT_MS))
          const what = uid ? `uid "${uid}"` : text ? `文本 "${text.slice(0, 80)}"` : ""
          if (!uid && !text) throw new Error('wait_for 需要 text 或 uid')
          const loc = uid ? targetOf("uid", "selector", { uid }) : state.page.getByText(text)
          await loc.waitFor({ state: "visible", timeout })
          return `等待命中：${what}（≤${timeout}ms 内可见）`
        }
        if (action === "evaluate_script") {
          const src = String(args.function ?? args.expression ?? "").trim()
          if (!src) throw new Error('缺少 expression/function 参数（JS 函数源或表达式）')
          traj({ step_id: stepId, event: "call", kind: "evaluate" })
          const value = await state.page.evaluate(src)
          return capTokens(`执行结果：${JSON.stringify(value ?? null)}`, "…(结果超长已截断)")
        }
        if (action === "list_pages") {
          const pages = context.pages()
          const lines: string[] = []
          for (let i = 0; i < pages.length; i++) {
            const p = pages[i]
            const title = await Promise.resolve(p.title?.()).catch(() => "")
            lines.push(`${i}${p === state.page ? "（当前）" : ""}: ${String(p.url?.() ?? "")} ${String(title ?? "")}`.trimEnd())
          }
          return `标签页（${pages.length}）：\n${lines.join("\n") || "（无）"}\n用 select_page { index } 切换。`
        }
        if (action === "select_page") {
          const idx = Number(args.index)
          const pages = context.pages()
          if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
            throw new Error(`index 越界（0..${pages.length - 1}）——先 list_pages`)
          }
          state.page = pages[idx]
          attach(state.page)
          await Promise.resolve(state.page.bringToFront?.()).catch(() => {})
          sess.currentUrl = String(state.page.url?.() ?? "")
          return `已切换到标签页 ${idx}：${sess.currentUrl}`
        }
        if (action === "list_console_messages") {
          const lines = state.consoleBuf.map((m, i) => `${i + 1}. [${m.type}] ${m.text.slice(0, 300)}`)
          if (args.clear) state.consoleBuf.length = 0
          return capTokens(`控制台消息（缓冲 ${lines.length}/${OBSERVE_BUFFER_CAP}）：\n${lines.join("\n") || "（无）"}`, "…(消息超长已截断)")
        }
        if (action === "list_network_requests") {
          const lines = state.netBuf.map((r, i) =>
            `${i + 1}. ${r.method} ${r.url}${r.status !== undefined ? ` → ${r.status}` : ""}${r.blocked ? " [被白名单拦截]" : r.failure ? ` [${r.failure}]` : ""}`,
          )
          return capTokens(`网络请求（缓冲 ${lines.length}/${OBSERVE_BUFFER_CAP}）：\n${lines.join("\n") || "（无）"}`, "…(列表超长已截断)")
        }
        if (action === "handle_dialog") {
          const d = state.dialogs.shift()
          if (!d) return "没有待处理的对话框（弹窗会在 click/submit 后出现——出现时 take_snapshot 的头部会提示，再 handle_dialog）。"
          const verdict = String(args.dialogAction ?? "accept").trim().toLowerCase()
          if (verdict === "dismiss") {
            await d.dismiss()
          } else {
            await d.accept(typeof args.promptText === "string" ? args.promptText : undefined)
          }
          return `已处理对话框（${d.type()}：「${d.message().slice(0, 120)}」→ ${verdict === "dismiss" ? "dismiss" : "accept"}）`
        }
        throw new Error(`playwright 引擎未知 action "${action}"`)
      },
      async close() {
        state.dialogs.length = 0
        await Promise.resolve(context.close()).catch(() => {})
        if (browser) await Promise.resolve(browser.close()).catch(() => {})
        if (persistentDir) {
          return `浏览器会话已关闭；持久配置目录已保留（下次 open 复用登录态）：${persistentDir}`
        }
        // playwright owns (and self-reclaims) the ephemeral profile under
        // the browser process — nothing on our side to delete
        return "浏览器会话已关闭，临时配置目录已清理。"
      },
    }
    return sess
  }

  // ---------- engine-neutral session lifecycle ----------

  async function ensureSession(headless: boolean): Promise<ActiveSession> {
    if (session) return session
    const sel = await selection()
    session =
      sel.kind === "playwright" && sel.pw
        ? await openPlaywrightSession(sel.pw, headless)
        : await openLegacySession(headless)
    return session
  }

  async function closeActive(): Promise<string> {
    const s = session
    if (!s) return "没有打开的浏览器会话。"
    session = null
    return s.close()
  }

  const ALL_ACTIONS = new Set<string>([...BROWSER_PLAYWRIGHT_ACTIONS, ...BROWSER_COMPAT_ACTIONS, "navigate_page"])

  const execute = async (rawArgs: Record<string, unknown>, ctx: unknown): Promise<ToolResult> => {
    try {
      const args = rawArgs ?? {}
      const action = String(args.action ?? "").trim()
      const url = String(args.url ?? "").trim()
      // allowlist FIRST — an out-of-allowlist URL only proceeds after the
      // OFFICIAL dialog approves it (then the host passes the network layer
      // too); hard red lines (scheme / env-file) reject with no dialog.
      // NOTE: this gate runs BEFORE engine selection — a blocked target
      // never touches playwright nor spawns anything (§6o invariant).
      if ((action === "open" || action === "navigate" || action === "navigate_page") && url) {
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
          return toToolResult(await session.act("navigate", { url }, "browser"))
        }
        const headless = args.headless != null ? Boolean(args.headless) : resolveHeadless(env)
        const s = await ensureSession(headless)
        const out = await s.act("navigate", { url }, "browser")
        traj({ step_id: "browser", event: "open", headless })
        const mode = headless ? "无头" : "有头窗口"
        const profile = String(env.TM_BROWSER_USER_DATA_DIR ?? "").trim() ? "持久登录配置" : "隔离临时配置"
        const note =
          lastSel && preference !== "cdp-legacy" && lastSel.kind === "cdp-legacy"
            ? `\n（引擎：cdp-legacy 降级——${lastSel.reason ?? ""}；完整 16 动作需 npm install playwright-core + node≥20）`
            : ""
        return toToolResult(`浏览器已启动（${mode}，${profile}）。${out}${note}`)
      }
      if (action === "navigate" || action === "navigate_page") {
        if (!url) return toToolResult(tmError(tool, "args", "缺少 url 参数"))
        if (!session) return toToolResult(tmError(tool, "args", '没有打开的浏览器会话——先用 action:"open"'))
        return toToolResult(await session.act(action, { url }, "browser"))
      }
      if (action === "close") {
        traj({ step_id: "browser", event: "close" })
        return toToolResult(await closeActive())
      }
      if (!ALL_ACTIONS.has(action)) {
        return toToolResult(
          tmError(
            tool,
            "args",
            `未知 action "${String(action).slice(0, 30)}"——可用: open | navigate | take_snapshot | click | fill | hover | drag | press_key | select_page | upload_file | wait_for | evaluate_script | list_console_messages | list_network_requests | list_pages | take_screenshot | handle_dialog | read | screenshot | close（快照优先：先 take_snapshot，按 [uid=…] 寻址）`,
          ),
        )
      }
      if (!session) return toToolResult(tmError(tool, "args", '没有打开的浏览器会话——先用 action:"open"'))
      // M1: upload_file SOURCE containment runs at the execute layer — the
      // engine act() has no host ctx. Out-of-P2 paths and R6 env files are
      // refused before setInputFiles can move any bytes.
      if (action === "upload_file") {
        const refusal = uploadExfilGuard(args, ctx)
        if (refusal) {
          traj({ step_id: "browser", event: "upload_refused", reason: refusal.slice(0, 200) })
          return toToolResult(tmError(tool, "permission", refusal))
        }
      }
      const stepId = pipelines.nextStepId()
      return toToolResult(await session.act(action, args, stepId))
    } catch (err) {
      const e = err as { name?: string; message?: unknown }
      return toToolResult(tmError(tool, "execute", String(e?.message ?? err ?? "browser 操作失败")))
    }
  }

  const DESCRIPTION = `Interactive browser (governed, Plan C): drives the user's own Chromium-family browser HEADFUL — playwright-core engine primary (npm install + node>=20; auto-degrades to the zero-dep CDP pipe when absent, snapshot actions then unavailable). Snapshot-first flow: open → take_snapshot → act by [uid] → observe again.
- 16 actions (chrome-devtools-mcp aligned): navigate_page { url } · take_snapshot { } → ariaSnapshot YAML with injected [uid=eN] · click/fill{text}/hover { uid|selector } · drag { uid, targetUid } · press_key { key } · select_page { index } · upload_file { uid, filePath } (filePath must live INSIDE the workspace/blackboard scope — .env & shell-rc files are refused) · wait_for { text|uid, timeoutMs<=3000 default } · evaluate_script { function } · list_console_messages · list_network_requests · list_pages · take_screenshot { fullPage? } → PNG path into the run store (pixels never enter context) · handle_dialog { dialogAction: accept|dismiss, promptText }.
- Compat actions: open { url } — launch/reuse + navigate; TM_BROWSER_PATH override → DEFAULT browser (Chromium-family only; Edge/Chrome probes fall through when it is Firefox). Isolated temp profile by default; persistent login ONLY via TM_BROWSER_USER_DATA_DIR (the real profile is never touched). navigate / read (page text) / screenshot / close also work.
- Discipline (enforced by defaults): act ONLY on uids from the latest take_snapshot — no guessed locators; one action then one observation; fold dialogs into the same round (snapshot header warns while a dialog is held); 3000 ms action budget; networkidle is never waited on; screenshots are the visual-last-resort, not the primary read.
- Network: per-request domain allowlist enforced INSIDE the page (playwright context.route abort / CDP Fetch interception), re-checked on every redirect hop; seeded = tm_webfetch's hosts (extend via TM_WEBFETCH_ALLOWED_DOMAINS). Out-of-allowlist open/navigate routes through the OFFICIAL confirmation dialog BEFORE any spawn; approved hosts pass the network layer for the session; env-file URLs and non-http(s) schemes hard-reject.
- Fixed priority ladder: ① tm_* governed tools → ② user MCP/plugin tools → ③ reasoning (never fabricate).  No browser installed → structured error, fall back to tm_webfetch / MCP.  Role grant: team + researcher full, tester browser-only (UI verification).`

  return {
    description: DESCRIPTION,
    args: deps.args ?? {
      action: { descriptor: "action: take_snapshot|click|fill|navigate_page|... (16 playwright verbs + open/navigate/read/screenshot/close)" },
      url: { descriptor: "url: string (open/navigate/navigate_page, allowlisted https)" },
      headless: { descriptor: "headless: boolean (open, optional — default auto)" },
      uid: { descriptor: "uid: snapshot [uid=eN] token (click/fill/hover/drag/upload_file/wait_for)" },
      selector: { descriptor: "selector: CSS/text locator escape hatch (only when a snapshot cannot express the node)" },
      targetUid: { descriptor: "targetUid: drag destination uid" },
      targetSelector: { descriptor: "targetSelector: drag destination selector" },
      text: { descriptor: "text: fill value / wait_for visible text" },
      key: { descriptor: "key: press_key chord, e.g. Enter|Control+A" },
      function: { descriptor: "function: JS function source for evaluate_script" },
      filePath: { descriptor: "filePath: local file path(s) for upload_file" },
      index: { descriptor: "index: select_page target from list_pages" },
      timeoutMs: { descriptor: "timeoutMs: wait_for budget (default 3000)" },
      fullPage: { descriptor: "fullPage: take_screenshot full page (default viewport only)" },
      dialogAction: { descriptor: "dialogAction: accept|dismiss for handle_dialog (default accept)" },
      promptText: { descriptor: "promptText: prompt-dialog reply for handle_dialog accept" },
      clear: { descriptor: "clear: drain the console buffer after list_console_messages" },
    },
    execute,
    dispose: () => {
      void closeActive().catch(() => {})
    },
    engineInfo: () => ({
      kind: lastSel?.kind ?? null,
      reason: lastSel?.reason ?? null,
    }),
  }
}

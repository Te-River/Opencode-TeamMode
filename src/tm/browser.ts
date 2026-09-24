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
 *     (take_snapshot + uid addressing, 18-verb chrome-devtools-mcp surface)
 *     require the playwright engine.
 *
 * Action surface aligns with chrome-devtools-mcp's 18 verbs (R2 mapping):
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
 *   - domain allowlist enforced at the NETWORK layer on the NAVIGATION
 *     (playwright context.route / CDP Fetch interception), re-checked on
 *     every redirect hop; SUBRESOURCES then follow TM_BROWSER_SUBRESOURCE
 *     (default same-site: passive types load, an executable resource loads
 *     when it belongs to a site this session opened).  Gating every request
 *     by the content allowlist is what made pages render picture-less — the
 *     21 seeded hosts contain no CDN, so img/css/js died silently;
 *   - out-of-allowlist open/navigate routes through the OFFICIAL dialog
 *     BEFORE any spawn; approved hosts also pass the network layer;
 *   - hardened context: real-Chrome UA + zh-CN Accept-Language,
 *     no-first-run / no-extensions / mute launch flags, 3 s default action
 *     timeout (the prompt's "3000 ms budget" is the tool's default, not an
 *     aspiration), no networkidle waits anywhere;
 *   - dispose AWAITS the close, and an idle session reaps itself
 *     (TM_BROWSER_IDLE_MS) — an orphaned visible window is a user-facing bug.
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

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { checkWebUrl, seedWebfetchDomains } from "./webfetch.js"
import { askGrantNote, askRefusalNote, askUserForTarget, askUserForTargetDetailed } from "./perm-ask.js"
import { assertReadablePath } from "./guard.js"
import { isEnvFilePath } from "../envprotect.js"
import type { ToolAttachment, ToolResult } from "../types.js"
import { tmError, toToolResult } from "./result.js"
import type { TmConfig } from "./config.js"
import { estimateTokens } from "./config.js"
import type { TmPipelines } from "./pipelines.js"
import { rmForceSafe } from "../fs-safe.js"

/** Per-OS browser candidates, in preference order (first hit wins).  ONLY a
 *  fallback: on Windows the registry probe below is what actually honours the
 *  user's chosen channel.  Edge/Chrome ship each channel in its OWN install
 *  directory (`Microsoft\EdgeBeta`, `EdgeDev`, `EdgeCanary`), so the stable
 *  path alone let a Beta-default host fall back to stable Edge (observed on
 *  Windows 11, 2026-09-18). */
const BROWSER_CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge Canary\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge Canary\\Application\\msedge.exe",
    "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "%LOCALAPPDATA%\\Google\\Chrome Beta\\Application\\chrome.exe",
    "%LOCALAPPDATA%\\Google\\Chrome Dev\\Application\\chrome.exe",
    "%LOCALAPPDATA%\\Google\\Chrome SxS\\Application\\chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
    "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
    "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome-beta",
    "/usr/bin/google-chrome-unstable",
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

/** Registry roots that can carry a ProgId's `shell\open\command`.  Edge is
 *  installed machine-wide (HKLM\SOFTWARE\Classes) while a per-user Chrome
 *  install registers HKCU\Software\Classes — probing HKCU only is what made
 *  a Beta-default host come back empty and fall through to the stable
 *  candidate path. */
const REG_CLASSES_ROOTS = ["HKCU\\Software\\Classes", "HKLM\\SOFTWARE\\Classes"]

/** Both URL schemes the shell association is recorded under.  A user can
 *  set the two differently, so `http` alone is not "the default browser". */
const REG_URL_SCHEMES = ["http", "https"]

/** Channel install dirs keyed off the ProgId name (`MSEdgeBetaHTM`,
 *  `ChromeHTML`, …) — the last-resort probe when the launch command itself is
 *  unreadable but the ProgId still names the channel.  NOTE the real Windows
 *  Edge dirs carry a SPACE ("Microsoft\Edge Beta"), which is what an
 *  `EdgeBeta` guess silently misses; and Chrome installs per-user under
 *  %LOCALAPPDATA% with a different exe name. */
const CHANNEL_INSTALL_BY_PROGID: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/edgebeta/i, "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe"],
  [/edgedev/i, "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe"],
  [/edgecanary|edgeappcanary/i, "C:\\Program Files (x86)\\Microsoft\\Edge Canary\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge Canary\\Application\\msedge.exe"],
  [/msedge|edgehtm/i, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"],
  [/chromebeta/i, "%LOCALAPPDATA%\\Google\\Chrome Beta\\Application\\chrome.exe", "C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe"],
  [/chromedev|chromejsx/i, "%LOCALAPPDATA%\\Google\\Chrome Dev\\Application\\chrome.exe", "C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe"],
  [/chromehtml|chromechtml/i, "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
]

/** Resolve a ProgId to its executable via every classes root.  `reg query`
 *  exits non-zero (throws) for a missing key, so each probe is wrapped. */
function progIdToExecutable(progId: string, run: CommandRunner): string | null {
  for (const root of REG_CLASSES_ROOTS) {
    try {
      const exe = parseRegCommand(run("reg", ["query", `${root}\\${progId}\\shell\\open\\command`, "/ve"]))
      if (exe) return exe
    } catch {
      /* next root */
    }
  }
  return null
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
      const accept = (exe: string | null): string | null =>
        exe && isChromiumFamily(exe) && fs.existsSync(exe) ? exe : null
      for (const scheme of REG_URL_SCHEMES) {
        let progId: string | null = null
        try {
          progId = parseProgId(
            run("reg", [
              "query",
              `HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${scheme}\\UserChoice`,
              "/v",
              "ProgId",
            ]),
          )
        } catch {
          progId = null
        }
        if (!progId) continue
        const direct = accept(progIdToExecutable(progId, run))
        if (direct) return direct
        // launch command unreadable (or points at a Firefox shim) — the
        // ProgId itself still names the channel, so probe that channel's
        // standard install dir before giving up on the user's default.
        for (const [re, ...cands] of CHANNEL_INSTALL_BY_PROGID) {
          if (!re.test(progId)) continue
          for (const cand of cands) {
            const hit = accept(cand.replace(/%LOCALAPPDATA%/gi, String(env.LOCALAPPDATA ?? "").trim()))
            if (hit) return hit
          }
        }
      }
      return null
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

/** Playwright's `channel` launch IGNORES the executable we discovered —
 *  `channel:"msedge"` resolves whatever playwright thinks the stable Edge is,
 *  so a correct Edge-Beta discovery still opened stable (the decisive half of
 *  the 2026-09-18 report).  The channel spelling is therefore only correct
 *  for the exact stable-channel install dir; everything else (Beta/Dev/
 *  Canary, portable, an explicit TM_BROWSER_PATH) rides on executablePath. */
export function playwrightLaunchTarget(
  executable: string,
  opts: { explicitOverride?: boolean } = {},
): { executablePath: string; channel?: string } {
  const exe = String(executable ?? "")
  const p = exe.replace(/\//g, "\\").toLowerCase()
  if (!opts.explicitOverride) {
    if (/\\microsoft\\edge\\application\\msedge\.exe$/.test(p)) return { executablePath: exe, channel: "msedge" }
    if (/\\google\\chrome\\application\\chrome\.exe$/.test(p)) return { executablePath: exe, channel: "chrome" }
  }
  return { executablePath: exe }
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
/** Decide what profile directory TM_BROWSER_USER_DATA_DIR asks for.
 *
 *  The tool description has claimed for a long time that "the real profile is
 *  never touched" while nothing enforced it: the string went straight into
 *  `launchPersistentContext`.  Pointing it at the user's own browser data dir is
 *  not a neutral choice — with the browser open, the new process hands its URL
 *  to the running instance and exits (the confusing "本机已有同品牌浏览器在跑"
 *  failure), and with it closed the agent browses AS THE USER, with every cookie
 *  and saved session, while our orphan reaper force-kills (`taskkill /T /F`) any
 *  browser whose owner died — a real route to corrupting a profile.
 *
 *  So: a real browser data dir is refused with the fix named, anything else is
 *  honored, and an unset value keeps the isolated temp profile (the default).
 *  Pure, so both engines and the tests share one answer. */
export function classifyProfileDir(
  env: Record<string, string | undefined> = process.env,
): { dir: string | null; refusal: string | null } {
  const raw = String(env.TM_BROWSER_USER_DATA_DIR ?? "").trim()
  if (!raw) return { dir: null, refusal: null }
  const norm = raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  const segs = norm.split("/").filter(Boolean)
  const last = segs[segs.length - 1] ?? ""
  const looksReal =
    last === "user data" ||
    last === "google-chrome" ||
    last === "chromium" ||
    last === "profiles" ||
    /(^|\/)(microsoft|google)\/(edge|chrome|chromium|chrome sxs)(\/(user data))?$/.test(norm) ||
    /\/mozilla\/firefox\/(profiles|profile)$/.test(norm)
  if (looksReal) {
    return {
      dir: null,
      refusal:
        `TM_BROWSER_USER_DATA_DIR 指向的看起来是浏览器自己的数据目录（${raw}），拒绝用它启动。` +
        `那样 agent 就是以你的真实身份上网，而孤儿回收是强杀进程，可能损坏这个目录。` +
        `要保留登录态：把它改成一个专用空目录（例如 D:\\tm-browser-profile 或 ~/.tm-browser-profile），` +
        `第一次让 agent 打开登录页、你人工登录一次，之后 cookie 就在这个目录里跨会话保留。`,
    }
  }
  return { dir: raw, refusal: null }
}

export function resolveHeadless(env: Record<string, string | undefined> = process.env): boolean {
  const raw = String(env.TM_BROWSER_HEADLESS ?? "auto").trim().toLowerCase()
  if (["1", "true", "force", "yes"].includes(raw)) return true
  if (["0", "false", "never", "no"].includes(raw)) return false
  if (process.platform === "linux") return !env.DISPLAY && !env.WAYLAND_DISPLAY
  return false
}

// ---------- subresource gate (the "pages render without images" fix) --------

/** A resource the page cannot execute code with — it can only paint. */
const PASSIVE_RESOURCE_TYPES: ReadonlySet<string> = new Set(["image", "media", "font", "stylesheet"])

/** Public suffixes that make the last TWO labels insufficient for a site
 *  comparison.  Deliberately a small spelled-out list (no PSL dependency):
 *  an unlisted multi-label suffix yields a LONGER site key, which auto-passes
 *  FEWER hosts — the conservative direction for a network gate. */
const TWO_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn", "co.cn", "com.hk", "org.hk", "co.jp", "ne.jp",
  "co.kr", "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.in", "com.br", "com.mx", "com.tr",
  "com.ua", "com.sg", "com.my", "com.tw", "co.za", "com.pl", "com.ru", "com.vn", "com.id", "com.ar", "com.co",
])

/** Approximate registrable site (eTLD+1) of a hostname. */
export function siteOf(host: string): string {
  const h = String(host ?? "").toLowerCase().replace(/\.$/, "")
  if (!h || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return h
  const labels = h.split(".").filter(Boolean)
  if (labels.length <= 2) return labels.join(".")
  const lastTwo = labels.slice(-2).join(".")
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".")
  return lastTwo
}

/** playwright and CDP spell resource types differently (`Image` vs `image`,
 *  `Stylesheet` vs `stylesheet`) — one normalizer keeps both engines on the
 *  same verdict table. */
export function normalizeResourceType(raw: unknown): string {
  const t = String(raw ?? "").trim().toLowerCase()
  return t === "" ? "other" : t
}

export function isPassiveResource(raw: unknown): boolean {
  return PASSIVE_RESOURCE_TYPES.has(normalizeResourceType(raw))
}

/**
 * One subresource verdict, shared VERBATIM by both engines so playwright and
 * cdp-legacy can never drift.  `allowedSites` holds the registrable sites of
 * every host this session actually navigated to (allowlist hit or dialog
 * approval), which is what makes a page's own JS/CSS work without opening
 * the whole internet: the governance boundary moves from "21 content domains"
 * to "the site you approved", and an off-site SCRIPT still needs a dialog.
 */
export function subresourcePass(opts: {
  url: string
  resourceType: unknown
  policy: "same-site" | "passive" | "off"
  allowlistHit: boolean
  approvedHost: boolean
  allowedSites: ReadonlySet<string>
}): { pass: boolean; via: string } {
  if (opts.allowlistHit) return { pass: true, via: "allowlist" }
  if (opts.approvedHost) return { pass: true, via: "approved" }
  if (opts.policy === "off") return { pass: false, via: "blocked" }
  let host: string
  try {
    host = new URL(opts.url).hostname
  } catch {
    return { pass: false, via: "blocked" }
  }
  const type = normalizeResourceType(opts.resourceType)
  if (PASSIVE_RESOURCE_TYPES.has(type)) return { pass: true, via: `passive:${type}` }
  if (opts.policy === "passive") return { pass: false, via: `blocked:${type}` }
  return opts.allowedSites.has(siteOf(host)) ? { pass: true, via: `same-site:${type}` } : { pass: false, via: `blocked:${type}` }
}

/** A navigation (or a host the dialog approved) widens the subresource
 *  footprint to its own site.  Called for EVERY top-level/document request
 *  that passed the allowlist side. */
export function rememberSite(allowedSites: Set<string>, url: string): void {
  try {
    const host = new URL(url).hostname
    if (host) allowedSites.add(siteOf(host))
  } catch {
    /* unparseable — nothing to remember */
  }
}

// ---------- a page that is not a page, but a wall ----------------------------

/**
 * Human-verification walls.  This exists because "0 个可寻址节点" and "this
 * site wants a human to prove it is one" look identical to the agent, and the
 * two have opposite next moves: an empty page is worth retrying, a wall never
 * is — retrying just spends rounds on a captcha.  Measured on baike.baidu.com
 * item pages, where every arm (raw playwright included, all resources allowed)
 * returns 0–6 nodes titled 百度安全验证, and the agent reported "该网站没有内容".
 *
 * Deliberately narrow: signatures we observed live, plus the unambiguous
 * English ones.  Callers consult it ONLY when the page came back thin, so an
 * article that merely mentions 验证码 is never mislabelled as a wall.
 */
export const CHALLENGE_WALL_SIGNS: ReadonlyArray<{ readonly re: RegExp; readonly label: string }> = [
  { re: /百度安全验证|百度的安全验证/, label: "百度安全验证" },
  { re: /安全验证|访问验证|请完成验证|滑动验证|拖动滑块|人机验证|点击按钮进行验证/, label: "站点安全验证" },
  { re: /just a moment|checking before the link|cf-browser-verification/i, label: "Cloudflare 人机校验" },
  { re: /verify you are a human|are you a robot|enable javascript and cookies/i, label: "人机校验" },
  { re: /access denied|attention required|blocked because|request blocked/i, label: "访问被拒（反爬拦截）" },
]

/** Which wall this thin page actually is, or null when it is just empty. */
export function challengeWallOf(...texts: ReadonlyArray<string | null | undefined>): string | null {
  const hay = texts.filter(Boolean).join("\n").slice(0, 4000)
  if (!hay.trim()) return null
  for (const s of CHALLENGE_WALL_SIGNS) if (s.re.test(hay)) return s.label
  return null
}

/** One hostname for `allow_host`, or "" when the argument is not a single bare
 *  domain.  Strict on purpose: this value becomes the pattern in an official
 *  consent dialog, and a user approving "bkssl.bdimg.com" must not be getting a
 *  wildcard, a URL with a path, or a port. */
export function normalizeApprovalHost(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^\.+|\.+$/g, "")
  if (!s || s.length > 253) return ""
  if (/[\s/@:*?#%\\]/.test(s)) return ""
  if (!/^[a-z0-9一-鿿-]+(\.[a-z0-9一-鿿-]+)+$/.test(s)) return ""
  return s
}

/** The document title, or "" — a title is a diagnostic, never a reason for the
 *  action that was asked for to fail. */
async function readTitle(page: { title?: () => Promise<string> }): Promise<string> {
  try {
    return String((await page.title?.()) ?? "")
  } catch {
    return ""
  }
}

/**
 * The launch pid, asked more than once.
 *
 * Why this exists: `childProcRows` folds EVERY OS-query failure (PowerShell
 * exiting non-zero, the 6 s timeout killing it mid-flight, a JSON parse miss)
 * into an empty list, and the launcher used to ask exactly once.  Under load —
 * this plugin's own parallel test runner reproduces it, four suites hammering
 * CIM at once — one such query fails now and then, and a single failed query
 * used to cost the session two things permanently: the orphan-ledger entry (so
 * the next boot could not reclaim that browser) and `close`'s process
 * verification.  Worse, an exception escaping the lookup failed `open` itself,
 * reporting a browser that had launched fine as an error.
 *
 * So: a failed or empty answer is retried a bounded number of times, and any
 * throw is swallowed into the retry counter — the pid is diagnostic and
 * reclamation metadata, never a reason to lose the session.  When it still
 * cannot be resolved, `via: "none"` says so and close keeps refusing the
 * 已确认关闭 sentence (pinned by §25).
 */
export const LAUNCH_PID_ATTEMPTS = 3
export const LAUNCH_PID_RETRY_MS = 250

export async function resolveLaunchPid(opts: {
  /** playwright's own accessor — it does not exist on 1.63, so this is usually 0 */
  playwrightPid?: () => number
  executablePath: string
  /** may throw, may answer empty, may answer undefined (let the scanner query) */
  rows: () => ChildProcRow[] | undefined
  sleep?: (ms: number) => Promise<void>
  attempts?: number
}): Promise<{ pid: number; via: "playwright" | "child-scan" | "none"; failures: number }> {
  const pwPid = Number(opts.playwrightPid?.() ?? 0) || 0
  if (pwPid > 0) return { pid: pwPid, via: "playwright", failures: 0 }
  const attempts = Math.max(1, Number(opts.attempts) || LAUNCH_PID_ATTEMPTS)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let failures = 0
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(LAUNCH_PID_RETRY_MS)
    try {
      const scan = launchedBrowserPid(opts.executablePath, { rows: opts.rows() })
      if (scan > 0) return { pid: scan, via: "child-scan", failures }
    } catch {
      failures++
    }
  }
  return { pid: 0, via: "none", failures }
}

// ---------- evaluate_script: consent + result redaction ---------------------

/** `evaluate_script` is the one browser verb the network gate cannot cover:
 *  the allowlist limits where we NAVIGATE, not what an already-loaded page
 *  hands back.  In a `TM_BROWSER_USER_DATA_DIR` profile that page may be a
 *  signed-in session, and `document.cookie` / `localStorage` / a token in the
 *  DOM is one expression away — and its value would then ride into the model
 *  context, the run store and the trajectory.  So: ask once per browser
 *  session (the OFFICIAL dialog), and name-anchor the result on the shapes
 *  that are secrets, not on "looks random" (which would blank legitimate
 *  JSON and teach the agent to distrust every read). */
export const EVAL_SECRET_SHAPES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "bearer", re: /\b(bearer\s+[A-Za-z0-9._~+/-]{12,}=*)/gi },
  { name: "auth-header", re: /\b(authorization\s*[:=]\s*[^\s"',}]{8,})/gi },
  { name: "cookie", re: /\b(set-cookie|cookie)\s*[:=]\s*[^"',}\n]{6,}/gi },
  { name: "api-key", re: /\b(sk|ghp|gho|github_pat|xox[baprs]|AKIA|AIza)[A-Za-z0-9_-]{8,}\b/g },
  { name: "secret-pair", re: /\b((?:password|passwd|secret|api_?key|access_?token|refresh_?token|client_?secret)\s*[:=]\s*"?[^\s"',}]{4,})/gi },
]

/** Mask every known secret shape in an in-page result.  Returns the masked
 *  text plus WHICH kinds were masked (counted, never the values). */
export function redactEvalResult(text: string): { text: string; masked: string[] } {
  let out = text
  const kinds: string[] = []
  for (const shape of EVAL_SECRET_SHAPES) {
    const re = new RegExp(shape.re.source, shape.re.flags)
    let hits = 0
    out = out.replace(re, () => {
      hits++
      return `〔已脱敏:${shape.name}〕`
    })
    if (hits) kinds.push(`${shape.name}×${hits}`)
  }
  return { text: out, masked: kinds }
}

// ---------- orphan browsers ------------------------------------------------
//
// A plugin process that dies (host restart, crash, the "browser has been
// closed" class of failure) leaves the browser it launched RUNNING: measured on
// a real machine, nine msedge processes under a scoped temp profile whose
// parent pid no longer existed. Nothing reaped them, and the user is left with
// invisible browsers holding RAM.
//
// The ledger is deliberately narrow: WE record the pid WE launched together
// with OUR process pid, and a boot pass may only terminate an entry whose
// OWNER pid is dead while its BROWSER pid is alive. That is the definition of
// an orphan, and it is safe when two OpenCode windows share one workspace —
// the other process is alive, so its browsers are not ours to touch. Nothing
// here ever scans the system by process name or profile prefix.

export interface BrowserLedgerEntry {
  pid: number
  ownerPid: number
  engine: string
  at: number
  /** The executable we launched, recorded so a pid that has been recycled to
   *  an unrelated program is never force-killed. */
  exe?: string
}

export function browserLedgerFile(storeRoot: string): string {
  return path.join(storeRoot, "browsers.jsonl")
}

/** Best-effort append: a ledger that cannot be written must never cost the
 *  user their browser session. */
export function appendBrowserLedger(file: string, rec: BrowserLedgerEntry): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(rec) + "\n", "utf8")
  } catch {
    /* observability + reclamation only */
  }
}

/** Read the ledger, terminate the orphans, and rewrite what is still live.
 *  Returns the counts so the caller can log them; never throws. */
export function reapOrphanBrowsers(
  file: string,
  opts: {
    now?: number
    alive?: (pid: number) => boolean
    kill?: (pid: number) => void
    /** seam for tests — what a pid currently IS (name + command line) */
    identity?: (pid: number) => { name: string; cmdline: string } | null
  } = {},
): { reaped: number[]; kept: number; dropped: number } {
  const alive = opts.alive ?? pidAlive
  const kill = opts.kill ?? ((p: number) => killBrowserTree(p))
  const identity = opts.identity ?? procIdentity
  const out = { reaped: [] as number[], kept: 0, dropped: 0 }
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return out
  }
  const survivors: BrowserLedgerEntry[] = []
  const seen = new Set<number>()
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let e: BrowserLedgerEntry
    try {
      e = JSON.parse(line) as BrowserLedgerEntry
    } catch {
      continue // a torn line is not an instruction to kill anything
    }
    const pid = Number(e?.pid)
    const owner = Number(e?.ownerPid)
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) {
      out.dropped++
      continue
    }
    seen.add(pid)
    if (!alive(pid)) {
      out.dropped++ // browser exited on its own — the entry is history
      continue
    }
    if (owner > 0 && !alive(owner)) {
      // An OS pid is a recyclable number, and the kill below is a FORCE kill of
      // a whole process tree.  So the entry has to still describe the
      // executable we launched: if it does not, that pid belongs to an
      // unrelated program now and killing it would be our bug, not our job.
      const exe = String(e?.exe ?? "").trim()
      if (exe && !identityMatchesExecutable(exe, identity(pid))) {
        out.dropped++
        continue
      }
      try {
        kill(pid)
        out.reaped.push(pid)
      } catch {
        survivors.push(e) // not ours to signal (or already gone) — keep the record, say nothing false
      }
      continue
    }
    survivors.push(e)
  }
  out.kept = survivors.length
  try {
    if (survivors.length) fs.writeFileSync(file, survivors.map((s) => JSON.stringify(s) + "\n").join(""), "utf8")
    else fs.rmSync(file, { force: true })
  } catch {
    /* the next boot retries */
  }
  return out
}

/** Is this OS pid still alive? `process.kill(pid, 0)` is the portable probe:
 *  ESRCH means gone, EPERM means alive but owned by someone else — both are
 *  answers, and "no answer" is never one of them. */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string })?.code === "EPERM"
  }
}

/** Wait up to `ms` for a pid to disappear, then terminate it once and give it
 *  a short grace. Returns whether the process is GONE — the only honest basis
 *  for a "已确认关闭" claim. */
export async function waitForPidExit(
  pid: number,
  ms = 3000,
  kill: (p: number) => void = (p) => killBrowserTree(p),
): Promise<boolean> {
  if (!pidAlive(pid)) return true
  const deadline = Date.now() + Math.max(0, ms)
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise<void>((r) => setTimeout(r, 100))
  }
  if (!pidAlive(pid)) return true
  try {
    kill(pid)
  } catch {
    /* already gone, or not ours to signal — the re-check below decides */
  }
  await new Promise<void>((r) => setTimeout(r, 250))
  return !pidAlive(pid)
}

/** One row of the OS process table, as far as the pid lookup below needs it. */
export interface ChildProcRow {
  pid: number
  name: string
  cmdline: string
}

/** What a pid actually is right now — its image name and command line, or null
 *  when the pid is gone.  Used to prove a recorded pid is still the browser we
 *  launched before anything force-kills it (see reapOrphanBrowsers). */
function procIdentity(pid: number): { name: string; cmdline: string } | null {
  const p = Number(pid)
  if (!Number.isInteger(p) || p <= 0) return null
  if (process.platform === "win32") {
    const script = `Get-CimInstance Win32_Process -Filter 'ProcessId=${p}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress`
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 4 * 1024 * 1024,
    })
    if (r.status !== 0) return null
    const text = String(r.stdout ?? "").trim()
    if (!text) return null
    try {
      const row = JSON.parse(text) as Record<string, unknown> | Array<Record<string, unknown>>
      const one = (Array.isArray(row) ? row[0] : row) ?? {}
      return { name: String(one?.Name ?? ""), cmdline: String(one?.CommandLine ?? "") }
    } catch {
      return null
    }
  }
  try {
    const raw = fs.readFileSync(`/proc/${p}/cmdline`)
    const parts = String(raw).split("\0").filter((s) => s !== "")
    if (!parts.length) return null
    return { name: path.basename(parts[0]), cmdline: parts.join(" ") }
  } catch {
    return null
  }
}

/** Does this identity look like the executable we launched?  Compared on the
 *  file NAME: the command line's quoting and path form can differ from ours
 *  (8.3-short vs long path, escaped quotes), while a pid recycled by an
 *  unrelated program almost never carries the same image name.  A missing
 *  identity counts as NO — the safe answer before a force-kill. */
export function identityMatchesExecutable(
  exePath: string,
  ident: { name: string; cmdline: string } | null,
): boolean {
  const want = path.basename(String(exePath ?? "")).toLowerCase()
  if (!want || !ident) return false
  const name = String(ident.name ?? "").toLowerCase()
  const cmd = String(ident.cmdline ?? "").toLowerCase()
  return name === want || cmd.includes(want)
}

/** The same question asked of a live pid (see identityMatchesExecutable). */
export function pidMatchesExecutable(pid: number, exePath: string): boolean {
  return identityMatchesExecutable(exePath, procIdentity(pid))
}

export interface KillTreeOpts {
  platform?: NodeJS.Platform
  /** seam for tests — how the platform tool gets invoked */
  run?: (cmd: string, args: string[]) => void
  /** seam for tests — the POSIX child enumeration */
  children?: (pid: number) => ChildProcRow[]
  /** seam for tests — how a single process gets signalled */
  signal?: (pid: number) => void
}

/** Terminate a browser process AND everything it spawned.
 *
 *  `process.kill(pid)` signals the ROOT only.  Measured on the desktop host the
 *  day this was written: the orphan reaper's default kill took the msedge root
 *  down and left all NINE of its child processes running — which is exactly the
 *  leftover the reaper exists to remove.  The graceful path does not have this
 *  problem (playwright's `browser.close()` shuts its children down first, and
 *  the real-host leg verifies it), so this is the fallback's job.
 *
 *  win32: `taskkill /T /F` walks the tree for us.
 *  POSIX: no tree flag, so descendants are enumerated and killed deepest-first.
 *  Best-effort throughout: a process that vanishes mid-walk is not an error.
 */
export function killBrowserTree(pid: number, opts: KillTreeOpts = {}): void {
  const p = Number(pid)
  if (!Number.isInteger(p) || p <= 0) return
  const run = opts.run ?? ((cmd: string, args: string[]) => {
    spawnSync(cmd, args, { windowsHide: true, timeout: 8000 })
  })
  if ((opts.platform ?? process.platform) === "win32") {
    try {
      run("taskkill.exe", ["/PID", String(p), "/T", "/F"])
    } catch {
      /* gone already, or not ours to signal */
    }
    return
  }
  const children = opts.children ?? childProcRows
  const order: number[] = []
  const queue: number[] = [p]
  while (queue.length) {
    const cur = queue.shift() as number
    let kids: ChildProcRow[] = []
    try {
      kids = children(cur) ?? []
    } catch {
      kids = []
    }
    for (const k of kids) {
      const kid = Number(k?.pid)
      if (Number.isInteger(kid) && kid > 0 && kid !== p && !order.includes(kid)) {
        order.push(kid)
        queue.push(kid)
      }
    }
  }
  const signal = opts.signal ?? ((p: number) => process.kill(p))
  for (const kid of order.reverse()) {
    try {
      signal(kid)
    } catch {
      /* racy by design — the re-check above is what decides */
    }
  }
  try {
    signal(p)
  } catch {
    /* already gone */
  }
}

/** Children of `ppid`, straight from the OS.  Best-effort by design: a host
 *  without PowerShell/CIM or a refused query returns [], and the caller then
 *  reports that the process could not be verified rather than guessing. */
function childProcRows(ppid: number): ChildProcRow[] {
  if (process.platform === "win32") {
    // The filter runs server-side, so the reply holds ONLY our own children —
    // never a full-table scan, never a name match on someone else's browser.
    const script =
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${ppid}' | ` +
      "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 8 * 1024 * 1024,
    })
    if (r.status !== 0) return []
    const text = String(r.stdout ?? "").trim()
    if (!text) return []
    let rows: unknown
    try {
      rows = JSON.parse(text)
    } catch {
      return []
    }
    const list = Array.isArray(rows) ? rows : [rows]
    return list
      .map((x) => ({
        pid: Number((x as { ProcessId?: unknown })?.ProcessId) || 0,
        name: String((x as { Name?: unknown })?.Name ?? ""),
        cmdline: String((x as { CommandLine?: unknown })?.CommandLine ?? ""),
      }))
      .filter((x) => x.pid > 0)
  }
  const r = spawnSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", timeout: 4000 })
  if (r.status !== 0) return []
  const out: ChildProcRow[] = []
  for (const line of String(r.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!m || Number(m[2]) !== ppid) continue
    const cmdline = m[3].trim()
    out.push({ pid: Number(m[1]), name: path.basename(cmdline.split(/\s+/)[0] ?? ""), cmdline })
  }
  return out
}

/** The OS pid behind a playwright-launched browser.
 *
 *  playwright-core has NO `Browser.process()` — that accessor belongs to
 *  ElectronApplication and BrowserServer.  Measured on the desktop host with a
 *  real 1.63 session: `typeof browser.process === "undefined"`, so the pid
 *  stayed 0, the orphan ledger recorded nothing, and close printed 已确认关闭
 *  over a browser process it had never checked.
 *
 *  The only exact anchor available is that the browser is a DIRECT CHILD of
 *  this process, started from the executable WE resolved.  That matters: this
 *  machine carries a dozen unrelated msedge trees (the user's own windows,
 *  msedgewebview2 under SearchHost.exe and under a vendor utility), so matching
 *  by process name would be a loaded gun pointed at them.
 *
 *  0 = not found, and every caller treats 0 as "no verification" — never as
 *  "verified gone".
 */
export function launchedBrowserPid(
  executablePath: string,
  opts: { ppid?: number; rows?: ChildProcRow[] } = {},
): number {
  const exe = String(executablePath ?? "").trim()
  const base = path.basename(exe).toLowerCase()
  if (!base) return 0
  let rows: ChildProcRow[]
  try {
    rows = opts.rows ?? childProcRows(opts.ppid ?? process.pid)
  } catch {
    return 0
  }
  const mine = (rows ?? []).filter((r) => Number.isFinite(Number(r?.pid)) && Number(r.pid) > 0)
  const byPath = mine.filter((r) => String(r.cmdline ?? "").toLowerCase().includes(exe.toLowerCase()))
  if (byPath.length === 1) return Number(byPath[0].pid)
  // More than one of OUR children from the same executable = an older session
  // that has not been reaped yet.  pids climb, so the highest is this launch.
  if (byPath.length > 1) return Math.max(...byPath.map((r) => Number(r.pid)))
  // Name fallback, and only for rows where the OS gave us NO command line at
  // all.  A row that carries a command line for some OTHER executable is
  // evidence against, not a missing clue — adopting it would mean signalling a
  // browser we never launched.
  const byName = mine.filter(
    (r) => String(r.cmdline ?? "").trim() === "" && String(r.name ?? "").toLowerCase() === base,
  )
  return byName.length === 1 ? Number(byName[0].pid) : 0
}
/** Consent is per BROWSER SESSION, not per call: one dialog when the lead
 *  decides to script the page, then the round stops paying for it. */
export function needsEvalConsent(policy: "on" | "off", alreadyApproved: boolean | undefined): boolean {
  return policy !== "off" && !alreadyApproved
}

/** A function-shaped source has to be INVOKED.  Every browser MCP documents
 *  `function: "() => …"`, but evaluate() treats a STRING as an expression: a
 *  function source evaluates to a function object, which is not serializable,
 *  so the call resolves to undefined and the agent reads "null" and goes
 *  looking for a bug that is in our call rather than in the page (measured
 *  live 2026-09-21 — six rounds lost this way).  An expression the model
 *  already wrapped, or a bare `document.title`, passes through untouched. */
export function evalExpression(src: string): string {
  const t = src.trim()
  if (!t) return t
  const fnLike =
    /^(async\s+)?function\b/.test(t) ||
    /^(async\s+)?\(\s*[^()]*?\s*\)\s*=>/.test(t) ||
    /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(t)
  return fnLike ? `(${t})()` : t
}

/** `null` is not a diagnosis.  The render names the type, so "the page has no
 *  such links" and "your function returned nothing" and "it was not called"
 *  stop looking like the same answer. */
export function renderEvalResult(value: unknown): string {
  if (value === undefined) {
    return (
      "执行结果：undefined —— 函数没有 return 值（或返回了不可序列化的对象，比如 DOM 节点本身）。" +
      "要拿数据就返回字符串或数组，例：() => [...document.querySelectorAll('a')].map(a => a.href)"
    )
  }
  if (value === null) return "执行结果：null（页面确实返回了 null —— 这是成功执行，不是失败）"
  const kind = Array.isArray(value) ? `array(${value.length})` : typeof value
  const json = JSON.stringify(value) ?? String(value)
  return `执行结果（${kind}）：${json}`
}

/** Host only — the consent line in the dialog and in the trajectory never
 *  carries a query string (a search URL can hold the very token we guard). */
export function hostOnly(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 60)
  }
}

// ---------- click effect verification ---------------------------------------
//
// "已点击" used to mean "playwright delivered a mouse event".  That is not the
// same fact as "the page did something", and on a modern SPA the gap is wide:
// measured on a Next.js documentation site, the same locator clicked at
// document.readyState === "interactive" (300 ms and 1500 ms after open) was a
// no-op, and at "complete" — once the framework's own globals existed — it
// worked.  Every actionability check playwright performs (visible, stable,
// enabled, receives events) passes on a button whose bundle has not run, so the
// event lands on a node with no handler and nothing happens.  An agent that is
// told 已点击 then reasons from a state change that never occurred.

/** What a click can be observed to change, read in ONE round-trip. */
export interface ClickProbe {
  attrs: Record<string, string>
  url: string
  ready: string
  nodes: number
}

const CLICK_EFFECT_BUDGET_MS = 900
const CLICK_POLL_MS = 150
const CLICK_SETTLE_MS = 5000

/** Runs in the page.  Kept free of TS annotations and outer-scope references
 *  because playwright serializes it. */
const clickProbeFn = (el: {
  getAttribute?: (n: string) => string | null
  value?: unknown
  tagName?: unknown
}): ClickProbe => {
  const attrs: Record<string, string> = {}
  for (const a of ["aria-expanded", "aria-checked", "aria-selected", "aria-pressed", "disabled"]) {
    const v = el.getAttribute ? el.getAttribute(a) : null
    if (v !== null && v !== undefined) attrs[a] = String(v)
  }
  if (typeof el.value === "string") attrs.value = el.value
  return {
    attrs,
    url: String(location.href || ""),
    ready: String(document.readyState || ""),
    nodes: document.getElementsByTagName("*").length,
  }
}

async function probeClickTarget(loc: PwLocator): Promise<ClickProbe | null> {
  if (typeof loc.evaluate !== "function") return null
  try {
    const raw = (await loc.evaluate(clickProbeFn)) as Partial<ClickProbe> | null
    if (!raw || typeof raw !== "object") return null
    return {
      attrs: (raw.attrs ?? {}) as Record<string, string>,
      url: String(raw.url ?? ""),
      ready: String(raw.ready ?? ""),
      nodes: Number(raw.nodes ?? 0),
    }
  } catch {
    return null // a detached element is an answer, not a crash
  }
}

/** Bounded settle.  `open` deliberately returns at domcontentloaded — reading a
 *  page must not wait for analytics — so the wait belongs to the action that
 *  needs a handler attached, not to every navigation. */
async function settlePage(page: PwPage, timeoutMs = CLICK_SETTLE_MS): Promise<void> {
  const waiting = typeof page.waitForLoadState === "function" ? page.waitForLoadState("load", { timeout: timeoutMs }) : null
  if (waiting) {
    await Promise.race([
      Promise.resolve(waiting).catch(() => undefined),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ])
  }
  await new Promise((r) => setTimeout(r, 250))
}

/** What differs between two probes, in the order a reader cares about. */
export function describeClickChange(before: ClickProbe, after: ClickProbe): string[] {
  const out: string[] = []
  const attrsBefore = before.attrs ?? {}
  const attrsAfter = after.attrs ?? {}
  for (const k of Object.keys(attrsBefore)) {
    if (attrsAfter[k] !== attrsBefore[k]) out.push(`${k}: ${attrsBefore[k]} → ${attrsAfter[k] ?? "（消失）"}`)
  }
  for (const k of Object.keys(attrsAfter)) {
    if (!(k in attrsBefore)) out.push(`${k}: → ${attrsAfter[k]}`)
  }
  if (before.url && after.url && before.url !== after.url) out.push(`已跳转 → ${after.url.slice(0, 120)}`)
  if (before.nodes && after.nodes !== before.nodes) out.push(`DOM 节点 ${before.nodes} → ${after.nodes}`)
  return out
}

/** Poll until something changed or the budget runs out.  A navigating click can
 *  detach the element, so the URL is checked independently of the probe. */
async function observeClickEffect(
  loc: PwLocator,
  page: PwPage,
  before: ClickProbe,
  budgetMs = CLICK_EFFECT_BUDGET_MS,
): Promise<{ changed: string[]; after: ClickProbe | null }> {
  const deadline = Date.now() + Math.max(0, budgetMs)
  for (;;) {
    const after = await probeClickTarget(loc)
    if (after) {
      const changed = describeClickChange(before, after)
      if (changed.length) return { changed, after }
    } else {
      const urlNow = typeof page.url === "function" ? String(page.url() ?? "") : ""
      if (urlNow && before.url && urlNow !== before.url) return { changed: [`已跳转 → ${urlNow.slice(0, 120)}`], after: null }
    }
    if (Date.now() >= deadline) return { changed: [], after }
    await new Promise((r) => setTimeout(r, CLICK_POLL_MS))
  }
}

/** The reply.  Pure, so the wording is pinnable without a browser: a click that
 *  observably did something says what changed; one that did not says so and
 *  names the next move instead of reporting success. */
export function clickVerdict(
  target: string,
  before: ClickProbe | null,
  changed: string[],
  opts: { retried: boolean; dialog: boolean; blocked?: { count: number; hosts: string[] } },
): string {
  const head = `已点击 ${target}`
  const dialogNote = opts.dialog ? "；有未处理对话框——handle_dialog（同轮观察，勿另起动作）" : ""
  if (!before) return head + dialogNote // nothing could be probed: claim no more than we know
  if (changed.length) {
    const retryNote = opts.retried
      ? `（第一次点击落在页面还没就绪时 readyState=${before.ready || "?"}，未观测到变化；等加载完重试才生效）`
      : ""
    return `${head} · ${changed.join(" · ")}${retryNote}${dialogNote}`
  }
  const watched = Object.keys(before.attrs).length
    ? Object.entries(before.attrs).map(([k, v]) => `${k}=${v}`).join(" ")
    : "无可观测状态属性"
  const facts = `${watched} · URL 未变 · DOM 节点 ${before.nodes} 未变 · readyState=${before.ready || "?"}`
  // Three different reasons produce the same "nothing changed", and the advice
  // that fits one of them is a dead end for the others.  Measured live: a page
  // at readyState=complete whose framework bundles the governance gate had
  // trimmed was told to "wait for the text" — wait_for then threw a strict-mode
  // violation, so the recommended way out led nowhere.
  const why = opts.blocked && opts.blocked.count > 0
    ? `最可能的原因不是"还没加载完"，而是**这个页面的脚本被治理闸门拦掉了**：本次有 ${opts.blocked.count} 个子资源被拦截` +
        `${opts.blocked.hosts.length ? `（${opts.blocked.hosts.join(", ")}）` : ""}，而它们的可执行资源不属于你导航过的那个站。` +
        `出路：请操作者把这些主机加进 TM_WEBFETCH_ALLOWED_DOMAINS（或先在确认窗里批准该站点）后重新 open；` +
        `也可以直接 TM_BROWSER_SUBRESOURCE=off 之外逐案判断——总之现在这个按钮上没有 handler。`
    : before.ready === "complete"
      ? `页面已经加载完成（readyState=complete），所以这不是加载时机问题：这个元素本身不响应这种点击（常见于 <a> 需要 navigate、事件绑在父节点、或被上层遮罩）。` +
          `下一步：重新 take_snapshot 看清结构再决定，或改用 navigate / evaluate_script 直接取你要的东西。`
      : `最常见的原因是页面脚本还没跑完（readyState=${before.ready || "?"}），而 playwright 的可见/稳定/可点检查在这种情况下全部通过。` +
          `下一步：wait_for 你要点的文字，或重新 take_snapshot 再点一次。`
  return `${head}，但页面没有任何可观测变化（${facts}）。点击送达了，可是没有 handler 响应。${why}不要把这次点击当成成功。${dialogNote}`
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
  /** Bounded settle before retrying an action that changed nothing. */
  waitForLoadState?(state: string, opts?: Record<string, unknown>): Promise<unknown>
  /** close_page — the tab only; the browser session survives it. */
  close?(): Promise<unknown>
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
  /** Optional on the seam: a mock without them takes the single-match path. */
  first?(): PwLocator
  count?(): Promise<number>
  dragTo(target: PwLocator): Promise<unknown>
  /** Read the element's own state in ONE round-trip, so verifying an action
   *  costs less than the action.  Optional: a locator without it cannot be
   *  verified, and then the reply must claim no more than it knows. */
  evaluate?(fn: unknown): Promise<unknown>
}
export interface PwRoute {
  continue(): Promise<unknown>
  abort(): Promise<unknown>
}
export interface PwRequestInfo {
  url(): string
  method?(): string
  /** playwright resource type ("document"|"script"|"image"|…).  Optional on
   *  the seam so a stale mock cannot break the gate — an absent type is
   *  treated as EXECUTABLE (the strict side of the subresource policy). */
  resourceType?(): string
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

// ---------- action surface (R2: chrome-devtools-mcp 18-verb alignment) --------

/** The 18 canonical verbs, named byte-identical to chrome-devtools-mcp. */
export const BROWSER_PLAYWRIGHT_ACTIONS = [
  "navigate_page",
  "take_snapshot",
  "click",
  "fill",
  "hover",
  "drag",
  "press_key",
  "select_page",
  "new_page",
  "close_page",
  "upload_file",
  "wait_for",
  "evaluate_script",
  "list_console_messages",
  "list_network_requests",
  "list_pages",
  "take_screenshot",
  "handle_dialog",
] as const

/** Legacy compat verbs that ride on top of the 18 (both engines). */
export const BROWSER_COMPAT_ACTIONS = ["open", "navigate", "read", "screenshot", "close"] as const

/** Verbs of our own that act on the GATE rather than the DOM: no page is
 *  involved, so both engines serve them and neither can drift. */
export const BROWSER_GATE_ACTIONS = ["allow_host"] as const

/** Every verb the execute layer accepts — the ONE table the refusal menu and
 *  the args schema are both built from.  The hand-written copies drifted the
 *  day `new_page` landed (§6o/unknown-action menu), and a schema that omits a
 *  verb is a capability no agent knows it has. */
export const ALL_BROWSER_ACTIONS: readonly string[] = [
  ...BROWSER_PLAYWRIGHT_ACTIONS,
  ...BROWSER_COMPAT_ACTIONS,
  ...BROWSER_GATE_ACTIONS,
]
export const BROWSER_ACTION_MENU = ALL_BROWSER_ACTIONS.join(" | ")

/** The verbs that must still WORK when a browser has zero tabs: `new_page` is
 *  the remedy the error text points at, `list_pages` is how you find out you
 *  are at zero, and `close_page` answers with its own "index 越界（0..-1）"
 *  rather than this sentence. */
const ZERO_TAB_SAFE = new Set(["new_page", "list_pages", "close_page"])

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

// The browser's OWN site-permission bubble ("…想要 访问此设备上的其他应用和服务",
// 阻止/允许) is not our ctx.ask channel, so nothing in perm-ask or the approval
// gate can bound it: measured on npmjs.com, an unanswered bubble held
// `page.goto` past its 45 s timeout without even reaching domcontentloaded, and
// a server-side session has nobody to click. Denying at launch is the safe
// direction and the ONLY one this toolset takes — there is deliberately no
// auto-allow counterpart (no `permissions:` in the context options either),
// because a browser that grants a site device access on the plugin's say-so
// would be the self-allowing the rest of this codebase refuses to do.
export const BROWSER_DENY_PERMISSIONS_ARG = "--deny-permission-prompts"

const SPAWN_TIMEOUT_MS = 15_000
const NAVIGATE_EVENT_TIMEOUT_MS = 15_000

// ---------- tool ----------------------------------------------------------------

interface ActiveSession {
  kind: BrowserEngineKind
  currentUrl: string
  /** The mode the session was ACTUALLY launched in.  Reported back to the
   *  agent from here — never from the caller's request — so a reused
   *  (sticky) session cannot be described as something it is not. */
  headless: boolean
  /** The profile this session was ACTUALLY launched with, or null for the
   *  isolated temp one.  Reported from here for the same reason `headless` is:
   *  reading TM_BROWSER_USER_DATA_DIR again at reply time lets a cdp-legacy
   *  session (which used a temp dir) be described as 持久登录配置. */
  persistentProfile: string | null
  /** Engine/profile identity for the open + close lines the agent quotes. */
  label: string
  /** Screenshot pixels the model asked for, drained by execute() into the
   *  ToolResult's `attachments`.  act() pushes; nothing else reads it. */
  attachments: ToolAttachment[]
  /** Subresource verdicts since the last observation, for the "page looks
   *  empty" note (count + distinct blocked hosts). */
  blocked: { count: number; hosts: Set<string> }
  /** Registrable sites this session navigated to (same-site subresources). */
  allowedSites: Set<string>
  /** evaluate_script consent was granted for THIS browser session (see
   *  needsEvalConsent) — one dialog per session, not per call. */
  evalApproved?: boolean
  /** Engine action dispatch; throws Error with an agent-actionable message
   *  (the execute() catch renders it as phase=execute). */
  act(action: string, args: Record<string, unknown>, stepId: string): Promise<string>
  /** Is the BROWSER still there?  "Target page, context or browser has been
   *  closed" is one string covering two very different facts — a tab the user
   *  closed and a browser that died.  Only the second one may cost the caller
   *  their lease, or a window the plugin walked away from stays on the user's
   *  screen with nothing holding it. */
  alive?(): boolean
  /** Closes the session and reports VERBATIM what it managed to close — a
   *  close that failed must not read like a success (issue #3 of 2026-09-18:
   *  an agent told the user the window was gone while it was still up). */
  close(): Promise<{ text: string; closed: boolean }>
}

/** Who is calling.  The host gives a tool ctx `{agent, sessionID, directory,
 *  ask}`; sessionID is the identity a browser lease belongs to. */
export interface BrowserCaller {
  owner: string
  agent: string
}

/** ONE BROWSER PER CALLER.
 *
 *  This tool used to hold a single session for the whole plugin process, and
 *  three agents carry it (lead + researcher for the web, tester for UI
 *  verification) — with host `task` children running in the SAME process.  So
 *  they shared one window, one "current tab" and ONE uid registry: a
 *  `take_snapshot` from A renumbered every uid B was holding (`SnapshotIndex
 *  .annotate` clears and restarts at e1), and B's next `click {uid}` landed on
 *  a different element while still reporting success.  Nothing in the reply
 *  could show it, because the browser was the same browser.
 *
 *  A lease per owner removes the sharing: separate window, separate uid
 *  namespace, separate dialog-approved hosts.  The `id` is what the model
 *  carries, and it is checked against the owner — an id is not a capability
 *  token, it is a name, so guessing `b1` must not let a second agent drive the
 *  first one's window.
 */
export interface BrowserLease {
  id: string
  owner: string
  agent: string
  session: ActiveSession
  at: number
  lastActivity: number
}

export function callerOf(ctx: unknown): BrowserCaller {
  const c = (ctx ?? {}) as { sessionID?: unknown; agent?: unknown }
  return { owner: String(c.sessionID ?? "").trim(), agent: String(c.agent ?? "").trim() }
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
  /** Best-effort user notification (host toast) — used by the idle reaper,
   *  which closes a window the agent forgot and must say so out loud. */
  notify?: (message: string) => void
  /** Test seam for the DISCOVERY result (not the TM_BROWSER_PATH override —
   *  the override is read from env so the channel-substitution rule stays
   *  honest in tests too). */
  findExecutable?: (env: Record<string, string | undefined>) => string | null
  /** seam for tests — the OS child listing the launch-pid scan reads.  Without
   *  it a mocked playwright (which has no `process()` accessor, exactly like
   *  the real 1.63) would make every unit test scan the developer's real
   *  process table and possibly adopt a live browser's pid. */
  listChildren?: (ppid: number) => ChildProcRow[]
}): {
  description: string
  args: Record<string, unknown>
  execute: (rawArgs: Record<string, unknown>, ctx: unknown) => Promise<ToolResult>
  /** Async on purpose: the host's `dispose` hook is `() => Promise<void>`,
   *  and a fire-and-forget close could exit before the browser child was
   *  killed (leaving a visible orphan window). */
  dispose: () => Promise<void>
  engineInfo: () => { kind: BrowserEngineKind | null; reason: string | null }
  /** Which browsers are alive right now and who owns each.  tm_join reads this
   *  to tell the lead that a child settled while still holding a window — the
   *  close duty is otherwise a prompt rule, and a prompt rule the agent forgets
   *  leaves a window on the user's screen with nothing said about it. */
  leases: () => { id: string; owner: string; agent: string; idleMs: number }[]
} {
  const { pipelines } = deps
  const env = deps.env ?? process.env
  const notify = typeof deps.notify === "function" ? deps.notify : undefined
  const tool = "tm_browser"
  const traj = (e: Record<string, unknown>) => pipelines.store.appendTrajectory({ tool, ...e })
  // The orphan ledger lives beside the run store (per workspace since the
  // tmpdir sharding), so a crash in one project can never reap another's
  // browser — and a test run, which gets its own store dir, never reaches a
  // real one either.
  const ledgerFile = (() => {
    const root = (pipelines.store as { blackboardRoot?: unknown } | undefined)?.blackboardRoot
    // No store root (a test double, or a host that never gave us one) means no
    // ledger — and then nothing is recorded and nothing is reaped. It must not
    // throw on the way to opening a browser.
    return typeof root === "string" && root ? browserLedgerFile(root) : ""
  })()
  const recordBrowser = (pid: number, engine: string, exe: string): void => {
    if (!ledgerFile || !Number.isFinite(pid) || pid <= 0) return
    appendBrowserLedger(ledgerFile, { pid, ownerPid: process.pid, engine, at: Date.now(), exe })
  }
  if (ledgerFile && String(env.TM_BROWSER_REAP ?? "on").trim().toLowerCase() !== "off") {
    const r = reapOrphanBrowsers(ledgerFile)
    if (r.reaped.length) traj({ step_id: "browser", event: "orphans_reaped", count: r.reaped.length, pids: r.reaped.join(",") })
  }
  /** Live browser leases by id — ONE browser per caller (see BrowserLease). */
  const leases = new Map<string, BrowserLease>()
  let leaseSeq = 0
  const liveLeases = (): BrowserLease[] => [...leases.values()]
  const ownedBy = (owner: string): BrowserLease[] => liveLeases().filter((l) => l.owner === owner)
  const leaseTable = (): string =>
    liveLeases()
      .map((l) => `${l.id} · ${l.agent || "未知角色"} · ${String(l.session.currentUrl || "").slice(0, 80) || "空白页"}`)
      .join("\n  ")
  /** Idle-reaper timers, one per lease: a forgotten window belongs to its
   *  owner, so B's activity must not keep A's browser alive (or reap it). */
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function clearIdle(id: string): void {
    const t = idleTimers.get(id)
    if (t) clearTimeout(t)
    idleTimers.delete(id)
  }
  /** Drop the lease whose session died on its own (a cdp-legacy child exiting,
   *  a browser the user closed) so a corpse is never handed back out. */
  const dropSession = (sess: ActiveSession): void => {
    for (const [id, l] of leases) {
      if (l.session === sess) {
        leases.delete(id)
        clearIdle(id)
      }
    }
  }
  // m2 (fix round): SAME seed policy as tm_webfetch / tm_search — the
  // built-in default list gains the T4 engine home hosts (api.stackexchange
  // .com, hn.algolia.com) so jump-reading a search hit stops re-popping the
  // dialog; a narrowed TM_WEBFETCH_ALLOWED_DOMAINS is never widened.
  const allowlist = seedWebfetchDomains(
    (deps.cfg as { webfetchAllowedDomains?: readonly string[] }).webfetchAllowedDomains ?? ["*"],
  )
  /** Hosts approved through the OFFICIAL dialog, keyed by the CALLER's session.
   *  It used to be one process-wide set, which meant a host the lead approved
   *  became a silent pass for the researcher's browser too — consent given to
   *  one agent is not a pass for another.  The network layer (both engines)
   *  consults the caller's set in addition to the static allowlist. */
  const approvedBy = new Map<string, Set<string>>()
  const approvedFor = (owner: string): Set<string> => {
    let s = approvedBy.get(owner)
    if (!s) {
      s = new Set<string>()
      approvedBy.set(owner, s)
    }
    return s
  }

  /** Which browser an action may drive.
   *
   *  The id is REQUIRED as soon as it could mean more than one thing: with a
   *  single live browser that belongs to the caller, omitting it is unambiguous
   *  and allowed (and every reply echoes the id back); the moment a second
   *  agent opens one, every call must name its own.  An id belonging to somebody
   *  else is refused WITH the owner named, because `b1` is guessable and the
   *  whole point is that guessing must not work. */
  function resolveLease(
    args: Record<string, unknown>,
    caller: BrowserCaller,
  ): { lease: BrowserLease } | { error: string } {
    const want = String(args.id ?? "").trim()
    const all = liveLeases()
    const mine = ownedBy(caller.owner)
    if (want) {
      const hit = all.find((l) => l.id === want)
      if (!hit) {
        return {
          error: all.length
            ? `没有 id 为 "${want}" 的浏览器。活着的：\n  ${leaseTable()}`
            : `没有 id 为 "${want}" 的浏览器——现在一个都没开，先用 action:"open"。`,
        }
      }
      if (hit.owner !== caller.owner) {
        return {
          error:
            `${hit.id} 是 ${hit.agent || "另一个会话"} 的浏览器，不是你的——两个 agent 共用一个窗口会互相踩当前标签和 uid 编号，` +
            `而你看到的每一次"成功"都可能是对方的页面。` +
            (mine.length
              ? `你自己的是 ${mine.map((l) => l.id).join(" / ")}。`
              : `你还没有浏览器：用 action:"open" 开一个，它会给你自己的 id。`),
        }
      }
      hit.lastActivity = Date.now()
      return { lease: hit }
    }
    if (all.length === 1 && mine.length === 1) {
      mine[0].lastActivity = Date.now()
      return { lease: mine[0] }
    }
    if (!mine.length) {
      return {
        error: all.length
          ? `你还没有浏览器（活着的：\n  ${leaseTable()}）——先用 action:"open" 开一个，之后带上它给你的 id。`
          : '没有打开的浏览器会话——先用 action:"open"',
      }
    }
    return {
      error:
        `现在有 ${all.length} 个浏览器在跑，动作必须写明 id（你自己的：${mine.map((l) => l.id).join(" / ")}）——` +
        `省略 id 只在"全场只有一个、且是你的"时才安全。\n  ${leaseTable()}`,
    }
  }
  const snapshotBudget = Math.max(10, Number(deps.cfg?.browserSnapshotMaxTokens) || 1200)
  const subPolicy = deps.cfg?.browserSubresource ?? "same-site"
  const evalAskPolicy = deps.cfg?.browserAskEval ?? "on"
  const discover = deps.findExecutable ?? findBrowserExecutable
  const imageMaxBytes = Math.max(1000, Number(deps.cfg?.browserImageMaxBytes) || 400_000)
  const idleCloseMs = Number(deps.cfg?.browserIdleCloseMs ?? 180_000)

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

  /** LLM args are booleans most of the time, but `"false"` / `"0"` strings
   *  are common — a bare `Boolean()` read both as TRUE, which is exactly how
   *  a model used to force tm_browser into headless (and get anti-bot
   *  blocked) on a desktop that defaults to headful. */
  function isTrueArg(raw: unknown): boolean {
    if (raw === true) return true
    if (typeof raw === "number") return raw === 1
    if (typeof raw === "string") return /^(1|true|yes|on)$/i.test(raw.trim())
    return false
  }

  /** Screenshot line + the OPT-IN pixels.
   *  The PNG always lands in the run store (it is the evidence artifact);
   *  what rides back to the MODEL is a quality-70 JPEG — a real page with
   *  images loaded is ~1.5 MB as PNG, which no token budget should ever
   *  inline, and ~150-300 KB as JPEG.  Pixels stay opt-in so a UI sweep
   *  cannot spend context the agent never asked for. */
  async function shotOutput(
    sess: ActiveSession,
    file: string,
    png: Buffer,
    args: Record<string, unknown>,
    captureJpeg?: () => Promise<Buffer | null>,
  ): Promise<string> {
    const head = `截图已保存（PNG ${png.length} bytes）：${file}`
    if (!isTrueArg(args.image)) {
      return `${head}\n（上下文只携带路径，不携带像素——需要真正看到画面时带 image:true 再截一次。）`
    }
    let img: Buffer | null = null
    if (captureJpeg) {
      try {
        img = await captureJpeg()
      } catch {
        img = null
      }
    }
    let kind = "jpeg"
    if (!img) {
      img = png
      kind = "png"
    }
    if (img.length > imageMaxBytes) {
      return `${head}\n（未附带像素：${kind.toUpperCase()} ${img.length} bytes 超过 TM_BROWSER_IMAGE_MAX_BYTES=${imageMaxBytes}。改用视口截图（去掉 fullPage）或提高该上限。）`
    }
    sess.attachments.push({
      type: "file",
      mime: `image/${kind}`,
      url: `data:image/${kind};base64,${img.toString("base64")}`,
      filename: path.basename(file).replace(/\.png$/, `.${kind === "jpeg" ? "jpg" : "png"}`),
    })
    return `${head}\n（像素以 ${kind.toUpperCase()} ${img.length} bytes 随本条结果附带。）`
  }

  /** One line telling the agent that the page is NOT actually empty — the
   *  subresource gate dropped N requests.  Without this the model reads a
   *  blank-looking page and reports "该网站没有图片".
   *
   *  `thin` means the page ALSO came back with nothing addressable, which
   *  changes the sentence from a footnote into the diagnosis: on baike the
   *  blocked request was the site's own bundle, so 0 nodes and "no content"
   *  were our doing.  An agent that is told the causality has two real moves
   *  (allow_host, or the env seed + restart); one that is not, reports the
   *  site as empty. */
  function blockedNote(sess: ActiveSession, thin = false): string {
    if (!sess.blocked.count) return ""
    const n = sess.blocked.count
    const hosts = [...sess.blocked.hosts]
    // RESET IN PLACE — the engine's route handler holds this very object, so
    // swapping in a new one would silently stop counting after the first
    // drain (and the note would never appear again for the session).
    sess.blocked.count = 0
    sess.blocked.hosts.clear()
    traj({ step_id: "browser", event: "blocked", count: n, hosts: hosts.slice(0, 20).join(","), thin })
    const list = `${hosts.slice(0, 6).join(", ")}${hosts.length > 6 ? ` …+${hosts.length - 6}` : ""}`
    const base =
      `\n注意：本页有 ${n} 个子资源请求被治理白名单拦截（${list}）——不是站点没有内容。` +
      `当前策略 TM_BROWSER_SUBRESOURCE=${subPolicy}；同域资源已自动放行，跨域脚本仍需白名单或弹窗批准。`
    if (!thin) return base
    return (
      base +
      `这一页的可寻址内容为 0，而被拦的正是页面自己的脚本域名——空白是我们的门禁造成的，不是页面没有内容。` +
      `两条出路：action:"allow_host" {host:"${hosts[0] ?? "被拦域名"}"} 由我拿官方确认窗去问用户（只放行这个域名、只对你这个浏览器、本次会话），` +
      `或请用户把域名加进 TM_WEBFETCH_ALLOWED_DOMAINS 后重启 OpenCode。批准后要重新 navigate 一次——门禁在请求时判定，已加载的页面不会自己补回来。` +
      `在拿到真实内容之前不要把这一页当成"网站没有内容"汇报。`
    )
  }

  /** A thin page may be a wall rather than an empty site.  Say which, because
   *  the next move is the opposite: retry an empty page, never a captcha. */
  function wallNote(...texts: ReadonlyArray<string | null | undefined>): string {
    const wall = challengeWallOf(...texts)
    if (!wall) return ""
    traj({ step_id: "browser", event: "challenge_wall", sign: wall })
    return (
      `\n这一页不是"没有内容"，它是一张${wall}墙——站点要求真人完成验证，自动化通道到此为止。` +
      `不要重试这一页来"等它加载完"，也不要把"该站点无内容"写进结论：换来源（tm_search 的其它引擎 / 别的站点），` +
      `或者告诉用户需要他本人在这个窗口里完成一次验证后再继续。`
    )
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

  /**
   * Shared network verdict for BOTH engines — one implementation, so the
   * playwright and cdp-legacy legs can never disagree about what passes.
   * The hard red lines (non-http scheme, remote env-file spelling) stay hard
   * under EVERY subresource policy: they are not consentable, so a passive
   * image or a same-site script can never relax them.
   */
  function gateDecide(
    st: { allowedSites: Set<string>; blocked: { count: number; hosts: Set<string> } },
    url: string,
    resourceType: unknown,
    approvedHosts: Set<string>,
  ): { pass: boolean; via: string } {
    const verdict = checkWebUrl(url, allowlist as readonly string[])
    if (!verdict.ok && !verdict.askable) return { pass: false, via: "red-line" }
    let approved = false
    try {
      approved = approvedHosts.has(new URL(url).hostname)
    } catch {
      approved = false
    }
    const v = subresourcePass({
      url,
      resourceType,
      policy: subPolicy,
      allowlistHit: verdict.ok,
      approvedHost: approved,
      allowedSites: st.allowedSites,
    })
    if (v.pass) {
      if (normalizeResourceType(resourceType) === "document") rememberSite(st.allowedSites, url)
    } else {
      st.blocked.count++
      try {
        st.blocked.hosts.add(new URL(url).hostname)
      } catch {
        /* no host to name */
      }
    }
    // NO per-request trajectory: a real page is hundreds of requests and the
    // log would be pure noise.  Blocked verdicts aggregate into st.blocked
    // and flush as ONE line (blockedNote / close).
    return v
  }

  async function openLegacySession(headless: boolean, approvedHosts: Set<string>): Promise<ActiveSession> {
    const executable = discover(env)
    if (!executable) throw discoveryError()
    // The SAME knob on BOTH engines.  This used to be temp-only, so a session
    // that degraded to cdp-legacy kept its logins nowhere while the reply still
    // read the env and announced 持久登录配置.
    const profile = classifyProfileDir(env)
    if (profile.refusal) throw new Error(profile.refusal)
    const persistent = profile.dir !== null
    const profileDir = persistent ? profile.dir! : fs.mkdtempSync(path.join(os.tmpdir(), "tm-browser-"))
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
        BROWSER_DENY_PERMISSIONS_ARG,
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
    // network-layer enforcement — the SAME gateDecide the playwright leg uses
    // (subresource policy + per-hop redirect re-check + dialog-approved hosts)
    const allowedSites = new Set<string>()
    const blocked = { count: 0, hosts: new Set<string>() }
    await cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId)
    cdp.onEvent((m) => {
      if (m.method !== "Fetch.requestPaused" || m.sessionId !== sessionId) return
      const requestId = String((m.params as { requestId?: string }).requestId ?? "")
      const p = (m.params as { request?: { url?: string; resourceType?: string } }).request ?? {}
      const url = String(p.url ?? "")
      const { pass } = gateDecide({ allowedSites, blocked }, url, p.resourceType, approvedHosts)
      if (pass) {
        void cdp.call("Fetch.continueRequest", { requestId }, sessionId, 5000).catch(() => {})
      } else {
        void cdp.call("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId, 5000).catch(() => {})
      }
    })

    recordBrowser(Number(child.pid ?? 0), "cdp-legacy", executable)
    const sess: ActiveSession = {
      kind: "cdp-legacy",
      currentUrl: "about:blank",
      headless,
      persistentProfile: persistent ? profileDir : null,
      label: `cdp-legacy · ${path.basename(executable)} · pid ${child.pid ?? "?"}`,
      attachments: [],
      blocked,
      allowedSites,
      // the CDP child still running IS the browser being alive on this engine
      alive: () => (child as { exitCode?: number | null }).exitCode === null,
      async act(action, args, stepId) {
        if (action === "navigate" || action === "navigate_page") {
          const url = String(args.url ?? "").trim()
          rememberSite(allowedSites, url)
          await cdp.call("Page.navigate", { url }, sessionId)
          await cdp.waitEvent("Page.loadEventFired", sessionId, NAVIGATE_EVENT_TIMEOUT_MS).catch(() => {})
          sess.currentUrl = url
          return `已导航：${url}${blockedNote(sess)}`
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
          // Same diagnosis as the playwright leg — the two engines must not
          // drift on what a blank page is allowed to be called.
          const thin = text.replace(/\s+/g, "").length < 80
          let title = ""
          if (thin) {
            const t = await cdp
              .call("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId)
              .catch(() => null)
            title = String((t?.result as { value?: unknown })?.value ?? "")
          }
          return `${pageTextOutput(sess.currentUrl, text)}${wallNote(title, text)}${blockedNote(sess, thin)}`
        }
        if (action === "screenshot" || action === "take_screenshot") {
          traj({ step_id: stepId, event: "call", kind: "screenshot", url: sess.currentUrl.slice(0, 200) })
          const shot = await cdp.call("Page.captureScreenshot", { format: "png" }, sessionId)
          const png = Buffer.from(String((shot as { data?: string }).data ?? ""), "base64")
          const { file } = saveShotPng(new Uint8Array(png), stepId)
          return shotOutput(sess, file, png, args, async () => {
            const j = await cdp.call("Page.captureScreenshot", { format: "jpeg", quality: 70 }, sessionId)
            return Buffer.from(String((j as { data?: string }).data ?? ""), "base64")
          })
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
          const ev = await cdp.call(
            "Runtime.evaluate",
            { expression: evalExpression(src), returnByValue: true, awaitPromise: true },
            sessionId,
          )
          // A page-side throw used to render as "执行结果：null", which is how an
          // agent spends six rounds wondering whether the selector was wrong.
          const det = ev?.exceptionDetails as
            | { exception?: { description?: unknown }; text?: unknown }
            | undefined
          if (det) {
            const first = String(det.exception?.description ?? det.text ?? JSON.stringify(det))
              .split("\n")[0]
              .slice(0, 300)
            throw new Error(`页面内抛出异常（不是"没找到"）：${first}`)
          }
          return capTokens(
            renderEvalResult((ev.result as { value?: unknown })?.value),
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
        const dead = (child as { exitCode?: number | null; killed?: boolean }).exitCode !== null
        // Only a directory WE created is ours to remove. Deleting a user-named
        // persistent profile on close would destroy the logins the knob exists
        // to keep.
        if (!persistent) {
          try {
            rmForceSafe(profileDir, { recursive: true })
          } catch {
            /* a locked leftover temp dir is reclaimed by the OS — never fail close */
          }
        }
        return dead
          ? {
              closed: true,
              text: persistent
                ? `浏览器进程已退出（cdp-legacy）；持久配置目录已保留（下次 open 复用登录态）：${profileDir}。`
                : "浏览器进程已退出（cdp-legacy），临时配置目录已清理。",
            }
          : {
              closed: false,
              text:
                `警告：cdp-legacy 子进程 pid ${child.pid ?? "?"} 未在 3s 内退出，窗口可能仍在前台——` +
                `请手动关闭该浏览器窗口（配置目录 ${profileDir}${persistent ? "，持久目录我不会删" : "，临时目录"}）。`,
            }
      },
    }
    const onExit = () => {
      dropSession(sess)
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

  async function openPlaywrightSession(pw: PwModule, headless: boolean, approvedHosts: Set<string>): Promise<ActiveSession> {
    const executable = discover(env)
    if (!executable) throw discoveryError()
    const launchArgs = [
      "--no-first-run", "--no-default-browser-check", "--disable-extensions",
      "--disable-background-networking", "--mute-audio",
      BROWSER_DENY_PERMISSIONS_ARG,
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
    const profile = classifyProfileDir(env)
    if (profile.refusal) throw new Error(profile.refusal)
    const persistentDir = profile.dir ?? ""
    // R2 (revised 2026-09-18): playwright's `channel` resolves the executable
    // ITSELF, which silently overrode our discovery (a Beta-default Windows
    // host opened STABLE Edge).  executablePath is now the primary launch and
    // the channel spelling only a fallback — the opposite of the old order.
    const target = playwrightLaunchTarget(executable, {
      explicitOverride: String(env.TM_BROWSER_PATH ?? "").trim() !== "",
    })
    let browser: PwBrowser | null = null
    let context: PwBrowserContext
    let via = "executablePath"
    if (persistentDir) {
      context = await pw.chromium.launchPersistentContext(persistentDir, {
        ...contextOpts,
        executablePath: target.executablePath,
        headless,
        args: launchArgs,
      })
      via = `persistent(executablePath)`
    } else {
      try {
        browser = await pw.chromium.launch({ executablePath: target.executablePath, headless, args: launchArgs })
        via = "executablePath"
      } catch (e1) {
        if (!target.channel) throw e1
        browser = await pw.chromium.launch({ channel: target.channel, headless, args: launchArgs })
        via = `channel(${target.channel})`
      }
      context = await browser.newContext(contextOpts)
    }

    const snapIndex = new SnapshotIndex()
    // The OS process behind the connection. playwright exposes it as
    // browser.process(); on the persistent path the browser is reached through
    // the context. Without a pid there is no way to tell "the CDP connection
    // dropped" apart from "the browser is gone" — and they are NOT the same
    // thing (measured: close printed 已确认关闭 while the msedge tree was still
    // alive under OpenCode.exe).
    const owningBrowser =
      browser ??
      (() => {
        try {
          return (context as { browser?: () => unknown }).browser?.() ?? null
        } catch {
          return null
        }
      })()
    const { pid: browserPid, via: pidRoute, failures: pidFailures } = await resolveLaunchPid({
      // playwright's own accessor first — it does not exist on 1.63, so the OS
      // scan is what answers today.  Which route replied is AUDITED: a silent
      // fall-back to 0 would put us straight back to printing 已确认关闭 about a
      // process nobody looked at.
      playwrightPid: () =>
        Number((owningBrowser as { process?: () => { pid?: unknown } } | null | undefined)?.process?.()?.pid ?? 0) || 0,
      executablePath: target.executablePath ?? executable,
      rows: () => (deps.listChildren ? deps.listChildren(process.pid) : undefined),
    })
    traj({ step_id: "browser", event: "launch_pid", via: pidRoute, pid: browserPid, tries: pidFailures })
    recordBrowser(browserPid, persistentDir ? "playwright-persistent" : "playwright", executable)
    const state = {
      page: context.pages()[0] ?? (await context.newPage()),
      dialogs: [] as PwDialog[],
      consoleBuf: [] as Array<{ type: string; text: string }>,
      netBuf: [] as Array<{ method: string; url: string; status?: number; failure?: string; blocked?: boolean }>,
      allowedSites: new Set<string>(),
      blocked: { count: 0, hosts: new Set<string>() },
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
      const { pass } = gateDecide(state, u, request.resourceType?.(), approvedHosts)
      if (pass) {
        await route.continue().catch(() => {})
      } else {
        // per-hop re-check lands here for every redirect hop too
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
      headless,
      persistentProfile: persistentDir || null,
      label: `playwright/${via} · ${path.basename(executable)} · ${headless ? "headless" : "headful"}`,
      attachments: [],
      blocked: state.blocked,
      allowedSites: state.allowedSites,
      // The browser object is the truth about liveness; a closed TAB is not it.
      alive: () =>
        (owningBrowser as { isConnected?: () => boolean } | null | undefined)?.isConnected?.() !== false,
      async act(action, args, stepId) {
        // A context with zero pages is ALIVE — it simply has no tab. Addressing
        // the tab close_page removed threw "Target page, context or browser has
        // been closed", which the recovery in execute() reads as a dead BROWSER:
        // the lease was dropped, `close` then reported "no browser open", and the
        // user kept a window nothing was claiming any more (measured live,
        // 1-6-0-click.json step 11 — right after our own reply promised
        // "浏览器仍在运行"). An empty window gets its own honest answer here and
        // keeps its lease.
        if (!ZERO_TAB_SAFE.has(action) && context.pages().length === 0) {
          throw new Error(
            "这个浏览器已经没有标签页了（0 个，窗口和进程都还在，你的租约我没有丢）。" +
              '要继续用 new_page 在同一个窗口开一个标签；要结束整个会话用 action:"close"（它会验进程真的退出）。',
          )
        }
        if (action === "navigate" || action === "navigate_page") {
          const url = String(args.url ?? "").trim()
          // the navigation itself already cleared the allowlist (execute()
          // asked the user otherwise) — its SITE may now load subresources
          rememberSite(state.allowedSites, url)
          // domcontentloaded ONLY — networkidle is banned (prompt discipline)
          await state.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 })
          sess.currentUrl = state.page.url?.() || url
          rememberSite(state.allowedSites, sess.currentUrl)
          return `已导航：${url}${blockedNote(sess)}`
        }
        if (action === "read") {
          traj({ step_id: stepId, event: "call", url: sess.currentUrl.slice(0, 200) })
          const text = String((await state.page.evaluate("document.body ? document.body.innerText : ''")) ?? "")
          traj({ step_id: stepId, event: "result", tokens: Math.ceil(text.length / 4) })
          const thin = text.replace(/\s+/g, "").length < 80
          const title = thin ? await readTitle(state.page) : ""
          return `${pageTextOutput(sess.currentUrl, text)}${wallNote(title, text)}${blockedNote(sess, thin)}`
        }
        if (action === "screenshot" || action === "take_screenshot") {
          traj({ step_id: stepId, event: "call", kind: "screenshot", url: sess.currentUrl.slice(0, 200) })
          const bytes = await state.page.screenshot({ type: "png", fullPage: Boolean(args.fullPage) })
          const { file, png } = saveShotPng(bytes, stepId)
          return shotOutput(sess, file, png, args, async () =>
            Buffer.from(await state.page.screenshot({ type: "jpeg", quality: 70, fullPage: Boolean(args.fullPage) })),
          )
        }
        if (action === "take_snapshot") {
          traj({ step_id: stepId, event: "call", kind: "snapshot", url: sess.currentUrl.slice(0, 200) })
          let yaml: string
          try {
            yaml = await state.page.locator("body").ariaSnapshot()
          } catch (e) {
            const m = String((e as Error)?.message ?? e)
            // Only talk about VERSIONS when the accessor itself is missing. It
            // threw "…has been closed" live and blamed playwright-core 1.63 for
            // it, which sent the agent off to check dependencies instead of
            // looking at the page — a wrong diagnosis costs more than none.
            throw new Error(
              /not a function|is not defined|unsupported|no method/i.test(m)
                ? `ariaSnapshot 不可用：${m} —— locator.ariaSnapshot 需要 playwright-core ≥1.49（本包 optionalDependencies 锁 1.63）；未安装或过旧会走 cdp-legacy 降级，那边没有快照动作。`
                : `快照读取失败：${m.slice(0, 300)}`,
            )
          }
          const annotated = snapIndex.annotate(yaml)
          traj({ step_id: stepId, event: "result", tokens: estimateTokens(annotated), nodes: snapIndex.size })
          const body = capTokens(annotated, `…(快照超过 browserSnapshotMaxTokens=${snapshotBudget}，后续行已截断——用 read 拿原文或先滚动再快照)`)
          const hint = state.dialogs.length ? `\n注意：有 ${state.dialogs.length} 个未处理对话框——先 handle_dialog` : ""
          // A snapshot with nothing addressable is the one case worth spending
          // a title read on: it is either our gate, or the site asking for a
          // human, and the agent has to be told which — "0 个可寻址节点" alone
          // reads as "this site is empty".
          const thin = snapIndex.size === 0
          const wall = thin ? wallNote(await readTitle(state.page), yaml) : ""
          return `ARIA 快照（${sess.currentUrl} · ${snapIndex.size} 个可寻址节点）——后续动作按行内 [uid=eN] 寻址：\n${body}${hint}${wall}${blockedNote(sess, thin)}`
        }
        if (action === "click") {
          const loc = targetOf("uid", "selector", args)
          const target = describeTarget(args)
          const before = await probeClickTarget(loc)
          await loc.click()
          const dialogOpen = state.dialogs.length > 0
          let seen = before ? await observeClickEffect(loc, state.page, before) : { changed: [] as string[], after: null }
          let retried = false
          // A delivered click that changed NOTHING is the SPA hazard this
          // verification exists for.  Retrying is safe precisely BECAUSE nothing
          // changed — a toggle that worked is never clicked twice — and a dialog
          // is open means the click did land, so it is never retried.
          if (before && !seen.changed.length && !dialogOpen) {
            await settlePage(state.page)
            const again = await probeClickTarget(loc)
            await loc.click().catch(() => {})
            retried = true
            seen = await observeClickEffect(loc, state.page, again ?? before)
          }
          traj({
            step_id: stepId,
            event: "click_verified",
            effective: seen.changed.length > 0,
            retried,
            probed: Boolean(before),
            ready: String(before?.ready ?? ""),
          })
          return clickVerdict(target, before, seen.changed, {
            retried,
            dialog: state.dialogs.length > 0,
            // The gate's own ledger rides along: "nothing changed" on a page
            // whose scripts were trimmed needs a different next move than a page
            // that is still loading.
            blocked: { count: state.blocked.count, hosts: [...state.blocked.hosts].slice(0, 5) },
          })
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
          const base = uid ? targetOf("uid", "selector", { uid }) : state.page.getByText(text)
          // A visible label matches several nodes on a real page, and playwright's
          // STRICT mode answers that by throwing its whole internal report at the
          // agent — measured live, where `wait_for` was the very recovery step our
          // own click message had just recommended. So: wait for the first match
          // and SAY that there were several, instead of blocking the way out.
          const hits = typeof base.count === "function" ? Number(await base.count().catch(() => 1)) || 1 : 1
          const loc = hits > 1 && typeof base.first === "function" ? base.first() : base
          await loc.waitFor({ state: "visible", timeout })
          return `等待命中：${what}（≤${timeout}ms 内可见）${hits > 1 ? `\n（这个文本命中 ${hits} 个元素，等的是第一个——要精确就改用 uid 寻址）` : ""}`
        }
        if (action === "evaluate_script") {
          const src = String(args.function ?? args.expression ?? "").trim()
          if (!src) throw new Error('缺少 expression/function 参数（JS 函数源或表达式）')
          traj({ step_id: stepId, event: "call", kind: "evaluate" })
          const value = await state.page.evaluate(evalExpression(src))
          return capTokens(renderEvalResult(value), "…(结果超长已截断)")
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
        if (action === "new_page") {
          // Multi-tab is an operator need, not a nicety: comparing two pages,
          // or reading a doc while keeping the first open, was impossible
          // because `open` on a live session only navigates the CURRENT tab.
          const p = await context.newPage()
          state.page = p
          attach(p)
          const url = String(args.url ?? "").trim()
          const index = context.pages().indexOf(p)
          if (!url) {
            sess.currentUrl = String(p.url?.() ?? "about:blank")
            traj({ step_id: stepId, event: "call", kind: "new_page", url: "" })
            return `已新建空白标签页 ${index}（共 ${context.pages().length} 个，当前在它上面）：${sess.currentUrl || "about:blank"}\n后续动作按 [uid] 寻址前请先 take_snapshot；切回去用 select_page { index }。`
          }
          // The URL cleared the allowlist at the execute layer (that is where
          // the official dialog lives), exactly like navigate_page does.
          rememberSite(state.allowedSites, url)
          traj({ step_id: stepId, event: "call", kind: "new_page", url: url.slice(0, 200) })
          await p.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 })
          sess.currentUrl = p.url?.() || url
          rememberSite(state.allowedSites, sess.currentUrl)
          return `已新建标签页 ${index} 并导航（共 ${context.pages().length} 个，当前在它上面）：${url}${blockedNote(sess)}`
        }
        if (action === "close_page") {
          const pages = context.pages()
          const raw = args.index
          const idx = raw === undefined || raw === "" ? pages.indexOf(state.page) : Number(raw)
          if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
            throw new Error(`index 越界（0..${pages.length - 1}）——先 list_pages`)
          }
          const victim = pages[idx]
          await Promise.resolve(victim.close?.()).catch(() => {})
          const rest = context.pages()
          const closedIndex = idx
          if (!rest.length) {
            state.page = victim
            sess.currentUrl = ""
            return `标签页 ${closedIndex} 已关闭，这是最后一个——浏览器仍在运行。` +
              `要结束整个会话用 action:"close"（它会验进程真的退出）；要继续就用 new_page 再开一个。`
          }
          state.page = rest.includes(state.page) ? state.page : rest[rest.length - 1]
          attach(state.page)
          const nextIdx = rest.indexOf(state.page)
          sess.currentUrl = String(state.page.url?.() ?? "")
          return `标签页 ${closedIndex} 已关闭，剩 ${rest.length} 个，当前在 ${nextIdx}：${sess.currentUrl}`
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
        const errs: string[] = []
        const fail = (label2: string) => (e: unknown) => {
          errs.push(`${label2}: ${String((e as Error)?.message ?? e)}`)
        }
        await Promise.resolve(context.close()).catch(fail("context"))
        if (browser) await Promise.resolve(browser.close()).catch(fail("browser"))
        // VERIFY before claiming — an agent quotes this line to the user as
        // "浏览器已关闭", so a swallowed failure must not read like success.
        let alivePages = 0
        try {
          alivePages = context.pages().length
        } catch {
          alivePages = 0
        }
        const connected = browser ? Boolean((browser as { isConnected?: () => boolean }).isConnected?.()) : false
        // The connection is NOT the process. Wait for the pid to actually
        // disappear; if it refuses, terminate it once and re-check. Only then
        // may this line say 已确认关闭 — an agent quotes it to the user as
        // proof the window is gone, and a lingering msedge tree is not gone.
        const pidWasThere = pidAlive(browserPid)
        const processGone = browserPid > 0 ? await waitForPidExit(browserPid) : true
        const pidNote =
          browserPid > 0
            ? processGone
              ? pidWasThere
                ? `进程 ${browserPid} 已退出`
                : `进程 ${browserPid} 早已不在`
              : `进程 ${browserPid} 仍在（已尝试终止但系统未放行）`
            : "未取得浏览器 pid，进程未核验"
        // The pid check is what makes the word 确认 mean anything.  An
        // unverifiable close must not borrow the verified sentence, because an
        // agent quotes this line to the user as proof the window is gone.
        const verified = browserPid > 0 && processGone
        const closed = errs.length === 0 && alivePages === 0 && !connected && processGone
        const profile = persistentDir
          ? `持久配置目录已保留（下次 open 复用登录态）：${persistentDir}`
          : "临时配置目录由 playwright 自行回收"
        if (closed && verified) return { closed: true, text: `浏览器会话已确认关闭（${sess.label} · ${pidNote}）；${profile}。` }
        if (closed) {
          return {
            closed: false,
            text:
              `连接与窗口已释放，但进程未核验（${sess.label} · ${pidNote}）——这次没拿到浏览器 pid，` +
              `所以这句不是"已确认关闭"。若桌面上窗口仍在请手动关闭；反复出现可换 TM_BROWSER_ENGINE=cdp-legacy 试一次。${profile}。`,
          }
        }
        return {
          closed: false,
          text:
            `警告：关闭未完全成功（${sess.label}${errs.length ? `：${errs.join("; ")}` : ""}）——` +
            `残留标签页 ${alivePages} 个${connected ? "，浏览器进程仍处于连接状态" : ""} · ${pidNote}。` +
            // Three states, and the sentence must match the one we are in.  A
            // dead pid cannot have a window on the desktop, so telling the user
            // to go hunt it sends them after something that is not there — and
            // the leftover count is OUR own stale reference (close_page leaves
            // state.page on the tab it closed).  No pid at all is a DIFFERENT
            // fact: nothing was verified, so the window may genuinely remain.
            (browserPid > 0 && processGone
              ? `进程已确认不在（pid ${browserPid} 已退出），所以桌面上不该还有它的窗口——那个"残留标签页"是我自己留着的路由引用，不是窗口，你不用去找。${profile}。`
              : browserPid > 0
                ? `窗口很可能仍在前台（pid ${browserPid} 还在），请用户手动关闭该浏览器窗口。${profile}。`
                : `这次没拿到浏览器 pid，进程无法核验——若桌面上窗口仍在请手动关闭。${profile}。`),
        }
      },
    }
    return sess
  }

  // ---------- engine-neutral session lifecycle ----------

  /** Idle reaper, PER LEASE.  The pre-v1.5.13 layer had NO cleanup path other
   *  than the agent remembering to call `close` — and an agent that believes it
   *  closed the window (issue #3) leaves the user staring at a Chromium window
   *  nobody owns.  With one browser per caller the timer belongs to the lease:
   *  one agent going quiet must not keep another's window alive, and a reap must
   *  never touch a browser somebody is still driving. */
  function armIdle(lease: BrowserLease): void {
    clearIdle(lease.id)
    if (!idleCloseMs) return
    const t = setTimeout(() => {
      idleTimers.delete(lease.id)
      if (!leases.has(lease.id)) return
      traj({ step_id: "browser", event: "idle_close", idle_ms: idleCloseMs, id: lease.id, agent: lease.agent })
      void closeLease(lease)
        .then((r) =>
          notify?.(
            `tm_browser ${lease.id}（${lease.agent || "agent"} 的浏览器）空闲 ${Math.round(idleCloseMs / 1000)}s，已自动关闭${r.closed ? "（窗口应已消失）" : "——但窗口可能仍需手动关闭"}`,
          ),
        )
        .catch(() => {})
    }, idleCloseMs)
    // never hold the event loop open for a reaper
    ;(t as { unref?: () => void }).unref?.()
    idleTimers.set(lease.id, t)
  }

  /** The caller's browser, launched on first use.  `open` on an existing lease
   *  navigates that window instead of spawning a second one. */
  async function ensureLease(headless: boolean, caller: BrowserCaller): Promise<BrowserLease> {
    const mine = ownedBy(caller.owner)
    if (mine.length) return mine[0]
    const sel = await selection()
    const approved = approvedFor(caller.owner)
    const session =
      sel.kind === "playwright" && sel.pw
        ? await openPlaywrightSession(sel.pw, headless, approved)
        : await openLegacySession(headless, approved)
    const lease: BrowserLease = {
      id: `b${++leaseSeq}`,
      owner: caller.owner,
      agent: caller.agent,
      session,
      at: Date.now(),
      lastActivity: Date.now(),
    }
    leases.set(lease.id, lease)
    traj({ step_id: "browser", event: "lease", id: lease.id, agent: lease.agent, live: leases.size })
    return lease
  }

  async function closeLease(lease: BrowserLease | null): Promise<{ text: string; closed: boolean }> {
    if (!lease) return { text: "没有打开的浏览器会话。", closed: true }
    leases.delete(lease.id)
    clearIdle(lease.id)
    return lease.session.close()
  }

  /** Move any screenshot pixels act() produced out of the session and onto
   *  the ToolResult.  Drained per call so a stale attachment can never ride
   *  along on the next action. */
  function withAttachments(res: ToolResult, sess: ActiveSession | null): ToolResult {
    const atts = sess?.attachments ?? []
    if (sess) sess.attachments = []
    if (!atts.length) return res
    const base = typeof res === "string" ? { output: res } : res
    return { ...base, attachments: atts }
  }

  const ALL_ACTIONS = new Set<string>(ALL_BROWSER_ACTIONS)
  // The menu IS the table the gate below reads.  A hand-written copy drifted the
  // day `new_page` landed: an agent that mistyped a verb was shown a list that
  // did not contain the capability it wanted.
  const ACTION_MENU = BROWSER_ACTION_MENU

  const execute = async (rawArgs: Record<string, unknown>, ctx: unknown): Promise<ToolResult> => {
    // Set once a lease is resolved, so the catch below knows WHICH browser died
    // — with one browser per caller, dropping the wrong lease would kill an
    // agent that was working fine.
    let activeLease: BrowserLease | null = null
    try {
      const args = rawArgs ?? {}
      const action = String(args.action ?? "").trim()
      const url = String(args.url ?? "").trim()
      // Whose browser this is.  The host hands every tool ctx a sessionID, and
      // a lease is keyed by it; without one (an older host, a test harness) all
      // callers share the single anonymous bucket, which is the old behaviour.
      const caller = callerOf(ctx)
      // The profile knob is checked BEFORE any engine runs: a refused value must
      // not spawn a browser that then discovers the problem.
      {
        const probe = classifyProfileDir(env)
        if (probe.refusal) return toToolResult(tmError(tool, "args", probe.refusal))
      }
      // Set when this call proceeded on a DIALOG approval rather than the
      // static allowlist; appended to whichever reply the action returns.
      let grantNote = ""
      // allowlist FIRST — an out-of-allowlist URL only proceeds after the
      // OFFICIAL dialog approves it (then the host passes the network layer
      // too); hard red lines (scheme / env-file) reject with no dialog.
      // NOTE: this gate runs BEFORE engine selection — a blocked target
      // never touches playwright nor spawns anything (§6o invariant).
      // new_page carries a URL too — it must clear the SAME allowlist gate, or
      // "open a second tab" becomes a way around the official dialog.
      if ((action === "open" || action === "navigate" || action === "navigate_page" || action === "new_page") && url) {
        const verdict = checkWebUrl(url, allowlist as readonly string[])
        if (!verdict.ok) {
          if (!verdict.askable || !verdict.url) {
            return toToolResult(tmError(tool, "permission", verdict.message))
          }
          const res = await askUserForTargetDetailed(ctx, {
            permission: tool,
            patterns: [verdict.url.toString()],
            metadata: { tool, url: url.slice(0, 200) },
          })
          if (res.outcome !== "approved") {
            return toToolResult(
              tmError(tool, "permission", verdict.message + " " + askRefusalNote(res.outcome)),
            )
          }
          approvedFor(caller.owner).add(verdict.url.hostname)
          // The approval is recorded in the REPLY, not only the trajectory: an
          // agent that cannot tell a saved "always" from a fresh click reports
          // "no dialog appeared" as evidence about the allowlist — measured live,
          // that is exactly what a researcher wrote into its deliverable.
          grantNote = askGrantNote(res)
          traj({
            step_id: "browser",
            event: res.autoGranted ? "silent_grant" : "dialog_approved",
            host: verdict.url.hostname,
            answered_ms: res.answeredInMs,
          })
        }
      }
      // The remedy for "our gate blanked this page".  A blocked asset host used
      // to be a dead end: the only move was an env edit plus a restart, which no
      // agent can do mid-task, so it reported the site as empty instead.  This
      // routes the SAME official dialog at ONE host, for ONE owner, for the
      // length of the session — and it cannot widen anything: a host already on
      // the static allowlist is refused (asking would train the user to approve
      // what is already allowed), a red-line host is refused with no dialog, and
      // the pattern handed to the dialog is the exact hostname, never a glob.
      if (action === "allow_host") {
        const host = normalizeApprovalHost(args.host)
        if (!host) {
          return toToolResult(
            tmError(tool, "args", '缺少或非法的 host 参数——要形如 "bkssl.bdimg.com" 的单个域名（不接受通配、URL、路径或端口）'),
          )
        }
        const verdict = checkWebUrl(`https://${host}/`, allowlist as readonly string[])
        if (verdict.ok) {
          return toToolResult(
            `不用批准：${host} 本来就在静态白名单里，它的子资源不会被拦。这一页的空白另有原因——看 take_snapshot 的拦截说明（被拦的是别的域名）或用 read 拿原文。`,
          )
        }
        if (!verdict.askable || !verdict.url) {
          return toToolResult(tmError(tool, "permission", `拒绝放行 ${host}：${verdict.message}`))
        }
        const outcome = await askUserForTarget(ctx, {
          permission: tool,
          patterns: [host],
          metadata: { tool, host, reason: "被拦的跨域脚本域名，放行后需重新导航" },
        })
        if (outcome !== "approved") {
          return toToolResult(tmError(tool, "permission", `未放行 ${host}。` + askRefusalNote(outcome)))
        }
        approvedFor(caller.owner).add(host)
        traj({ step_id: "browser", event: "host_approved", host, agent: caller.agent })
        const mine = ownedBy(caller.owner)[0]
        return toToolResult(
          `${mine ? `[${mine.id}] ` : ""}已按用户批准临时放行 ${host}（只对这个浏览器、本次会话，不改任何配置文件）。` +
            `现在重新 navigate 一次同一页——门禁在请求时判定，已经加载完的页面不会自己把脚本补回来。`,
        )
      }
      if (action === "open") {
        if (!url) return toToolResult(tmError(tool, "args", "缺少 url 参数"))
        const existing = ownedBy(caller.owner)[0]
        if (existing) {
          // already open: navigate instead of spawning a second browser.
          // Report the mode the RUNNING instance is actually in — the old
          // code echoed the REQUESTED mode, so a sticky session could be
          // described as headful while it was a headless leftover.
          // Tracked as the active lease: a browser that dies HERE must be
          // dropped too, or the next open hands back the same corpse.
          activeLease = existing
          const out = await existing.session.act("navigate", { url }, "browser")
          armIdle(existing)
          return withAttachments(
            toToolResult(
              `[${existing.id}] 复用你自己的浏览器（${existing.session.headless ? "无头" : "有头窗口"} · ${existing.session.label}）。${out}${grantNote}`,
            ),
            existing.session,
          )
        }
        // Mode is an OPERATOR decision (TM_BROWSER_HEADLESS), never a model
        // arg: a model that once passed headless:"false" (string → truthy
        // under Boolean()) pinned the whole process to headless and every
        // anti-bot gate in the run failed.
        const headless = resolveHeadless(env)
        const lease = await ensureLease(headless, caller)
        activeLease = lease
        const s = lease.session
        const out = await s.act("navigate", { url }, "browser")
        traj({ step_id: "browser", event: "open", headless, label: s.label, id: lease.id, agent: lease.agent })
        const mode = s.headless ? "无头" : "有头窗口"
        // From the SESSION, never from the environment: this line used to re-read
        // TM_BROWSER_USER_DATA_DIR at reply time, so a session that had degraded
        // to cdp-legacy (temp profile) announced 持久登录配置.
        const profile = s.persistentProfile ? "持久登录配置" : "隔离临时配置"
        const note =
          lastSel && preference !== "cdp-legacy" && lastSel.kind === "cdp-legacy"
            ? `\n（引擎：cdp-legacy 降级——${lastSel.reason ?? ""}；完整 16 动作需 npm install playwright-core + node≥20）`
            : ""
        const guard =
          subPolicy === "off"
            ? `\n（子资源策略=off：跨域图片/脚本一律拦截，页面可能显示不全——TM_BROWSER_SUBRESOURCE=same-site 可恢复）`
            : ""
        const others = liveLeases().length - 1
        // The close duty belongs in the reply that OPENS the window, not only in
        // the tool description: a long-lived host never re-reads a description
        // (the same finding that moved the date onto the search header), and the
        // agent's attention is here — the moment it stops needing the page is the
        // moment it forgets the window exists. When the reaper is off, say so
        // rather than promising a cleanup that will not come.
        const duty = idleCloseMs
          ? `\n用完必须 action:"close"（窗口用户看得见；空闲 ${Math.round(idleCloseMs / 1000)}s 我会替你关掉并提示他）。`
          : `\n用完必须 action:"close"——TM_BROWSER_IDLE_MS=0，没有空闲回收，你不关它就一直开着。`
        armIdle(lease)
        return withAttachments(
          toToolResult(
            `[${lease.id}] 浏览器已启动（${mode}，${profile} · ${s.label}）。${out}${note}${guard}` +
              `\n这个窗口的 id 是 ${lease.id}，归你（${lease.agent || "本会话"}）：后续动作带 id:"${lease.id}"。` +
              duty +
              (others > 0
                ? `现在共有 ${others + 1} 个浏览器在跑（别的 agent 各有各的窗口），省略 id 会被拒绝。`
                : "") +
              grantNote,
          ),
          s,
        )
      }
      if (action === "navigate" || action === "navigate_page") {
        if (!url) return toToolResult(tmError(tool, "args", "缺少 url 参数"))
        const got = resolveLease(args, caller)
        if ("error" in got) return toToolResult(tmError(tool, "args", got.error))
        activeLease = got.lease
        const out = await got.lease.session.act(action, { url }, "browser")
        armIdle(got.lease)
        return withAttachments(toToolResult(`[${got.lease.id}] ${out}${grantNote}`), got.lease.session)
      }
      if (action === "close") {
        // `id:"all"` closes every browser the CALLER owns — never anybody
        // else's, which is the one thing a shared kill switch would get wrong.
        const mine = ownedBy(caller.owner)
        if (String(args.id ?? "").trim().toLowerCase() === "all") {
          if (!mine.length) return toToolResult(tmError(tool, "args", "你没有打开的浏览器。"))
          traj({ step_id: "browser", event: "close", id: "all", count: mine.length, agent: caller.agent })
          const parts: string[] = []
          for (const l of mine) parts.push(`[${l.id}] ${(await closeLease(l)).text}`)
          return toToolResult(parts.join("\n"))
        }
        const got = resolveLease(args, caller)
        if ("error" in got) return toToolResult(tmError(tool, "args", got.error))
        traj({ step_id: "browser", event: "close", id: got.lease.id, agent: caller.agent })
        const r = await closeLease(got.lease)
        return toToolResult(`[${got.lease.id}] ${r.text}`)
      }
      if (!ALL_ACTIONS.has(action)) {
        return toToolResult(
          tmError(
            tool,
            "args",
            `未知 action "${String(action).slice(0, 30)}"——可用: ${ACTION_MENU}（快照优先：先 take_snapshot，按 [uid=…] 寻址）`,
          ),
        )
      }
      const got = resolveLease(args, caller)
      if ("error" in got) return toToolResult(tmError(tool, "args", got.error))
      const lease = got.lease
      // Bound locally so the dispatch below reads the way it did when the whole
      // process had one browser — except `session` now means "the CALLER's
      // browser", never "the browser".
      const session = lease.session
      activeLease = lease
      armIdle(lease)
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
      // M5 (v1.5.14): evaluate_script's consent + result redaction run at the
      // execute layer for BOTH engines — same reason upload_file's source
      // check does: the engine act() has no host ctx, and one choke point
      // cannot drift from the other.
      if (action === "evaluate_script" && needsEvalConsent(evalAskPolicy, session.evalApproved)) {
        const target = hostOnly(session.currentUrl)
        // An error page or a blank tab has no host to consent to. Asking the
        // official dialog about `evaluate_script:` with an EMPTY pattern gives
        // the user a prompt they cannot judge, and the refusal then reads
        // "未获批准（目标站点 ）" — seen live on a chrome-error:// tab.
        if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(target)) {
          const where = String(session.currentUrl ?? "").slice(0, 80) || "空白页"
          traj({ step_id: "browser", event: "eval_refused_no_host", where })
          return toToolResult(
            tmError(
              tool,
              "permission",
              `evaluate_script 被拒绝：当前页面不是可识别的 http(s) 站点（${where}），没有可批准的主机。` +
                `先 open/navigate 到一个真实页面再执行 JS——对着错误页要权限，用户无法判断该不该批。`,
            ),
          )
        }
        const outcome = await askUserForTarget(ctx, {
          permission: tool,
          patterns: [`evaluate_script:${target}`],
          metadata: {
            tool,
            action: "evaluate_script",
            host: target,
            source: String(args.function ?? args.expression ?? "").slice(0, 160),
          },
        })
        traj({ step_id: "browser", event: "eval_consent", host: target, verdict: outcome })
        if (outcome !== "approved") {
          return toToolResult(
            tmError(
              tool,
              "permission",
              (outcome === "unavailable"
                ? `evaluate_script 需要官方确认窗授权，本宿主没有 ask 桥——已拒绝执行。TM_BROWSER_ASK_EVAL=off 可关掉这道确认（不建议：这个动词能在你已登录的浏览器里读任意页面数据）。`
                : `evaluate_script 未获批准（目标站点 ${target}），已拒绝执行。改用 take_snapshot/read 的受治理读取，或让用户单独批准。`) +
                " " +
                askRefusalNote(outcome),
            ),
          )
        }
        session.evalApproved = true
      }
      const stepId = pipelines.nextStepId()
      const out = await session.act(action, args, stepId)
      if (action !== "evaluate_script") {
        return withAttachments(toToolResult(`[${lease.id}] ${out}${grantNote}`), session)
      }
      // The value is masked BEFORE it can reach the context window, the run
      // store or the trajectory; the agent is told a mask happened (a silent
      // blank would read as "the page has no token").
      const red = redactEvalResult(out)
      if (red.masked.length) {
        traj({ step_id: "browser", event: "eval_redacted", kinds: red.masked.join(",") })
        return withAttachments(
          toToolResult(
            `[${lease.id}] ${red.text}\n注意：结果里有 ${red.masked.join("、")} 被识别为密钥形状并已脱敏——不是页面没有这些值，是插件不把它们送进上下文。需要它们请让用户自己在浏览器里看。`,
          ),
          session,
        )
      }
      return withAttachments(toToolResult(`[${lease.id}] ${red.text}`), session)
    } catch (err) {
      const e = err as { name?: string; message?: unknown }
      const msg = String(e?.message ?? err ?? "browser 操作失败")
      // A browser the user closed — or a launch that handed its request to an
      // already-running Edge and exited — leaves a cached session whose every
      // action throws the SAME line. Live session: three identical failures,
      // then a fourth, with no way out except our own bookkeeping. Drop the
      // corpse, say that we did, and name the one move that works.  With one
      // browser per caller, only THAT lease is dropped: another agent's window
      // is not ours to declare dead.
      if (/has been closed|Target closed|Browser closed|browser has been closed/i.test(msg)) {
        const dead = activeLease
        const leaseId = dead?.id ?? ""
        // That one string covers two very different facts — a TAB the user closed
        // and a BROWSER that died.  Only the second may cost the lease: measured
        // live, closing the last tab threw this line while the window was still
        // up, the lease got dropped, `close` then reported "no browser open", and
        // the user was left holding a browser no agent could address.
        const alive = dead ? dead.session.alive?.() !== false : false
        if (dead && !alive) {
          leases.delete(dead.id)
          clearIdle(dead.id)
        }
        traj({
          step_id: "browser",
          event: alive ? "page_dead_browser_alive" : "session_dead",
          cleared: Boolean(dead && !alive),
          id: leaseId,
          reason: msg.slice(0, 160),
        })
        return toToolResult(
          tmError(
            tool,
            "execute",
            alive
              ? `${msg.slice(0, 200)}\n但浏览器本身还连着（${leaseId} 我保留了，你的 id 不变）——死的是**这一个页面/标签**，不是实例。` +
                  `下一步：list_pages 看还剩几个标签，或 new_page 在同一个窗口开一个；要结束整个会话用 close。`
              : `${msg.slice(0, 200)}\n浏览器实例已失效${dead ? `（${leaseId}，${dead.agent || "本会话"} 的窗口）：我已丢弃它，下一次 action:"open" 会真的重启一个新实例` : "，当前没有可复用的会话"}。` +
                  `连着两次都这样，通常是本机已有同品牌浏览器在跑、新进程把请求移交给旧实例后退掉了——请用户关掉那个窗口再 open，或设 TM_BROWSER_ENGINE=cdp-legacy 换一条传输。` +
                  `不要第三次重复同一个动作。`,
          ),
        )
      }
      return toToolResult(tmError(tool, "execute", msg))
    }
  }

  const DESCRIPTION = `Interactive browser (governed, Plan C): drives the user's own Chromium-family browser HEADFUL — playwright-core engine primary (npm install + node>=20; auto-degrades to the zero-dep CDP pipe when absent, snapshot actions then unavailable). Snapshot-first flow: open → take_snapshot → act by [uid] → observe again.
- MULTI-TAB is a first-class flow: new_page { url? } opens a tab and makes it current (its url clears the SAME allowlist gate and dialog as navigate_page), list_pages numbers them, select_page { index } switches, close_page { index? } closes one and moves you to a survivor — closing the LAST tab does NOT close the browser, and the reply says so. Compare two pages without losing either.
- ONE BROWSER PER AGENT: open returns an id ("b1") and that window is YOURS — its own uid numbering, its own current tab, its own dialog-approved hosts. Every reply is prefixed with the id it ran on. Pass id on every action once more than one browser is live (omitting it is only unambiguous while exactly one exists and it is yours); another agent's id is refused with the owner named, because sharing one window means your take_snapshot renumbers the uids they are holding and their next click lands somewhere else while STILL reporting success. close { id: "all" } closes all of yours — never anybody else's.
- 18 actions (chrome-devtools-mcp aligned): navigate_page { url } · take_snapshot { } → ariaSnapshot YAML with injected [uid=eN] · click/fill{text}/hover { uid|selector } · drag { uid, targetUid } · press_key { key } · select_page { index } · upload_file { uid, filePath } (filePath must live INSIDE the workspace/blackboard scope — .env & shell-rc files are refused) · wait_for { text|uid, timeoutMs<=3000 default } · evaluate_script { function } (arbitrary JS in YOUR browser: needs one official-dialog consent per browser session, and the result is scanned so JWT/bearer/cookie/api-key shapes never enter the context) · list_console_messages · list_network_requests · list_pages · take_screenshot { fullPage?, image? } → the PNG always lands in the run store (path in the reply); with image:true a quality-70 JPEG of the same view is attached to THIS result so a vision model can actually see it (opt-in: pixels cost context, so ask only when the screenshot is the evidence) · handle_dialog { dialogAction: accept|dismiss, promptText }.
- Compat actions: open { url } — launch/reuse + navigate (TM_BROWSER_PATH override → DEFAULT browser, Chromium-family only; the registry ProgId decides the CHANNEL, so an Edge Beta default opens Edge Beta, not stable). Isolated temp profile by default; persistent login ONLY via TM_BROWSER_USER_DATA_DIR — honored by BOTH engines, and a value pointing at your browser's OWN data dir (…\\Microsoft\\Edge\\User Data, google-chrome, Firefox Profiles) is refused before anything spawns, because browsing as your real identity plus a force-kill reaper is how a profile gets corrupted. navigate / read (page text) / screenshot / close also work.
- Lifecycle (the user SEES this window): headful by default — headless is an operator setting (TM_BROWSER_HEADLESS), not a parameter you can pass. An idle session closes itself (TM_BROWSER_IDLE_MS, default 180s) and the user is told. ALWAYS action:"close" when your browser work is done, and quote the tool's own close line — "已确认关闭" vs "警告：关闭未完全成功" — instead of asserting the window is gone.
- Discipline (enforced by defaults): act ONLY on uids from the latest take_snapshot — no guessed locators; one action then one observation; fold dialogs into the same round (snapshot header warns while a dialog is held); 3000 ms action budget; networkidle is never waited on; screenshots are the visual-last-resort, not the primary read.
- Network: the top-level navigation must clear the domain allowlist (seeded = tm_webfetch's hosts; out-of-allowlist open/navigate asks the user through the OFFICIAL confirmation dialog BEFORE any spawn). SUBRESOURCES then follow TM_BROWSER_SUBRESOURCE (default same-site): images/media/fonts/stylesheets load, a script/XHR loads when it belongs to a site this session actually opened, anything else is blocked and reported as a "N 个子资源被拦截" note on the next snapshot — that note means the gate trimmed the page, NOT that the site has no images. env-file URLs and non-http(s) schemes hard-reject under every policy.
- An EMPTY page gets a reason, never a shrug. A site whose own bundle sits on a brand-unrelated CDN (Baidu's bdimg.com is the case that started this) renders 0 addressable nodes behind our gate; the reply then names the blocked host and says the blankness is OURS, with two ways out: allow_host { host } — one bare domain, this browser, this session, via the OFFICIAL dialog, nothing written to any config (re-navigate afterwards, the gate decides per request) — or the user adding the host to TM_WEBFETCH_ALLOWED_DOMAINS and restarting. And if the page is really a human-verification wall (百度安全验证 / Cloudflare / access denied) the reply says so, because a wall is not an empty site: retrying it buys nothing, the move is another source or the user's own hands.
- A dead instance is never retried: if an action reports the browser/page "has been closed", the cached session is dropped, the reply says the next open really rebuilds, and the trajectory records session_dead — do NOT repeat the same open a third time (close the competing browser window, or set TM_BROWSER_ENGINE=cdp-legacy). evaluate_script on a hostless page (chrome-error://, about:blank) is refused outright: an empty dialog pattern is something no user can judge.  No browser installed → structured error, fall back to tm_webfetch / MCP.  Role grant: team + researcher full, tester browser-only (UI verification).`

  return {
    description: DESCRIPTION,
    args: deps.args ?? {
      action: { descriptor: "action: take_snapshot|click|fill|navigate_page|... (18 playwright verbs + open/navigate/read/screenshot/close)" },
      id: { descriptor: 'id: which browser — the id open gave you ("b1"). One browser per agent: required once more than one is live, and it must be YOURS (another agent\'s id is refused). close {id:"all"} closes all of yours' },
      url: { descriptor: "url: string (open/navigate/navigate_page, allowlisted https)" },
      image: { descriptor: "image: true (take_screenshot only — attach the PNG pixels to this result; default is path-only)" },
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
    dispose: async () => {
      for (const t of idleTimers.values()) clearTimeout(t)
      idleTimers.clear()
      // AWAITED: the host's dispose hook is Promise-returning, and tearing
      // down while a close was still in flight left the window on screen.
      // EVERY lease, not just one caller's: plugin unload owns all of them.
      for (const l of liveLeases()) {
        await closeLease(l).catch(() => {})
      }
    },
    engineInfo: () => ({
      kind: lastSel?.kind ?? null,
      reason: lastSel?.reason ?? null,
    }),
    leases: () => {
      const nowMs = Date.now()
      return liveLeases().map((l) => ({
        id: l.id,
        owner: l.owner,
        agent: l.agent,
        idleMs: Math.max(0, nowMs - l.lastActivity),
      }))
    },
  }
}

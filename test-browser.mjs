/**
 * test-browser.mjs — T5 tm_browser package assertions (round 2).
 *
 * Scope (per the design board — §6o STAYS in test-tm-tools.mjs, this file
 * does NOT migrate it):
 *   (a) engine selection + degrade logic (browserEngine=playwright with a
 *       failing playwright-core import lands on cdp-legacy; =cdp-legacy
 *       never imports; node<20 never imports);
 *   (b) the cdp-legacy behavior contract that must not regress (pre-spawn
 *       allowlist gate, discovery error, §6o-verbatim output shapes) — the
 *       live §6o round-trip in test-tm-tools.mjs is the browser-running
 *       counterpart, re-verified separately by this package's run;
 *   (c) the 18 chrome-devtools-mcp verb mappings + ariaSnapshot handling
 *       against a MOCK playwright module (fake chromium/locator objects —
 *       the suite must not REQUIRE playwright to be installed, because
 *       installing it is a release/user action);
 *   (d) the REAL playwright smoke is explicitly gated behind
 *       `npm install` — skipped (never failed) while playwright-core is
 *       absent.  When it DOES run it is not a smoke: it asserts the three
 *       claims the mock groups can only approximate — that `close`'s
 *       已确认关闭 is true for the OS process AND its whole child tree
 *       (issue: close printed success over a live msedge tree), that
 *       new_page/list_pages/close_page work on a real context, and that the
 *       orphan reaper's DEFAULT kill path really takes a browser down.
 *
 * Runs against ./dist (build first: npm run build).
 */
import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const br = await import("./dist/tm/browser.js")
const sp = await import("./dist/prompts/specialists.js")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tm-browser-test-"))
process.on("exit", () => {
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* temp dir reclaimed by the OS */
  }
})

/** The fake exe only ever feeds discovery/launch-option assertions — no
 *  process is spawned while playwright is faked. */
const fakeExe = path.join(root, "msedge.exe")
fs.writeFileSync(fakeExe, "MZ")

let stepSeq = 0
/** Beyond any pid the OS will hand out, so `pidAlive()` is false for it — the
 *  fake browser pid every mock test uses.  Nothing real is ever signalled. */
const NO_PID = 0x7fffffe0
function makeTool(over = {}) {
  const events = []
  const stepsRoot = path.join(root, `steps-${++stepSeq}`)
  fs.mkdirSync(stepsRoot, { recursive: true })
  const pipelines = {
    nextStepId: () => `s9${String(++stepSeq).padStart(3, "0")}`,
    store: { appendTrajectory: (e) => events.push(e), stepsRoot: () => stepsRoot },
  }
  // The real smoke passes a store root so the ORPHAN LEDGER is written for
  // real — that file is the only independent record of which OS pid this
  // session launched, which is what a close verdict has to be checked against.
  if (over.blackboardRoot) pipelines.store.blackboardRoot = over.blackboardRoot
  const cfg = {
    browserEngine: over.browserEngine ?? "playwright",
    browserSnapshotMaxTokens: over.snapshotMaxTokens ?? 1200,
    browserSubresource: over.subresource,
    browserImageMaxBytes: over.imageMaxBytes,
    browserIdleCloseMs: over.idleMs,
    browserAskEval: over.askEval ?? "on",
    webfetchAllowedDomains: over.cfgDomains ?? ["cn.bing.com", "bing.com", "example.com"],
  }
  // `discovered: true` feeds the exe through the discovery SEAM instead of
  // TM_BROWSER_PATH — an explicit override must never be substituted by a
  // playwright channel, so the channel-fallback path is only reachable from
  // a discovered candidate.
  const env =
    over.discovered || over.realDiscovery
      ? { TM_BROWSER_HEADLESS: "1", ...over.env }
      : { TM_BROWSER_PATH: over.executablePath ?? fakeExe, TM_BROWSER_HEADLESS: "1", ...over.env }
  // The default mock mirrors playwright-core 1.63, which has NO
  // Browser.process(): the product must fall through to the OS child scan.  So
  // the scan is fed one row for the executable THIS tool will launch, keeping
  // every mock test on the real code path instead of a legacy accessor.  The
  // real-discovery leg deliberately passes nothing, so it exercises the real
  // query.  A test that wants "no pid found" passes listChildren: () => [].
  const scanExe = over.executablePath ?? fakeExe
  const listChildren = over.realDiscovery
    ? undefined
    : over.listChildren ?? (() => [{ pid: NO_PID, name: path.basename(scanExe), cmdline: `"${scanExe}" --remote-debugging-pipe` }])
  const tool = br.buildTmBrowserTool({
    pipelines,
    cfg,
    env,
    importPlaywright: over.importPlaywright,
    nodeMajor: over.nodeMajor,
    findExecutable: over.discovered ? () => over.executablePath : undefined,
    listChildren,
    notify: over.notify,
  })
  return { tool, events, stepsRoot }
}

const ctxNoAsk = { directory: root }
const ctxApprove = { directory: root, ask: async () => "once" }
const o = (r) => String(r?.output ?? "")

// ---------- mock playwright-core (task c — NO real install) ------------------

const ARIA_YAML = [
  "- banner:",
  "  - heading \"站点 标题\" [level=1]",
  "- main:",
  "  - textbox \"用户名\"",
  "  - textbox \"密码\"",
  "  - button \"登 录\"",
  "  - button \"登 录\"",
  "  - link \"帮助: 首页\"",
  "  - text: some plain text",
  "- list:",
  "  - listitem:",
  "    - checkbox \"记住我\" [checked]",
].join("\n")

function makeFakePw(opts = {}) {
  let ctxRef = null
  const calls = {
    launch: [],
    persistent: [],
    contextOpts: [],
    route: [],
    acted: [],
    pages: [],
    pngBytes: Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]),
  }
  const makeLocator = (desc) => ({
    desc,
    ariaSnapshot: async () => {
      if (opts.ariaThrows) throw new Error("locator.ariaSnapshot is not a function")
      return opts.ariaYaml ?? ARIA_YAML
    },
    click: async () => {
      calls.clicks = (calls.clicks ?? 0) + 1
      calls.acted.push(["click", desc])
      opts.onClick?.(calls.clicks)
    },
    // the click-effect probe reads the element in ONE round-trip; a mock with no
    // `probe` returns undefined, which the product must treat as "cannot verify"
    evaluate: async () => (typeof opts.probe === "function" ? opts.probe() : undefined),
    fill: async (t) => calls.acted.push(["fill", desc, t]),
    hover: async () => calls.acted.push(["hover", desc]),
    pressKey: async (k) => calls.acted.push(["pressKey", desc, k]),
    setInputFiles: async (f) => calls.acted.push(["setInputFiles", desc, f]),
    waitFor: async (x) => calls.acted.push(["waitFor", desc, x]),
    dragTo: async (t) => calls.acted.push(["dragTo", desc, t.desc]),
    nth: (i) => makeLocator(`${desc}#nth${i}`),
  })
  const mkPage = (url, label) => {
    const p = {
      label,
      _url: url,
      _events: {},
      keys: [],
      evals: [],
      brought: 0,
      goto(u, x) {
        this._url = u
        p._goto = { u, x }
        return Promise.resolve()
      },
      locator: (sel) => makeLocator(`${label}:locator(${sel})`),
      getByRole: (role, x) => makeLocator(`${label}:getByRole(${role},${JSON.stringify(x ?? null)})`),
      getByText: (t) => makeLocator(`${label}:getByText(${t})`),
      keyboard: { press: (k) => (p.keys.push(k), Promise.resolve()) },
      waitForLoadState: async () => {
        calls.settled = (calls.settled ?? 0) + 1
        opts.onSettle?.()
      },
      evaluate: (src) => (p.evals.push(src), Promise.resolve(opts.evalValue ?? "EVAL")),
      screenshot: (x) => (p._shotOpts = x, Promise.resolve(calls.pngBytes)),
      on(ev, cb) {
        ;(p._events[ev] ??= []).push(cb)
      },
      fire(ev, arg) {
        for (const cb of p._events[ev] ?? []) cb(arg)
      },
      url: () => p._url,
      title: () => Promise.resolve(`title<${p._url}>`),
      bringToFront: () => (p.brought++, Promise.resolve()),
      // close_page needs a faithful tab: it leaves the context's list
      close: async () => {
        p._closed = true
        if (p._ctx) p._ctx._pages = p._ctx._pages.filter((x) => x !== p)
      },
    }
    return p
  }
  const mkContext = () => {
    const page0 = mkPage("about:blank", "p0")
    const page1 = mkPage("https://cn.bing.com/second", "p1")
    const context = {
      _pages: [page0, page1],
      route(pattern, handler) {
        calls.route.push({ pattern, handler })
        // M2 pin: simulated context.route() registration failure
        if (opts.routeThrows) throw new Error("route registration refused (fake)")
      },
      pages: () => context._pages,
      newPage: async () => {
        // a faithful new tab: a distinct page appended to the context, which is
        // exactly what new_page has to be for multi-tab to mean anything
        const p = mkPage("about:blank", `p${context._pages.length}`)
        p._ctx = context
        context._pages.push(p)
        calls.newPage = (calls.newPage ?? 0) + 1
        return p
      },
      // a faithful close: the real context drops its pages AND reports
      // disconnected — tm_browser's verified close verdict reads that state
      close: async () => {
        context._closed = true
        context._pages = []
        if (context._browser) context._browser._closed = true
        return true
      },
    }
    page0._ctx = context
    page1._ctx = context
    ctxRef = context
    return context
  }
  const pw = {
    chromium: {
      async launch(launchOpts) {
        calls.launch.push(launchOpts)
        // executablePath is the PRIMARY launch now; this seam simulates a
        // host where that exec refuses to start, so the channel fallback
        // leg gets exercised.
        if (opts.execPathThrows && !launchOpts.channel && calls.launch.length === 1) {
          throw new Error("executablePath launch refused (fake)")
        }
        const browser = {
          async newContext(contextOpts) {
            calls.contextOpts.push(contextOpts)
            browser._context = mkContext()
            browser._context._browser = browser
            return browser._context
          },
          async close() {
            browser._closed = true
            if (browser._context) browser._context._pages = []
          },
          isConnected: () => !browser._closed,
          // `process()` is NOT part of playwright-core's Browser — measured on
          // 1.63 it is `undefined` (that accessor lives on ElectronApplication
          // and BrowserServer).  The fake mirrors the real shape by default;
          // tests that want the legacy accessor opt in with `browserPid`.
          ...(opts.browserPid === undefined ? {} : { process: () => ({ pid: opts.browserPid }) }),
        }
        calls.launchBrowser = browser
        return browser
      },
      async launchPersistentContext(dir, fullOpts) {
        calls.persistent.push({ dir, fullOpts })
        const context = mkContext()
        context._closeOnly = true
        return context
      },
    },
  }
  return { pw, calls, get __ctx() { return ctxRef }, get __ctxPage() { return ctxRef?._pages?.[0] ?? null } }
}

let n = 0
const log = (msg) => console.log(`  ✓ ${++n}. ${msg}`)

async function main() {
  console.log("browser. tm_browser T5 package (engine selection/degrade + 16 verbs on mock playwright + uid registry)")

  // ---------- 1. engine selection / degrade logic (task a) ----------
  {
    assert.equal(br.PLAYWRIGHT_MIN_NODE_MAJOR, 20, "playwright node gate constant = 20")
    assert.equal(br.nodeMajorOf("v22.13.1"), 22, "nodeMajorOf parses vXX")
    assert.equal(br.nodeMajorOf("20.0.0"), 20, "nodeMajorOf parses bare")
    assert.equal(br.nodeMajorOf("garbage"), 0, "nodeMajorOf unparseable -> 0 (fail toward legacy)")

    let imports = 0
    const boom = async () => {
      imports++
      throw new Error("Cannot find package 'playwright-core'")
    }
    // playwright preference + failing import -> degrade to cdp-legacy
    let sel = await br.selectBrowserEngine({ preference: "playwright", nodeMajor: 22, importPlaywright: boom })
    assert.equal(sel.kind, "cdp-legacy", "import failure degrades playwright -> cdp-legacy")
    assert.ok(String(sel.reason).includes("playwright-core 加载失败"), "degrade reason names the import failure")
    assert.equal(imports, 1, "import was attempted once")
    // cdp-legacy preference -> legacy WITHOUT ever importing
    sel = await br.selectBrowserEngine({ preference: "cdp-legacy", nodeMajor: 22, importPlaywright: boom })
    assert.equal(sel.kind, "cdp-legacy", "explicit preference stays legacy")
    assert.equal(imports, 1, "cdp-legacy preference never imports playwright-core")
    // node < 20 -> legacy WITHOUT importing
    sel = await br.selectBrowserEngine({ preference: "playwright", nodeMajor: 18, importPlaywright: boom })
    assert.equal(sel.kind, "cdp-legacy", "node 18 < 20 refuses playwright")
    assert.ok(String(sel.reason).includes("node 18"), "reason records the node gate")
    assert.equal(imports, 1, "node gate precedes the import")
    // node exactly 20 + good module -> playwright, pw carried
    const fake = { chromium: { launch: () => {}, launchPersistentContext: () => {} } }
    sel = await br.selectBrowserEngine({ preference: "playwright", nodeMajor: 20, importPlaywright: async () => fake })
    assert.equal(sel.kind, "playwright", "node 20 + importable package selects playwright")
    assert.equal(sel.pw, fake, "selection carries the imported module")
    // module shape guard
    sel = await br.selectBrowserEngine({ preference: "playwright", nodeMajor: 22, importPlaywright: async () => ({}) })
    assert.equal(sel.kind, "cdp-legacy", "shape-invalid playwright module degrades")
    // unknown preference strings coerce to the playwright default
    sel = await br.selectBrowserEngine({ preference: "nonsense", nodeMajor: 22, importPlaywright: async () => fake })
    assert.equal(sel.kind, "playwright", "unrecognized preference defaults toward playwright (config coerces too)")
    log("engine selection: preference / node>=20 gate / import failure / shape guard all degrade or select correctly")
  }

  // ---------- 2. discovery-layer non-regression (kept verbatim, T5 pins) ----------
  {
    assert.equal(br.isChromiumFamily("C:\\Program Files\\Mozilla Firefox\\firefox.exe"), false, "firefox rejected")
    assert.equal(br.isChromiumFamily("/usr/bin/chromium-browser"), true, "chromium-browser accepted")
    assert.equal(
      br.parseRegCommand('    (Default)    REG_SZ    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1\r\n'),
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      'registry command template `" -- %1"` stripped from the exe path',
    )
    assert.equal(br.parseProgId("    ProgId    REG_SZ    MSEdge\r\n"), "MSEdge", "ProgId parsed")
    assert.equal(br.parseDesktopExec('Exec=/usr/bin/google-chrome-stable -- "%1"\r\n'), "/usr/bin/google-chrome-stable", "Exec template stripped")
    assert.equal(br.resolveHeadless({ TM_BROWSER_HEADLESS: "1" }), true, "headless matrix: force 1")
    assert.equal(br.resolveHeadless({ TM_BROWSER_HEADLESS: "0" }), false, "headless matrix: force 0")
    assert.equal(br.findBrowserExecutable({ TM_BROWSER_PATH: fakeExe }), fakeExe, "TM_BROWSER_PATH override")
    log("discovery layer intact: Chromium-family filter + registry/desktop template stripping + override + headless matrix")
  }

  // ---------- 3. 18-verb alignment (R2 mapping table) ----------
  {
    const R2_18 = [
      "navigate_page", "take_snapshot", "click", "fill", "hover", "drag", "press_key",
      "select_page", "new_page", "close_page", "upload_file", "wait_for", "evaluate_script",
      "list_console_messages", "list_network_requests", "list_pages", "take_screenshot", "handle_dialog",
    ]
    assert.deepEqual([...br.BROWSER_PLAYWRIGHT_ACTIONS].sort(), [...R2_18].sort(), "chrome-devtools-mcp 18 verbs, byte-identical names")
    const legacy = new Set(br.BROWSER_LEGACY_ACTIONS)
    for (const v of ["new_page", "close_page"]) {
      assert.ok(!legacy.has(v), `${v} is playwright-only — cdp-legacy has no target create/close path, and it must say so rather than half-work`)
    }
    for (const v of ["navigate_page", "take_screenshot", "list_pages", "evaluate_script"]) {
      assert.ok(legacy.has(v), `cdp-legacy keeps the ${v} alias (no §6o regression surface shrinks)`)
    }
    for (const v of ["take_snapshot", "click", "fill", "handle_dialog", "upload_file"]) {
      assert.ok(!legacy.has(v), `${v} is playwright-only on the degraded engine`)
    }
    log("action surface: 16 verbs aligned; legacy subset keeps the compatible four + core five")
  }

  // ---------- 4. SnapshotIndex: ariaSnapshot -> uid registry (task c core) ----------
  {
    const idx = new br.SnapshotIndex()
    const annotated = idx.annotate(ARIA_YAML)
    const uidLines = annotated.split("\n").filter((l) => /\[uid=e\d+\]/.test(l))
    assert.equal(uidLines.length, 11, "11 addressable nodes (banner/heading/main/2 textbox/2 button/link/list/listitem/checkbox)")
    assert.ok(annotated.includes("  - text: some plain text\n"), "text pseudo-role line NOT annotated / NOT renumbered")
    assert.ok(annotated.includes("- list [uid=e"), "container line keeps `key:` anchor semantics (uid injected BEFORE the colon)")
    assert.ok(annotated.includes('"帮助: 首页"'), "colons inside quoted names survive the container split")
    assert.ok(annotated.includes('[level=1] [uid=e2]'), "attrs stay before the injected uid")
    assert.deepEqual(idx.get("e4"), { role: "textbox", name: "用户名", nth: 0 }, "uid e4 = first 用户名 textbox")
    assert.deepEqual(idx.get("e7"), { role: "button", name: "登 录", nth: 1 }, "duplicate role+name counts nth-of-kind")
    assert.equal(idx.get("e999"), undefined, "stale/unknown uid misses")
    // ariaSnapshot escapes: \s \n \t \" \\
    assert.equal(br.unescapeAriaName("a\\sb\\nc\\td\\\"e\\\\f"), "a b\nc\td\"e\\f", "aria name unescape")
    const idx2 = new br.SnapshotIndex()
    idx2.annotate(ARIA_YAML)
    const p = {
      getByRole: (role, x) => ({ role, x, nth: (i) => ({ role, x, i }) }),
    }
    const loc = idx2.locatorFor(p, "e7")
    assert.equal(loc.role, "button", "locatorFor builds getByRole(role)")
    assert.deepEqual(loc.x, { name: "登 录", exact: true }, "locatorFor pins exact accessible name")
    assert.equal(loc.i, 1, "locatorFor applies nth-of-kind")
    assert.equal(idx2.locatorFor(p, "nope"), null, "locatorFor unknown uid -> null")
    idx2.annotate("- button \"New\"")
    assert.equal(idx2.get("e4"), undefined, "each take_snapshot RESETS the registry (uids renumbered)")
    assert.deepEqual(idx2.get("e1"), { role: "button", name: "New", nth: 0 }, "fresh snapshot indexes fresh")
    log("uid registry: annotate/attrs/container/nth-dedup/stale-uid handling all pinned")
  }

  // ---------- 5. pre-spawn gates + degrade wiring through the tool ----------
  {
    let importCalls = 0
    const missing = path.join(root, "definitely-missing-browser.exe")
    const mk = makeTool({
      executablePath: missing,
      importPlaywright: async () => {
        importCalls++
        throw new Error("Cannot find package 'playwright-core'")
      },
      nodeMajor: 22,
    })
    // allowlist gate runs BEFORE engine selection AND before any spawn
    const blocked = await mk.tool.execute({ action: "open", url: "https://not-allowed.test/x" }, ctxNoAsk)
    assert.ok(o(blocked).includes("phase=permission"), "out-of-allowlist open -> permission error")
    assert.equal(importCalls, 0, "blocked target never touches engine selection (pre-spawn invariant)")
    const blockedNav = await mk.tool.execute({ action: "navigate_page", url: "https://not-allowed.test/x" }, ctxNoAsk)
    assert.ok(o(blockedNav).includes("phase=permission"), "navigate_page rides the same pre-spawn gate")
    assert.equal(mk.tool.engineInfo().kind, null, "engine selection is lazy — gates answered, nothing chosen yet")
    // open without url -> args error (legacy §6o wording)
    assert.ok(o(await mk.tool.execute({ action: "open" }, ctxNoAsk)).includes("缺少 url"), "open without url keeps 缺少 url")
    // navigate without session -> session guidance, STILL no spawn/engine
    assert.ok(o(await mk.tool.execute({ action: "navigate", url: "https://cn.bing.com" }, ctxNoAsk)).includes('action:"open"'), "navigate without session -> open-first guidance")
    // allowed target -> engine selected -> degraded legacy -> discovery error
    const miss = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(miss).includes("未找到可用的浏览器"), "degraded cdp-legacy reaches its own discovery error")
    assert.equal(importCalls, 1, "selection attempted the playwright import exactly once (cached)")
    assert.equal(mk.tool.engineInfo().kind, "cdp-legacy", "engineInfo reports the degraded engine")
    assert.ok(String(mk.tool.engineInfo().reason).includes("加载失败"), "engineInfo reason traces the import failure")
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.equal(importCalls, 1, "engine selection memoized per plugin instance")
    assert.ok(mk.events.some((e) => e.event === "engine" && e.kind === "cdp-legacy"), "degrade is trajectory-audited")
    // unknown action -> full verb list
    const unknown = await mk.tool.execute({ action: "teleport" }, ctxNoAsk)
    assert.ok(o(unknown).includes("未知 action") && o(unknown).includes("take_snapshot"), "unknown action lists the snapshot-first surface")
    // The menu is now DERIVED from the same table the gate reads, because the
    // hand-written copy did not gain new_page when new_page shipped — and this
    // refusal line is the only place an agent that forgot the verb can find it.
    assert.ok(o(unknown).includes("new_page") && o(unknown).includes("close_page"), "unknown action names the multi-tab verbs")
    assert.equal((o(unknown).match(/ \| /g) ?? []).length + 1, 23, "the derived menu lists every registered verb exactly once")
    // cdp-legacy preference -> import NEVER called
    let legacyToolImports = 0
    const legacyTool = makeTool({
      executablePath: missing,
      browserEngine: "cdp-legacy",
      importPlaywright: async () => {
        legacyToolImports++
        return {}
      },
    })
    await legacyTool.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.equal(legacyToolImports, 0, "TM_BROWSER_ENGINE=cdp-legacy skips the import entirely")
    assert.ok(String(legacyTool.tool.engineInfo().reason).includes("偏好"), "legacy preference reason recorded")
    // node<20 tool path -> no import either
    let nodeGateImports = 0
    const nodeTool = makeTool({
      executablePath: missing,
      nodeMajor: 18,
      importPlaywright: async () => {
        nodeGateImports++
        return {}
      },
    })
    const nodeOpen = await nodeTool.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.equal(nodeGateImports, 0, "node<20 refuses playwright before importing")
    assert.ok(o(nodeOpen).includes("未找到可用的浏览器"), "node<20 host still serves the cdp-legacy discovery path")
    assert.ok(String(nodeTool.tool.engineInfo().reason).includes("node 18"), "node gate reason surfaced")
    log("tool wiring: pre-spawn allowlist / lazy+memoized selection / degrade reasons / legacy-preference + node<20 never import")
  }

  // ---------- 5b. official-dialog approval path unchanged by the split ----------
  {
    const missing = path.join(root, "definitely-missing-browser.exe")
    const mk = makeTool({ executablePath: missing, importPlaywright: async () => ({}) })
    let asked = null
    const ctxAsk = { directory: root, ask: async (req) => ((asked = req.patterns), "once") }
    const res = await mk.tool.execute({ action: "open", url: "https://not-allowed.test/page" }, ctxAsk)
    assert.ok(asked && String(asked[0]).includes("not-allowed.test"), "out-of-allowlist open routes through ctx.ask")
    assert.ok(o(res).includes("未找到可用的浏览器"), "approved ask proceeds past the gate (then discovery fails w/o a browser)")
    assert.ok(!o(res).includes("phase=permission"), "approved ask is no longer a permission error")
    const ctxDeny = { directory: root, ask: async () => { throw new Error("user said no") } }
    const denied = await mk.tool.execute({ action: "open", url: "https://also-not-allowed.test/x" }, ctxDeny)
    assert.ok(o(denied).includes("用户未批准"), "dialog rejection keeps its honest wording")
    log("approval semantics intact on the new engine split (ask/deny paths byte-familiar)")
  }

  // ---------- 6. playwright engine on MOCK module: launch + verbs (task c) ----------
  {
    const fx = makeFakePw()
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    const open = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(open).includes("浏览器已启动") && o(open).includes("已导航"), "playwright open keeps the §6o launch+nav wording")
    assert.equal(mk.tool.engineInfo().kind, "playwright", "engineInfo = playwright")
    assert.equal(fx.calls.launch.length, 1, "one launch attempt")
    assert.equal(fx.calls.launch[0].executablePath, fakeExe, "the DISCOVERED executable is what launches")
    assert.equal(fx.calls.launch[0].channel, undefined, "no channel on an explicit TM_BROWSER_PATH — channel would relaunch a different install")
    assert.equal(fx.calls.launch[0].headless, true, "TM_BROWSER_HEADLESS=1 honored through playwright opts")
    assert.ok(fx.calls.launch[0].args.includes("--mute-audio"), "hardened launch flags carried")
    const ctxOpts = fx.calls.contextOpts[0]
    assert.equal(ctxOpts.timeout, 3000, "3000 ms action budget is the ENGINE default")
    assert.match(String(ctxOpts.userAgent), /Windows NT/, "real-Chrome UA applied via context options")
    assert.equal(ctxOpts.extraHTTPHeaders["Accept-Language"], "zh-CN,zh;q=0.9,en;q=0.8", "zh Accept-Language via extraHTTPHeaders")
    assert.equal(fx.calls.route[0]?.pattern, "**/*", "context.route(**/*) installed (CDP Fetch 的迁移面)")

    // ---- network allowlist via route() ----
    const handler = fx.calls.route[0].handler
    const decisions = []
    const route = () => ({
      continue: async () => decisions.push("continue"),
      abort: async () => decisions.push("abort"),
    })
    await handler(route(), { url: () => "https://cn.bing.com/search?q=x", method: () => "GET", resourceType: () => "document" })
    await handler(route(), { url: () => "https://evil.test/steal", method: () => "GET", resourceType: () => "document" })
    await handler(route(), { url: () => "data:image/png;base64,AAAA" })
    assert.deepEqual(decisions, ["continue", "abort", "continue"], "route(): allowlisted continue / off-list abort / data: passthrough")

    // ---- SUBRESOURCE policy (the "pages render without images" fix) ----
    // cfgDomains = the exact host only, so an asset host on the SAME SITE is
    // a genuine same-site case rather than an allowlist hit.
    {
      const fxS = makeFakePw()
      const mkS = makeTool({ importPlaywright: async () => fxS.pw, nodeMajor: 22, cfgDomains: ["cn.bing.com"] })
      await mkS.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
      const h = fxS.calls.route[0].handler
      const dec = []
      const r = () => ({ continue: async () => dec.push("continue"), abort: async () => dec.push("abort") })
      const req = (url, resourceType) => ({ url: () => url, method: () => "GET", resourceType: () => resourceType })
      // navigating to cn.bing.com registered the site "bing.com"
      await h(r(), req("https://assets.bing.com/app.js", "script"))
      await h(r(), req("https://assets.bing.com/logo.png", "image"))
      await h(r(), req("https://evil.test/track.js", "script"))
      await h(r(), req("https://evil.test/banner.jpg", "image"))
      await h(r(), req("https://evil.test/steal", "document"))
      // R6 red line on the remote face: an ALLOWLISTED host asking for a .env
      // is still refused, even as a "harmless" image.
      await h(r(), req("https://cn.bing.com/.env", "image"))
      assert.deepEqual(
        dec,
        ["continue", "continue", "abort", "continue", "abort", "abort"],
        "same-site script + passive images pass; off-site script/document blocked; a remote .env stays a hard red line under every policy",
      )
      const snap = await mkS.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
      assert.ok(o(snap).includes("个子资源请求被治理白名单拦截"), "the next observation TELLS the agent the gate trimmed the page")
      assert.ok(o(snap).includes("evil.test"), "the note names the blocked hosts")
      assert.ok(
        mkS.events.some((e) => e.event === "blocked" && String(e.hosts ?? "").includes("evil.test") && Number(e.count) === 2),
        "blocked requests aggregate into ONE trajectory line (count + hosts), never one per request",
      )
      assert.ok(
        !String(mkS.events.find((e) => e.event === "blocked")?.hosts ?? "").includes("cn.bing.com"),
        "a hard red-line refusal is not counted as a policy trim (it is not page content the gate hid)",
      )
      const snap2 = await mkS.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
      assert.ok(!o(snap2).includes("个子资源请求被治理白名单拦截"), "the note drains — it is not repeated forever")
      await h(r(), req("https://evil.test/again.js", "script"))
      const snap3 = await mkS.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
      assert.ok(o(snap3).includes("个子资源请求被治理白名单拦截"), "a SECOND round of blocks still reports (the counter resets in place, it is not swapped out)")
      // policy=off restores the legacy verbatim gate
      const fxO = makeFakePw()
      const mkO = makeTool({ importPlaywright: async () => fxO.pw, nodeMajor: 22, cfgDomains: ["cn.bing.com"], subresource: "off" })
      await mkO.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
      const decO = []
      const rO = () => ({ continue: async () => decO.push("continue"), abort: async () => decO.push("abort") })
      await fxO.calls.route[0].handler(rO(), req("https://assets.bing.com/logo.png", "image"))
      assert.deepEqual(decO, ["abort"], "TM_BROWSER_SUBRESOURCE=off restores the strict every-request allowlist")
      // policy=passive: images pass, same-site scripts do NOT
      const fxP = makeFakePw()
      const mkP = makeTool({ importPlaywright: async () => fxP.pw, nodeMajor: 22, cfgDomains: ["cn.bing.com"], subresource: "passive" })
      await mkP.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
      const decP = []
      const rP = () => ({ continue: async () => decP.push("continue"), abort: async () => decP.push("abort") })
      await fxP.calls.route[0].handler(rP(), req("https://assets.bing.com/app.js", "script"))
      await fxP.calls.route[0].handler(rP(), req("https://assets.bing.com/app.css", "stylesheet"))
      assert.deepEqual(decP, ["abort", "continue"], "passive tier: stylesheet loads, same-site script still gated")
      // a missing resourceType is treated as EXECUTABLE (the strict side)
      const decU = []
      const rU = () => ({ continue: async () => decU.push("continue"), abort: async () => decU.push("abort") })
      await fxS.calls.route[0].handler(rU(), { url: () => "https://assets.bing.com/x" })
      assert.deepEqual(decU, ["continue"], "untyped same-site request still covered by same-site")
      await fxS.calls.route[0].handler(rU(), { url: () => "https://evil.test/x" })
      assert.deepEqual(decU, ["continue", "abort"], "untyped off-site request is NOT treated as passive")
      void mkO; void mkP
    }

    // ---- take_snapshot -> ariaSnapshot + uid addressing ----
    const snap = await mk.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
    assert.ok(o(snap).includes("[uid=e1]") && o(snap).includes("[uid=e11]"), "snapshot carries injected uids")
    assert.ok(o(snap).includes("11 个可寻址节点"), "snapshot reports the indexed node count")
    assert.match(o(snap), /- text: some plain text/, "raw text lines stay addressable-free")

    const byAct = (name) => fx.calls.acted.filter((a) => a[0] === name)

    await mk.tool.execute({ action: "click", uid: "e6" }, ctxNoAsk)
    assert.deepEqual(byAct("click").at(-1), ["click", 'p0:getByRole(button,{"name":"登 录","exact":true})#nth0'], "click uid -> getByRole(name,exact).nth via the registry")
    const stale = await mk.tool.execute({ action: "click", uid: "e99" }, ctxNoAsk)
    assert.ok(o(stale).includes("take_snapshot"), "unknown uid refuses to guess — points back to take_snapshot")
    const guessed = await mk.tool.execute({ action: "click" }, ctxNoAsk)
    assert.ok(o(guessed).includes("禁止猜 locator"), "no uid + no selector = snapshot-first violation rejected")
    const escaped = await mk.tool.execute({ action: "click", selector: "#rare-node" }, ctxNoAsk)
    assert.ok(o(escaped).includes('selector "#rare-node"'), "explicit selector escape hatch works + echoes")
    await mk.tool.execute({ action: "fill", uid: "e4", text: "admin" }, ctxNoAsk)
    assert.deepEqual(byAct("fill").at(-1), ["fill", 'p0:getByRole(textbox,{"name":"用户名","exact":true})#nth0', "admin"], "fill by uid")
    await mk.tool.execute({ action: "hover", uid: "e8" }, ctxNoAsk)
    assert.ok(byAct("hover").length === 1, "hover dispatched")
    await mk.tool.execute({ action: "drag", uid: "e6", targetUid: "e11" }, ctxNoAsk)
    assert.equal(byAct("dragTo").at(-1)[0], "dragTo", "drag = locator.dragTo(target) on both registry locators")
    await mk.tool.execute({ action: "press_key", key: "Enter" }, ctxNoAsk)
    assert.ok(fx.__ctxPage.keys.includes("Enter"), "press_key reaches page.keyboard.press")
    await mk.tool.execute({ action: "wait_for", text: "登 录" }, ctxNoAsk)
    assert.deepEqual(byAct("waitFor").at(-1), ["waitFor", "p0:getByText(登 录)", { state: "visible", timeout: 3000 }], "wait_for default 3000 ms budget")
    await mk.tool.execute({ action: "wait_for", text: "x", timeoutMs: "99999" }, ctxNoAsk)
    assert.equal(byAct("waitFor").at(-1)[2].timeout, 30000, "wait_for timeout clamped to 30 s ceiling")
    const uploaded = path.join(root, "upload-me.txt")
    fs.writeFileSync(uploaded, "data")
    await mk.tool.execute({ action: "upload_file", uid: "e4", filePath: uploaded }, ctxNoAsk)
    assert.deepEqual(byAct("setInputFiles").at(-1), ["setInputFiles", 'p0:getByRole(textbox,{"name":"用户名","exact":true})#nth0', [uploaded]], "upload_file by uid with a local path")
    const missingUp = await mk.tool.execute({ action: "upload_file", uid: "e4", filePath: path.join(root, "nope.bin") }, ctxNoAsk)
    assert.ok(o(missingUp).includes("不存在"), "upload_file validates the local path first")
    // M5: evaluate_script needs the official dialog ONCE per browser session
    const evalsBefore = fx.__ctxPage.evals.length
    const evalNoBridge = await mk.tool.execute({ action: "evaluate_script", function: "document.title" }, ctxNoAsk)
    assert.ok(o(evalNoBridge).includes("phase=permission"), "no ask bridge -> evaluate_script is REFUSED (tm_pty's rule, never a silent pass)")
    assert.equal(fx.__ctxPage.evals.length, evalsBefore, "a refused evaluate never reached the page")
    const evald = await mk.tool.execute({ action: "evaluate_script", function: "document.title" }, ctxApprove)
    assert.ok(o(evald).includes("EVAL"), "approved evaluate_script routes JS + returns the value")
    assert.ok(o(evald).includes("string"), "and the result names its TYPE (null/undefined/empty must not look alike)")
    // The function-source trap: evaluate("() => …") treats the STRING as an
    // expression, gets a function object back, cannot serialize it, and
    // resolves to undefined — which printed "执行结果：null" and sent the model
    // hunting for a page bug that was actually in our call (live: 6 rounds).
    await mk.tool.execute({ action: "evaluate_script", function: "() => document.title" }, ctxApprove)
    assert.equal(fx.__ctxPage.evals.at(-1), "(() => document.title)()", "a function source is INVOKED, not merely evaluated")
    await mk.tool.execute({ action: "evaluate_script", function: "document.title" }, ctxApprove)
    assert.equal(fx.__ctxPage.evals.at(-1), "document.title", "a plain expression is passed through byte-exact")
    await mk.tool.execute({ action: "evaluate_script", function: "(() => 3)()" }, ctxApprove)
    assert.equal(fx.__ctxPage.evals.at(-1), "(() => 3)()", "an expression the model already invoked is NOT double-wrapped")

    // ---- tab management ----
    const listPages = await mk.tool.execute({ action: "list_pages" }, ctxNoAsk)
    assert.ok(o(listPages).includes("(当前)") || o(listPages).includes("（当前）"), "list_pages marks the current tab")
    const sel2 = await mk.tool.execute({ action: "select_page", index: 1 }, ctxNoAsk)
    assert.ok(o(sel2).includes("标签页 1"), "select_page switches")
    await mk.tool.execute({ action: "read" }, ctxNoAsk)
    const readOnP1 = await mk.tool.execute({ action: "evaluate_script", function: "1+1" }, ctxNoAsk)
    assert.ok(o(readOnP1).includes("EVAL"), "post-switch evaluate lands on the new page")
    const oob = await mk.tool.execute({ action: "select_page", index: 42 }, ctxNoAsk)
    assert.ok(o(oob).includes("越界"), "select_page bounds the index")

    // ---- console + network capture through the real listener wiring ----
    // Re-open to observe listeners on a pristine page object:
    const fx2 = makeFakePw()
    const mk2 = makeTool({ importPlaywright: async () => fx2.pw, nodeMajor: 22 })
    await mk2.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    const firstPage = fx2.__ctxPage
    assert.ok(firstPage, "test seam: fake captured the page instance")
    firstPage.fire("console", { type: () => "error", text: () => "boom-xyz" })
    firstPage.fire("pageerror", { message: () => "crash-abc" })
    firstPage.fire("request", { url: () => "https://cn.bing.com/api", method: () => "POST" })
    firstPage.fire("response", { url: () => "https://cn.bing.com/api", status: () => 201, request: () => ({ method: () => "POST" }) })
    const cons = await mk2.tool.execute({ action: "list_console_messages" }, ctxNoAsk)
    assert.ok(o(cons).includes("boom-xyz") && o(cons).includes("crash-abc"), "list_console_messages shows console + pageerror lines")
    const net = await mk2.tool.execute({ action: "list_network_requests" }, ctxNoAsk)
    assert.ok(o(net).includes("POST https://cn.bing.com/api") && o(net).includes("201"), "list_network_requests shows the response line")
    const cleared = await mk2.tool.execute({ action: "list_console_messages", clear: true }, ctxNoAsk)
    const afterClear = await mk2.tool.execute({ action: "list_console_messages" }, ctxNoAsk)
    assert.ok(o(cleared).includes("boom-xyz") && !o(afterClear).includes("boom-xyz"), "clear:true drains the console buffer")

    // ---- dialogs: held + handle_dialog ----
    let accepted = 0
    let dismissed = 0
    firstPage.fire("dialog", {
      type: () => "confirm",
      message: () => "确定删除？",
      accept: async () => accepted++,
      dismiss: async () => dismissed++,
    })
    const snapWithDialog = await mk2.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
    assert.ok(o(snapWithDialog).includes("未处理对话框"), "held dialog surfaces on the NEXT observation (popup 合并观察)")
    const handled = await mk2.tool.execute({ action: "handle_dialog" }, ctxNoAsk)
    assert.ok(o(handled).includes("确定删除") && accepted === 1, "handle_dialog accepts by default and quotes the message")
    firstPage.fire("dialog", { type: () => "alert", message: () => "bye", accept: async () => accepted++, dismiss: async () => dismissed++ })
    await mk2.tool.execute({ action: "handle_dialog", dialogAction: "dismiss" }, ctxNoAsk)
    assert.equal(dismissed, 1, "dialogAction dismiss honored")
    const noneLeft = await mk2.tool.execute({ action: "handle_dialog" }, ctxNoAsk)
    assert.ok(o(noneLeft).includes("没有待处理"), "handle_dialog without a dialog reports honestly")

    // ---- screenshots keep the §6o contract on BOTH engines ----
    const shot = await mk2.tool.execute({ action: "take_screenshot" }, ctxNoAsk)
    const m = /截图已保存（PNG (\d+) bytes）：(.+)$/m.exec(o(shot))
    assert.ok(m && fs.existsSync(m[2].trim()) && Number(m[1]) === 8, "take_screenshot writes the PNG to the run store, §6o output shape")
    const shotImg = await mk2.tool.execute({ action: "take_screenshot", image: true }, ctxNoAsk)
    assert.equal(shotImg.attachments?.[0]?.mime, "image/jpeg", "image:true attaches a JPEG, not the (much larger) PNG")
    assert.ok(String(shotImg.attachments?.[0]?.url ?? "").startsWith("data:image/jpeg;base64,"), "attachment ships as a data URL")
    assert.equal(fx2.__ctxPage._shotOpts?.type, "jpeg", "the attached capture is requested from the engine as jpeg")
    assert.equal(fx2.__ctxPage._shotOpts?.quality, 70, "quality 70 — small enough to inline, good enough to read")
    const legacyNamed = await mk2.tool.execute({ action: "screenshot" }, ctxNoAsk)
    assert.ok(o(legacyNamed).includes("截图已保存"), "compat `screenshot` verb maps to take_screenshot")
    const read = await mk2.tool.execute({ action: "read" }, ctxNoAsk)
    assert.ok(
      /^\[b\d+\] 页面文本（/.test(o(read)),
      `compat \`read\` keeps the page-text header, tagged with the browser id it ran on — got: ${o(read).slice(0, 80)}`,
    )

    // ---- close: a VERIFIED verdict, quoted verbatim by the agent ----
    const closed = await mk2.tool.execute({ action: "close" }, ctxNoAsk)
    assert.ok(o(closed).includes("已确认关闭"), "playwright close reports the verified success verdict")
    assert.ok(o(closed).includes("playwright/"), "the close line names the engine+exe it closed (the agent can point at a window)")
    assert.ok(o(await mk2.tool.execute({ action: "close" }, ctxNoAsk)).includes("没有打开的浏览器会话"), "double close stays honest")
    // a close that could NOT release the pages must warn, never claim
    {
      const fxL = makeFakePw()
      const mkL = makeTool({ importPlaywright: async () => fxL.pw, nodeMajor: 22 })
      await mkL.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
      const ctxLive = fxL.__ctx
      const brLive = fxL.calls.launchBrowser
      ctxLive.close = async () => {
        throw new Error("context busy (fake)")
      }
      brLive.close = async () => {}
      brLive.isConnected = () => true // claims a browser that is still up
      const stuck = await mkL.tool.execute({ action: "close" }, ctxNoAsk)
      assert.ok(o(stuck).includes("警告：关闭未完全成功"), "a half-closed session warns instead of claiming success")
      assert.ok(o(stuck).includes("残留标签页 2 个"), "the warning counts what is still open")
      assert.ok(o(stuck).includes("context busy"), "the underlying engine error is surfaced, not swallowed")
    }
    log("playwright engine (mocked): launch opts / route allowlist / snapshot+uid / all 16 verbs / buffers / dialogs / shots")
  }

  // ---------- 6b. launch target: the DISCOVERED exe wins, channel is fallback ----------
  {
    // The regression this pins: channel:"msedge" makes playwright resolve the
    // STABLE install itself and DISCARD our path, so an Edge-Beta default
    // opened stable Edge.  Channel is now only correct for a stable-shaped
    // install dir, and only as a fallback.
    assert.equal(br.playwrightLaunchTarget("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe").channel, "msedge", "stable Edge dir -> channel msedge available")
    assert.equal(br.playwrightLaunchTarget("C:\\Program Files (x86)\\Microsoft\\EdgeBeta\\Application\\msedge.exe").channel, undefined, "Edge BETA dir -> no channel (channel would silently relaunch stable)")
    assert.equal(br.playwrightLaunchTarget("C:\\Program Files\\Microsoft\\EdgeDev\\Application\\msedge.exe").channel, undefined, "Edge DEV dir -> no channel")
    assert.equal(br.playwrightLaunchTarget("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe").channel, "chrome", "stable Chrome dir -> channel chrome available")
    assert.equal(br.playwrightLaunchTarget("/snap/bin/chromium").channel, undefined, "chromium -> no channel at all")
    assert.equal(
      br.playwrightLaunchTarget("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", { explicitOverride: true }).channel,
      undefined,
      "an explicit TM_BROWSER_PATH is honoured verbatim — never substituted by a channel",
    )
    assert.equal(br.playwrightLaunchTarget("C:\\x\\msedge.exe").executablePath, "C:\\x\\msedge.exe", "executablePath always carries the discovered path")
    assert.equal(br.playwrightLaunchTarget("C:/x/msedge.exe").executablePath, "C:/x/msedge.exe", "forward-slash paths pass through unchanged")

    // executablePath refuses -> the channel leg is what saves the session
    const stable = path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")
    fs.mkdirSync(path.dirname(stable), { recursive: true })
    fs.writeFileSync(stable, "MZ")
    const fx = makeFakePw({ execPathThrows: true })
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22, executablePath: stable, discovered: true })
    const open = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(open).includes("已导航"), "a refused executablePath still opens via the channel fallback")
    assert.equal(fx.calls.launch[0].executablePath, stable, "attempt 1 = the discovered path")
    assert.equal(fx.calls.launch[0].channel, undefined, "attempt 1 sends no channel")
    assert.equal(fx.calls.launch[1]?.channel, "msedge", "attempt 2 = channel (stable-shaped install only)")
    assert.ok(o(open).includes("channel(msedge)"), "the open line reports which launch path actually won")

    // the Beta case end-to-end: a beta-shaped discovered path NEVER sends a
    // channel, so a refusal is a real error instead of a silent downgrade to
    // stable Edge.
    const beta = path.join(root, "Microsoft", "EdgeBeta", "Application", "msedge.exe")
    fs.mkdirSync(path.dirname(beta), { recursive: true })
    fs.writeFileSync(beta, "MZ")
    const fxB = makeFakePw({ execPathThrows: true })
    const mkB = makeTool({ importPlaywright: async () => fxB.pw, nodeMajor: 22, executablePath: beta, discovered: true })
    const failB = await mkB.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(failB).includes("phase=execute"), "a Beta install that refuses to launch fails honestly")
    assert.equal(fxB.calls.launch.length, 1, "no channel fallback exists for a non-stable install (would open the WRONG browser)")
    const okB = await mkB.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(okB).includes("已导航") && fxB.calls.launch[1].executablePath === beta, "retry launches the discovered Beta path itself")
    log("launch target: discovered executablePath primary, channel only for a stable-shaped install, never over an explicit override")
  }

  // ---------- 6b2. site math + resource-type normalisation (pure) ----------
  {
    assert.equal(br.siteOf("assets.bing.com"), "bing.com", "subdomain collapses to the registrable site")
    assert.equal(br.siteOf("www.something.com.cn"), "something.com.cn", "a two-level CN suffix keeps three labels")
    assert.equal(br.siteOf("moe.example.co.uk"), "example.co.uk", "co.uk handled without a PSL dependency")
    assert.equal(br.siteOf("a.b.c.d.example.org"), "example.org", "deep subdomains collapse to the site")
    assert.equal(br.siteOf("10.0.0.8"), "10.0.0.8", "a bare IP stays itself (no site inference on literals)")
    assert.equal(br.siteOf("HTTP.EXAMPLE.COM."), "example.com", "case + trailing dot normalised")
    assert.equal(br.normalizeResourceType("Stylesheet"), "stylesheet", "CDP spelling maps onto playwright's")
    assert.equal(br.normalizeResourceType(undefined), "other", "an untyped request defaults to the EXECUTABLE side")
    assert.ok(br.isPassiveResource("Image") && br.isPassiveResource("font"), "image/font/… are passive")
    assert.ok(!br.isPassiveResource("script") && !br.isPassiveResource("document"), "script/document are never passive")
    const pass = (o2) => br.subresourcePass({ allowlistHit: false, approvedHost: false, allowedSites: new Set(["bing.com"]), policy: "same-site", ...o2 })
    assert.equal(pass({ url: "https://x.bing.com/a.js", resourceType: "script" }).pass, true, "same-site script passes")
    assert.equal(pass({ url: "https://cdn.other.com/a.js", resourceType: "script" }).pass, false, "off-site script blocked")
    assert.equal(pass({ url: "https://cdn.other.com/a.png", resourceType: "image" }).pass, true, "off-site image passes (passive)")
    assert.equal(pass({ url: "https://cn.bing.com/x", resourceType: "document" }).via, "same-site:document", "navigation to an already-visited site is same-site")
    assert.equal(br.subresourcePass({ url: "https://cdn.other.com/a.js", resourceType: "script", policy: "off", allowlistHit: false, approvedHost: false, allowedSites: new Set(["other.com"]) }).pass, false, "policy=off ignores same-site entirely")
    assert.equal(br.subresourcePass({ url: "https://x.bing.com/a.js", resourceType: "script", policy: "passive", allowlistHit: false, approvedHost: false, allowedSites: new Set(["bing.com"]) }).pass, false, "policy=passive blocks even same-site scripts")
    assert.equal(br.subresourcePass({ url: "https://x.bing.com/a.js", resourceType: "script", policy: "same-site", allowlistHit: true, approvedHost: false, allowedSites: new Set() }).via, "allowlist", "an allowlist hit short-circuits before the policy")
    assert.equal(br.subresourcePass({ url: "https://x.bing.com/a.js", resourceType: "script", policy: "same-site", allowlistHit: false, approvedHost: true, allowedSites: new Set() }).via, "approved", "a dialog-approved host passes the network layer")
  }

  // ---------- 6c. ariaSnapshot absence -> honest directive ----------
  {
    const fx = makeFakePw({ ariaThrows: true })
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    const snap = await mk.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
    assert.ok(o(snap).includes("ariaSnapshot 不可用") && o(snap).includes("playwright-core"), "old playwright tells the agent to upgrade, no silent text fallback")
    log("missing ariaSnapshot support surfaces as an upgrade directive")
  }

  // ---------- 6d. snapshot token cap (browserSnapshotMaxTokens) ----------
  {
    const fx = makeFakePw()
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22, snapshotMaxTokens: 15 })
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    const snap = await mk.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
    assert.ok(o(snap).includes("browserSnapshotMaxTokens=15"), "snapshot payload capped by the P0 knob")
    log("snapshot cap wired to cfg.browserSnapshotMaxTokens")
  }

  // ---------- 6e. persistent login: ONLY an explicit userDataDir ----------
  {
    const fx = makeFakePw()
    const persistDir = path.join(root, "my-profile")
    fs.mkdirSync(persistDir, { recursive: true })
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22, env: { TM_BROWSER_USER_DATA_DIR: persistDir } })
    const open = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(open).includes("持久登录配置"), "open announces the persistent profile mode")
    assert.equal(fx.calls.persistent[0]?.dir, persistDir, "launchPersistentContext uses the USER-chosen dir")
    const closed = await mk.tool.execute({ action: "close" }, ctxNoAsk)
    assert.ok(o(closed).includes("已保留") && fs.existsSync(persistDir), "close KEEPS the persistent dir (login survives); never rm -rf's it")
    log("persistent login = TM_BROWSER_USER_DATA_DIR only, preserved across close")
  }

  // ---------- 6f. legacy engine action guidance (degrade honesty) ----------
  {
    // No live legacy session is constructed here (that is §6o's live job);
    // the ROUTER guarantee is what this package owns: an out-of-allowlist
    // navigate never reaches any engine, and the degraded instance answers
    // through the legacy discovery path.
    const mk2 = makeTool({
      executablePath: path.join(root, "still-missing.exe"),
      importPlaywright: async () => {
        throw new Error("missing")
      },
      nodeMajor: 22,
    })
    const r = await mk2.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(r).includes("未找到可用的浏览器") && mk2.tool.engineInfo().kind === "cdp-legacy", "degraded instance answers through the legacy discovery path")
    log("router-level guarantees pinned (engine-level legacy matrix lives in test-tm-tools §6o)")
  }

  // ---------- 6g. M1: upload_file SOURCE containment (P2) + R6 env refusal ----------
  {
    const fx = makeFakePw()
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    await mk.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
    const byAct = (name) => fx.calls.acted.filter((a) => a[0] === name)

    // file OUTSIDE the workspace root -> P2 refusal before any bytes move
    const outside = path.join(os.tmpdir(), "tm-browser-outside-upload.txt")
    fs.writeFileSync(outside, "secret")
    const outRes = await mk.tool.execute({ action: "upload_file", uid: "e4", filePath: outside }, ctxNoAsk)
    assert.ok(o(outRes).includes("phase=permission") && o(outRes).includes("越界"), "out-of-scope upload_file -> P2 permission refusal")
    assert.equal(byAct("setInputFiles").length, 0, "refused upload never reaches setInputFiles")

    // env files INSIDE the root — the case P2 alone cannot catch (R6 line)
    const envIn = path.join(root, "prod.env")
    fs.writeFileSync(envIn, "SECRET=1")
    const envRes = await mk.tool.execute({ action: "upload_file", uid: "e4", filePath: envIn }, ctxNoAsk)
    assert.ok(o(envRes).includes("phase=permission") && o(envRes).includes("R6"), "in-root .env still refused by the R6 env-file classifier")
    const rcIn = path.join(root, ".bashrc")
    fs.writeFileSync(rcIn, "export X=1")
    const rcRes = await mk.tool.execute({ action: "upload_file", uid: "e4", filePath: rcIn }, ctxNoAsk)
    assert.ok(o(rcRes).includes("phase=permission") && o(rcRes).includes("R6"), "shell-rc family refused too")
    assert.ok(!o(envRes).includes("prod.env") && !o(rcRes).includes(".bashrc"), "R6 refusal echoes NO path (privacy line)")

    // files[] alias: one good + one out-of-scope -> the whole batch is refused
    const good = path.join(root, "upload-ok.txt")
    fs.writeFileSync(good, "d")
    const mixed = await mk.tool.execute({ action: "upload_file", uid: "e4", files: [good, outside] }, ctxNoAsk)
    assert.ok(o(mixed).includes("phase=permission"), "array alias is guarded path-by-path")
    assert.equal(byAct("setInputFiles").length, 0, "mixed batch uploads nothing")

    // checked-in template stays allowed (same exception as the read face)
    const tpl = path.join(root, "prod.env.example")
    fs.writeFileSync(tpl, "SECRET=")
    const tplRes = await mk.tool.execute({ action: "upload_file", uid: "e4", filePath: tpl }, ctxNoAsk)
    assert.ok(o(tplRes).includes("已上传 1 个文件"), "*.env.example template copy stays uploadable (R6 exception carried)")
    // legitimate in-root single + array uploads keep working
    await mk.tool.execute({ action: "upload_file", uid: "e4", filePath: good }, ctxNoAsk)
    await mk.tool.execute({ action: "upload_file", uid: "e4", files: [good, tpl] }, ctxNoAsk)
    assert.deepEqual(byAct("setInputFiles").at(-1)[2], [good, tpl], "in-scope array upload still lands")
    assert.equal(byAct("setInputFiles").length, 3, "three accepted uploads, the refused ones never fired")
    // missing file stays an honest error (P2 fail-closed wording carries 不存在)
    const missingUp = await mk.tool.execute({ action: "upload_file", uid: "e4", filePath: path.join(root, "nope.bin") }, ctxNoAsk)
    assert.ok(o(missingUp).includes("不存在"), "non-existent path still refused (P2 fail-closed)")
    assert.ok(mk.events.some((e) => e.event === "upload_refused"), "refusals are trajectory-audited")
    fs.rmSync(outside, { force: true })
    log("M1: upload_file source-gated to workspace/store scope, R6 env files refused inside the root, templates + in-scope uploads intact")
  }

  // ---------- 6h. M2: route() registration failure -> fail-closed session ----------
  {
    const fx = makeFakePw({ routeThrows: true })
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    const open = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(open).includes("phase=execute"), "route() registration failure surfaces as an execute error (never swallowed)")
    assert.ok(o(open).includes("fail-closed"), "error wording states the fail-closed verdict")
    assert.equal(fx.calls.route.length, 1, "the gate install was attempted once")
    assert.equal(fx.__ctx?._closed, true, "context CLOSED on gate failure — no ungated window stays up")
    assert.equal(fx.calls.launchBrowser?._closed, true, "launched browser closed too")
    const closeAfter = await mk.tool.execute({ action: "close" }, ctxNoAsk)
    assert.ok(o(closeAfter).includes("没有打开的浏览器会话"), "failed open leaves NO session behind")
    assert.ok(mk.events.some((e) => e.event === "gate_register_failed"), "gate failure trajectory-audited")
    // persistent-context leg: browser handle is null — context.close alone seals it
    const pdir = path.join(root, "gate-fail-profile")
    fs.mkdirSync(pdir, { recursive: true })
    const fx2 = makeFakePw({ routeThrows: true })
    const mk2 = makeTool({ importPlaywright: async () => fx2.pw, nodeMajor: 22, env: { TM_BROWSER_USER_DATA_DIR: pdir } })
    const open2 = await mk2.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(open2).includes("phase=execute") && fx2.__ctx?._closed === true, "persistent leg also closes fail-closed (no bare browsing)")
    log("M2: route() failure = closed context/browser + execute error (parity with the CDP Fetch.enable fail-closed)")
  }

  // ---------- 6i. m2: allowlist carries the T4 seeds (webfetch/search parity) ----------
  {
    const { DEFAULT_WEBFETCH_DOMAINS } = await import("./dist/tm/config.js")
    const missing = path.join(root, "still-missing-seeds.exe")
    // built-in default cfg -> T4 home hosts ride along; hitting them from a
    // search hit no longer re-pops the dialog
    const mk = makeTool({ executablePath: missing, importPlaywright: async () => ({}), cfgDomains: [...DEFAULT_WEBFETCH_DOMAINS] })
    const jumped = await mk.tool.execute({ action: "open", url: "https://api.stackexchange.com/1.1/questions" }, ctxNoAsk)
    assert.ok(!o(jumped).includes("phase=permission") && o(jumped).includes("未找到可用的浏览器"), "api.stackexchange.com passes the gate WITHOUT a dialog on the default list")
    const hn = await mk.tool.execute({ action: "open", url: "https://hn.algolia.com/api/v1/search" }, ctxNoAsk)
    assert.ok(!o(hn).includes("phase=permission"), "hn.algolia.com seeded too")
    const stranger = await mk.tool.execute({ action: "open", url: "https://example.org/x" }, ctxNoAsk)
    assert.ok(o(stranger).includes("phase=permission"), "non-listed host still gated (seeds never over-widen)")
    // narrowed cfg is NEVER widened — the exact webfetch/search policy
    const narrowed = makeTool({ executablePath: missing, importPlaywright: async () => ({}) })
    const denied = await narrowed.tool.execute({ action: "open", url: "https://api.stackexchange.com/1.1/questions" }, ctxNoAsk)
    assert.ok(o(denied).includes("phase=permission"), "narrowed allowlist keeps the T4 seeds out (never widened)")
    log("m2: browser allowlist = seedWebfetchDomains(cfg) — T4 seeds on the default list only, narrowed lists untouched")
  }

  // ---------- 7. tester prompt: snapshot-first discipline (task 6) ----------
  {
    const t = sp.TESTER_PROMPT
    assert.ok(t.includes("## UI verification (tm_browser"), "section heading intact (test-blackboard pin)")
    assert.ok(!t.includes("UI verification mode"), "removed mode wording stays removed")
    assert.ok(t.includes("UI NOT VERIFIED:"), "honest-gap fallback kept")
    assert.ok(t.includes("headless"), "headless wording still present (prohibition + degraded-engine note)")
    assert.ok(t.includes("take_snapshot"), "snapshot-first is the headline")
    assert.ok(t.includes("[uid="), "agents are taught the uid addressing token")
    assert.ok(/guessed[\s\n]+selectors or guessed text are BANNED/.test(t), "no-guess-locator rule stated")
    assert.ok(t.includes("One action, one observation"), "single-action-single-observation round")
    assert.ok(t.includes("SAME observation round"), "popup/dialog/tab merges into one round")
    assert.ok(t.includes("3000 ms budget"), "the 3000 ms wait discipline is stated")
    assert.ok(t.includes("never networkidle"), "networkidle ban stated")
    assert.ok(t.includes("take_screenshot ONLY"), "screenshots demoted to visual last resort")
    log("tester UI section rewritten to snapshot-first discipline with all pins holding")
  }

  // ---------- 8. real playwright-core smoke — 需 npm install 后另测 ----------
  {
    const req = createRequire(import.meta.url)
    let installed = null
    try {
      installed = req.resolve("playwright-core")
    } catch {
      /* not installed — the P0 state */
    }
    if (!installed) {
      console.log("  SKIP: real playwright-core smoke — playwright-core 未安装（P0 只声明依赖）；真·playwright 冒烟 **需 npm install 后另测**，本包不依赖真装")
    } else if (!br.findBrowserExecutable()) {
      console.log("  SKIP: real playwright-core smoke — no browser executable on this host")
    } else {
      // REAL discovery (registry default browser on Windows) — no
      // TM_BROWSER_PATH, no seam: this is the path issue #5 (Edge Beta)
      // actually took, and it must not be propped up by a channel fallback.
      const store1 = path.join(root, "real-ledger-1")
      const mk = makeTool({ realDiscovery: true, blackboardRoot: store1 })
      const ledgerOf = (dir) => br.browserLedgerFile(dir)
      /** The pid THIS tool instance launched, read off the ledger — an
       *  independent witness, so a close verdict cannot be graded against the
       *  same number it printed. */
      const launchedPid = (dir) => {
        try {
          const lines = fs.readFileSync(ledgerOf(dir), "utf8").split("\n").filter((l) => l.trim())
          return Number(JSON.parse(lines[lines.length - 1]).pid) || 0
        } catch {
          return 0
        }
      }
      // Walking the OS process table is a win32 capability; elsewhere the
      // caller only asserts the root pid and says so out loud.
      const winRows = () => {
        if (process.platform !== "win32") return null
        const r = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress)",
          ],
          { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        )
        if (r.status !== 0 || !String(r.stdout || "").trim()) return null
        let rows = JSON.parse(r.stdout)
        if (!Array.isArray(rows)) rows = [rows]
        return rows
      }
      const descendants = (rows, rootPid) => {
        if (!rows) return []
        const byParent = new Map()
        for (const row of rows) {
          const ppid = Number(row.ParentProcessId)
          if (!byParent.has(ppid)) byParent.set(ppid, [])
          byParent.get(ppid).push(Number(row.ProcessId))
        }
        const out = []
        const queue = [rootPid]
        while (queue.length) {
          for (const kid of byParent.get(queue.shift()) ?? []) {
            out.push(kid)
            queue.push(kid)
          }
        }
        return out
      }
      /** Children outlive the root by a few hundred ms while they tear down, so
       *  "the tree is gone" is polled, not sampled once.  The budget only buys
       *  time — a survivor at the end still fails the assertion. */
      const survivorsAfter = async (pids, budgetMs = 4000) => {
        const deadline = Date.now() + budgetMs
        for (;;) {
          const left = pids.filter((p) => br.pidAlive(p))
          if (!left.length || Date.now() >= deadline) return left
          await new Promise((r) => setTimeout(r, 150))
        }
      }
      try {
        const open = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
        assert.ok(o(open).includes("浏览器已启动"), `real playwright open — got: ${o(open).slice(0, 160)}`)
        console.log(`  (real smoke launched: ${/· (playwright\/[^）]*)/.exec(o(open))?.[1] ?? "n/a"})`)
        const browserPid = launchedPid(store1)
        assert.ok(browserPid > 0, "the orphan ledger recorded the pid this session launched")
        if (mk.tool.engineInfo().kind === "playwright") {
          const snap = await mk.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
          assert.ok(/\[uid=e\d+\]/.test(o(snap)), "real ariaSnapshot + uid registry round-trip")

          // (1) multi-tab against a REAL context.  The extra tabs are blank, so
          //     this leg costs no network and cannot flake on a remote page.
          const np = o(await mk.tool.execute({ action: "new_page" }, ctxNoAsk))
          assert.ok(/已新建空白标签页 1（共 2 个/.test(np), `real new_page — got: ${np.slice(0, 200)}`)
          const lp = o(await mk.tool.execute({ action: "list_pages" }, ctxNoAsk))
          assert.ok(lp.includes("标签页（2）") && (lp.match(/（当前）/g) ?? []).length === 1, `real list_pages — got: ${lp.slice(0, 240)}`)
          const cp = o(await mk.tool.execute({ action: "close_page" }, ctxNoAsk))
          assert.ok(/已关闭，剩 1 个，当前在 0/.test(cp), `real close_page — got: ${cp.slice(0, 200)}`)
          const last = o(await mk.tool.execute({ action: "close_page" }, ctxNoAsk))
          assert.ok(/这是最后一个——浏览器仍在运行/.test(last), `closing the last tab must not fake a session end — got: ${last.slice(0, 200)}`)
          const re = o(await mk.tool.execute({ action: "new_page" }, ctxNoAsk))
          assert.ok(/共 1 个/.test(re), `a context whose last tab closed must still take a new one — got: ${re.slice(0, 200)}`)

          // (2) the sentence the user caught us getting wrong: 已确认关闭 has to
          //     mean the OS process is gone, and not just its root pid.
          const rowsAtClose = winRows()
          const kids = descendants(rowsAtClose, browserPid)
          const cl = o(await mk.tool.execute({ action: "close" }, ctxNoAsk))
          assert.ok(cl.includes("浏览器会话已确认关闭"), `close must EARN 已确认关闭 — got: ${cl.slice(0, 240)}`)
          assert.ok(cl.includes("浏览器会话已确认关闭"), `close must EARN 已确认关闭 — got: ${cl.slice(0, 240)}`)
          // playwright's own close() takes the process down before the note is
          // written, so "早已不在" is the NORMAL honest branch; both wordings
          // mean the same verified thing, and neither is allowed to be a guess.
          assert.ok(
            new RegExp(`进程 ${browserPid} (已退出|早已不在)`).test(cl),
            `the verdict must name the pid that died — got: ${cl.slice(0, 240)}`,
          )
          assert.ok(!br.pidAlive(browserPid), `pid ${browserPid} survived 已确认关闭`)
          if (rowsAtClose) {
            const survivors = await survivorsAfter(kids)
            assert.equal(survivors.length, 0, `已确认关闭 but ${survivors.length} descendant(s) of ${browserPid} survived: ${survivors.join(",")}`)
            console.log(`  (real close took pid ${browserPid} and its ${kids.length} descendant process(es))`)
          } else {
            console.log(`  (real close took pid ${browserPid}; descendant tree not enumerable on ${process.platform})`)
          }
        } else {
          console.log(`  (real playwright present but degraded: ${mk.tool.engineInfo().reason})`)
        }
      } finally {
        try {
          await mk.tool.execute({ action: "close" }, ctxNoAsk)
        } catch {
          /* the legs above already graded close */
        }
        try {
          await mk.tool.dispose()
        } catch {
          /* teardown best-effort */
        }
      }

      // (3) the orphan reaper exactly as the boot path calls it — NO injected
      //     `alive`, NO injected `kill`.  §23 pins the decision; only a real
      //     Chromium proves that the default `process.kill` is enough.
      {
        const store2 = path.join(root, "real-ledger-2")
        const mk2 = makeTool({ realDiscovery: true, blackboardRoot: store2 })
        let victim = 0
        try {
          const second = o(await mk2.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk))
          assert.ok(second.includes("浏览器已启动"), `second real launch — got: ${second.slice(0, 160)}`)
          victim = launchedPid(store2)
          assert.ok(victim > 0, "the second session recorded its own pid")
          const kids = descendants(winRows(), victim)
          // Now pretend THIS process died while that browser kept living: the
          // owner is pointed at a pid the OS has already released.  Rewriting
          // the file (not appending) is what a stale line looks like on disk —
          // the reaper dedupes by pid, so an appended second line would be
          // dropped rather than reaped.
          const deadOwner = spawnSync(process.execPath, ["-e", "0"]).pid
          assert.ok(deadOwner > 0 && !br.pidAlive(deadOwner), `no released pid to play the dead owner (got ${deadOwner})`)
          fs.writeFileSync(
            ledgerOf(store2),
            JSON.stringify({
              pid: victim,
              ownerPid: deadOwner,
              engine: "playwright",
              at: Date.now(),
              // recorded WITH the exe on purpose: the reaper force-kills a whole
              // tree, so it first proves this pid is still that executable —
              // against a real msedge, not a stub.
              exe: br.findBrowserExecutable() ?? "",
            }) + "\n",
            "utf8",
          )
          const r = br.reapOrphanBrowsers(ledgerOf(store2))
          assert.ok(r.reaped.includes(victim), `the reaper did not claim pid ${victim} — got ${JSON.stringify(r)}`)
          assert.ok(await br.waitForPidExit(victim, 5000), `the default kill path left pid ${victim} alive`)
          const survivors = await survivorsAfter(kids)
          assert.equal(survivors.length, 0, `reaped the browser but ${survivors.length} descendant(s) survived: ${survivors.join(",")}`)
          assert.ok(!fs.existsSync(ledgerOf(store2)), "an emptied ledger removes itself")
          console.log(`  (real reaper killed orphan pid ${victim} + ${kids.length} descendant(s), default kill path)`)
        } finally {
          try {
            await mk2.tool.execute({ action: "close" }, ctxNoAsk)
          } catch {
            /* the victim is already reaped — its verdict is not graded */
          }
          try {
            await mk2.tool.dispose()
          } catch {
            /* teardown best-effort */
          }
        }
      }
      console.log("  real playwright-core smoke: OK")
    }
  }

  // ---------- 9. args-schema — full 16-verb param surface (round 2.5) ----------
  {
    const { buildBrowserArgsSchema } = await import("./dist/tm/args-schema.js")
    const shape = await buildBrowserArgsSchema()
    const text = (v) => String(v?.description ?? v?.descriptor ?? "")
    // The raw shape is a CLOSED param surface in effect: no z.object wrapper
    // means no zod-level strip, but the host serializes exactly these keys
    // into the model's parameter spec — an undeclared field never reaches
    // execute().  Every field browser.ts reads must be declared here.
    const CONSUMED = [
      "action", "url", "image", "uid", "selector", "targetUid", "targetSelector",
      "text", "key", "function", "expression", "filePath", "files", "index",
      "timeoutMs", "dialogAction", "promptText", "clear", "fullPage",
    ]
    for (const k of CONSUMED) assert.ok(k in shape, `browser args shape declares ${k}`)
    // 2026-09-18: `headless` is DELIBERATELY absent — as a model arg it was
    // the string-trap (`Boolean("false")` === true) that pinned a desktop
    // session to headless and got every later page anti-bot blocked.
    assert.ok(!("headless" in shape), "browser args shape does NOT expose headless (operator env only)")
    // drift guard: every STATIC `args.x` read in the built module is covered
    const src = fs.readFileSync(new URL("./dist/tm/browser.js", import.meta.url), "utf8")
    assert.ok(!/\bargs\.headless\b/.test(src), "browser.ts never reads args.headless either")
    const seen = new Set([...src.matchAll(/\bargs\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    for (const k of seen) assert.ok(k in shape, `execute() reads args.${k} but the shape does not declare it`)
    // selector/targetUid/targetSelector are dynamic-bracket reads (targetOf) —
    // keep them in the explicit list above if a refactor changes that.
    const actionText = text(shape.action)
    for (const v of ["take_snapshot", "handle_dialog", "upload_file", "evaluate_script", "list_console_messages", "open", "close"])
      assert.ok(actionText.includes(v), `action description names ${v}`)
    log(`args-schema declares the full param surface (${CONSUMED.length} fields; ${seen.size} static reads covered)`)
  }

  // ---------- 18. M5: evaluate_script consent + result redaction ----------
  {
    // pure helpers first — the shapes are the security surface
    const clean = br.redactEvalResult('执行结果：{"title":"定价页","h1":"Pro 计划"}')
    assert.deepEqual(clean.masked, [], "a legitimate JSON read is NOT blanked (name-anchored, not entropy-anchored)")
    assert.equal(clean.text.includes("定价页"), true, "the payload survives untouched when nothing matches")
    const leaky = br.redactEvalResult(
      '执行结果：{"jwt":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvYW4iLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c","auth":"Authorization: Bearer abcdefghijklmnop1234","cookie":"document.cookie=sessionId=deadbeefcafe","key":"ghp_abcdefghijklmnopqrstuvwxyz1234"}',
    )
    assert.ok(!leaky.text.includes("SflKxwRJSMeKKF2QT4"), "the JWT value is gone")
    assert.ok(!leaky.text.includes("eyJzdWIiOiIxMjM0NTY3ODkw"), "…including its payload segment")
    assert.ok(!leaky.text.includes("deadbeefcafe"), "the cookie value is gone")
    assert.ok(!leaky.text.includes("ghp_abcdefghijklmnopqrstuvwxyz"), "the GitHub token is gone")
    assert.ok(leaky.masked.length >= 3, `which kinds were masked is reported, not hidden (${leaky.masked.join(",")})`)
    assert.ok(leaky.text.includes("〔已脱敏:JWT〕"), "a masked slot says WHAT was masked so the agent does not read it as absent data")
    assert.equal(br.needsEvalConsent("on", undefined), true, "first evaluate in a session asks")
    assert.equal(br.needsEvalConsent("on", true), false, "once approved, the rest of the session is not nagged")
    assert.equal(br.needsEvalConsent("off", undefined), false, "TM_BROWSER_ASK_EVAL=off restores the old behaviour")
    assert.equal(br.hostOnly("https://site.test/private/path?token=abcdef"), "site.test", "the consent line + trajectory carry the HOST, never the query string")
    assert.equal(br.hostOnly("not a url at all……"), "not a url at all……", "an unparseable url degrades to a short prefix, never a throw")
    // …and the two helpers that decide what the model's JS even MEANS.  A
    // function source handed to evaluate() as a string is evaluated to a
    // function object, which cannot be serialized, so the call resolves to
    // undefined — "执行结果：null" for six wasted rounds in a live session.
    assert.equal(br.evalExpression("() => 1"), "(() => 1)()", "an arrow function is invoked")
    assert.equal(br.evalExpression("async () => { const r = await fetch('/x'); return r.status }"), "(async () => { const r = await fetch('/x'); return r.status })()", "an async arrow is invoked (and awaitPromise carries its result out)")
    assert.equal(br.evalExpression("function () { return 2 }"), "(function () { return 2 })()", "the function keyword is invoked")
    assert.equal(br.evalExpression("a => a.href"), "(a => a.href)()", "a bare-parameter arrow is invoked")
    assert.equal(br.evalExpression("[1,2].map(x => x*2)"), "[1,2].map(x => x*2)", "an EXPRESSION that merely contains an arrow is left alone")
    assert.equal(br.evalExpression("(() => 3)()"), "(() => 3)()", "an already-invoked source is never double-wrapped")
    assert.equal(br.evalExpression("document.title"), "document.title", "a plain expression passes through byte-exact")
    assert.ok(br.renderEvalResult(undefined).includes("没有 return"), "undefined says why, instead of posing as a null")
    assert.ok(br.renderEvalResult(null).includes("成功执行"), "a real null is labelled a successful answer")
    assert.ok(br.renderEvalResult([]).includes("array(0)"), "an empty list reads differently from null, '' and undefined")
    assert.ok(br.renderEvalResult("").includes('""'), "an empty string shows its quotes")
    assert.ok(br.renderEvalResult(["/a", "/b"]).includes("array(2)"), "a hit list reports its length so 'no matches' cannot be inferred from it")

    // one dialog per session, and the pattern is the host (verified end to end)
    const asked = []
    const fx = makeFakePw()
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com/search?q=token%3Dtopsecret" }, ctxNoAsk)
    const ctxAskOnce = { directory: root, ask: async (req) => (asked.push(req.patterns.slice()), "once") }
    fx.__ctxPage.evaluate = async () => ({ ok: true, note: "plain text stays" })
    const first = await mk.tool.execute({ action: "evaluate_script", function: "x" }, ctxAskOnce)
    assert.ok(o(first).includes("plain text stays"), "approved + unremarkable result passes through verbatim")
    assert.deepEqual(asked, [["evaluate_script:cn.bing.com"]], "the dialog pattern is the HOST only (no query, no path)")
    await mk.tool.execute({ action: "evaluate_script", function: "y" }, ctxAskOnce)
    assert.equal(asked.length, 1, "the SECOND evaluate in the same browser session opens no second dialog")
    const consented = mk.events.filter((e) => e.event === "eval_consent")
    assert.equal(consented.length, 1, "one consent event per approval, and the trajectory never records a secret")
    assert.equal(consented[0].host, "cn.bing.com", "the trajectory line holds the host, not the URL")

    // rejection is a refusal, not a fall-through
    const fxR = makeFakePw()
    const mkR = makeTool({ importPlaywright: async () => fxR.pw, nodeMajor: 22 })
    await mkR.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    const denied = await mkR.tool.execute({ action: "evaluate_script", function: "document.cookie" }, { directory: root, ask: async () => { throw new Error("no") } })
    assert.ok(o(denied).includes("未获批准"), "a rejected consent refuses — the plugin never runs the JS anyway")
    assert.equal(fxR.__ctxPage.evals.length, 0, "the refused expression never reached the page")

    // redaction observed through the tool, and TM_BROWSER_ASK_EVAL=off skips the dialog
    const fxD = makeFakePw()
    const mkD = makeTool({ importPlaywright: async () => fxD.pw, nodeMajor: 22, askEval: "off" })
    await mkD.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    fxD.__ctxPage.evaluate = async () => ({ token: "sk-abcdefghijklmnop1234" })
    const offRes = await mkD.tool.execute({ action: "evaluate_script", function: "localStorage" }, ctxNoAsk)
    assert.ok(!o(offRes).includes("sk-abcdefghijklmnop"), "redaction is NOT switchable — with consent off the secret is still masked")
    assert.ok(o(offRes).includes("已脱敏"), "and the reply says so")
    assert.ok(o(offRes).includes("注意"), "the agent is told a mask happened instead of guessing the page is empty")
    assert.equal(mkD.events.filter((e) => e.event === "eval_redacted").length, 1, "the mask is counted in the trajectory (kinds only, never values)")
    assert.ok(mkD.events.filter((e) => e.event === "eval_redacted")[0].kinds.includes("api-key"), "which shape matched is recorded")
    log("M5: evaluate_script consent (once per session, host-only pattern, refuse on no-bridge/reject) + non-switchable result redaction")
  }

  // ---------- 19. a dead browser is DROPPED, not retried forever ----------
  // Live session: `open` failed three times with the same
  // "Target page, context or browser has been closed", while `close` and
  // `evaluate_script` each insisted there was no session at all. The cached
  // instance was never cleared, so the agent had no way out but to repeat.
  {
    const DEAD = "page.goto: Target page, context or browser has been closed"
    const fx = makeFakePw()
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    // now make the LIVE page die: every action against it throws the same line
    fx.__ctxPage.goto = () => Promise.reject(new Error(DEAD))
    const dead = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(dead).includes("浏览器实例已失效"), "a dead instance is named as dead")
    assert.ok(o(dead).includes('下一次 action:"open"'), "…and says the next open really rebuilds")
    assert.ok(o(dead).includes("不要第三次重复同一个动作"), "…including the anti-loop instruction")
    assert.ok(mk.events.some((e) => e.event === "session_dead"), "the death is on the trajectory")
    const again = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.equal(fx.calls.launch.length, 2, "the second open LAUNCHED again — the corpse was cleared, not reused")
    assert.ok(!o(again).includes("已失效"), "and against the fresh instance it simply works (no phantom failure)")
    // an ordinary failure must NOT be dressed up as a dead session
    const fxN = makeFakePw()
    const mkN = makeTool({ importPlaywright: async () => fxN.pw, nodeMajor: 22 })
    await mkN.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    fxN.__ctxPage.goto = () => Promise.reject(new Error("page.goto: Timeout 20000ms exceeded"))
    const nav = await mkN.tool.execute({ action: "navigate_page", url: "https://cn.bing.com/x" }, ctxNoAsk)
    assert.ok(o(nav).includes("Timeout 20000ms"), "a navigation timeout keeps its own message")
    assert.ok(!o(nav).includes("已失效"), "…and is not mislabelled as a dead instance")
    assert.equal(fxN.calls.launch.length, 1, "…and the live session is kept")
    log("dead browser: session cleared + rebuild stated, ordinary failures untouched")
  }

  // ---------- 20. no host, no dialog ----------
  // `evaluate_script:` with an EMPTY pattern is a prompt the user cannot judge,
  // and the refusal came back as "未获批准（目标站点 ）" on a chrome-error:// tab.
  {
    const asked = []
    const fx = makeFakePw()
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    fx.__ctxPage.goto = (u) => {
      fx.__ctxPage._url = "chrome-error://chromewebdata/"
      return Promise.resolve()
    }
    await mk.tool.execute({ action: "navigate_page", url: "https://cn.bing.com/x" }, ctxNoAsk)
    const ask = { directory: root, ask: async (r) => (asked.push(r.patterns.slice()), "once") }
    const refused = await mk.tool.execute({ action: "evaluate_script", function: "() => 1" }, ask)
    assert.ok(o(refused).includes("不是可识别的 http(s) 站点"), "an error page is refused by name")
    assert.equal(asked.length, 0, "and NO dialog is opened for a pattern the user cannot judge")
    assert.ok(o(refused).includes("open/navigate"), "…with the way out named")
    assert.ok(mk.events.some((e) => e.event === "eval_refused_no_host"), "the refusal is on the trajectory")
    log("evaluate_script on a hostless page: refused without a dialog")
  }

  // ---------- 21. multi-tab: new_page / close_page ----------
  // The user asked for it directly: `open` on a live session only navigates
  // the CURRENT tab, so holding two pages at once was impossible.
  {
    const fx = makeFakePw()
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    const before = fx.__ctx._pages.length
    const t2 = await mk.tool.execute({ action: "new_page", url: "https://cn.bing.com/x" }, ctxNoAsk)
    assert.equal(fx.__ctx._pages.length, before + 1, "new_page adds a DISTINCT tab (the mock used to hand back page0)")
    assert.ok(o(t2).includes("已新建标签页") && o(t2).includes("并导航"), "…and reports create + navigate")
    assert.ok(o(t2).includes("当前在它上面"), "…and the new tab is the current one")
    const blank = await mk.tool.execute({ action: "new_page" }, ctxNoAsk)
    assert.ok(o(blank).includes("空白标签页"), "new_page without a url is a blank tab, not an args error")
    const listed = await mk.tool.execute({ action: "list_pages" }, ctxNoAsk)
    assert.ok(o(listed).includes(`标签页（${before + 2}）`), "list_pages counts the tabs")
    const closedOne = await mk.tool.execute({ action: "close_page", index: 0 }, ctxNoAsk)
    assert.ok(o(closedOne).includes("已关闭，剩"), "close_page reports the remainder")
    assert.equal(fx.__ctx._pages.length, before + 1, "…and the tab really left the context")
    assert.ok(o(closedOne).includes("当前在"), "…and names which tab is current now")
    const oob = await mk.tool.execute({ action: "close_page", index: 99 }, ctxNoAsk)
    assert.ok(o(oob).includes("越界"), "an out-of-range index is refused, never silently ignored")
    // closing the LAST tab must not claim the browser closed
    let guard = 0
    while (fx.__ctx._pages.length > 1 && guard++ < 10) await mk.tool.execute({ action: "close_page", index: 0 }, ctxNoAsk)
    assert.equal(fx.__ctx._pages.length, 1, "down to exactly one tab")
    const last = await mk.tool.execute({ action: "close_page", index: 0 }, ctxNoAsk)
    assert.ok(o(last).includes("这是最后一个") && o(last).includes("浏览器仍在运行"), "the last tab says the browser is still up — close is a different verb")
    assert.ok(o(last).includes('action:"close"'), "…and points at the verb that ends the session")
    const empty = await mk.tool.execute({ action: "close_page", index: 0 }, ctxNoAsk)
    assert.ok(o(empty).includes("越界"), "with no tabs left, close_page says so instead of inventing a success")
    log("multi-tab: new_page/close_page with honest current-tab and last-tab semantics")
  }

  // ---------- 22. close verifies the PROCESS, not just the connection ----------
  // Live proof this was needed: close printed 已确认关闭 while an msedge tree
  // was still running under OpenCode.exe — pages gone and connection dropped
  // are NOT the same fact as "the process exited".
  {
    const fx = makeFakePw({ browserPid: NO_PID })
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    const done = await mk.tool.execute({ action: "close" }, ctxNoAsk)
    assert.ok(o(done).includes("已确认关闭"), "with the process gone the verdict is a real confirmation")
    assert.ok(new RegExp(`进程 ${NO_PID} 早已不在`).test(o(done)), "…and it names the pid it actually checked")
    assert.equal(br.pidAlive(NO_PID), false, "pidAlive: a bogus pid is dead, not 'unknown'")
    assert.equal(br.pidAlive(process.pid), true, "pidAlive: our own pid is alive")
    assert.equal(br.pidAlive(0), false, "pidAlive: pid 0 is never a browser")
    assert.equal(await br.waitForPidExit(NO_PID), true, "a pid that is not there needs no waiting")
    let killed = 0
    const still = await br.waitForPidExit(process.pid, 150, () => {
      killed++
    })
    assert.equal(still, false, "a live pid that survives the wait is NOT reported as exited")
    assert.equal(killed, 1, "…and exactly one terminate was attempted (never a retry storm)")
    log("close verifies the OS process: pid named in the verdict, live pid never declared gone")
  }

  // ---------- 23. orphan browsers: reclaimed by OUR ledger, never by name ----------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reap-"))
    const file = br.browserLedgerFile(dir)
    const rec = (pid, owner) => JSON.stringify({ pid, ownerPid: owner, engine: "playwright", at: 1 })
    fs.writeFileSync(
      file,
      [rec(111, 999), rec(222, process.pid), rec(333, 999), "torn-line", rec(222, process.pid)].join("\n") + "\n",
    )
    const alive = new Set([111, 222, process.pid]) // 333 already exited, 999 is gone
    const killed = []
    const r = br.reapOrphanBrowsers(file, { alive: (p) => alive.has(p), kill: (p) => killed.push(p) })
    assert.deepEqual(killed, [111], "only the entry whose OWNER process is dead is terminated")
    assert.equal(r.kept, 1, "a browser owned by a LIVE process is left alone (two windows, one workspace)")
    assert.equal(r.dropped, 2, "an exited browser and a duplicate pid are dropped from the ledger, not killed")
    const left = fs.readFileSync(file, "utf8").trim().split("\n")
    assert.equal(left.length, 1, "the rewritten ledger holds only what is still live")
    assert.ok(left[0].includes('"pid":222'), "…and it is the survivor")
    assert.deepEqual(br.reapOrphanBrowsers(path.join(dir, "nope.jsonl"), {}), { reaped: [], kept: 0, dropped: 0 }, "no ledger is a no-op, never a throw")
    // all dead → the file goes away instead of accumulating
    fs.writeFileSync(file, rec(444, 999) + "\n")
    const r2 = br.reapOrphanBrowsers(file, { alive: () => false, kill: () => {} })
    assert.equal(r2.dropped, 1, "an already-exited browser is dropped")
    assert.ok(!fs.existsSync(file), "an empty ledger is removed rather than left as a tombstone")
    log("orphan reaper: owner-dead + browser-alive only, ledger rewritten to survivors")
  }

  // ---------- 24. the pid route playwright-core does NOT provide ----------
  {
    // Measured on the desktop host: `typeof browser.process === "undefined"` —
    // that accessor is on ElectronApplication / BrowserServer, not Browser.  So
    // the pid has to come from the OS, anchored on two facts we own: the browser
    // is OUR child, and it runs the executable WE resolved.  Matching by process
    // name alone is not allowed — this machine runs a dozen unrelated msedge
    // trees (the user's own windows, msedgewebview2 under SearchHost.exe and
    // under a vendor utility).
    const EXE =
      process.platform === "win32"
        ? "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe"
        : "/opt/microsoft/msedge"
    const base = EXE.split(/[\\/]/).pop()
    const row = (pid, cmdline, name = base) => ({ pid, name, cmdline })

    assert.equal(br.launchedBrowserPid("", { rows: [row(7, `"${EXE}" --x`)] }), 0, "no executable -> no pid (never guess)")
    assert.equal(br.launchedBrowserPid(EXE, { rows: [] }), 0, "no children -> 0")
    assert.equal(br.launchedBrowserPid(EXE, { rows: [row(4242, `"${EXE}" --remote-debugging-pipe`)] }), 4242, "our child running our executable IS the browser")
    assert.equal(
      br.launchedBrowserPid(EXE, {
        rows: [row(11, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile"), row(4242, `"${EXE}" --x`)],
      }),
      4242,
      "another child we spawned (a shell probe) is not mistaken for the browser",
    )
    assert.equal(
      br.launchedBrowserPid(EXE, { rows: [row(10, `"${EXE}" --first`), row(20, `"${EXE}" --second`)] }),
      20,
      "two of our browsers (an unreaped session): pids climb, so the highest is this launch",
    )
    assert.equal(
      br.launchedBrowserPid(EXE, { rows: [row(9, "C:\\other\\chrome.exe --x")] }),
      0,
      "a row whose command line is a DIFFERENT executable is never adopted, even when its image name matches (the name fallback needs an absent command line)",
    )
    assert.equal(br.launchedBrowserPid(EXE, { rows: [row(31, "")] }), 31, "a bare image-name match is accepted when it is the ONLY candidate")
    assert.equal(br.launchedBrowserPid(EXE, { rows: [row(31, ""), row(32, "")] }), 0, "two name-only candidates: ambiguous -> 0, not a coin flip")
    assert.equal(br.launchedBrowserPid(EXE.toUpperCase(), { rows: [row(4242, `"${EXE}" --x`)] }), 4242, "the comparison is case-insensitive (Windows paths)")

    // The identity gate: the kill below is a FORCE kill of a whole tree, and an
    // OS pid is a recyclable number.
    assert.equal(br.identityMatchesExecutable(EXE, { name: base, cmdline: "" }), true, "same image name -> ours")
    assert.equal(br.identityMatchesExecutable(EXE, { name: "notepad.exe", cmdline: `"${EXE}" --x` }), true, "the command line still names it -> ours")
    assert.equal(br.identityMatchesExecutable(EXE, { name: "notepad.exe", cmdline: "notepad.exe notes.txt" }), false, "a recycled pid running something else is NOT ours")
    assert.equal(br.identityMatchesExecutable(EXE, null), false, "a pid we cannot identify is not ours to kill")
    assert.equal(br.identityMatchesExecutable("", { name: base, cmdline: base }), false, "no recorded executable -> no match -> no kill")

    // The tree kill: signalling only the root is what left nine msedge
    // processes behind after the reaper "succeeded".
    const win = []
    br.killBrowserTree(4242, { platform: "win32", run: (cmd, a) => win.push([cmd, ...a]) })
    assert.deepEqual(win, [["taskkill.exe", "/PID", "4242", "/T", "/F"]], "win32 kills the TREE (/T), not just the root")
    const posix = []
    br.killBrowserTree(100, {
      platform: "linux",
      children: (p) => (p === 100 ? [row(200, ""), row(201, "")] : p === 200 ? [row(300, "")] : []),
      signal: (p) => posix.push(p),
    })
    assert.deepEqual(posix, [300, 201, 200, 100], "POSIX enumerates the tree and signals deepest-first, root last")
    const none = []
    br.killBrowserTree(0, { platform: "win32", run: (c, a) => none.push([c, ...a]) })
    br.killBrowserTree(-1, { platform: "win32", run: (c, a) => none.push([c, ...a]) })
    br.killBrowserTree(Number.NaN, { platform: "win32", run: (c, a) => none.push([c, ...a]) })
    assert.equal(none.length, 0, "an unknown/invalid pid is never signalled")

    // …and the reaper honours the gate.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ident-"))
    const file = br.browserLedgerFile(dir)
    const rec = (pid, owner, exe) => JSON.stringify({ pid, ownerPid: owner, engine: "playwright", at: 1, exe })
    fs.writeFileSync(file, [rec(111, 999, EXE), rec(222, 999, EXE)].join("\n") + "\n")
    const killed = []
    const r = br.reapOrphanBrowsers(file, {
      alive: (p) => p === 111 || p === 222,
      kill: (p) => killed.push(p),
      identity: (p) => (p === 111 ? { name: "notepad.exe", cmdline: "notepad.exe notes.txt" } : { name: base, cmdline: `"${EXE}" --x` }),
    })
    assert.deepEqual(killed, [222], "the pid that no longer IS our browser is dropped, not force-killed")
    assert.equal(r.dropped, 1, "…and counted as dropped")
    // A line written by an older version (no exe column) must still be reaped,
    // or an upgrade would strand every browser the user already orphaned.
    fs.writeFileSync(file, JSON.stringify({ pid: 333, ownerPid: 999, engine: "playwright", at: 1 }) + "\n")
    const killed2 = []
    br.reapOrphanBrowsers(file, { alive: (p) => p === 333, kill: (p) => killed2.push(p), identity: () => null })
    assert.deepEqual(killed2, [333], "a legacy ledger line without the exe column is still reclaimed")
    fs.rmSync(dir, { recursive: true, force: true })
    log("launch pid without Browser.process(): our child + our executable, identity-checked before a tree kill")
  }

  // ---------- 25. close may not claim a verification it did not do ----------
  {
    const fx = makeFakePw() // no process() — the shape playwright-core 1.63 really has
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22, listChildren: () => [] })
    await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    const done = o(await mk.tool.execute({ action: "close" }, ctxNoAsk))
    // The VERIFIED sentence is `浏览器会话已确认关闭（…）`.  The unverified
    // branch quotes the phrase only to deny it, so the invariant is about that
    // sentence, not about the substring.
    assert.ok(!done.includes("浏览器会话已确认关闭"), `an unverifiable close must not borrow the verified sentence — got: ${done.slice(0, 220)}`)
    assert.ok(done.includes("进程未核验"), "…and it says out loud that the process was never checked")
    assert.ok(mk.events.some((e) => e.event === "launch_pid" && e.via === "none"), "the pid route is audited, so 'none' shows up in tm_stats")

    const fx2 = makeFakePw()
    const mk2 = makeTool({ importPlaywright: async () => fx2.pw, nodeMajor: 22 }) // default scan row -> NO_PID
    await mk2.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    const done2 = o(await mk2.tool.execute({ action: "close" }, ctxNoAsk))
    assert.ok(done2.includes("浏览器会话已确认关闭"), `a pid found by the scan earns the verified sentence — got: ${done2.slice(0, 240)}`)
    assert.ok(done2.includes(`进程 ${NO_PID} 早已不在`), `…and names the pid it checked — got: ${done2.slice(0, 240)}`)
    assert.ok(
      mk2.events.some((e) => e.event === "launch_pid" && e.via === "child-scan" && e.pid === NO_PID),
      "the audit names the route that found the pid",
    )
    log("close: 已确认关闭 only when a pid was actually checked; the unverified case says so")
  }

  // ---------- 26. click reports what the PAGE did, not what we sent ----------
  {
    const probe = (attrs, extra = {}) => ({ attrs, url: "https://cn.bing.com/", ready: "complete", nodes: 1200, ...extra })

    // pure: what counts as an effect
    assert.deepEqual(br.describeClickChange(probe({ "aria-expanded": "false" }), probe({ "aria-expanded": "true" })), ["aria-expanded: false → true"], "a disclosure flip is named")
    assert.deepEqual(br.describeClickChange(probe({}), probe({}, { url: "https://cn.bing.com/next" })), ["已跳转 → https://cn.bing.com/next"], "a navigation is named")
    assert.deepEqual(br.describeClickChange(probe({}), probe({}, { nodes: 1290 })), ["DOM 节点 1200 → 1290"], "a DOM delta is named")
    assert.deepEqual(br.describeClickChange(probe({ "aria-expanded": "false" }), probe({ "aria-expanded": "false" })), [], "an unchanged page yields no claim")
    assert.deepEqual(br.describeClickChange(probe({}), probe({ "aria-checked": "true" })), ["aria-checked: → true"], "an attribute that appeared is named")

    // pure: the wordings
    const effective = br.clickVerdict('uid "e7"', probe({ "aria-expanded": "false" }), ["aria-expanded: false → true"], { retried: false, dialog: false })
    assert.ok(effective.startsWith('已点击 uid "e7" · aria-expanded: false → true'), `an effective click names the change — got: ${effective}`)
    const dead = br.clickVerdict('uid "e7"', probe({ "aria-expanded": "false" }, { ready: "interactive" }), [], { retried: true, dialog: false })
    assert.ok(
      dead.includes("没有任何可观测变化") && dead.includes("readyState=interactive") && dead.includes("wait_for") && dead.includes("不要把这次点击当成成功"),
      `an ineffective click must not read as success — got: ${dead}`,
    )
    const late = br.clickVerdict('uid "e7"', probe({}, { ready: "interactive" }), ["aria-expanded: false → true"], { retried: true, dialog: false })
    assert.ok(late.includes("第一次点击落在页面还没就绪时"), `a retry that worked says why it needed two tries — got: ${late}`)
    assert.equal(br.clickVerdict('uid "e7"', null, [], { retried: false, dialog: false }), '已点击 uid "e7"', "with nothing probeable the reply claims no more than the click")
    assert.ok(br.clickVerdict('uid "e7"', probe({}), [], { retried: false, dialog: true }).includes("handle_dialog"), "an open dialog still gets its note")

    // A: the first click works -> ONE click, no settle wait
    {
      let expanded = false
      const fx = makeFakePw({ probe: () => probe({ "aria-expanded": String(expanded) }), onClick: () => { expanded = true } })
      const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
      await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
      const r = o(await mk.tool.execute({ action: "click", selector: "#go" }, ctxNoAsk))
      assert.ok(r.includes("aria-expanded: false → true"), `A: the flip is reported — got: ${r.slice(0, 160)}`)
      assert.equal(fx.calls.clicks, 1, "A: an effective click is not repeated")
      assert.equal(fx.calls.settled ?? 0, 0, "A: no settle wait when the click landed")
      assert.ok(mk.events.some((e) => e.event === "click_verified" && e.effective === true && e.retried === false), "A: the verdict is audited")
      await mk.tool.dispose()
    }
    // B: the page never reacts -> exactly ONE bounded retry, then the honest answer
    {
      const fx = makeFakePw({ probe: () => probe({ "aria-expanded": "false" }, { ready: "interactive" }) })
      const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
      await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
      const r = o(await mk.tool.execute({ action: "click", selector: "#go" }, ctxNoAsk))
      assert.equal(fx.calls.clicks, 2, "B: one retry only — a loop would toggle a switch back")
      assert.ok((fx.calls.settled ?? 0) >= 1, "B: the retry waits for the page to settle first")
      assert.ok(r.includes("没有任何可观测变化"), `B: an inert page is reported as inert — got: ${r.slice(0, 200)}`)
      assert.ok(mk.events.some((e) => e.event === "click_verified" && e.effective === false && e.retried === true), "B: audited as ineffective")
      await mk.tool.dispose()
    }
    // C: a click that opened a dialog DID land — it must never be retried
    {
      const fx = makeFakePw({
        probe: () => probe({ "aria-expanded": "false" }),
        onClick: () => fx.__ctxPage.fire("dialog", { type: () => "confirm", message: () => "删除？", accept: async () => {}, dismiss: async () => {} }),
      })
      const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
      await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
      const r = o(await mk.tool.execute({ action: "click", selector: "#go" }, ctxNoAsk))
      assert.equal(fx.calls.clicks, 1, "C: an open dialog proves the click landed — no retry")
      assert.ok(r.includes("handle_dialog"), `C: the dialog is surfaced — got: ${r.slice(0, 160)}`)
      await mk.tool.dispose()
    }
    // D: a navigating click detaches the element — the URL still proves the effect
    {
      let navigated = false
      const fx = makeFakePw({
        probe: () => {
          if (navigated) throw new Error("Element is not attached to the DOM")
          return probe({})
        },
        onClick: () => {
          navigated = true
          fx.__ctxPage._url = "https://cn.bing.com/next"
        },
      })
      const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
      await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
      const r = o(await mk.tool.execute({ action: "click", selector: "#go" }, ctxNoAsk))
      assert.equal(fx.calls.clicks, 1, "D: a navigation is an effect — no retry")
      assert.ok(r.includes("已跳转 → https://cn.bing.com/next"), `D: the navigation is named even though the element is gone — got: ${r.slice(0, 160)}`)
      await mk.tool.dispose()
    }
    log("click reports the page's response: a change is named, a no-op is named, and a pre-hydration click gets ONE bounded retry")
  }

  // ---------- 27. one browser per caller: ids are names, and names are checked ----------
  {
    // Three agents carry this tool (lead + researcher for the web, tester for UI
    // verification) and host `task` children run in the SAME plugin process, so
    // they used to share one window, one "current tab" and ONE uid registry:
    // A's take_snapshot renumbered every uid B was holding, and B's next click
    // landed on a different element while still reporting success.
    const tester = { directory: root, sessionID: "ses_tester", agent: "tester" }
    const researcher = { directory: root, sessionID: "ses_researcher", agent: "researcher" }
    const fx = makeFakePw()
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })

    const a = o(await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, tester))
    assert.ok(/^\[b1\] 浏览器已启动/.test(a), `open tags the reply with the id it minted — got: ${a.slice(0, 120)}`)
    assert.ok(a.includes("这个窗口的 id 是 b1") && a.includes("tester"), "…and says whose window it is")
    const b = o(await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, researcher))
    assert.ok(/^\[b2\] /.test(b), `a second caller gets a SECOND browser — got: ${b.slice(0, 120)}`)
    assert.equal(fx.calls.launch.length, 2, "two callers = two launches, not one shared window")
    assert.ok(b.includes("现在共有 2 个浏览器在跑"), "…and is told the id stopped being optional")

    // with two live, an omitted id is ambiguous -> refused, naming the caller's own
    const noId = o(await mk.tool.execute({ action: "take_snapshot" }, tester))
    assert.ok(noId.includes("必须写明 id") && noId.includes("b1"), `an omitted id is refused once it is ambiguous — got: ${noId.slice(0, 220)}`)
    // an id is a NAME, not a capability token: guessing somebody else's is refused
    const stolen = o(await mk.tool.execute({ action: "take_snapshot", id: "b2" }, tester))
    assert.ok(stolen.includes("researcher") && stolen.includes("不是你的"), `another agent's browser is refused WITH the owner named — got: ${stolen.slice(0, 220)}`)
    assert.ok(stolen.includes("b1"), "…and the caller is pointed at its own id")
    const ghost = o(await mk.tool.execute({ action: "take_snapshot", id: "b9" }, tester))
    assert.ok(ghost.includes('没有 id 为 "b9"') && ghost.includes("b1") && ghost.includes("b2"), `an unknown id lists what is actually live — got: ${ghost.slice(0, 220)}`)

    // the uid namespace is per browser: B's snapshot must not invalidate A's uids
    const snapA = o(await mk.tool.execute({ action: "take_snapshot", id: "b1" }, tester))
    assert.ok(snapA.startsWith("[b1]") && /\[uid=e\d+\]/.test(snapA), "A snapshots its own browser")
    const snapB = o(await mk.tool.execute({ action: "take_snapshot", id: "b2" }, researcher))
    assert.ok(snapB.startsWith("[b2]") && /\[uid=e\d+\]/.test(snapB), "B snapshots its own browser")
    const clickA = o(await mk.tool.execute({ action: "click", id: "b1", uid: "e1" }, tester))
    assert.ok(clickA.startsWith("[b1] 已点击"), `A can still act on its own uid AFTER B snapshotted — got: ${clickA.slice(0, 140)}`)
    assert.ok(fx.calls.acted.some((x) => x[0] === "click"), "…and the click really reached the engine")

    // close is per caller: A closing must leave B's window alone
    const closeA = o(await mk.tool.execute({ action: "close", id: "b1" }, tester))
    assert.ok(closeA.startsWith("[b1]"), "close says which browser it closed")
    assert.ok(o(await mk.tool.execute({ action: "take_snapshot", id: "b2" }, researcher)).startsWith("[b2]"), "B's browser survived A's close")
    assert.ok(o(await mk.tool.execute({ action: "take_snapshot", id: "b1" }, tester)).includes('没有 id 为 "b1"'), "…and A's id is really gone")
    // back to one live browser -> the id is unambiguous again and may be omitted
    assert.ok(o(await mk.tool.execute({ action: "list_pages" }, researcher)).startsWith("[b2]"), "with one live browser the id may be omitted again")
    // close {id:"all"} closes the CALLER's own, never anybody else's
    assert.ok(/^\[b3\]/.test(o(await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, tester))), "a caller that closed its browser gets a fresh id")
    const all = o(await mk.tool.execute({ action: "close", id: "all" }, tester))
    assert.ok(all.includes("[b3]"), `close all names what it closed — got: ${all.slice(0, 160)}`)
    assert.ok(o(await mk.tool.execute({ action: "list_pages" }, researcher)).startsWith("[b2]"), "close all never touches another caller's browser")
    assert.ok(mk.events.some((e) => e.event === "lease" && e.id === "b3"), "each lease is audited with its owner")
    await mk.tool.dispose()

    // Consent is per caller too: a host the tester approved through the OFFICIAL
    // dialog must not become a silent pass for the researcher's browser.
    const fxC = makeFakePw()
    const mkC = makeTool({ importPlaywright: async () => fxC.pw, nodeMajor: 22, cfgDomains: ["cn.bing.com"] })
    const askTester = { directory: root, sessionID: "ses_t2", agent: "tester", ask: async () => "once" }
    const plainResearcher = { directory: root, sessionID: "ses_r2", agent: "researcher" }
    await mkC.tool.execute({ action: "open", url: "https://cn.bing.com" }, askTester)
    await mkC.tool.execute({ action: "open", url: "https://cn.bing.com" }, plainResearcher)
    await mkC.tool.execute({ action: "navigate_page", url: "https://approved.test/doc", id: "b1" }, askTester)
    const dec = []
    const rr = () => ({ continue: async () => dec.push("continue"), abort: async () => dec.push("abort") })
    const doc = { url: () => "https://approved.test/doc", method: () => "GET", resourceType: () => "document" }
    await fxC.calls.route[0].handler(rr(), doc) // the tester's browser: approved through its own dialog
    await fxC.calls.route[1].handler(rr(), doc) // the researcher's: never asked, never approved
    assert.deepEqual(dec, ["continue", "abort"], "dialog consent belongs to the caller who earned it — the other agent's browser still blocks that host")
    await mkC.tool.dispose()
    log("one browser per caller: ids minted, echoed, required once ambiguous, checked against the owner, and consent not shared")
  }

  console.log("browser: OK (engine select/degrade matrix, 18-verb playwright mapping + uid registry on mock pw, route()-based allowlist, persistent-profile policy, prompt pins, evaluate_script consent + redaction, dead-session rebuild, hostless-page refusal, multi-tab new_page/close_page, process-verified close, orphan ledger reaper, launch-pid scan + identity gate + tree kill, unverified-close honesty, click effect verification, per-caller browser leases, full args-schema param surface; real-playwright smoke gated on npm install)")
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("browser: FAIL")
    console.error(err)
    process.exit(1)
  },
)

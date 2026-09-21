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
 *   (c) the 16 chrome-devtools-mcp verb mappings + ariaSnapshot handling
 *       against a MOCK playwright module (fake chromium/locator objects —
 *       playwright-core is NOT installed and this suite must not require
 *       it to be);
 *   (d) the REAL playwright smoke is explicitly gated behind
 *       `npm install` — skipped (never failed) while playwright-core is
 *       absent, since installing it is a release/user action.
 *
 * Runs against ./dist (build first: npm run build).
 */
import assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
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
function makeTool(over = {}) {
  const events = []
  const stepsRoot = path.join(root, `steps-${++stepSeq}`)
  fs.mkdirSync(stepsRoot, { recursive: true })
  const pipelines = {
    nextStepId: () => `s9${String(++stepSeq).padStart(3, "0")}`,
    store: { appendTrajectory: (e) => events.push(e), stepsRoot: () => stepsRoot },
  }
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
  const tool = br.buildTmBrowserTool({
    pipelines,
    cfg,
    env,
    importPlaywright: over.importPlaywright,
    nodeMajor: over.nodeMajor,
    findExecutable: over.discovered ? () => over.executablePath : undefined,
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
    click: async () => calls.acted.push(["click", desc]),
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
      newPage: async () => page0,
      // a faithful close: the real context drops its pages AND reports
      // disconnected — tm_browser's verified close verdict reads that state
      close: async () => {
        context._closed = true
        context._pages = []
        if (context._browser) context._browser._closed = true
        return true
      },
    }
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

  // ---------- 3. 16-verb alignment (R2 mapping table) ----------
  {
    const R2_16 = [
      "navigate_page", "take_snapshot", "click", "fill", "hover", "drag", "press_key",
      "select_page", "upload_file", "wait_for", "evaluate_script", "list_console_messages",
      "list_network_requests", "list_pages", "take_screenshot", "handle_dialog",
    ]
    assert.deepEqual([...br.BROWSER_PLAYWRIGHT_ACTIONS].sort(), [...R2_16].sort(), "chrome-devtools-mcp 16 verbs, byte-identical names")
    const legacy = new Set(br.BROWSER_LEGACY_ACTIONS)
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
    assert.ok(o(read).startsWith("页面文本（"), "compat `read` keeps the page-text header")

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
      const mk = makeTool({ realDiscovery: true })
      try {
        const open = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
        assert.ok(o(open).includes("浏览器已启动"), `real playwright open — got: ${o(open).slice(0, 160)}`)
        console.log(`  (real smoke launched: ${/· (playwright\/[^）]*)/.exec(o(open))?.[1] ?? "n/a"})`)
        if (mk.tool.engineInfo().kind === "playwright") {
          const snap = await mk.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
          assert.ok(/\[uid=e\d+\]/.test(o(snap)), "real ariaSnapshot + uid registry round-trip")
        } else {
          console.log(`  (real playwright present but degraded: ${mk.tool.engineInfo().reason})`)
        }
      } finally {
        await mk.tool.execute({ action: "close" }, ctxNoAsk)
        await mk.tool.dispose()
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

  console.log("browser: OK (engine select/degrade matrix, 16-verb playwright mapping + uid registry on mock pw, route()-based allowlist, persistent-profile policy, prompt pins, evaluate_script consent + redaction, full args-schema param surface; real-playwright smoke gated on npm install)")
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("browser: FAIL")
    console.error(err)
    process.exit(1)
  },
)

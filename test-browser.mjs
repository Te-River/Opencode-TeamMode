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
    webfetchAllowedDomains: over.cfgDomains ?? ["cn.bing.com", "bing.com", "example.com"],
  }
  const env = { TM_BROWSER_PATH: over.executablePath ?? fakeExe, TM_BROWSER_HEADLESS: "1", ...over.env }
  const tool = br.buildTmBrowserTool({
    pipelines,
    cfg,
    env,
    importPlaywright: over.importPlaywright,
    nodeMajor: over.nodeMajor,
  })
  return { tool, events, stepsRoot }
}

const ctxNoAsk = { directory: root }
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
      close: async () => (context._closed = true),
    }
    ctxRef = context
    return context
  }
  const pw = {
    chromium: {
      async launch(launchOpts) {
        calls.launch.push(launchOpts)
        if (opts.channelThrows && launchOpts.channel && calls.launch.length === 1) {
          throw new Error("channel launch unsupported (fake)")
        }
        const browser = {
          async newContext(contextOpts) {
            calls.contextOpts.push(contextOpts)
            browser._context = mkContext()
            return browser._context
          },
          async close() {
            browser._closed = true
          },
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
    assert.equal(fx.calls.launch[0].channel, "msedge", "msedge.exe -> channel smoke attempt first")
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
    await handler(route(), { url: () => "https://cn.bing.com/search?q=x", method: () => "GET" })
    await handler(route(), { url: () => "https://evil.test/steal", method: () => "GET" })
    await handler(route(), { url: () => "data:image/png;base64,AAAA" })
    assert.deepEqual(decisions, ["continue", "abort", "continue"], "route(): allowlisted continue / off-list abort / data: passthrough")
    assert.ok(mk.events.some((e) => e.event === "blocked" && String(e.url).includes("evil.test")), "blocked hop trajectory-audited (per-hop)")

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
    const evald = await mk.tool.execute({ action: "evaluate_script", function: "document.title" }, ctxNoAsk)
    assert.ok(o(evald).includes("EVAL"), "evaluate_script routes JS + returns the value")

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
    const m = /截图已保存（(\d+) bytes）：(.+)$/m.exec(o(shot))
    assert.ok(m && fs.existsSync(m[2].trim()) && Number(m[1]) === 8, "take_screenshot writes the PNG to the run store, §6o output shape")
    const legacyNamed = await mk2.tool.execute({ action: "screenshot" }, ctxNoAsk)
    assert.ok(o(legacyNamed).includes("截图已保存"), "compat `screenshot` verb maps to take_screenshot")
    const read = await mk2.tool.execute({ action: "read" }, ctxNoAsk)
    assert.ok(o(read).startsWith("页面文本（"), "compat `read` keeps the page-text header")

    // ---- close ----
    const closed = await mk2.tool.execute({ action: "close" }, ctxNoAsk)
    assert.ok(o(closed).includes("已关闭"), "playwright close keeps the 已关闭 wording")
    assert.ok(o(await mk2.tool.execute({ action: "close" }, ctxNoAsk)).includes("没有打开的浏览器会话"), "double close stays honest")
    log("playwright engine (mocked): launch opts / route allowlist / snapshot+uid / all 16 verbs / buffers / dialogs / shots")
  }

  // ---------- 6b. channel -> executablePath fallback (R2: channel is smoke-only) ----------
  {
    const fx = makeFakePw({ channelThrows: true })
    const mk = makeTool({ importPlaywright: async () => fx.pw, nodeMajor: 22 })
    const open = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.ok(o(open).includes("已导航"), "channel failure falls back to executablePath and still opens")
    assert.equal(fx.calls.launch[0].channel, "msedge", "attempt 1 = channel")
    assert.equal(fx.calls.launch[1]?.executablePath, fakeExe, "attempt 2 = our discovered executablePath")
    // chrome.exe discovered name -> channel chrome
    const chromeExe = path.join(root, "chrome.exe")
    fs.writeFileSync(chromeExe, "MZ")
    const fx2 = makeFakePw()
    const mk2 = makeTool({ importPlaywright: async () => fx2.pw, nodeMajor: 22, executablePath: chromeExe })
    await mk2.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
    assert.equal(fx2.calls.launch[0].channel, "chrome", "chrome.exe -> channel(chrome) smoke attempt")
    log("channel launches are smoke-attempt-only with executablePath fallback (official cross-version warning)")
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
      const mk = makeTool({})
      try {
        const open = await mk.tool.execute({ action: "open", url: "https://cn.bing.com" }, ctxNoAsk)
        assert.ok(o(open).includes("浏览器已启动"), "real playwright open")
        if (mk.tool.engineInfo().kind === "playwright") {
          const snap = await mk.tool.execute({ action: "take_snapshot" }, ctxNoAsk)
          assert.ok(/\[uid=e\d+\]/.test(o(snap)), "real ariaSnapshot + uid registry round-trip")
        } else {
          console.log(`  (real playwright present but degraded: ${mk.tool.engineInfo().reason})`)
        }
      } finally {
        await mk.tool.execute({ action: "close" }, ctxNoAsk)
        mk.tool.dispose()
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
      "action", "url", "headless", "uid", "selector", "targetUid", "targetSelector",
      "text", "key", "function", "expression", "filePath", "files", "index",
      "timeoutMs", "dialogAction", "promptText", "clear", "fullPage",
    ]
    for (const k of CONSUMED) assert.ok(k in shape, `browser args shape declares ${k}`)
    // drift guard: every STATIC `args.x` read in the built module is covered
    const src = fs.readFileSync(new URL("./dist/tm/browser.js", import.meta.url), "utf8")
    const seen = new Set([...src.matchAll(/\bargs\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    for (const k of seen) assert.ok(k in shape, `execute() reads args.${k} but the shape does not declare it`)
    // selector/targetUid/targetSelector are dynamic-bracket reads (targetOf) —
    // keep them in the explicit list above if a refactor changes that.
    const actionText = text(shape.action)
    for (const v of ["take_snapshot", "handle_dialog", "upload_file", "evaluate_script", "list_console_messages", "open", "close"])
      assert.ok(actionText.includes(v), `action description names ${v}`)
    log(`args-schema declares the full param surface (${CONSUMED.length} fields; ${seen.size} static reads covered)`)
  }

  console.log("browser: OK (engine select/degrade matrix, 16-verb playwright mapping + uid registry on mock pw, route()-based allowlist, persistent-profile policy, prompt pins, full args-schema param surface; real-playwright smoke gated on npm install)")
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("browser: FAIL")
    console.error(err)
    process.exit(1)
  },
)

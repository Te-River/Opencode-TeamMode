/**
 * tm_ptc_run — the three engines behind the frozen `PtcEngine` seam.
 * Split out of the former monolithic ptc.ts; behavior unchanged.
 *
 * M1 legacy: InlineSequentialEngine (test-only — runs on the MAIN thread,
 * no sandbox, no timeout; a post-await busy loop blocks the host event loop
 * irrecoverably).
 * M2 primary: WorkerEngine (worker_threads + MessagePort RPC, env:{},
 * resourceLimits, hard `terminate()` wall-clock kill; bootstrap as a
 * build-time string; the program body runs inside a node:vm sandbox —
 * whitelist { tm, console, setTimeout, clearTimeout }, no node globals —
 * with the run's timeoutMs as the in-engine script timeout).
 * M2 fallback: InlineVmEngine (node:vm runInContext — the script timeout
 * kills PRE-await synchronous busy-loops; a POST-await busy loop blocks the
 * host event loop irrecoverably, documented — prefer worker/auto).
 *
 * C1 fix batch: BOTH vm engines now build their `tm` facade IN-CONTEXT via
 * `vm.compileFunction` (parsingContext) and compile the context with
 * `codeGeneration:{strings:false,wasm:false}`, so an injected facade's
 * `.constructor` is the sandbox Function
 * and `tm.read.constructor("return process")()` / `eval` / `new Function` THROW
 * instead of escaping into the worker/plugin realm.  A started worker that
 * then crashes is reported as a program fault (never auto-replayed on the
 * more-privileged inline realm) — see engines WorkerEngine error/exit handling.
 */

import * as vm from "node:vm"
import type { PtcBridge, PtcEngine, PtcEngineName, PtcEngineRunOpts, PtcRpcRequest, PtcRpcResponse } from "./contract.js"
import { PtcProgramError, PtcStopSignal } from "./contract.js"

/**
 * The `node:vm` sandbox calls the C1 fix relies on.  `vm.compileFunction`
 * with a `parsingContext` compiles a function INTO that vm context's realm,
 * so the injected facade's `.constructor` is the SANDBOX Function (there is
 * no `vm.wrap` in Node — compileFunction + parsingContext is the supported
 * primitive).  `createContext`'s `codeGeneration` option is present at
 * runtime on the supported Node range but absent from the installed
 * `@types/node`, so a narrow typed view keeps these SECURITY call sites
 * checked instead of reaching for `any`.
 */
interface VmSandboxApi {
  createContext: (
    sandbox: Record<string, unknown>,
    options?: { codeGeneration?: { strings?: boolean; wasm?: boolean } },
  ) => void
  compileFunction: (
    body: string,
    params: string[],
    options: { parsingContext: Record<string, unknown> },
  ) => (...args: unknown[]) => unknown
  runInContext: (
    code: string,
    context: Record<string, unknown>,
    options: { timeout: number },
  ) => unknown
}
const vmSandbox = vm as unknown as VmSandboxApi

/** Build the `tm` facade the program body sees (one method per bridge tool). */
function makeFacade(
  bridge: PtcBridge,
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const one =
    (tool: string) =>
    (args: Record<string, unknown>): Promise<unknown> =>
      bridge.call(tool as never, args && typeof args === "object" ? args : {})
  return {
    read: one("tm_read"),
    grep: one("tm_grep"),
    bash: one("tm_bash"),
    fetch: one("tm_fetch"),
    // T6 web bridges — always present so the program SHAPE is uniform; the
    // bridge itself rejects the call with a clear error when the web bridge
    // is off (TM_PTC_WEB_BRIDGE) or the caller's role denies the tool.
    search: one("tm_search"),
    webfetch: one("tm_webfetch"),
  }
}

/**
 * C1 (sandbox-escape) containment — the reason a facade is built with
 * `vm.compileFunction` (parsingContext) instead of being injected as a host/worker-realm closure.
 *
 * A function injected into a `vm` context still belongs to the realm that
 * CREATED it, so `tm.read.constructor` used to be the WORKER (or, worse, the
 * plugin ESM) realm's `Function` — `tm.read.constructor("return process")()`
 * escaped the sandbox outright.  Compiling the facade INSIDE the context via
 * `compileFunction`-with-parsingContext makes every injected function a SANDBOX-realm function whose
 * `.constructor` is the sandbox `Function`; combined with
 * `codeGeneration:{strings:false}` on the context that call throws
 * ("Code generation from strings disallowed for this context"), and even
 * without the throw the sandbox `Function` can only compile into the sandbox
 * realm, where `process` / `require` do not exist.
 *
 * The two host callbacks the sandbox needs (`postCall` in the worker,
 * `callBridge` inline) are passed as WRAPPER PARAMETERS, so they live in the
 * closure — unreachable from the program (`Function.prototype.toString`
 * shows only source, never the closed-over values).  And every RPC result is
 * JSON round-tripped IN the sandbox (`JSON.parse(JSON.stringify(raw))`) so a
 * host/worker-realm object (whose `.constructor` would be a host Object →
 * host Function) NEVER crosses into the program: rejected reasons are plain
 * strings too.  Dynamic `import("node:fs")` is unavailable in a `vm` context
 * that supplies no `importModuleDynamically` callback, so it throws by default.
 */

/** The vm-wrap body (worker engine): builds { tm, console, setTimeout,
 *  clearTimeout } entirely in the sandbox realm from four host callbacks. */
const TM_SANDBOX_SRC = [
  '"use strict";',
  "function mk(tool) {",
  "  return function(args) {",
  "    return new Promise(function(resolve, reject) {",
  // resolve normalizes the host/worker-realm result into a sandbox object.
  "      postCall(tool, args, function(raw) { resolve(JSON.parse(JSON.stringify(raw))); }, reject);",
  "    });",
  "  };",
  "}",
  'var tm = { read: mk("tm_read"), grep: mk("tm_grep"), bash: mk("tm_bash"), fetch: mk("tm_fetch"), search: mk("tm_search"), webfetch: mk("tm_webfetch") };',
  "var console = { log: function() { return callLog(); }, error: function() { return callLog(); }, warn: function() { return callLog(); }, info: function() { return callLog(); }, debug: function() { return callLog(); }, trace: function() { return callLog(); } };",
  // setTimeout/clearTimeout return a SANDBOX id and keep the worker timer
  // handle in a closure so no worker object ever surfaces to the program.
  "var __timers = {}; var __tid = 0;",
  "var setTimeout = function(fn, ms) {",
  "  var id = ++__tid;",
  "  __timers[id] = callTimeout(function() { delete __timers[id]; try { fn(); } catch (e) { void e; } }, ms);",
  "  return id;",
  "};",
  "var clearTimeout = function(id) { var h = __timers[id]; if (h) { delete __timers[id]; callClearTimeout(h); } };",
  "return { tm: tm, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };",
].join("\n")

/** The vm-wrap body (inline-vm engine): builds { tm } in the sandbox realm
 *  from one host `callBridge` callback (rejects hand back a string, never a
 *  host Error, so the program cannot climb `err.constructor`). */
const TM_INLINE_SRC = [
  '"use strict";',
  "function mk(tool) {",
  "  return function(args) {",
  "    return new Promise(function(resolve, reject) {",
  "      callBridge(tool, args, function(raw) { resolve(JSON.parse(JSON.stringify(raw))); }, function(msg) { reject(String(msg)); });",
  "    });",
  "  };",
  "}",
  'return { read: mk("tm_read"), grep: mk("tm_grep"), bash: mk("tm_bash"), fetch: mk("tm_fetch"), search: mk("tm_search"), webfetch: mk("tm_webfetch") };',
].join("\n")

export class InlineSequentialEngine implements PtcEngine {
  readonly name: PtcEngineName = "inline"
  async run(program: string, bridge: PtcBridge, signal: AbortSignal): Promise<unknown> {
    // M1 legacy engine, kept test-only: the program runs as a trusted async
    // function body on the MAIN thread — no sandbox, no timeout, and a
    // post-await busy loop blocks the host event loop irrecoverably (same
    // residual as InlineVmEngine).  Production runs WorkerEngine (auto
    // default) or InlineVmEngine.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...a: string[]
    ) => (...a: unknown[]) => Promise<unknown>
    const tm = makeFacade(bridge)
    let abortHandler: (() => void) | undefined
    const abortP = new Promise<never>((_, rej) => {
      // The driver only aborts on wall-clock timeout (budget stops flow through
      // the gate as PtcStopSignal).
      abortHandler = () => rej(new PtcStopSignal("timeout"))
      if (signal.aborted) abortHandler()
      else signal.addEventListener("abort", abortHandler, { once: true })
    })
    try {
      const fn = new AsyncFunction("tm", `"use strict";\n${program}`)
      return await Promise.race([fn(tm), abortP])
    } finally {
      if (abortHandler) signal.removeEventListener("abort", abortHandler)
    }
  }
}

// ---------- worker engine (MessagePort RPC over worker_threads) --------------

export class WorkerEngine implements PtcEngine {
  readonly name: PtcEngineName = "worker"

  async run(
    program: string,
    bridge: PtcBridge,
    signal: AbortSignal,
    opts?: PtcEngineRunOpts,
  ): Promise<unknown> {
    const { Worker } = await import("node:worker_threads")
    // Build the worker bootstrap source as a regular string (ts-safe).
    // The worker receives {program, startDeadlineMs, timeoutMs} via its
    // first message, creates the tm facade, runs the program, and sends RPC
    // call requests back to the driver which executes them through the
    // gate bridge.
    //
    // T2 (C1 security): the program body runs inside a node:vm context —
    // a fresh realm with NO node globals.  The C1 FIX closes the residual
    // host-function leak the earlier comments conceded: the `tm` facade and
    // the whitelisted intrinsics (console/setTimeout/clearTimeout) are now
    // COMPILED INSIDE the context via `vm.compileFunction` + `parsingContext` (see TM_SANDBOX_SRC), so a
    // facade function's `.constructor` is the sandbox Function, and the
    // context carries `codeGeneration:{strings:false,wasm:false}` so
    // `tm.read.constructor("return process")()` / `eval` / `new Function`
    // all THROW instead of escaping into the worker realm.  RPC results are
    // JSON round-tripped in the sandbox and rejection reasons are strings,
    // so no worker-realm object crosses the boundary.  (node:vm is still a
    // containment layer, not a hard boundary — staticPscan stays the first
    // gate and terminate() the wall-clock kill — but the trivial
    // `.constructor` escape that used to make the sandbox porous is gone.)
    // The bootstrap itself keeps worker powers (it needs require for
    // node:vm/worker_threads) — ONLY the program loses them.
    const src = [
      '"use strict";',
      'const { parentPort } = require("node:worker_threads");',
      'const vm = require("node:vm");',
      "parentPort.on(" + JSON.stringify("message") + ", async function onMsg(msg) {",
      "  if (msg && msg.t === " + JSON.stringify("run") + ") {",
      "    const program = msg.program;",
      "    const callMap = new Map();",
      "    let nextId = 0;",
      // The ONLY worker capability the sandbox reaches — passed to the wrapped
      // facade as a closure parameter, so it is invisible to the program.  A
      // postMessage clone failure rejects with a STRING (never a worker Error).
      "    var postCall = function(tool, args, resolve, reject) {",
      "      const id = nextId++;",
      "      callMap.set(id, { resolve: resolve, reject: reject });",
      "      try { parentPort.postMessage({ t: " + JSON.stringify("call") + ", id: id, tool: tool, args: args }); }",
      "      catch (e) { callMap.delete(id); reject(String(e && e.message ? e.message : e)); }",
      "    };",
      "    var callLog = function() {};",
      "    var callTimeout = function(fn, ms) { return setTimeout(fn, ms); };",
      "    var callClearTimeout = function(h) { return clearTimeout(h); };",
      // inner listener: RPC replies resolve pending program calls; abort
      // rejects are STRINGS (the parent normally hard-terminates on a stop).
      '    parentPort.on("message", function(inner) {',
      '      if (inner && inner.t === "result" && callMap.has(inner.id)) {',
      "        callMap.get(inner.id).resolve(inner.r);",
      "        callMap.delete(inner.id);",
      '      } else if (inner && inner.t === "abort") {',
      "        for (const e of callMap.values()) e.reject(String(" + JSON.stringify("ptc-stop:") + ") + String(inner.reason));",
      "        callMap.clear();",
      "      }",
      "    });",
      // C1: null-prototype context + codeGeneration OFF, facade built in-realm.
      "    var sandbox = Object.create(null);",
      "    vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });",
      "    var inject = vm.compileFunction(" + JSON.stringify(TM_SANDBOX_SRC) + ", [" +
        JSON.stringify("postCall") + ", " + JSON.stringify("callLog") + ", " +
        JSON.stringify("callTimeout") + ", " + JSON.stringify("callClearTimeout") + "], " +
        "{ parsingContext: sandbox });",
      "    var built = inject(postCall, callLog, callTimeout, callClearTimeout);",
      "    sandbox.tm = built.tm;",
      "    sandbox.console = built.console;",
      "    sandbox.setTimeout = built.setTimeout;",
      "    sandbox.clearTimeout = built.clearTimeout;",
      "    var vmTimeout = typeof msg.timeoutMs === " + JSON.stringify("number") + " && msg.timeoutMs > 0 ? msg.timeoutMs : 30000;",
      "    try {",
      // async-IIFE wrapper (same shape as InlineVmEngine): `return` stays
      // legal in the body, strict mode applies, and the completion value
      // IS the program's promise.  The vm timeout kills PRE-await sync
      // busy-loops in-engine (post-await loops die via the driver-side
      // abort → terminate()).
      "      var result = await vm.runInContext(" +
        JSON.stringify('(async () => {\n"use strict";\n') +
        " + program + " +
        JSON.stringify("\n})()") +
        ", sandbox, { timeout: vmTimeout });",
      '      parentPort.postMessage({ t: "done", result: result });',
      "    } catch (err) {",
      // T5: tag the fault kind — a program throw becomes kind:"program"
      // so the parent constructs PtcProgramError (status "program-error",
      // no auto-degrade).  vm-realm Errors are not instanceof the worker
      // realm's Error — read message/stack structurally.
      '      parentPort.postMessage({ t: "error", kind: "program", message: (err && err.message) ? String(err.message) : String(err), stack: (err && err.stack) ? String(err.stack) : undefined });',
      "    }",
      "  }",
      "});",
    ].join("\n")
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      // C1: did the worker thread actually START?  A crash AFTER the thread
      // came online is a RUNTIME fault (a started program) and must never be
      // replayed on the inline/ESM realm; only a failure to START at all
      // (pre-online) is an engine-init fault the driver may degrade from.
      let online = false
      const w = new Worker(src, {
        eval: true,
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      })

      function settle(fn: () => void) {
        if (settled) return
        settled = true
        fn()
      }

      w.on("message", (msg: { t: string; [k: string]: unknown }) => {
        if (!msg || settled) return
        if (msg.t === "done") {
          settle(() => {
            w.terminate()
            resolve(msg.result)
          })
        } else if (msg.t === "error") {
          settle(() => {
            w.terminate()
            const message = typeof msg.message === "string" ? msg.message : "worker error"
            // A vm script-timeout text means the program blew its
            // in-engine time budget — surface it as the run TIMEOUT so the
            // status stays "timeout" whichever watchdog fired first.
            if (msg.kind === "program" && /^Script execution timed out/i.test(message)) {
              reject(new PtcStopSignal("timeout"))
              return
            }
            // T5: a tagged program fault → PtcProgramError (the driver maps
            // it to "program-error" and never auto-degrades).  An untagged
            // error stays a generic engine fault.
            if (msg.kind === "program") {
              reject(
                new PtcProgramError(message, typeof msg.stack === "string" ? msg.stack : undefined),
              )
              return
            }
            const err = new Error(message)
            if (typeof msg.stack === "string") err.stack = msg.stack
            reject(err)
          })
        } else if (msg.t === "call") {
          // Driver executes the bridge call through the gate and replies.
          const req = msg as unknown as PtcRpcRequest
          bridge
            .call(req.tool, req.args)
            .then((r) => {
              if (!settled) {
                w.postMessage({ t: "result", id: req.id, r } as PtcRpcResponse)
              }
            })
            .catch((err: unknown) => {
              // T5 (stop-signal swallow): the gate throws PtcStopSignal on
              // budget/time stops — it must TERMINATE the run with the stop
              // status instead of being swallowed into a generic per-call
              // error (zombie mode: the program kept running past the stop
              // on "bridge call failed" replies).
              if (err instanceof PtcStopSignal) {
                settle(() => {
                  w.terminate().then(() => reject(err))
                })
                return
              }
              if (!settled) {
                w.postMessage({
                  t: "result",
                  id: req.id,
                  r: { ok: false, error: { tool: req.tool, phase: "execute", message: "bridge call failed" } },
                } as PtcRpcResponse)
              }
            })
        }
      })

      w.on("online", () => {
        online = true
      })

      w.on("error", (err: Error) => {
        const msg = err instanceof Error ? err.message : String(err)
        settle(() => {
          if (online) {
            // The worker thread had started and then threw at the bootstrap
            // level — a runtime crash of a started program.  Tag it as a
            // PROGRAM fault so the driver maps to "program-error" and NEVER
            // replays the (already-running) program on a more-privileged
            // realm.  Do NOT terminate-and-resolve; the run simply fails.
            reject(new PtcProgramError(msg, err instanceof Error ? err.stack : undefined))
          } else {
            // The worker never came online: an engine-init fault.  This is
            // the ONLY case the auto worker→inline degrade may act on.
            reject(err instanceof Error ? err : new Error(msg))
          }
        })
      })

      // C1: an unexpected exit while the run is still open.  Post-online this
      // is a crash (e.g. a bootstrap-level process.exit) → program-error, no
      // replay; pre-online it is an init failure → engine-error (degradable).
      w.on("exit", (code: number) => {
        if (code === 0 || settled) return
        settle(() => {
          if (online) reject(new PtcProgramError(`worker crashed (exit ${code})`))
          else reject(new Error(`worker failed to start (exit ${code})`))
        })
      })

      // Wire signal abort → terminate the worker.
      const onAbort = () => {
        settle(() => {
          w.terminate().then(() => reject(new PtcStopSignal("timeout")))
        })
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })

      // Send the run request — timeoutMs feeds the in-engine vm script
      // timeout (complementary to the driver-side abort→terminate).
      w.postMessage({
        t: "run",
        program,
        startDeadlineMs: opts?.startDeadlineMs ?? 0,
        timeoutMs: opts?.timeoutMs,
      } as unknown)
    })
  }
}

// ---------- inline-vm fallback engine (node:vm with script timeout) ----------

export class InlineVmEngine implements PtcEngine {
  readonly name: PtcEngineName = "inline"
  /** Script execution timeout in ms (kills pre-await synchronous
   *  busy-loops).  Injectable so tests can pin the kill fast. */
  private readonly compileTimeoutMs: number
  constructor(compileTimeoutMs = 30_000) {
    this.compileTimeoutMs = compileTimeoutMs
  }

  async run(program: string, bridge: PtcBridge, signal: AbortSignal): Promise<unknown> {
    // C1: build the facade INSIDE the sandbox (vm.compileFunction + parsingContext) and compile the
    // context with codeGeneration OFF.  This engine runs in the PLUGIN ESM
    // realm (historically the WORST leak: an escaped `Function` could then
    // `import("node:fs" | "node:child_process")` → arbitrary file read incl.
    // .env, bypassing R6/P2).  Wrapping the injected functions into the
    // sandbox realm is what closes it: `tm.read.constructor` is the sandbox
    // Function, codeGeneration:{strings:false} blocks compiling any new
    // string, and dynamic `import(...)` has no callback in a vm context so it
    // throws.  The plugin-realm `bridge` is passed as a WRAPPER PARAMETER
    // (closure, unreachable from the program); RPC results are JSON
    // round-tripped into the sandbox and rejection reasons are plain strings,
    // so no host-realm object (with a host `.constructor`) ever crosses in.
    const callBridge = (
      tool: string,
      args: unknown,
      resolve: (r: unknown) => void,
      reject: (m: string) => void,
    ): void => {
      let p: Promise<unknown>
      try {
        p = bridge.call(
          tool as never,
          args && typeof args === "object" ? (args as Record<string, unknown>) : {},
        )
      } catch (e) {
        reject(e instanceof Error ? e.message : String(e))
        return
      }
      Promise.resolve(p).then(
        (r) => resolve(r),
        (e) => reject(e instanceof Error ? e.message : String(e)),
      )
    }
    const sandbox = Object.create(null) as Record<string, unknown>
    vmSandbox.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
    // TM_INLINE_SRC returns the { read, grep, bash, fetch, search, webfetch }
    // facade directly (this context carries only `tm`, no console/timers).
    const inject = vmSandbox.compileFunction(TM_INLINE_SRC, ["callBridge"], {
      parsingContext: sandbox,
    }) as (cb: typeof callBridge) => Record<string, unknown>
    sandbox.tm = inject(callBridge)
    let abortHandler: (() => void) | undefined
    const abortP = new Promise<never>((_, rej) => {
      abortHandler = () => rej(new PtcStopSignal("timeout"))
      if (signal.aborted) abortHandler()
      else signal.addEventListener("abort", abortHandler, { once: true })
    })
    try {
      // The async-IIFE is the program wrapper: `return` stays legal in the
      // body, the `tm` facade rides the context globals, and the script's
      // completion value IS the program's promise.  The timeout kills
      // pre-await synchronous busy-loops (see the module doc).
      let promise: Promise<unknown>
      try {
        promise = vmSandbox.runInContext(
          `(async () => {\n"use strict";\n${program}\n})()`,
          sandbox,
          { timeout: this.compileTimeoutMs },
        ) as Promise<unknown>
      } catch (err) {
        // a SYNCHRONOUS vm throw (script timeout) is an engine-side kill —
        // generic Error → engine-error semantics (pinned by §9j).
        throw err
      }
      try {
        return await Promise.race([promise, abortP])
      } catch (err) {
        if (err instanceof PtcStopSignal) throw err
        // T5: the program body REJECTED — tag it so the driver maps to
        // status "program-error" instead of auto-degrading.  A vm-realm
        // Error is not instanceof the host Error — read message/stack
        // structurally.
        const message = (err as { message?: unknown } | null | undefined)?.message
        const stack = (err as { stack?: unknown } | null | undefined)?.stack
        throw new PtcProgramError(
          typeof message === "string" && message ? message : String(err ?? "program error"),
          typeof stack === "string" ? stack : undefined,
        )
      }
    } finally {
      if (abortHandler) signal.removeEventListener("abort", abortHandler)
    }
  }
}

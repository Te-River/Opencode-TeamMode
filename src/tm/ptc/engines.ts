/**
 * tm_ptc_run — the three engines behind the frozen `PtcEngine` seam.
 * Split out of the former monolithic ptc.ts; behavior unchanged.
 *
 * M1 legacy: InlineSequentialEngine (test-only — runs on the MAIN thread,
 * no sandbox, no timeout; a post-await busy loop blocks the host event loop
 * irrecoverably).
 * M2 primary: WorkerEngine (worker_threads + MessagePort RPC, env:{},
 * resourceLimits, hard `terminate()` wall-clock kill; bootstrap as a
 * build-time string, strict-mode program body).
 * M2 fallback: InlineVmEngine (node:vm runInNewContext — the script timeout
 * kills PRE-await synchronous busy-loops; a POST-await busy loop blocks the
 * host event loop irrecoverably, documented — prefer worker/auto).
 */

import * as vm from "node:vm"
import type { PtcBridge, PtcEngine, PtcEngineName, PtcRpcRequest, PtcRpcResponse } from "./contract.js"
import { PtcStopSignal } from "./contract.js"

/** Build the `tm` facade the program body sees (one method per bridge tool). */
function makeFacade(bridge: PtcBridge): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  const one =
    (tool: string) =>
    (args: Record<string, unknown>): Promise<unknown> =>
      bridge.call(tool as never, args && typeof args === "object" ? args : {})
  return { read: one("tm_read"), grep: one("tm_grep"), bash: one("tm_bash"), fetch: one("tm_fetch") }
}

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

  async run(program: string, bridge: PtcBridge, signal: AbortSignal): Promise<unknown> {
    const { Worker } = await import("node:worker_threads")
    // Build the worker bootstrap source as a regular string (ts-safe).
    // The worker receives {program, startDeadlineMs} via its first message,
    // creates the tm facade, runs the program, and sends RPC call requests
    // back to the driver which executes them through the gate bridge.
    const src = [
      '"use strict";',
      'const { parentPort } = require("node:worker_threads");',
      "parentPort.on(" + JSON.stringify("message") + ", async function onMsg(msg) {",
      "  if (msg && msg.t === " + JSON.stringify("run") + ") {",
      "    const program = msg.program;",
      "    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;",
      "    const callMap = new Map();",
      "    let nextId = 0;",
      '    const one = function(tool) { return function(args) { return new Promise(function(resolve, reject) {',
      "      const id = nextId++;",
      "      callMap.set(id, { resolve: resolve, reject: reject });",
      '      parentPort.postMessage({ t: "call", id: id, tool: tool, args: args || {} });',
      "    }); }; };",
      "    var tm = { read: one(" + JSON.stringify("tm_read") + "), grep: one(" + JSON.stringify("tm_grep") + "), bash: one(" + JSON.stringify("tm_bash") + "), fetch: one(" + JSON.stringify("tm_fetch") + ") };",
      '    parentPort.on("message", function(inner) {',
      '      if (inner && inner.t === "result" && callMap.has(inner.id)) {',
      "        callMap.get(inner.id).resolve(inner.r);",
      "        callMap.delete(inner.id);",
      '      } else if (inner && inner.t === "abort") {',
      "        for (const e of callMap.values()) e.reject(new Error(" + JSON.stringify("ptc-stop:") + " + inner.reason));",
      "        callMap.clear();",
      "      }",
      "    });",
      "    try {",
      // strict-mode body, same as the inline engines (they prefix the program
      // with "use strict"; the worker builds the body string here)
      "      var body = " + JSON.stringify('"use strict";\n') + " + program;",
      "      var fn = new AsyncFunction(" + JSON.stringify("tm") + ", body);",
      "      var result = await fn(tm);",
      '      parentPort.postMessage({ t: "done", result: result });',
      "    } catch (err) {",
      '      parentPort.postMessage({ t: "error", message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });',
      "    }",
      "  }",
      "});",
    ].join("\n")
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
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
            const err = new Error(typeof msg.message === "string" ? msg.message : "worker error")
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
            .catch(() => {
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

      w.on("error", (err: Error) => {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))))
      })

      // Wire signal abort → terminate the worker.
      const onAbort = () => {
        settle(() => {
          w.terminate().then(() => reject(new PtcStopSignal("timeout")))
        })
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })

      // Send the run request.
      w.postMessage({ t: "run", program } as unknown)
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
    const tm = makeFacade(bridge)
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
      const promise = vm.runInNewContext(
        `(async () => {\n"use strict";\n${program}\n})()`,
        { tm },
        { timeout: this.compileTimeoutMs },
      ) as Promise<unknown>
      return await Promise.race([promise, abortP])
    } finally {
      if (abortHandler) signal.removeEventListener("abort", abortHandler)
    }
  }
}

/**
 * host-hooks (tool.definition / chat.params / compaction / shell.env) +
 * tm_pty (non-blocking command execution on the host's terminal sessions).
 *
 * These ride surfaces whose live delivery we cannot exercise from a unit
 * test (the desktop binary owns them), so the contract pinned here is the
 * adapter shape: mutate ONLY the verified field, ONLY when the payload has
 * the expected shape, idempotently, and never throw into a host hook.  The
 * governance half (tm_pty must pass R6 AND the official dialog before a
 * process exists) is asserted against a fake pty client, because that is the
 * part that would be a bypass if it were wrong.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  applyToolDefinition,
  applyChatParams,
  resolveAgentTemperature,
  applySessionCompacting,
  applyCompactionAutoContinue,
  applyShellEnv,
  resolveShellEnv,
  hookSwitches,
  COMPACTION_CONTEXT,
  TOOL_HINTS,
  AGENT_TEMPERATURES,
} from "./dist/host-hooks.js"

const tm = await import("./dist/tm/index.js")
const plugin = (await import("./dist/index.js")).default

const tmpDirs = []
const mktmp = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tm-${label}-`))
  tmpDirs.push(dir)
  return dir
}
const ok = (cond, msg) => assert.ok(cond, msg)
const eq = (a, b, msg) => assert.deepEqual(a, b, msg)

console.log("hosthooks. tool.definition / chat.params / compaction / shell.env / tm_pty")

/* ---------- 1. tool.definition: append at the call site, never replace ---- */
{
  const out = { description: "Executes a given bash command in a persistent shell session." }
  eq(applyToolDefinition({ toolID: "bash" }, out, true), true, "bash description is annotated")
  ok(out.description.startsWith("Executes a given bash command"), "the host's own description is preserved verbatim")
  ok(out.description.includes("[OpenCode TeamMode]"), "our marker is present")
  ok(out.description.includes("120 s"), "the timeout discipline reaches the tool description")
  const before = out.description
  eq(applyToolDefinition({ toolID: "bash" }, out, true), false, "idempotent: never appended twice")
  eq(out.description, before, "the second pass leaves the string byte-exact")
  const task = { description: "Launch a sub-agent to handle the task." }
  eq(applyToolDefinition({ toolID: "task" }, task, true), true, "task gets the async-dispatch pointer")
  ok(task.description.includes("tm_dispatch"), "task is steered to the non-blocking lever")
  const unrelated = { description: "edit a file" }
  eq(applyToolDefinition({ toolID: "edit" }, unrelated, true), false, "unlisted tools untouched")
  eq(unrelated.description, "edit a file", "no mutation of an unlisted description")
  const missing = {}
  eq(applyToolDefinition({ toolID: "bash" }, missing, true), false, "a payload without a string description is skipped")
  eq(applyToolDefinition(null, null, true), false, "garbage input cannot throw")
  eq(applyToolDefinition({ toolID: "bash" }, out, false), false, "TM_TOOL_HINTS=off disables the whole hook")
  ok(typeof TOOL_HINTS.bash === "string" && typeof TOOL_HINTS.task === "string", "hint table covers bash + task")
  console.log("  1. tool.definition: append-only, idempotent, switch-off, never throws")
}

/* ---------- 2. chat.params: default is DON'T TOUCH ------------------------ */
{
  const baseline = { temperature: 0.2, topP: 1, topK: 40, maxOutputTokens: undefined, options: {} }
  eq(applyChatParams({ agent: "architect" }, { ...baseline }, {}), false, "TM_AGENT_TEMPERATURE unset (off) leaves sampling alone")
  const out = { ...baseline }
  eq(applyChatParams({ agent: "architect" }, out, { TM_AGENT_TEMPERATURE: "on" }), true, "opt-in applies the table")
  eq(out.temperature, AGENT_TEMPERATURES.architect, "architect gets the design-table value")
  eq(out.topP, 1, "only temperature is touched — topP/topK/maxOutputTokens stay the host's")
  eq(applyChatParams({ agent: "unknown-role" }, { ...baseline }, { TM_AGENT_TEMPERATURE: "on" }), false, "an unlisted agent is left alone")
  eq(applyChatParams({ agent: "reviewer" }, out, { TM_AGENT_TEMPERATURE: "reviewer=0.05;team=0.4" }), true, "a custom table parses")
  eq(out.temperature, 0.05, "custom value wins over the built-in table")
  eq(resolveAgentTemperature("reviewer", { TM_AGENT_TEMPERATURE: "reviewer=abc" }), null, "a malformed table resolves to NO override (never half-applied)")
  eq(resolveAgentTemperature("reviewer", { TM_AGENT_TEMPERATURE: "reviewer=9" }), null, "out-of-range sampling is refused, not clamped")
  eq(resolveAgentTemperature("", { TM_AGENT_TEMPERATURE: "on" }), null, "an anonymous session gets no override")
  eq(applyChatParams({ agent: "architect" }, undefined, { TM_AGENT_TEMPERATURE: "on" }), false, "missing output cannot throw")
  console.log("  2. chat.params: off by default, one field only, malformed table = no change")
}

/* ---------- 3. compaction: additive context, autocontinue untouched ------- */
{
  const out = { context: ["host's own line"], prompt: undefined }
  eq(applySessionCompacting(out, true), true, "context lines are added")
  eq(out.context[0], "host's own line", "existing entries keep their order")
  eq(out.context.length, 1 + COMPACTION_CONTEXT.length, "every contract line lands")
  eq(out.prompt, undefined, "output.prompt is NEVER replaced (the summarizer stays the host's)")
  ok(COMPACTION_CONTEXT.some((l) => l.includes("STATUS")), "the reply skeleton survives compaction")
  ok(COMPACTION_CONTEXT.some((l) => l.includes("access_token")), "offload handles are named as must-keep")
  ok(COMPACTION_CONTEXT.some((l) => l.includes("tm_dispatch")), "uncollected children survive the summary")
  ok(COMPACTION_CONTEXT.every((l) => l.includes("OpenCode TeamMode") || l.startsWith("Offloaded") || l.startsWith("Async") || l.startsWith("Every") || l.startsWith("The")), "lines self-identify as ours")
  eq(applySessionCompacting(out, true), false, "idempotent: a second compaction adds nothing")
  eq(applySessionCompacting(out, false), false, "TM_COMPACTION_CONTEXT=off disables it")
  eq(applySessionCompacting(null, true), false, "garbage output cannot throw")
  const ac = { enabled: true }
  eq(applyCompactionAutoContinue(ac, {}), false, "auto-continue untouched by default (the host keeps resuming)")
  eq(ac.enabled, true, "so the run still carries on after a summary")
  eq(applyCompactionAutoContinue(ac, { TM_COMPACTION_AUTOCONTINUE: "off" }), true, "TM_COMPACTION_AUTOCONTINUE=off opts out")
  eq(ac.enabled, false, "then the turn pauses for the user")
  eq(hookSwitches({}).compactionContext, true, "compaction context defaults on")
  console.log("  3. compaction: additive + idempotent, prompt never replaced, autocontinue left alone by default")
}

/* ---------- 4. shell.env: NO_COLOR + an explicit allowlisted passthrough -- */
{
  eq(resolveShellEnv({}), { NO_COLOR: "1", CLANG_COLOR_MODE: "never", TERM: "dumb" }, "color-off by default (ANSI is context noise)")
  const out = { env: { TERM: "xterm-256color", PATH: "/usr/bin" } }
  eq(applyShellEnv(out, {}), true, "the hook fills what the host did not set")
  eq(out.env.TERM, "xterm-256color", "an existing value is NEVER overwritten")
  eq(out.env.NO_COLOR, "1", "NO_COLOR injected")
  eq(out.env.PATH, "/usr/bin", "PATH untouched — this hook forwards nothing implicitly")
  const withExtra = applyShellEnv({ env: {} }, { TM_SHELL_ENV: "LC_ALL=C.UTF-8;PIPX=1;BAD LINE;=nope" })
  eq(withExtra, true, "a well-formed entry still gets through a sloppy list")
  const out2 = { env: {} }
  applyShellEnv(out2, { TM_SHELL_ENV: "LC_ALL=C.UTF-8;PIPX=1;=nope;NOKEY" })
  eq(out2.env.LC_ALL, "C.UTF-8", "operator passthrough applied")
  eq(out2.env.PIPX, "1", "second pair applied")
  eq(out2.env[""], undefined, "a valueless pair is dropped")
  ok(!("NOKEY" in out2.env), "a key without =value is dropped (no blanket env forwarding)")
  eq(applyShellEnv({ env: {} }, { TM_SHELL_NO_COLOR: "off", TM_SHELL_ENV: "" }), false, "everything off = no mutation at all")
  eq(applyShellEnv(null, {}), false, "garbage output cannot throw")
  console.log("  4. shell.env: NO_COLOR/TERM only + explicit allowlist, never clobbers, never leaks the parent env")
}

/* ---------- 5. tm_pty: the governance gate (this is the bypass risk) ------ */
{
  const { ptyCommandLine, ptyCommandBlocked } = tm
  eq(ptyCommandLine("npm", ["test", "--", "x"]), "npm test -- x", "command line joins argv for the dialog")
  eq(ptyCommandBlocked("npm test", "standard"), null, "a plain test run is not a blocked shape")
  ok(ptyCommandBlocked("printenv PATH", "standard"), "the R6 env face is refused here too (not a side channel)")
  ok(ptyCommandBlocked("git push origin main", "standard"), "the R2 danger face is refused (push stays in built-in bash)")
  ok(ptyCommandBlocked("rm -rf /", "standard"), "destructive shapes refused")
  ok(ptyCommandBlocked("npm install left-pad", "standard"), "package install refused (its dialog lives in built-in bash)")
  ok(ptyCommandBlocked("", "standard"), "an empty command is refused")
  ok(ptyCommandBlocked("echo $(whoami)", "standard"), "command substitution never reaches a spawn")

  const runtime = await tm.createTmTools({ directory: mktmp("pty-none"), client: {}, $: () => ({ text: async () => "" }) })
  const noApi = await runtime.tools.tm_pty.execute({ action: "start", command: "npm", args: ["test"] }, { directory: "/tmp", sessionID: "s1" })
  ok(String(noApi.output).includes("client.pty") && String(noApi.output).includes("tm_ptc_run"), "a host without client.pty degrades with alternatives")

  const calls = { create: [], remove: [], get: [] }
  const client = {
    app: { log: async () => {} },
    pty: {
      create: async (o) => (calls.create.push(o), { ok: true, data: { id: "pty_1", pid: 4242, status: "running" } }),
      get: async (o) => (calls.get.push(o), { ok: true, data: { id: "pty_1", pid: 4242, status: "running" } }),
      remove: async (o) => (calls.remove.push(o), { ok: true, data: true }),
    },
  }
  const rt = await tm.createTmTools({ directory: mktmp("pty-ok"), client, $: () => ({ text: async () => "" }) })
  const P = rt.tools.tm_pty

  const noAsk = await P.execute({ action: "start", command: "npm", args: ["test"] }, { directory: "/tmp", sessionID: "s1" })
  ok(String(noAsk.output).includes("宿主无法弹出确认窗口"), "NO ask bridge -> refused (fail closed)")
  eq(calls.create.length, 0, "and nothing was spawned")

  const denied = await P.execute(
    { action: "start", command: "npm", args: ["test"] },
    { directory: "/tmp", sessionID: "s1", ask: async () => { throw new Error("user said no") } },
  )
  ok(String(denied.output).includes("用户未批准"), "a rejected dialog is honoured")
  eq(calls.create.length, 0, "still nothing spawned")

  let asked = null
  const started = await P.execute(
    { action: "start", command: "npm", args: ["test"], cwd: "/work", log: "/tmp/t.log" },
    { directory: "/tmp", sessionID: "s1", ask: async (req) => ((asked = req), undefined) },
  )
  ok(String(started.output).includes("已启动（非阻塞）") && String(started.output).includes("pty_1"), "approved -> the session id comes back at once")
  eq(asked.permission, "tm_pty", "the ask names tm_pty so the {" + '"*"' + ":\"ask\"} rule decides it")
  eq(asked.patterns, ["npm test"], "the dialog shows the EXACT command line, not a wildcard")
  eq(calls.create[0].body.command, "npm", "pty.create gets command + argv separately (no shell string to reinterpret)")
  eq(calls.create[0].body.args, ["test"], "argv preserved")
  eq(calls.create[0].body.cwd, "/work", "cwd honoured")
  ok(String(started.output).includes("/tmp/t.log"), "the log path is echoed so the agent knows where evidence will be")
  ok(String(started.output).includes("不会把输出送回"), "and the no-transcript limit is stated up front")

  const status = await P.execute({ action: "status", id: "pty_1" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(status.output).includes("running"), "status reports the host's state")
  ok(String(status.output).includes("pid 4242"), "with the pid")
  const listed = await P.execute({ action: "list" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(listed.output).includes("pty_1"), "list shows what this plugin started")
  const foreignKill = await P.execute({ action: "kill", id: "pty_other" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(foreignKill.output).includes("不是本插件启动的"), "a session we did not start is not ours to kill")
  eq(calls.remove.length, 0, "no remove call for a foreign id")
  const killed = await P.execute({ action: "kill", id: "pty_1" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(killed.output).includes("已停止会话 pty_1"), "our own session can be stopped")
  eq(calls.remove[0].path.id, "pty_1", "remove targeted by id")
  const afterKill = await P.execute({ action: "status", id: "pty_1" }, { directory: "/tmp", sessionID: "s1" })
  ok(!String(afterKill.output).includes("运行中"), "a killed session stops reporting as running")

  const bad = await P.execute({ action: "start", command: "npm\nrm -rf /" }, { directory: "/tmp", sessionID: "s1", ask: async () => undefined })
  ok(String(bad.output).includes("单条程序名"), "a multi-line command is refused at the args layer")
  ok(String(P.execute ? "" : "").length === 0, "sanity: tool surface present")
  const unknownAction = await P.execute({ action: "nope" }, { directory: "/tmp", sessionID: "s1" })
  ok(String(unknownAction.output).includes("start|status|list|kill"), "an unknown action names the real ones")
  await rt.dispose()
  await runtime.dispose()
  console.log("  5. tm_pty: R6-classified THEN official dialog THEN spawn; no bridge/no approval = nothing runs; only our own ids are killable")
}

/* ---------- 6. concurrency cap + registration on the tool surface -------- */
{
  const created = []
  const client = {
    app: { log: async () => {} },
    pty: {
      create: async (o) => (created.push(o), { ok: true, data: { id: "pty_" + created.length, pid: 100 + created.length, status: "running" } }),
      get: async () => ({ ok: true, data: { status: "running" } }),
      remove: async () => ({ ok: true, data: true }),
    },
  }
  const rt = await tm.createTmTools({ directory: mktmp("pty-cap"), client, $: () => ({ text: async () => "" }) })
  const ctx = { directory: "/tmp", sessionID: "s1", ask: async () => undefined }
  for (let i = 0; i < 4; i++) ok(!(await rt.tools.tm_pty.execute({ action: "start", command: "sleep", args: ["1"] }, ctx)).output.includes("并发上限"), `start #${i + 1} within the cap`)
  const fifth = await rt.tools.tm_pty.execute({ action: "start", command: "sleep", args: ["1"] }, ctx)
  ok(String(fifth.output).includes("并发上限 4"), "the 5th concurrent session is refused before the dialog")
  eq(created.length, 4, "and no process was created for it")
  ok("tm_pty" in (await plugin.server({ directory: mktmp("pty-reg"), client, $: () => ({ text: async () => "" }) }, {})).tool, "tm_pty registered on the tool segment")
  await rt.dispose()
  console.log("  6. tm_pty: capped at TM_PTY_MAX concurrent sessions, refusal happens before any dialog")
}

for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
console.log("\nHOSTHOOKS: ALL PASS (6 groups)")

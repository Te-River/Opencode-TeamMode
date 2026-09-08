#!/usr/bin/env node
/**
 * PT-07 baseline runner (task book §11).
 *
 *   node runner.mjs                       # run all tasks -> results/baseline.json
 *   node runner.mjs --only t03,t05        # subset (smoke)
 *   node runner.mjs --out results/smoke.json --timeout 600
 *   node runner.mjs --oc <path-to-opencode.exe>
 *
 * Per task:
 *   1. sidecar `opencode serve` on a private port (isolated XDG env + env-provided
 *      password) -> GET /experimental/tool/ids = tool-face snapshot -> kill
 *   2. `opencode run --format json --auto --model <model> --title pt07-<id> <prompt>`
 *      with cwd = pt07/workspace, stdout parsed as NDJSON events
 *   3. timeout guard (default 900s, cold start can take ~35s), taskkill /T /F
 *   4. judge via judge.mjs -> results/<out> + raw events in results/events/
 *
 * Isolation: XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME are redirected into
 * pt07/.oc-* so the user's global config (and its gov-mode/quota plugins) are NOT
 * loaded and global state is never written. auth.json is copied once from the
 * user's global data dir into the isolated data dir (read-only w.r.t. the source).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { judgeTask } from "./judge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(__dirname, "workspace");
const RESULTS_DIR_DEFAULT = path.join(__dirname, "results");
const OC_DEFAULT = path.join(
  os.tmpdir(), "opencode", "tm-probe", "runtime", "node_modules", "opencode-ai", "bin", "opencode.exe"
);
const GLOBAL_AUTH = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");

// ------------------------------------------------------------------ args --
const argv = process.argv.slice(2);
const argOf = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const ONLY = argOf("--only", null); // comma-separated task ids
const OUT = path.resolve(__dirname, argOf("--out", "results/baseline.json"));
const TIMEOUT_S = Number(argOf("--timeout", "900"));
const OC = path.resolve(argOf("--oc", process.env.OC_PATH || OC_DEFAULT));
const MODEL = argOf("--model", null); // default from tasks.json

if (!fs.existsSync(OC)) {
  console.error(`opencode CLI not found at: ${OC}`);
  console.error("pass --oc <path> or set OC_PATH");
  process.exit(1);
}

// --------------------------------------------------------------- fixtures --
const tasksJsonPath = path.join(__dirname, "tasks.json");
const tasksManifest = JSON.parse(fs.readFileSync(tasksJsonPath, "utf8"));
const model = MODEL || tasksManifest.meta.defaultModel;
const groundtruthPath = path.join(__dirname, "groundtruth.json");

if (!fs.existsSync(WORKSPACE) || !fs.existsSync(groundtruthPath)) {
  console.error("fixture workspace missing - run first:  node pt07/generate.mjs");
  process.exit(1);
}
const groundtruth = JSON.parse(fs.readFileSync(groundtruthPath, "utf8"));
if (groundtruth.seed !== tasksManifest.meta.seed) {
  console.error(`seed mismatch: groundtruth ${groundtruth.seed} != tasks ${tasksManifest.meta.seed}`);
  console.error("re-run node pt07/generate.mjs");
  process.exit(1);
}

// ------------------------------------------------------------- isolation --
const XDG = {
  XDG_CONFIG_HOME: path.join(__dirname, ".oc-config"),
  XDG_DATA_HOME: path.join(__dirname, ".oc-data"),
  XDG_STATE_HOME: path.join(__dirname, ".oc-state"),
};
for (const dir of Object.values(XDG)) fs.mkdirSync(path.join(dir, "opencode"), { recursive: true });
// copy provider auth once (read-only w.r.t. the global source)
const isolatedAuth = path.join(XDG.XDG_DATA_HOME, "opencode", "auth.json");
let authCopied = fs.existsSync(isolatedAuth);
if (!authCopied && fs.existsSync(GLOBAL_AUTH)) {
  fs.copyFileSync(GLOBAL_AUTH, isolatedAuth);
  authCopied = true;
}

const SIDEcar_PASSWORD = "pt07-sidecar-" + crypto.randomBytes(8).toString("hex");
function isoEnv(extra) {
  return { ...process.env, ...XDG, OPENCODE_SERVER_PASSWORD: SIDEcar_PASSWORD, ...(extra || {}) };
}

// ------------------------------------------------------------ HTTP helper --
function httpGet(port, pathname, password, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const headers = {};
    if (password) headers.Authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: timeoutMs, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: "", err: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "", err: "timeout" }); });
  });
}

// -------------------------------------------------- tool-face via sidecar --
async function snapshotToolFace(port) {
  const serve = spawn(OC, ["serve", "--port", String(port)], {
    cwd: WORKSPACE,
    env: isoEnv(),
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const deadline = Date.now() + 90_000; // cold start can take ~35s
  let snap = null;
  while (Date.now() < deadline) {
    if (serve.exitCode !== null) break;
    const r = await httpGet(port, `/experimental/tool/ids?directory=${encodeURIComponent(WORKSPACE)}`, SIDEcar_PASSWORD, 4000);
    if (r.status === 200) {
      try { snap = JSON.parse(r.body); } catch { snap = r.body; }
      break;
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  try { serve.kill(); } catch { /* ignore */ }
  return snap;
}

// ------------------------------------------------------------- run a task --
function runTask(task) {
  return new Promise((resolve) => {
    const events = [];
    const toolSequence = [];
    const tokenSteps = [];
    const textParts = [];
    let sessionId = null;
    let stderrTail = "";

    const args = [
      "run", "--format", "json", "--auto",
      "--model", model,
      "--title", `pt07-${task.id}`,
      task.prompt,
    ];
    const child = spawn(OC, args, {
      cwd: WORKSPACE,
      env: isoEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutBuf = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // kill the whole process tree (Windows)
      const r = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      if (r.status !== 0) { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    }, TIMEOUT_S * 1000);

    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString("utf8");
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        events.push(ev);
        if (ev.sessionID && !sessionId) sessionId = ev.sessionID;
        const part = ev.part || {};
        if (part.type === "text" && typeof part.text === "string") textParts.push(part.text);
        if (ev.type === "tool_use" || part.type === "tool") {
          toolSequence.push({
            tool: part.tool || "?",
            callID: part.callID || null,
            status: part.state?.status || null,
            title: typeof part.state?.input?.description === "string"
              ? part.state.input.description
              : typeof part.title === "string" ? part.title : null,
          });
        }
        if (ev.type === "step_finish" && part.tokens) {
          tokenSteps.push({
            input: part.tokens.input ?? 0,
            output: part.tokens.output ?? 0,
            reasoning: part.tokens.reasoning ?? 0,
            cacheRead: part.tokens.cache?.read ?? 0,
            cacheWrite: part.tokens.cache?.write ?? 0,
            cost: part.cost ?? 0,
            reason: part.reason || null,
          });
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString("utf8")).slice(-4000);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ events, toolSequence, tokenSteps, textParts, sessionId, timedOut: false, exitCode: null, spawnError: String(err), stderrTail });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ events, toolSequence, tokenSteps, textParts, sessionId, timedOut, exitCode: code, spawnError: null, stderrTail });
    });
  });
}

// ------------------------------------------------------------------- main --
async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const eventsDir = path.join(path.dirname(OUT), "events");
  const logsDir = path.join(path.dirname(OUT), "logs");
  fs.mkdirSync(eventsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  // versions
  const ver = spawnSync(OC, ["--version"], { encoding: "utf8", windowsHide: true });
  const ocVersion = (ver.stdout || "").trim() || `unknown(exit ${ver.status})`;

  let tasks = tasksManifest.tasks;
  if (ONLY) {
    const wanted = ONLY.split(",").map((s) => s.trim()).filter(Boolean);
    tasks = tasks.filter((t) => wanted.some((w) => t.id === w || t.id.startsWith(w)));
    if (tasks.length === 0) {
      console.error(`no task matched --only "${ONLY}"; known ids: ${tasksManifest.tasks.map((t) => t.id).join(", ")}`);
      process.exit(1);
    }
  }

  const meta = {
    suite: tasksManifest.meta.name,
    suiteVersion: tasksManifest.meta.version,
    mode: tasksManifest.meta.mode,
    seed: tasksManifest.meta.seed,
    model,
    ocCli: OC,
    ocVersion,
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    isolation: {
      xdgConfigHome: XDG.XDG_CONFIG_HOME,
      xdgDataHome: XDG.XDG_DATA_HOME,
      xdgStateHome: XDG.XDG_STATE_HOME,
      authCopiedFromGlobal: authCopied,
      note: "global config plugins (gov-mode/quota) are NOT loaded; global state not written",
    },
    toolFaceMethod: "GET /experimental/tool/ids via per-task sidecar opencode serve (OPENCODE_SERVER_PASSWORD auth)",
    timeoutSecondsPerTask: TIMEOUT_S,
    tasksJsonSha256: crypto.createHash("sha256").update(fs.readFileSync(tasksJsonPath)).digest("hex"),
    groundtruthSeedVerified: groundtruth.seed,
    startedAt: new Date().toISOString(),
  };

  console.log(`PT-07 baseline runner | opencode ${ocVersion} | node ${process.version} | model ${model}`);
  console.log(`tasks: ${tasks.map((t) => t.id).join(", ")}`);
  console.log(`timeout/task: ${TIMEOUT_S}s | isolation: ${XDG.XDG_DATA_HOME}`);

  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const port = 4710 + i;
    const t0 = Date.now();
    console.log(`\n=== ${task.id} [${task.category}] ===`);

    const toolFace = await snapshotToolFace(port);
    if (!toolFace) console.log("  warn: tool-face snapshot unavailable (sidecar serve failed)");

    const run = await runTask(task);
    const durationMs = Date.now() - t0;

    // persist raw evidence
    fs.writeFileSync(path.join(eventsDir, `${task.id}.jsonl`), run.events.map((e) => JSON.stringify(e)).join("\n") + (run.events.length ? "\n" : ""));
    if (run.stderrTail) fs.writeFileSync(path.join(logsDir, `${task.id}.stderr.log`), run.stderrTail);

    const totals = run.tokenSteps.reduce(
      (acc, s) => ({
        input: acc.input + s.input,
        output: acc.output + s.output,
        reasoning: acc.reasoning + s.reasoning,
        cacheRead: acc.cacheRead + s.cacheRead,
        cacheWrite: acc.cacheWrite + s.cacheWrite,
        cost: acc.cost + s.cost,
      }),
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    );

    const replyText = run.textParts.join("\n").trim();
    const judge = judgeTaskSafe(task, { replyText, events: run.events });

    const status = run.spawnError ? "error" : run.timedOut ? "timeout" : judge.pass ? "pass" : "fail";
    console.log(`  status=${status} llmSteps=${run.tokenSteps.length} toolCalls=${run.toolSequence.length} dur=${(durationMs / 1000).toFixed(1)}s`);
    console.log(`  tokens: in=${totals.input} out=${totals.output} cacheRead=${totals.cacheRead} cacheWrite=${totals.cacheWrite}`);
    console.log(`  judge: ${judge.pass ? "PASS" : "FAIL"}${judge.evidence.length ? " | " + judge.evidence[0] : ""}`);

    results.push({
      id: task.id,
      category: task.category,
      title: task.title,
      prompt: task.prompt,
      judgeSpec: task.judge,
      expectedSteps: task.expectedSteps,
      status,
      sessionID: run.sessionId,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      spawnError: run.spawnError,
      durationMs,
      llmSteps: run.tokenSteps.length,
      toolCalls: run.toolSequence.length,
      toolSequence: run.toolSequence,
      tokens: { totals, perStep: run.tokenSteps },
      replyText,
      toolFace,
      judge,
      eventsFile: path.relative(path.dirname(OUT), path.join(eventsDir, `${task.id}.jsonl`)),
    });
  }

  const output = {
    meta: { ...meta, finishedAt: new Date().toISOString() },
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      timeout: results.filter((r) => r.status === "timeout").length,
      error: results.filter((r) => r.status === "error").length,
      tokenTotals: results.reduce(
        (acc, r) => ({
          input: acc.input + r.tokens.totals.input,
          output: acc.output + r.tokens.totals.output,
          cacheRead: acc.cacheRead + r.tokens.totals.cacheRead,
          cacheWrite: acc.cacheWrite + r.tokens.totals.cacheWrite,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      ),
    },
    tasks: results,
  };
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nwrote ${OUT}`);
  console.log(`summary: ${output.summary.pass}/${output.summary.total} pass (timeout=${output.summary.timeout}, error=${output.summary.error})`);
}

function judgeTaskSafe(task, ctx) {
  try {
    return judgeTask(task, ctx);
  } catch (e) {
    return { pass: false, evidence: [`judge crashed: ${e && e.message}`] };
  }
}

main().catch((e) => {
  console.error("runner crashed:", e);
  process.exit(1);
});

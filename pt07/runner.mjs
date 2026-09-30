#!/usr/bin/env node
/**
 * PT-07 baseline runner (task book §11).
 *
 *   node runner.mjs --help                # flags + exit codes (spawns NOTHING)
 *   node runner.mjs                       # reset fixture, run all tasks -> results/baseline.json
 *   node runner.mjs --only t03,t05        # subset (smoke)
 *   node runner.mjs --out results/smoke.json --timeout 600
 *   node runner.mjs --oc <path-to-opencode.exe> --model <provider/model>
 *
 * Per task:
 *   0. the fixture is RESET with generate.mjs before ANY task runs (see "fixture"),
 *      and the workspace fingerprint is recorded per task so judge.mjs can tell
 *      later whether a re-judge still has its premise
 *   1. sidecar `opencode serve` on a private port (isolated XDG env + env-provided
 *      password) -> GET <toolface endpoint> = tool-face snapshot -> kill.
 *      An unreachable tool-face ABORTS the run before the first model call unless
 *      the operator passed --no-toolface / --allow-no-toolface: toolFace is a core
 *      measurement item and a silent null would make the A/B incomparable.
 *   2. `opencode run --format json --auto --model <model> --title pt07-<id> <prompt>`
 *      with cwd = pt07/workspace, stdout parsed as NDJSON events
 *   3. timeout guard (default 900s, cold start can take ~35s), taskkill /T /F
 *   4. judge via judge.mjs -> results/<out> + raw events in results/events/
 *
 * Isolation: XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME are redirected into
 * pt07/.oc-* so the user's global config (and its gov-mode/quota plugins) are NOT
 * loaded and global state is never written. auth.json is copied from the user's
 * global data dir into the isolated data dir and REFRESHED whenever the source's
 * size or mtime moved on (metadata only - this runner never reads the file's
 * contents).
 *
 * The tool-face endpoint `/experimental/tool/ids` is an opencode 1.18.x route. It
 * is GONE on 2.x (binary scan of 2.0.20, 197.3 MB: 0 hits; /api/session: 111), so
 * on a 2.x host the probe fails loudly and the run refuses to spend tokens until
 * the operator says otherwise. `--toolface-endpoint` exists so a verified 2.x
 * route can be substituted without editing this file.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { judgeTask, JudgeSpecError, FixtureDriftError, fixtureFingerprint, sha256Of } from "./judge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(__dirname, "workspace");
const GENERATE = path.join(__dirname, "generate.mjs");
const RESULTS_DIR_DEFAULT = path.join(__dirname, "results");
const OC_DEFAULT = path.join(
  os.tmpdir(), "opencode", "tm-probe", "runtime", "node_modules", "opencode-ai", "bin", "opencode.exe"
);
const GLOBAL_AUTH = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
const TOOLFACE_ENDPOINT_DEFAULT = "/experimental/tool/ids";

// ------------------------------------------------------------------ args --
const RUNNER_FLAGS = {
  "--only": "value",
  "--out": "value",
  "--timeout": "value",
  "--model": "value",
  "--oc": "value",
  "--toolface-endpoint": "value",
  "--toolface-deadline": "value",
  "--no-reset": "bool",
  "--no-toolface": "bool",
  "--allow-no-toolface": "bool",
  "--allow-dirty-fixture": "bool",
  "--force": "bool",
  "--help": "bool",
};

const USAGE = `usage: node runner.mjs [flags]

flags:
  --only <ids>              comma-separated task ids (default: all 8)
  --out <p>                 results file (default results/baseline.json; refuses to
                            overwrite an existing file unless --force)
  --timeout <s>             per-task wall-clock limit (default 900, cold start ~35s incl.)
  --model <p/m>             provider/model. Default comes from tasks.json meta.defaultModel,
                            NOT from this file - the stored baseline used zai/glm-5.3-flash,
                            so an A/B retest must pass --model explicitly to match it.
  --oc <path>               opencode executable (default the isolated 1.18.29 CLI in %TEMP%,
                            or $OC_PATH; on this machine the 2.x desktop CLI lives at
                            %LOCALAPPDATA%\\Programs\\@opencode-aidesktop\\resources\\opencode-cli.exe)
  --toolface-endpoint <p>   tool-face HTTP path (default ${TOOLFACE_ENDPOINT_DEFAULT}, 1.18.x only)
  --toolface-deadline <s>   how long to wait for the sidecar to answer (default 90)
  --no-reset                do NOT rebuild the fixture first (refuses if residue of a
                            previous run is detected)
  --allow-dirty-fixture     with --no-reset: accept a workspace that still holds a previous
                            run's answers/edits (steps and tokens will be polluted)
  --no-toolface             skip the tool-face sidecar entirely (recorded as status=skipped)
  --allow-no-toolface       attempt the sidecar but continue even when it is unreachable
                            (recorded per task as toolFaceUnavailable)
  --force                   allow --out to overwrite an existing results file
  --help                    this text (exit 0, spawns nothing)

exit codes:
  0 finished  ·  2 bad flags / fixture or CLI missing / judge harness error
  4 tool-face could not be captured and was not waived`;

function argError(msg) {
  console.error(`runner.mjs: ${msg}\n`);
  console.error(USAGE);
  process.exit(2);
}

/** Unknown flags, missing values and stray positionals all die here (exit 2). */
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("-")) argError(`unexpected positional argument: ${tok}`);
    const kind = RUNNER_FLAGS[tok];
    if (!kind) argError(`unknown flag: ${tok} (known: ${Object.keys(RUNNER_FLAGS).join(", ")})`);
    if (kind === "bool") {
      flags[tok] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("-")) argError(`${tok} needs a value`);
    flags[tok] = val;
    i++;
  }
  return flags;
}

const F = parseArgs(process.argv.slice(2));
// --help is answered before ANY probe, spawn or fs write (C6): a mistyped flag on a
// machine that does have a CLI used to fall through and start all 8 paid tasks.
if (F["--help"]) {
  console.log(USAGE);
  process.exit(0);
}

const ONLY = F["--only"] ?? null;
const OUT = path.resolve(__dirname, F["--out"] ?? path.join("results", "baseline.json"));
const TIMEOUT_S = Number(F["--timeout"] ?? "900");
if (!Number.isFinite(TIMEOUT_S) || TIMEOUT_S <= 0) argError(`--timeout must be a positive number of seconds (got ${JSON.stringify(F["--timeout"])})`);
const OC = path.resolve(F["--oc"] ?? process.env.OC_PATH ?? OC_DEFAULT);
const MODEL = F["--model"] ?? null;
const TOOLFACE_ENDPOINT = F["--toolface-endpoint"] ?? TOOLFACE_ENDPOINT_DEFAULT;
const TOOLFACE_DEADLINE_S = Number(F["--toolface-deadline"] ?? "90");
if (!Number.isFinite(TOOLFACE_DEADLINE_S) || TOOLFACE_DEADLINE_S <= 0) argError(`--toolface-deadline must be a positive number of seconds`);
const NO_TOOLFACE = Boolean(F["--no-toolface"]);
const ALLOW_NO_TOOLFACE = Boolean(F["--allow-no-toolface"]) || NO_TOOLFACE;

if (fs.existsSync(OUT) && !F["--force"]) {
  argError(
    `--out ${OUT} already exists. A stored result set is evidence; re-running over it is a decision, ` +
      "not a default. Pass --force to overwrite, or --out results/<new-name>.json."
  );
}

if (!fs.existsSync(OC)) {
  console.error(`opencode CLI not found at: ${OC}`);
  console.error("pass --oc <path> or set OC_PATH");
  console.error("note: the isolated 1.18.29 CLI under %TEMP%\\opencode\\tm-probe\\runtime is gone on hosts that");
  console.error("run the 2.x desktop app; its CLI is %LOCALAPPDATA%\\Programs\\@opencode-aidesktop\\resources\\opencode-cli.exe");
  process.exit(2);
}
if (!fs.existsSync(GENERATE)) argError(`generator not found at ${GENERATE} - the fixture cannot be reset`);

// --------------------------------------------------------------- fixtures --
const tasksJsonPath = path.join(__dirname, "tasks.json");
const tasksManifest = JSON.parse(fs.readFileSync(tasksJsonPath, "utf8"));
const model = MODEL || tasksManifest.meta.defaultModel;
const modelSource = MODEL ? "--model flag" : "tasks.json meta.defaultModel";
const groundtruthPath = path.join(__dirname, "groundtruth.json");

/**
 * Artifacts a previous run left behind. t03/t04/t07 write answers/, t05 adds
 * applyBulkDiscount to src/pricing.js, t06 renames normalizeRegionCode ->
 * canonicalRegion. Any of these means the next run starts from a partly solved
 * fixture, which pollutes exactly the numbers the A/B is about (steps, tokens).
 */
function detectFixtureResidue() {
  const found = [];
  if (!fs.existsSync(WORKSPACE)) return ["workspace/ does not exist"];
  const ansDir = path.join(WORKSPACE, "answers");
  if (fs.existsSync(ansDir)) {
    for (const f of fs.readdirSync(ansDir)) found.push(path.posix.join("answers", f));
  }
  const srcDir = path.join(WORKSPACE, "src");
  let normalizeHits = 0;
  let canonicalHits = 0;
  let bulkHit = false;
  const stack = [srcDir];
  while (stack.length) {
    const dir = stack.pop();
    if (!fs.existsSync(dir)) break;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name.endsWith(".js")) {
        const text = fs.readFileSync(p, "utf8");
        normalizeHits += (text.match(/normalizeRegionCode/g) || []).length;
        if (text.includes("canonicalRegion")) canonicalHits++;
        if (ent.name === "pricing.js" && text.includes("applyBulkDiscount")) bulkHit = true;
      }
    }
  }
  if (bulkHit) found.push("src/pricing.js: applyBulkDiscount already present");
  if (canonicalHits > 0 || normalizeHits === 0)
    found.push(`src/: t06 rename already applied (canonicalRegion in ${canonicalHits} file(s), normalizeRegionCode x${normalizeHits})`);
  return found;
}

function resetFixture(seed) {
  const r = spawnSync(process.execPath, [GENERATE, "--seed", String(seed)], {
    cwd: __dirname,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
  });
  const tail = `${(r.stdout || "").trim()}\n${(r.stderr || "").trim()}`.trim();
  if (r.error || r.status !== 0) {
    console.error("fixture reset FAILED - refusing to run against an unknown workspace state:");
    console.error(`  node ${path.relative(process.cwd(), GENERATE)} --seed ${seed} -> exit ${r.status}${r.error ? ` (${r.error.message})` : ""}`);
    if (tail) console.error(tail.split("\n").map((l) => "  | " + l).join("\n"));
    process.exit(2);
  }
  return tail.split("\n").filter(Boolean);
}

const residue = detectFixtureResidue();
if (F["--no-reset"]) {
  if (!fs.existsSync(WORKSPACE) || !fs.existsSync(groundtruthPath)) {
    console.error("fixture workspace missing - run first:  node pt07/generate.mjs  (or drop --no-reset)");
    process.exit(2);
  }
  if (residue.length && !F["--allow-dirty-fixture"]) {
    console.error("--no-reset on a workspace that still holds a previous run's output:");
    for (const r of residue) console.error(`  - ${r}`);
    console.error("A/B steps/tokens taken from an already-solved fixture are not measurements.");
    console.error("drop --no-reset to rebuild the fixture, or pass --allow-dirty-fixture to say you mean it.");
    process.exit(2);
  }
  console.log(`fixture: NOT reset (--no-reset)${residue.length ? " — residue accepted by --allow-dirty-fixture" : ""}`);
} else {
  if (residue.length) {
    console.log(`fixture: residue of a previous run detected, resetting`);
    for (const r of residue) console.log(`  - ${r}`);
  }
  console.log(`fixture: rebuilding with generate.mjs (seed ${tasksManifest.meta.seed}) ...`);
  for (const line of resetFixture(tasksManifest.meta.seed)) console.log("  | " + line);
}

if (!fs.existsSync(groundtruthPath)) {
  console.error(`groundtruth.json missing after reset - ${groundtruthPath}`);
  process.exit(2);
}
const groundtruth = JSON.parse(fs.readFileSync(groundtruthPath, "utf8"));
if (groundtruth.seed !== tasksManifest.meta.seed) {
  console.error(`seed mismatch: groundtruth ${groundtruth.seed} != tasks ${tasksManifest.meta.seed}`);
  console.error("re-run node pt07/generate.mjs");
  process.exit(2);
}
const fixtureClean = fixtureFingerprint();
const groundtruthSha256 = sha256Of(groundtruthPath);
console.log(`fixture: ${fixtureClean.files} files / ${fixtureClean.bytes} B / ${fixtureClean.digest.slice(0, 16)}…`);

// ------------------------------------------------------------- isolation --
const XDG = {
  XDG_CONFIG_HOME: path.join(__dirname, ".oc-config"),
  XDG_DATA_HOME: path.join(__dirname, ".oc-data"),
  XDG_STATE_HOME: path.join(__dirname, ".oc-state"),
};
for (const dir of Object.values(XDG)) fs.mkdirSync(path.join(dir, "opencode"), { recursive: true });

/**
 * Keep the isolated provider-credentials copy in step with the global source.
 * existsSync alone meant the copy was made once and NEVER refreshed, so a rotated
 * token silently left the runner authenticating with a stale credential.
 * Only stat metadata is compared and copied - the file's contents are never read,
 * printed or hashed by this runner.
 */
function syncAuthCopy() {
  const isolated = path.join(XDG.XDG_DATA_HOME, "opencode", "auth.json");
  const d = { isolated, source: GLOBAL_AUTH, action: "none", reason: null, sourceMeta: null, copyMeta: null };
  const meta = (p) => {
    const s = fs.statSync(p);
    return { size: s.size, mtimeMs: Math.round(s.mtimeMs) };
  };
  if (!fs.existsSync(GLOBAL_AUTH)) {
    d.action = "absent";
    d.reason = "no global auth.json at the source path - provider auth will not work in the isolated env";
    return d;
  }
  d.sourceMeta = meta(GLOBAL_AUTH);
  const hasCopy = fs.existsSync(isolated);
  if (hasCopy) {
    d.copyMeta = meta(isolated);
    const sizeDiffers = d.copyMeta.size !== d.sourceMeta.size;
    const sourceNewer = d.sourceMeta.mtimeMs > d.copyMeta.mtimeMs;
    if (!sizeDiffers && !sourceNewer) {
      d.action = "reused";
      d.reason = `size ${d.copyMeta.size} B and mtime still match the source`;
      return d;
    }
    const why = [];
    if (sizeDiffers) why.push(`size ${d.copyMeta.size} -> ${d.sourceMeta.size} B`);
    if (sourceNewer)
      why.push(`source newer ${new Date(d.copyMeta.mtimeMs).toISOString()} -> ${new Date(d.sourceMeta.mtimeMs).toISOString()}`);
    d.reason = why.join(", ");
  } else {
    d.reason = "no copy yet";
  }
  fs.copyFileSync(GLOBAL_AUTH, isolated);
  d.action = "copied";
  d.copyMeta = meta(isolated);
  return d;
}

const authSync = syncAuthCopy();
const authCopied = authSync.action !== "absent";
console.log(`auth copy: ${authSync.action}${authSync.reason ? ` (${authSync.reason})` : ""}`);

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
/**
 * Turn an endpoint body into a list of tool names, or say why it is not one.
 *
 * Shape validation is the point: measured live on the 2.0.20 desktop CLI,
 * GET /experimental/tool/ids answers **HTTP 200 with the SPA's index.html** (a
 * catch-all route), so "status 200" alone would record a wall of HTML as the
 * task's tool face - a worse failure than the silent null C4 was filed for.
 */
function normalizeToolFace(raw) {
  if (typeof raw === "string") {
    if (/^\s*<(!doctype|html)/i.test(raw))
      return { ok: false, reason: "endpoint answered HTTP 200 with an HTML document (a 2.x SPA catch-all route), not a tool list" };
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, reason: `endpoint answered a non-JSON body: ${raw.slice(0, 80)}` };
    }
  }
  if (Array.isArray(raw)) {
    const names = raw.filter((x) => typeof x === "string");
    if (names.length && names.length === raw.length) return { ok: true, names };
    const objs = raw.map((x) => (x && typeof x === "object" ? x.id ?? x.name : null));
    if (objs.length && objs.every((n) => typeof n === "string")) return { ok: true, names: objs };
    return { ok: false, reason: `array of ${raw.length} entr(ies) is not a list of tool names` };
  }
  if (raw && typeof raw === "object") {
    for (const k of ["tools", "ids", "toolIds", "result", "data"]) {
      if (Array.isArray(raw[k])) {
        const sub = normalizeToolFace(raw[k]);
        if (sub.ok) return sub;
      }
    }
    return { ok: false, reason: `object payload with keys [${Object.keys(raw).slice(0, 8).join(", ")}] carries no tool-name array` };
  }
  return { ok: false, reason: `payload of type ${typeof raw} is not a tool list` };
}

/**
 * Capture the tool face the host offers the workspace. Never returns a bare null:
 * every non-success carries a status and a reason, because toolFace is a core
 * measurement item and a silent null is how a whole A/B became meaningless.
 * @returns {Promise<{toolFace: string[]|null, status: "ok"|"unavailable"|"skipped", reason: string|null, httpStatus: number|null, endpoint: string}>}
 */
async function snapshotToolFace(port, endpoint) {
  const out = { toolFace: null, status: "unavailable", reason: null, httpStatus: null, endpoint };
  const qs = `directory=${encodeURIComponent(WORKSPACE)}`;
  const pathWithQuery = endpoint.includes("?") ? `${endpoint}&${qs}` : `${endpoint}?${qs}`;
  const serve = spawn(OC, ["serve", "--port", String(port)], {
    cwd: WORKSPACE,
    env: isoEnv(),
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  let serveExit = null;
  let spawnError = null;
  serve.on("close", (c) => {
    serveExit = c;
  });
  serve.on("error", (e) => {
    spawnError = e.message;
  });
  const deadline = Date.now() + TOOLFACE_DEADLINE_S * 1000; // cold start can take ~35s
  let attempts = 0;
  while (Date.now() < deadline) {
    if (spawnError) break;
    const r = await httpGet(port, pathWithQuery, SIDEcar_PASSWORD, 4000);
    attempts++;
    out.httpStatus = r.status;
    if (r.status === 200) {
      const norm = normalizeToolFace(r.body);
      if (norm.ok) {
        out.toolFace = norm.names;
        out.status = "ok";
      } else {
        // A 200 that is not a tool list will not become one by asking again.
        out.reason = `${norm.reason} (${endpoint}, ${attempts} attempt(s))`;
      }
      break;
    }
    // A missing route or a rejected credential is definitive - polling it for the
    // whole deadline only hides the reason behind "no 200 within Ns".
    if (r.status === 404 || r.status === 405) {
      out.reason = `endpoint ${endpoint} does not exist on this host (http ${r.status})`;
      break;
    }
    if (r.status === 401 || r.status === 403) {
      out.reason = `sidecar refused the credential (http ${r.status}) for ${endpoint}`;
      break;
    }
    if (serveExit !== null) break; // the sidecar is gone, retrying cannot help
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (out.status !== "ok" && !out.reason) {
    out.reason = spawnError
      ? `sidecar spawn failed: ${spawnError}`
      : serveExit !== null
        ? `sidecar exited (code ${serveExit}) before answering ${endpoint} (${attempts} attempt(s), last http ${out.httpStatus ?? "none"})`
        : `no usable answer from ${endpoint} within ${TOOLFACE_DEADLINE_S}s (${attempts} attempt(s), last http ${out.httpStatus ?? "none"})`;
  }
  try {
    serve.kill();
  } catch {
    /* ignore */
  }
  return out;
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
    modelSource,
    ocCli: OC,
    ocVersion,
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    isolation: {
      xdgConfigHome: XDG.XDG_CONFIG_HOME,
      xdgDataHome: XDG.XDG_DATA_HOME,
      xdgStateHome: XDG.XDG_STATE_HOME,
      authCopiedFromGlobal: authCopied,
      authSync,
      note: "global config plugins (gov-mode/quota) are NOT loaded; global state not written; auth.json compared by size+mtime only, contents never read",
    },
    fixture: {
      reset: !F["--no-reset"],
      residueAtStart: residue,
      // Symmetric with toolFaceWaived below: an exemption that only prints to stdout
      // cannot be audited later, and "was this run judged on a fixture someone had
      // already solved?" is exactly the fact a stored baseline must answer on its own.
      dirtyWaived: Boolean(F["--allow-dirty-fixture"] && residue.length),
      cleanSha256: fixtureClean.digest,
      cleanFiles: fixtureClean.files,
      cleanBytes: fixtureClean.bytes,
      note: "tasks mutate workspace/ (answers/, src/ edits); each task also records fixtureSha256 at its own completion, which is what judge.mjs needs to re-judge",
    },
    groundtruthSha256,
    toolFaceMethod: NO_TOOLFACE
      ? "skipped by --no-toolface"
      : `GET ${TOOLFACE_ENDPOINT} via per-task sidecar opencode serve (OPENCODE_SERVER_PASSWORD auth)`,
    toolFaceEndpoint: TOOLFACE_ENDPOINT,
    toolFaceWaived: ALLOW_NO_TOOLFACE,
    timeoutSecondsPerTask: TIMEOUT_S,
    tasksJsonSha256: crypto.createHash("sha256").update(fs.readFileSync(tasksJsonPath)).digest("hex"),
    groundtruthSeedVerified: groundtruth.seed,
    startedAt: new Date().toISOString(),
  };

  console.log(`PT-07 baseline runner | opencode ${ocVersion} | node ${process.version} | model ${model} (${modelSource})`);
  console.log(`tasks: ${tasks.map((t) => t.id).join(", ")}`);
  console.log(`timeout/task: ${TIMEOUT_S}s | isolation: ${XDG.XDG_DATA_HOME}`);
  console.log(`out: ${OUT}${F["--force"] && fs.existsSync(OUT) ? " (--force overwriting)" : ""}`);

  const summarize = (list) => ({
    total: list.length,
    pass: list.filter((r) => r.status === "pass").length,
    fail: list.filter((r) => r.status === "fail").length,
    timeout: list.filter((r) => r.status === "timeout").length,
    error: list.filter((r) => r.status === "error").length,
    tokenTotals: list.reduce(
      (acc, r) => ({
        input: acc.input + r.tokens.totals.input,
        output: acc.output + r.tokens.totals.output,
        cacheRead: acc.cacheRead + r.tokens.totals.cacheRead,
        cacheWrite: acc.cacheWrite + r.tokens.totals.cacheWrite,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    ),
  });

  // Partial results are still evidence: an aborted run writes what it got, marked
  // as aborted, instead of silently discarding the tasks that already cost tokens.
  const flushOut = (done, extraMeta) => {
    const output = {
      meta: { ...meta, toolFaceStatus: extraMeta?.toolFaceStatus ?? meta.toolFaceStatus, finishedAt: new Date().toISOString(), ...extraMeta },
      summary: summarize(done),
      tasks: done,
    };
    fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n");
    return output;
  };

  const results = [];
  const toolFaceFailures = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const port = 4710 + i;
    const t0 = Date.now();
    console.log(`\n=== ${task.id} [${task.category}] ===`);

    let tf;
    if (NO_TOOLFACE) {
      tf = { toolFace: null, status: "skipped", reason: "--no-toolface", httpStatus: null, endpoint: TOOLFACE_ENDPOINT };
    } else {
      tf = await snapshotToolFace(port, TOOLFACE_ENDPOINT);
    }
    if (tf.status !== "ok") {
      toolFaceFailures.push({ id: task.id, status: tf.status, reason: tf.reason, endpoint: tf.endpoint, httpStatus: tf.httpStatus });
      console.error(`  TOOL-FACE ${tf.status.toUpperCase()} (port ${port}): ${tf.reason}`);
      if (!ALLOW_NO_TOOLFACE) {
        console.error(`  aborting BEFORE the model call for ${task.id}: toolFace is a core measurement item, a silent null there makes the A/B incomparable.`);
        console.error(`  ${TOOLFACE_ENDPOINT} is an opencode 1.18.x route. Measured on 2.0.20: it answers HTTP 200 with the SPA's index.html (a catch-all), which is why the payload shape is checked, not just the status.`);
        console.error(`  once a 2.x route is verified: --toolface-endpoint <path>; to accept the gap knowingly: --allow-no-toolface (records toolFaceUnavailable per task) or --no-toolface`);
        meta.toolFaceStatus = "aborted-unavailable";
        const out = flushOut(results, { aborted: { reason: "tool-face unavailable and not waived", task: task.id }, toolFaceFailures });
        console.error(`\nwrote PARTIAL results (${out.summary.total} task(s)) to ${OUT}`);
        process.exit(4);
      }
      console.error("  continuing because the operator waived it (--no-toolface / --allow-no-toolface); the record says so explicitly");
    } else {
      console.log(`  tool-face: ${tf.toolFace.length} names`);
    }

    const fixtureAtStart = fixtureFingerprint();
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

    // The state the judge's fixture-dependent checks are valid for is the state
    // THIS task left behind - record it while we still know it.
    const fixtureAtEnd = fixtureFingerprint();

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
      toolFace: tf.toolFace,
      toolFaceStatus: tf.status,
      toolFaceUnavailable: tf.status === "ok" ? null : { reason: tf.reason, endpoint: tf.endpoint, httpStatus: tf.httpStatus, ocVersion },
      fixtureSha256AtStart: fixtureAtStart.digest,
      fixtureSha256: fixtureAtEnd.digest,
      judge,
      eventsFile: path.relative(path.dirname(OUT), path.join(eventsDir, `${task.id}.jsonl`)),
    });
  }

  meta.toolFaceStatus = NO_TOOLFACE
    ? "skipped"
    : toolFaceFailures.length === 0
      ? "ok"
      : toolFaceFailures.length === tasks.length
        ? "all-unavailable"
        : "partial";
  meta.fixture.fixtureSha256AfterRun = fixtureFingerprint().digest;
  const output = flushOut(results, {
    toolFaceStatus: meta.toolFaceStatus,
    ...(toolFaceFailures.length ? { toolFaceFailures } : {}),
  });
  console.log(`\nwrote ${OUT}`);
  console.log(`summary: ${output.summary.pass}/${output.summary.total} pass (timeout=${output.summary.timeout}, error=${output.summary.error})`);
  if (meta.toolFaceStatus !== "ok") {
    console.error(`RESULT INCOMPLETE: tool-face was ${meta.toolFaceStatus} for ${toolFaceFailures.length}/${tasks.length} task(s) — toolFace is null in those records BY THE OPERATOR'S WAIVER, not by accident.`);
    process.exitCode = 4;
  }
}

function judgeTaskSafe(task, ctx) {
  try {
    return judgeTask(task, ctx);
  } catch (e) {
    // A judge spec that cannot resolve, or a fixture that no longer matches the
    // seed, is a harness failure - turning it into status="fail" is exactly the
    // silent-all-red shape C1 was filed for. Let it out and stop the run.
    if (e instanceof JudgeSpecError || e instanceof FixtureDriftError) throw e;
    return { pass: false, evidence: [`judge crashed: ${e && e.message}`] };
  }
}

main().catch((e) => {
  if (e instanceof JudgeSpecError || e instanceof FixtureDriftError) {
    console.error(`\nrunner stopped by the judge harness (${e.constructor.name}): ${e.message}`);
    console.error("  no result file was written for the tasks that had not run; fix the spec/fixture and re-run");
    process.exit(2);
  }
  console.error("runner crashed:", e);
  process.exit(2);
});

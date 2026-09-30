#!/usr/bin/env node
/**
 * PT-07 per-task judge (task book §11).
 *
 * Importable:  import { judgeTask, resolveSpec, fixtureFingerprint } from "./judge.mjs";
 * CLI re-judge: node judge.mjs --results results/baseline.json [--task t03] [--write]
 *
 * Every check recomputes its expectation from the fixture (pt07/workspace +
 * pt07/groundtruth.json) - never from free-form model claims. Returns
 * { pass, evidence[] } per task.
 *
 * Two things this file guarantees about ITSELF (both learned the hard way):
 *
 * 1. A missing or unknown judge spec is a HARNESS failure, not a task failure.
 *    The stored results keep the spec in `judgeSpec` and the verdict in `judge`,
 *    so reading `t.judge.checkId` silently resolved to `undefined` for every task
 *    and a full run of 8/8 pass re-judged as 0/8 with exit 0. Now: the spec is
 *    resolved via resolveSpec(), an unresolvable spec throws JudgeSpecError, the
 *    CLI prints it and exits 2, and --write refuses. (C1)
 * 2. Re-judging a stored result is only valid while the workspace is still in the
 *    state the run left it in. Six of the eight checks read fixture/agent-written
 *    files, so re-judging after `generate.mjs` rebuilt the fixture produced five
 *    false FAILs ("answers/t03.txt missing", "normalizeRegionCode still present").
 *    Now: every check declares its state dependency (CHECK_STATE_DEP), the runner
 *    records a workspace fingerprint per task, and the CLI reports STALE (exit 3)
 *    instead of a verdict when the fingerprint no longer matches. --allow-fixture-drift
 *    is the explicit opt-in for "I know this is not reproducible". (C2)
 *
 * Exit codes: 0 clean pass · 1 a genuine FAIL · 2 invalid harness (spec missing /
 * unknown checkId / bad flags) · 3 fixture drift, some checks not re-judged.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(__dirname, "workspace");
const GROUNDTRUTH = path.join(__dirname, "groundtruth.json");

// ---------------------------------------------------------------- helpers --

function loadGroundtruth() {
  return JSON.parse(fs.readFileSync(GROUNDTRUTH, "utf8"));
}

function normPath(p) {
  return String(p || "").trim().replace(/^\.\/+/, "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function replyRegex(re, text) {
  const m = text.match(re);
  return m;
}

function scanTodoMarkers() {
  const out = [];
  const stack = [path.join(WORKSPACE, "src")];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name.endsWith(".js")) {
        const rel = normPath(path.relative(WORKSPACE, p));
        fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
          if (line.includes("TODO(pt07)")) out.push(`${rel}:${i + 1}`);
        });
      }
    }
  }
  return out.sort();
}

function firstIntOfFile(rel) {
  const p = path.join(WORKSPACE, rel);
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, "utf8").match(/(-?\d+)/);
  return m ? Number(m[1]) : null;
}

function runNodeEval(code, timeoutMs = 30000) {
  const r = spawnSync(process.execPath, ["-e", code], {
    cwd: WORKSPACE,
    timeout: timeoutMs,
    encoding: "utf8",
    windowsHide: true,
  });
  // r.error is set when the spawn itself failed (ENOENT, signal kill); without
  // folding it in here the caller sees an empty stdout AND an empty stderr and
  // reports "got=" with nothing to attribute the failure to.
  const stderr = [(r.stderr || "").trim(), r.error ? `spawn error: ${r.error.message}` : ""].filter(Boolean).join(" | ");
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr };
}

/**
 * A judge spec that cannot be resolved means the harness is broken. It must never
 * be reported as "the task failed" - that is how 8/8 pass looked like 0/8.
 */
export class JudgeSpecError extends Error {}

/**
 * The fixture no longer matches what generate.mjs planted, so the expectation the
 * judge would recompute is not the one the task was set against. Also a harness
 * failure, never a task verdict.
 */
export class FixtureDriftError extends Error {}

/**
 * Resolve the spec for one stored result task.
 * runner.mjs writes the spec to `judgeSpec` and the verdict to `judge`, so
 * `judgeSpec` is the primary source; `judge` is accepted only when it still
 * carries a checkId (a hand-written / older record).
 * @returns {{checkId: string, groundtruthKey?: string, ref?: string}}
 * @throws {JudgeSpecError}
 */
export function resolveSpec(task) {
  const cands = [task.judgeSpec, task.judge];
  for (const c of cands) {
    if (c && typeof c === "object" && typeof c.checkId === "string" && c.checkId) return c;
  }
  const stored = cands.map((c) => (c && typeof c === "object" ? Object.keys(c).join("+") : String(c)));
  throw new JudgeSpecError(
    `no judge spec for task ${task.id}: judgeSpec=${stored[0] || "<none>"}, judge=${stored[1] || "<none>"} ` +
      "(expected a `checkId`; runner.mjs stores the spec under judgeSpec)"
  );
}

/**
 * Which state a check reads. "reply" = only the stored reply + groundtruth.json
 * (re-judgeable forever); "fixture" = the workspace as the run left it (only
 * re-judgeable while the fingerprint matches).
 */
export const CHECK_STATE_DEP = {
  "reply-substring": "reply",
  "todo-locations": "fixture",
  "answer-file-int": "fixture",
  "node-behavior-t05": "fixture",
  "refactor-t06": "fixture",
  "orchestration-t07": "fixture",
};

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

/** Directories that never belong to the fixture fingerprint. */
const EXCLUDED_FIXTURE_DIRS = new Set(["node_modules", ".git"]);

/**
 * Deterministic fingerprint of the fixture workspace: every file (sorted by
 * workspace-relative path) contributing `<relpath>\0<sha256>\n`. Empty
 * directories (answers/ right after generate.mjs) contribute nothing, so a
 * clean fixture has one stable digest and any agent-written artifact or edited
 * source file changes it.
 */
export function fixtureFingerprint(dir = WORKSPACE) {
  const rows = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      throw new Error(`fixture fingerprint failed reading ${d}: ${e.message}`);
    }
    for (const ent of ents) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (!EXCLUDED_FIXTURE_DIRS.has(ent.name)) stack.push(p);
      } else if (ent.isFile()) {
        const st = fs.statSync(p);
        rows.push({ rel: normPath(path.relative(dir, p)), sha: sha256File(p), size: st.size });
      }
    }
  }
  rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const digest = crypto
    .createHash("sha256")
    .update(rows.map((r) => `${r.rel}\u0000${r.sha}\n`).join(""), "utf8")
    .digest("hex");
  return { digest, files: rows.length, bytes: rows.reduce((a, r) => a + r.size, 0) };
}

/** sha256 of a file's bytes (used for groundtruth.json in the run meta). */
export function sha256Of(p) {
  return sha256File(p);
}

/**
 * Read a task's raw NDJSON event log (results/events/<id>.jsonl). Returns [] when
 * the file is missing - the caller decides whether that is fatal. Torn tail lines
 * are skipped, matching the store's own parse discipline.
 */
export function loadEventsFromFile(eventsFile) {
  if (!eventsFile || !fs.existsSync(eventsFile)) return [];
  const out = [];
  for (const line of fs.readFileSync(eventsFile, "utf8").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* torn line - skip */
    }
  }
  return out;
}

/** stdout when there is one, else stderr - never a `.slice` of an undefined field. */
function outOrErr(res, n = 120) {
  // flattened: one evidence line per case, so a 4-case judge output stays readable
  // in a log instead of becoming a stack trace
  return String((res && (res.stdout || res.stderr)) || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function usedTool(events, toolName) {
  return (events || []).some(
    (ev) => (ev.type === "tool_use" || ev.part?.type === "tool") && ev.part?.tool === toolName
  );
}

// ------------------------------------------------------------ task checks --

/**
 * @param {{id: string, judge?: object, judgeSpec?: object}} task  the spec is read
 *   from `judgeSpec` (what runner.mjs stores) or `judge` (tasks.json shape);
 *   an unresolvable spec throws JudgeSpecError rather than reporting a task FAIL.
 * @param {{replyText: string, events: any[]}} ctx
 */
export function judgeTask(task, ctx) {
  const spec = resolveSpec(task);
  const gt = loadGroundtruth();
  const reply = ctx.replyText || "";
  const events = ctx.events || [];
  const evidence = [];
  let pass = false;

  switch (spec.checkId) {
    // ---- t01 / t08: marker lines in the reply -----------------------------
    case "reply-substring": {
      if (task.id === "t01-read-codeqa") {
        const mTax = replyRegex(/PT07_ANSWER_TAX\s*[:=]\s*0\.18\b/i, reply);
        const mShip = replyRegex(/PT07_ANSWER_SHIPPING\s*[:=]\s*4\.5\b/i, reply);
        const mFile = replyRegex(/PT07_ANSWER_ROUND2_FILE\s*[:=]\s*(\S+)/i, reply);
        const fileOk = mFile && /pricing\.js$/i.test(normPath(mFile[1]));
        pass = Boolean(mTax && mShip && fileOk);
        evidence.push(`TAX match: ${Boolean(mTax)}`, `SHIPPING match: ${Boolean(mShip)}`);
        evidence.push(`ROUND2_FILE raw: ${mFile ? mFile[1] : "<missing>"}, accepted: ${Boolean(fileOk)}`);
      } else if (task.id === "t08-read-logqa") {
        const m = replyRegex(/PT07_ANSWER_PEAK\s*[:=]\s*(\d{1,2})/i, reply);
        const got = m ? Number(m[1]) : null;
        pass = got === gt.peakErrorHourDay02;
        evidence.push(
          `replied hour: ${got}`,
          `expected hour: ${gt.peakErrorHourDay02}`,
          `expected ERROR count at peak: ${gt.peakErrorHourDay02Count} (unique max: ${gt.peakErrorHourDay02Unique})`
        );
      } else {
        evidence.push("unknown reply-substring task id");
      }
      break;
    }

    // ---- t02: TODO(pt07) file:line set equality ---------------------------
    case "todo-locations": {
      const expected = scanTodoMarkers();
      // Compare the CONTENT of the two marker sets, not just their size: an equal
      // count with different line numbers means the fixture moved under us, and a
      // length-only check called that a match (C6). groundtruth stores {file,line}
      // objects, the rescan stores "file:line" strings - normalise before comparing.
      const gtMarkers = (gt.todoMarkers || []).map((m) =>
        typeof m === "string" ? m : `${normPath(m.file)}:${Number(m.line)}`
      );
      const gtSet = new Set(gtMarkers);
      const wsSet = new Set(expected);
      const driftMissing = [...gtSet].filter((x) => !wsSet.has(x));
      const driftExtra = [...wsSet].filter((x) => !gtSet.has(x));
      if (driftMissing.length || driftExtra.length) {
        throw new FixtureDriftError(
          `workspace rescan != groundtruth.todoMarkers (extra=${driftExtra.join(",") || "none"}, missing=${driftMissing.join(",") || "none"}); ` +
            "the fixture no longer matches the seed - re-run node pt07/generate.mjs and re-run the task"
        );
      }
      const got = new Set();
      for (const m of reply.matchAll(/PT07_TODO\s+([^\s:]+):(\d+)/gi)) {
        got.add(`${normPath(m[1])}:${Number(m[2])}`);
      }
      const missing = expected.filter((x) => !got.has(x));
      const extra = [...got].filter((x) => !expected.includes(x));
      pass = missing.length === 0 && extra.length === 0 && expected.length > 0;
      evidence.push(`expected ${expected.length}: ${expected.join(", ")}`);
      evidence.push(`replied ${got.size}; missing: ${missing.length ? missing.join(", ") : "none"}; extra: ${extra.length ? extra.join(", ") : "none"}`);
      break;
    }

    // ---- t03 / t04: integer answer file -----------------------------------
    case "answer-file-int": {
      const rel = task.id === "t03-bash-logagg" ? "answers/t03.txt" : "answers/t04.txt";
      const got = firstIntOfFile(rel);
      const key = spec.groundtruthKey;
      if (!key || gt[key] === undefined) {
        throw new JudgeSpecError(
          `checkId answer-file-int needs a groundtruthKey that exists in groundtruth.json (got ${JSON.stringify(key)}) for task ${task.id}`
        );
      }
      const expected = gt[key];
      pass = got !== null && got === expected;
      if (got === null) evidence.push(`${rel} missing or contains no integer`);
      evidence.push(`file integer: ${got}`, `expected (${key}): ${expected}`);
      break;
    }

    // ---- t05: applyBulkDiscount behavior ----------------------------------
    case "node-behavior-t05": {
      const pricingPath = path.join(WORKSPACE, "src", "pricing.js");
      if (!fs.existsSync(pricingPath)) {
        evidence.push("src/pricing.js missing");
        break;
      }
      const cases = [
        { name: "no-eligible-rule", cart: [{ price: 10, qty: 2 }, { price: 5, qty: 1 }], rules: [{ minQty: 10, percentOff: 5 }], expect: { subtotal: 25, discount: 0, total: 25 } },
        { name: "largest-minQty-wins", cart: [{ price: 10, qty: 2 }, { price: 5, qty: 1 }], rules: [{ minQty: 3, percentOff: 20 }, { minQty: 2, percentOff: 5 }], expect: { subtotal: 25, discount: 5, total: 20 } },
        { name: "empty-cart", cart: [], rules: [{ minQty: 1, percentOff: 50 }], expect: { subtotal: 0, discount: 0, total: 0 } },
        { name: "fractional-rounding", cart: [{ price: 19.99, qty: 3 }], rules: [{ minQty: 3, percentOff: 15 }], expect: { subtotal: 59.97, discount: 8.9955, total: 50.9745 } },
      ];
      const tol = 0.011;
      let allOk = true;
      for (const c of cases) {
        const script = `
const { applyBulkDiscount } = require(${JSON.stringify(pricingPath)});
const out = applyBulkDiscount(${JSON.stringify(c.cart)}, ${JSON.stringify(c.rules)});
if (!out || typeof out !== 'object') { console.log('FAIL no object'); process.exit(0); }
const r = { subtotal: Number(out.subtotal), discount: Number(out.discount), total: Number(out.total) };
console.log(JSON.stringify(r));`;
        const res = runNodeEval(script);
        let ok = false;
        let got = null;
        try {
          got = JSON.parse(res.stdout);
          ok =
            res.code === 0 && got &&
            Math.abs(got.subtotal - c.expect.subtotal) <= tol &&
            Math.abs(got.discount - c.expect.discount) <= tol &&
            Math.abs(got.total - c.expect.total) <= tol;
        } catch { ok = false; }
        if (!ok) allOk = false;
        evidence.push(`case ${c.name}: ${ok ? "ok" : "FAIL"} got=${outOrErr(res)} expect=${JSON.stringify(c.expect)}`);
      }
      pass = allOk;
      break;
    }

    // ---- t06: rename + behavior preserved ----------------------------------
    case "refactor-t06": {
      const srcDir = path.join(WORKSPACE, "src");
      const files = [];
      const stack = [srcDir];
      while (stack.length) {
        const dir = stack.pop();
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) stack.push(p);
          else if (ent.name.endsWith(".js")) files.push(p);
        }
      }
      let oldHits = 0;
      const newIn = new Set();
      for (const p of files) {
        const src = fs.readFileSync(p, "utf8");
        if (src.includes("normalizeRegionCode")) oldHits++;
        if (src.includes("canonicalRegion")) newIn.add(normPath(path.relative(WORKSPACE, p)));
      }
      const noOld = oldHits === 0;
      const newFiles = ["src/utils/format.js", "src/utils/validate.js", "src/report.js"];
      const allNew = newFiles.every((f) => newIn.has(f));
      const script = `
const { regionRevenue } = require(${JSON.stringify(path.join(WORKSPACE, "src", "report.js"))});
const orders = [{ region: 'NORTH', total: 100 }, { region: 'west', total: 250 }, { region: 'south', total: 50 }];
const r = [regionRevenue(orders, 'north'), regionRevenue(orders, 'west'), regionRevenue(orders, 'n')];
console.log(JSON.stringify(r));`;
      const res = runNodeEval(script);
      let behavOk = false;
      let got = null;
      try {
        got = JSON.parse(res.stdout);
        behavOk = res.code === 0 && got && got[0] === 100 && got[1] === 250 && got[2] === 100;
      } catch { behavOk = false; }
      const m = reply.match(/PT07_RENAME_DONE\s+(\d+)/i);
      pass = noOld && allNew && behavOk;
      evidence.push(`old-name occurrences under src/: ${oldHits} (must be 0)`);
      evidence.push(`canonicalRegion present in: ${[...newIn].sort().join(", ") || "none"}`);
      evidence.push(`behavior check: ${behavOk ? "ok" : "FAIL"} got=${outOrErr(res)} expect=[100,250,100]`);
      evidence.push(`PT07_RENAME_DONE in reply: ${m ? m[1] + " files" : "missing (non-blocking)"}`);
      break;
    }

    // ---- t07: orchestrated answer file --------------------------------------
    case "orchestration-t07": {
      const p = path.join(WORKSPACE, "answers", "t07.md");
      if (!fs.existsSync(p)) {
        evidence.push("answers/t07.md missing");
        break;
      }
      const content = fs.readFileSync(p, "utf8");
      const mRegion = content.match(/region\s*[:=]\s*([a-z]+)/i);
      const mRev = content.match(/revenue\s*[:=]\s*([\d,]+(?:\.\d+)?)/i);
      const region = mRegion ? mRegion[1].toLowerCase() : null;
      const revenue = mRev ? Number(mRev[1].replace(/,/g, "")) : null;
      const expectedRevenue = gt.topDeliveredRegionRevenueCents / 100;
      const regionOk = region === gt.topDeliveredRegion;
      const revOk = revenue !== null && Math.abs(revenue - expectedRevenue) <= 0.05;
      pass = regionOk && revOk;
      evidence.push(`region: got=${region} expected=${gt.topDeliveredRegion}`);
      evidence.push(`revenue: got=${revenue} expected=${expectedRevenue.toFixed(2)} (tolerance 0.05)`);
      const taskUsed = usedTool(events, "task");
      evidence.push(`task tool used: ${taskUsed ? "yes" : "no (non-blocking evidence)"}`);
      break;
    }

    default:
      // An unknown checkId is not a task that failed - it is a judge that cannot
      // run. Returning pass=false here is what let a whole suite re-judge as 0/8
      // with exit 0.
      throw new JudgeSpecError(`unknown checkId: ${JSON.stringify(spec.checkId)} for task ${task.id}`);
  }

  return { pass, evidence };
}

// -------------------------------------------------------------- CLI mode --

const JUDGE_FLAGS = {
  "--results": "value",
  "--task": "value",
  "--reply-file": "value",
  "--write": "bool",
  "--allow-fixture-drift": "bool",
  "--help": "bool",
};

const JUDGE_USAGE = `usage:
  node judge.mjs --results results/baseline.json [--task <id>] [--write] [--allow-fixture-drift]
  node judge.mjs --task <id> [--reply-file <path>]      manual mode: one task against the live fixture

flags:
  --results <p>            results file to re-judge (required for re-judge mode)
  --task <id>              restrict to one task id, or manual single-task mode
  --reply-file <p>         manual mode: file holding the agent reply text
  --write                  write verdicts back into --results. Refused while any task has no
                           resolvable judge spec or any fixture-dependent check is STALE - a
                           re-judge that cannot see the run's workspace must not overwrite the
                           verdicts that WERE taken against it. Writes <file>.bak first.
  --allow-fixture-drift    judge fixture-dependent checks against the CURRENT workspace anyway
                           and label every such verdict non-reproducible
  --help                   this text (exit 0)

exit codes:
  0  every judged task passed
  1  at least one genuine FAIL verdict
  2  invalid harness: missing/unknown judge spec, bad flag, unreadable results
  3  fixture drift: some checks were reported STALE and not judged`;

function argError(msg) {
  console.error(`judge.mjs: ${msg}\n`);
  console.error(JUDGE_USAGE);
  process.exit(2);
}

/** Unknown flags, missing values and stray positionals all die here (exit 2). */
function parseJudgeArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("-")) argError(`unexpected positional argument: ${tok}`);
    const kind = JUDGE_FLAGS[tok];
    if (!kind) argError(`unknown flag: ${tok} (known: ${Object.keys(JUDGE_FLAGS).join(", ")})`);
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

function cli() {
  const F = parseJudgeArgs(process.argv.slice(2));
  if (F["--help"]) {
    console.log(JUDGE_USAGE);
    process.exit(0);
  }
  const only = F["--task"] ?? null;

  // ---- manual mode: judge ONE task straight from tasks.json + live fixture ----
  if (only && !F["--results"]) {
    const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, "tasks.json"), "utf8")).tasks;
    const t = tasks.find((x) => x.id === only);
    if (!t) argError(`unknown task id: ${only}`);
    const rf = F["--reply-file"];
    const replyText = rf ? fs.readFileSync(path.resolve(rf), "utf8") : "";
    let verdict;
    try {
      verdict = judgeTask({ id: t.id, judgeSpec: t.judge }, { replyText, events: [] });
    } catch (e) {
      console.error(`[${t.id}] JUDGE ERROR (${e.constructor?.name}): ${e.message}`);
      console.error("  a judge that cannot run is not a verdict - fix the spec or the fixture");
      process.exit(2);
    }
    console.log(`[${t.id}] ${verdict.pass ? "PASS" : "FAIL"}`);
    for (const e of verdict.evidence) console.log("  - " + e);
    process.exit(verdict.pass ? 0 : 1);
  }

  if (!F["--results"]) {
    argError("nothing to do: pass --results <file> (re-judge) or --task <id> (manual mode)");
  }
  const resultsPath = path.resolve(__dirname, F["--results"]);
  if (!fs.existsSync(resultsPath)) argError(`results file not found: ${resultsPath}`);
  let results;
  try {
    results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  } catch (e) {
    argError(`cannot parse ${resultsPath}: ${e.message}`);
  }
  if (!results || !Array.isArray(results.tasks)) argError(`${resultsPath} has no tasks[] array`);

  const write = Boolean(F["--write"]);
  const allowDrift = Boolean(F["--allow-fixture-drift"]);
  const meta = results.meta || {};

  // ---- gates: what is this re-judge actually allowed to claim? ----------------
  let gtSha = null;
  try {
    gtSha = sha256Of(GROUNDTRUTH);
  } catch {
    /* unreadable groundtruth is reported per check below */
  }
  const gtHardDrift = Boolean(gtSha && meta.groundtruthSha256 && meta.groundtruthSha256 !== gtSha);
  const gateNotes = [];
  if (!gtSha) gateNotes.push("groundtruth.json unreadable - expected values cannot be recomputed");
  else if (gtHardDrift)
    gateNotes.push(
      `groundtruth.json changed since the run (run=${meta.groundtruthSha256.slice(0, 12)}… now=${gtSha.slice(0, 12)}…) - NO verdict below is trustworthy`
    );
  else if (!meta.groundtruthSha256)
    gateNotes.push(
      "note: this results file records no groundtruthSha256 (runner older than the gate); groundtruth.json is committed, so drift is visible in git"
    );

  let currentFp = null;
  let fpError = null;
  try {
    currentFp = fixtureFingerprint();
  } catch (e) {
    fpError = e.message;
  }
  console.log(
    `fixture now: ${currentFp ? `${currentFp.files} files / ${currentFp.bytes} B / ${currentFp.digest.slice(0, 16)}…` : `UNREADABLE (${fpError})`}`
  );
  for (const n of gateNotes) console.log("  " + n);

  let passCount = 0;
  let failCount = 0;
  let staleCount = 0;
  let harnessCount = 0;
  let total = 0;

  for (const t of results.tasks) {
    if (only && t.id !== only) continue;
    total++;

    // 1. spec must resolve, or the harness is broken (C1)
    let spec;
    try {
      spec = resolveSpec(t);
    } catch (e) {
      harnessCount++;
      console.log(`\n[${t.id}] HARNESS ERROR: ${e.message}`);
      continue;
    }
    if (!t.replyText && !t.eventsFile) {
      harnessCount++;
      console.log(`\n[${t.id}] HARNESS ERROR: no replyText and no eventsFile recorded - nothing to judge`);
      continue;
    }

    // 2. state gate: a fixture-dependent check needs the workspace the run left (C2)
    const dep = CHECK_STATE_DEP[spec.checkId] ?? "fixture";
    let staleReason = null;
    if (gtHardDrift) staleReason = "groundtruth.json drifted from the run (see the gate note above)";
    else if (dep === "fixture") {
      const recorded = t.fixtureSha256 || meta.fixtureSha256AfterRun || null;
      if (!recorded) staleReason = "结果未记录 run 后的 workspace 指纹（旧版 runner 产物），无法证明判据前提";
      else if (!currentFp) staleReason = `当前 workspace 不可读：${fpError}`;
      else if (recorded !== currentFp.digest)
        staleReason =
          `workspace 指纹与 run 时不一致（run=${recorded.slice(0, 16)}… 现=${currentFp.digest.slice(0, 16)}…）` +
          "——判据读的是被 agent 改写过的状态，重建夹具后这些文件已不存在";
    }
    if (staleReason && !allowDrift) {
      staleCount++;
      console.log(`\n[${t.id}] STALE (未重判 · checkId=${spec.checkId} · 依赖=${dep})`);
      console.log(`  - ${staleReason}`);
      console.log("  - 前提不成立时判据只会给出假 FAIL（例如 answers/t03.txt 已被 generate.mjs 清掉）");
      console.log("  - 下一步：node pt07/generate.mjs 后用 runner 重跑；或明确接受不可复现：--allow-fixture-drift");
      continue;
    }

    // 3. run the check
    let verdict;
    try {
      const events = Array.isArray(t.events) && t.events.length ? t.events : loadEventsFromFile(
        t.eventsFile ? path.resolve(path.dirname(resultsPath), t.eventsFile) : null
      );
      verdict = judgeTask({ id: t.id, judgeSpec: spec }, { replyText: t.replyText || "", events });
    } catch (e) {
      harnessCount++;
      console.log(`\n[${t.id}] HARNESS ERROR (${e.constructor?.name}): ${e.message}`);
      continue;
    }

    if (verdict.pass) passCount++;
    else failCount++;
    const label = `${verdict.pass ? "PASS" : "FAIL"}${staleReason ? " (非复现 · 前提不成立，仅供参考)" : ""}`;
    console.log(`\n[${t.id}] ${label}`);
    if (staleReason) console.log(`  - ⚠ non-reproducible: ${staleReason}`);
    for (const e of verdict.evidence) console.log("  - " + e);
    if (write) {
      t.judge = {
        pass: verdict.pass,
        evidence: verdict.evidence,
        judgedAt: new Date().toISOString(),
        // what the verdict was computed against - without these the number cannot
        // be re-derived by anyone later, which is the whole C2 complaint.
        judgedFrom: { checkId: spec.checkId, fixtureSha256: currentFp ? currentFp.digest : null, groundtruthSha256: gtSha },
      };
    }
  }

  if (write) {
    if (harnessCount > 0) {
      console.error("\n--write refused: some tasks had no resolvable judge spec (see HARNESS ERROR lines).");
      console.error("   writing now would overwrite stored verdicts with numbers the judge never actually computed.");
      process.exit(2);
    }
    if (staleCount > 0) {
      console.error(`\n--write refused: ${staleCount} task(s) are STALE (fixture drift, see lines above).`);
      console.error("   pass --allow-fixture-drift if you really mean to overwrite them with non-reproducible verdicts.");
      process.exit(3);
    }
    fs.copyFileSync(resultsPath, `${resultsPath}.bak`);
    results.meta = {
      ...meta,
      lastRejudge: {
        at: new Date().toISOString(),
        fixtureSha256: currentFp ? currentFp.digest : null,
        groundtruthSha256: gtSha,
        allowFixtureDrift: allowDrift,
      },
    };
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
  }

  console.log(
    `\njudged ${total} tasks: ${passCount} pass, ${failCount} fail` +
      (staleCount ? `, ${staleCount} stale (not judged)` : "") +
      (harnessCount ? `, ${harnessCount} harness error` : "") +
      (write ? " (written back)" : "")
  );
  if (staleCount && !allowDrift) {
    console.log("REMEDIY: node pt07/generate.mjs  →  node pt07/runner.mjs（新 runner 会记录指纹）；重判要求 fixture 与 run 时同哈希。");
  }
  const code = harnessCount > 0 ? 2 : staleCount > 0 ? 3 : failCount > 0 ? 1 : 0;
  if (code) process.exit(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli();
}

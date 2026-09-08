#!/usr/bin/env node
/**
 * PT-07 per-task judge (task book §11).
 *
 * Importable:  import { judgeTask } from "./judge.mjs";
 * CLI re-judge: node judge.mjs --results results/baseline.json [--task t03] [--write]
 *
 * Every check recomputes its expectation from the fixture (pt07/workspace +
 * pt07/groundtruth.json) - never from free-form model claims. Returns
 * { pass, evidence[] } per task.
 */
import fs from "node:fs";
import path from "node:path";
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
  return { code: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

function usedTool(events, toolName) {
  return (events || []).some(
    (ev) => (ev.type === "tool_use" || ev.part?.type === "tool") && ev.part?.tool === toolName
  );
}

// ------------------------------------------------------------ task checks --

/**
 * @param {{id: string, judge: {checkId: string, groundtruthKey?: string}}} task
 * @param {{replyText: string, events: any[]}} ctx
 */
export function judgeTask(task, ctx) {
  const gt = loadGroundtruth();
  const reply = ctx.replyText || "";
  const events = ctx.events || [];
  const evidence = [];
  let pass = false;

  switch (task.judge.checkId) {
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
      if (expected.length !== gt.todoMarkers.length) {
        evidence.push(`workspace rescan (${expected.length}) != groundtruth (${gt.todoMarkers.length}); fixture may have drifted`);
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
      const expected = gt[task.judge.groundtruthKey];
      pass = got !== null && got === expected;
      if (got === null) evidence.push(`${rel} missing or contains no integer`);
      evidence.push(`file integer: ${got}`, `expected (${task.judge.groundtruthKey}): ${expected}`);
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
        evidence.push(`case ${c.name}: ${ok ? "ok" : "FAIL"} got=${res.stdout || res.stderr.slice(0, 120)} expect=${JSON.stringify(c.expect)}`);
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
      evidence.push(`behavior check: ${behavOk ? "ok" : "FAIL"} got=${res.stdout || res.stderr.slice(0, 120)} expect=[100,250,100]`);
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
      evidence.push(`unknown checkId: ${task.judge.checkId}`);
  }

  return { pass, evidence };
}

// -------------------------------------------------------------- CLI mode --

function cli() {
  const argv = process.argv.slice(2);
  const argOf = (flag, def) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
  };
  if (argv.includes("--help") || argv.length === 0) {
    console.log("usage: node judge.mjs --results results/baseline.json [--task <id>] [--write]");
    process.exit(argv.includes("--help") ? 0 : 1);
  }
  const resultsPath = path.resolve(__dirname, argOf("--results", "results/baseline.json"));
  const only = argOf("--task", null);
  const write = argv.includes("--write");
  const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
  let passCount = 0;
  let total = 0;
  for (const t of results.tasks) {
    if (only && t.id !== only) continue;
    if (!t.replyText && !t.eventsFile) {
      console.log(`${t.id}: no replyText/events recorded - skipped`);
      continue;
    }
    const verdict = judgeTask(
      { id: t.id, judge: t.judge },
      { replyText: t.replyText, events: t.events || [] }
    );
    total++;
    if (verdict.pass) passCount++;
    console.log(`\n[${t.id}] ${verdict.pass ? "PASS" : "FAIL"}`);
    for (const e of verdict.evidence) console.log("  - " + e);
    if (write) t.judge = { ...t.judge, ...verdict, judgedAt: new Date().toISOString() };
  }
  if (write) fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2) + "\n");
  console.log(`\njudged ${total} tasks: ${passCount} pass, ${total - passCount} fail${write ? " (written back)" : ""}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli();
}

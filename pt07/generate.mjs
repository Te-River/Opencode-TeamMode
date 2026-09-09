#!/usr/bin/env node
/**
 * PT-07 baseline fixture generator (task book §11).
 *
 *   node generate.mjs [--seed 20260907] [--force]
 *
 * Deterministically rebuilds pt07/workspace/ and pt07/groundtruth.json.
 * Same seed -> byte-identical output (no wall-clock, no Math.random).
 * Idempotent: workspace/ is wiped and rebuilt on every run.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- args ----------
const argv = process.argv.slice(2);
function argOf(flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
export const SEED = Number(argOf("--seed", "20260907"));

// ---------- seeded RNG (mulberry32) ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

const WS = path.join(__dirname, "workspace");
const GT = path.join(__dirname, "groundtruth.json");

fs.rmSync(WS, { recursive: true, force: true });
fs.mkdirSync(path.join(WS, "src", "utils"), { recursive: true });
fs.mkdirSync(path.join(WS, "logs"), { recursive: true });
fs.mkdirSync(path.join(WS, "data"), { recursive: true });
fs.mkdirSync(path.join(WS, "answers"), { recursive: true });

// ===========================================================================
// 1. Synthetic codebase (8 source files, CommonJS)
// ===========================================================================

const CONFIG_JS = `// pt07-fixture store configuration
'use strict';

const REGIONS = ['north', 'south', 'east', 'west'];

const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

// sales tax applied at checkout
const TAX_RATE = 0.18;

// pre-2020 tax rate kept for historical report reproduction
const LEGACY_RATE_2019 = 0.31;

// flat shipping fee in currency units
const SHIPPING_FLAT_FEE = 4.5;

// cart subtotal above which shipping is free
const FREE_SHIPPING_THRESHOLD = 120;

// warehouse alerting level
const LOW_STOCK_THRESHOLD = 5;

module.exports = {
  REGIONS,
  ORDER_STATUSES,
  TAX_RATE,
  LEGACY_RATE_2019,
  SHIPPING_FLAT_FEE,
  FREE_SHIPPING_THRESHOLD,
  LOW_STOCK_THRESHOLD,
};
`;

// MARKER_1 lives in PRICING_JS at a deterministic line; keep file layout stable.
const PRICING_JS = `// pricing engine for the pt07-fixture store
'use strict';

const { TAX_RATE, SHIPPING_FLAT_FEE, FREE_SHIPPING_THRESHOLD } = require('./config');

// price of a single line item
function lineTotal(item) {
  return round2(item.price * item.qty);
}

// sum of all line totals, before tax and shipping
function cartSubtotal(cart) {
  return round2(cart.reduce((sum, item) => sum + item.price * item.qty, 0));
}

// subtotal + tax + shipping (shipping waived above the free threshold)
function cartTotal(cart) {
  const subtotal = cartSubtotal(cart);
  const tax = round2(subtotal * TAX_RATE);
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT_FEE;
  return round2(subtotal + tax + shipping);
}

// apply a coupon code to a cart; returns the adjusted total
function applyCoupon(cart, coupon) {
  if (!coupon || !coupon.active) {
    return cartTotal(cart);
  }
  const subtotal = cartSubtotal(cart);
  let discount = 0;
  if (coupon.type === 'percent') {
    discount = subtotal * coupon.value / 100;
  } else if (coupon.type === 'fixed') {
    discount = Math.min(coupon.value, subtotal);
  }
  // TODO(pt07): percent coupons currently stack with fixed coupons; add a
  // stacking guard so only the single best coupon applies.
  const tax = round2((subtotal - discount) * TAX_RATE);
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT_FEE;
  return round2(subtotal - discount + tax + shipping);
}

// TODO(pt07): volume discounts are on the 2026 roadmap; see the bulk pricing
// spec in docs before implementing anything here.

function round2(x) {
  return Number(x.toFixed(2));
}

module.exports = {
  lineTotal,
  cartSubtotal,
  cartTotal,
  applyCoupon,
  round2,
};
`;

const INVENTORY_JS = `// warehouse stock management
'use strict';

const { LOW_STOCK_THRESHOLD } = require('./config');

// reserve qty units of sku; returns remaining stock or null when impossible
function reserveStock(warehouse, sku, qty) {
  const record = warehouse[sku];
  if (!record || record.onHand < qty) {
    return null;
  }
  record.onHand -= qty;
  record.reserved += qty;
  return record.onHand;
}

// give reserved units back
function releaseStock(warehouse, sku, qty) {
  const record = warehouse[sku];
  if (!record || record.reserved < qty) {
    return false;
  }
  record.reserved -= qty;
  record.onHand += qty;
  return true;
}

function isLowStock(record) {
  return record.onHand <= LOW_STOCK_THRESHOLD;
}

// TODO(pt07): nightly restock job should compare onHand against RESTOCK_LEVEL;
// the constant does not exist yet, add it to config.js when the job lands.

module.exports = {
  reserveStock,
  releaseStock,
  isLowStock,
};
`;

const NOTIFICATIONS_JS = `// customer facing email templates
'use strict';

const { formatMoney } = require('./utils/format');

function orderConfirmationEmail(order) {
  const lines = order.items.map(
    (item) => '- ' + item.qty + ' x ' + item.name + ' @ ' + formatMoney(item.price)
  );
  return [
    'Subject: Order ' + order.id + ' confirmed',
    '',
    'Hi ' + order.customerName + ',',
    '',
    'We received your order ' + order.id + ':',
    ...lines,
    '',
    'Total: ' + formatMoney(order.total),
    '',
    'Thanks for shopping with us!',
  ].join('\\n');
}

// TODO(pt07): shipping-delay notice template is missing; ops asked for a
// variant that quotes the new ETA instead of the original promise date.

module.exports = {
  orderConfirmationEmail,
};
`;

const REPORT_JS = `// daily sales reporting
'use strict';

const { normalizeRegionCode } = require('./utils/format');

// aggregate revenue per canonical region for one day of orders
function dailyReport(orders) {
  const report = { north: 0, south: 0, east: 0, west: 0, unknown: 0 };
  for (const order of orders) {
    const region = normalizeRegionCode(order.region);
    report[region] = round2(report[region] + order.total);
  }
  return report;
}

// revenue of one region (canonical code, e.g. 'north')
function regionRevenue(orders, region) {
  const canonical = normalizeRegionCode(region);
  return round2(
    orders.reduce((sum, order) => {
      return normalizeRegionCode(order.region) === canonical ? sum + order.total : sum;
    }, 0)
  );
}

// TODO(pt07): report rows for 'unknown' regions should raise an alert to the
// data team instead of silently aggregating.

function round2(x) {
  return Number(x.toFixed(2));
}

module.exports = {
  dailyReport,
  regionRevenue,
};
`;

const FORMAT_JS = `// string / money formatting helpers
'use strict';

const REGION_ALIASES = {
  n: 'north',
  north: 'north',
  s: 'south',
  south: 'south',
  e: 'east',
  east: 'east',
  w: 'west',
  west: 'west',
};

// map a raw region string ('N', 'NORTH', 'west', ...) to its canonical code
function normalizeRegionCode(raw) {
  if (typeof raw !== 'string') {
    return 'unknown';
  }
  const key = raw.trim().toLowerCase();
  return REGION_ALIASES[key] || 'unknown';
}

// format a currency amount, e.g. 1234.5 -> '1234.50'
function formatMoney(amount) {
  return Number(amount).toFixed(2);
}

module.exports = {
  normalizeRegionCode,
  formatMoney,
};
`;

const VALIDATE_JS = `// order field validation
'use strict';

const { REGIONS, ORDER_STATUSES } = require('../config');
const { normalizeRegionCode } = require('./format');

function isValidRegion(raw) {
  return REGIONS.includes(normalizeRegionCode(raw));
}

function isValidStatus(status) {
  return ORDER_STATUSES.includes(status);
}

function clampQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n < 1) {
    return 1;
  }
  return Math.min(Math.floor(n), 999);
}

module.exports = {
  isValidRegion,
  isValidStatus,
  clampQty,
};
`;

const MODELS_JS = `// domain object factories
'use strict';

const { clampQty, isValidRegion, isValidStatus } = require('./utils/validate');

let orderSeq = 1000;

function makeOrder(fields) {
  if (!isValidStatus(fields.status)) {
    throw new Error('invalid status: ' + fields.status);
  }
  if (!isValidRegion(fields.region)) {
    throw new Error('invalid region: ' + fields.region);
  }
  orderSeq += 1;
  return {
    id: 'ORD-' + orderSeq,
    status: fields.status,
    region: fields.region,
    total: Number(fields.total.toFixed ? fields.total.toFixed(2) : fields.total),
    items: (fields.items || []).map((item) => ({ ...item, qty: clampQty(item.qty) })),
  };
}

function makeCustomer(fields) {
  return {
    id: fields.id || 'CUS-' + Math.abs(hash(fields.email)) % 10000,
    name: fields.name,
    email: fields.email,
    region: fields.region,
  };
}

function makeProduct(fields) {
  return {
    sku: fields.sku,
    name: fields.name,
    price: Number(fields.price.toFixed ? fields.price.toFixed(2) : fields.price),
    onHand: fields.onHand || 0,
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

module.exports = {
  makeOrder,
  makeCustomer,
  makeProduct,
};
`;

const README_MD = `# pt07-fixture

A small synthetic storefront codebase used by the PT-07 baseline task set.

## Layout

- \`src/config.js\`      - store-wide constants (tax, shipping, thresholds)
- \`src/models.js\`      - order / customer / product factories
- \`src/pricing.js\`     - cart pricing engine (subtotal, tax, coupons)
- \`src/inventory.js\`   - warehouse reserve / release logic
- \`src/notifications.js\` - customer email templates
- \`src/report.js\`      - daily sales report per region
- \`src/utils/format.js\` - region + money formatting
- \`src/utils/validate.js\` - order field validation

## Data

- \`logs/\` - application logs (three days)
- \`data/orders.csv\` - order export

This workspace is generated; edit nothing by hand.
`;

const files = {
  "src/config.js": CONFIG_JS,
  "src/pricing.js": PRICING_JS,
  "src/inventory.js": INVENTORY_JS,
  "src/notifications.js": NOTIFICATIONS_JS,
  "src/report.js": REPORT_JS,
  "src/utils/format.js": FORMAT_JS,
  "src/utils/validate.js": VALIDATE_JS,
  "src/models.js": MODELS_JS,
  "README.md": README_MD,
};
for (const [rel, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(WS, rel), content);
}

// ===========================================================================
// 2. Log files (>= 5000 lines total, ERROR/WARN distribution patterns)
// ===========================================================================
// Line format: 2026-09-01T08:15:03Z LEVEL  [component] message
// t03 target: 'ERROR [payment] timeout' occurrences on day 01 -> 17 (exact,
// no other line contains that substring).
// t08 target: peak ERROR hour on day 02 -> hour 14 with a unique maximum.

const COMPONENTS = ["auth", "orders", "payment", "inventory", "email", "search"];

const INFO_MSGS = {
  auth: ["user logged in user=u#N#", "session refreshed user=u#N#", "token issued scope=readonly"],
  orders: ["order created order=ORD-#N#", "order updated order=ORD-#N#", "order exported count=#N#"],
  payment: ["charge authorized order=ORD-#N#", "refund processed order=ORD-#N#", "settlement batch closed"],
  inventory: ["stock synced sku=SKU-#N#", "reservation committed sku=SKU-#N#", "cycle count scheduled"],
  email: ["notification queued template=order-confirmation", "notification delivered template=shipping-notice"],
  search: ["query served index=catalog ms=#N#", "index rebuilt docs=#N#"],
};
const WARN_MSGS = {
  auth: ["repeated login failures user=u#N#", "deprecated api version v1 called"],
  orders: ["slow query order=ORD-#N# ms=#N#", "duplicate webhook ignored"],
  payment: ["retrying charge order=ORD-#N# attempt=#N#", "gateway latency high ms=#N#"],
  inventory: ["low stock sku=SKU-#N#", "reservation stale sku=SKU-#N#"],
  email: ["bounce recorded address=customer#N#@example.net", "template fallback used"],
  search: ["query timed out partial results ms=#N#", "synonym cache miss"],
};
const ERROR_MSGS = {
  auth: ["auth provider unreachable", "invalid credentials user=u#N#"],
  orders: ["order persist failed order=ORD-#N#", "state conflict order=ORD-#N#"],
  payment: ["declined by issuer order=ORD-#N#", "gateway 5xx order=ORD-#N#"],
  inventory: ["negative stock detected sku=SKU-#N#", "stock sync failed warehouse=wh#N#"],
  email: ["notification failed template=order-confirmation", "smtp relay rejected"],
  search: ["index corrupted shard=#N#", "query planner error"],
};

function fill(msg) {
  return msg.replace(/#N#/g, () => String(randInt(1, 9999)));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function logLine(day, hour, min, sec, level, component, msg) {
  return (
    `2026-09-${pad2(day)}T${pad2(hour)}:${pad2(min)}:${pad2(sec)}Z ` +
    `${level.padEnd(5)} [${component}] ${msg}`
  );
}

// Build one day's log. errorQuota: array of 24 counts (sum = number of ERROR
// lines). WARN cadence: roughly one every warnEvery lines. Everything else INFO.
function buildDayLog(day, totalLines, errorQuota, warnEvery) {
  const lines = [];
  const errorsPerHour = errorQuota.slice();
  const hours = Array.from({ length: totalLines }, () => {
    // weighted hour distribution: business hours heavier
    const h = randInt(0, 23);
    return h;
  });
  for (let i = 0; i < totalLines; i++) {
    const hour = hours[i];
    const component = pick(COMPONENTS);
    let level, msg;
    const isErrorSlot = errorsPerHour[hour] > 0 && rng() < 0.9;
    if (isErrorSlot) {
      errorsPerHour[hour] -= 1;
      level = "ERROR";
      if (component === "payment" && errorsPerHour[hour] >= 0 && paymentTimeoutBudget > 0) {
        // reserved special message; handled below
      }
      if (component === "payment" && paymentTimeoutBudget > 0 && day === 1 && rng() < 0.65) {
        paymentTimeoutBudget -= 1;
        msg = "timeout while charging order=ORD-" + randInt(10000, 99999);
      } else {
        msg = fill(pick(ERROR_MSGS[component]));
      }
    } else if (i % warnEvery === 7) {
      level = "WARN";
      msg = fill(pick(WARN_MSGS[component]));
    } else {
      level = "INFO";
      msg = fill(pick(INFO_MSGS[component]));
    }
    const min = randInt(0, 59);
    const sec = randInt(0, 59);
    lines.push(logLine(day, hour, min, sec, level, component, msg));
  }
  return lines;
}

// payment-timeout budget for day 01: exactly 17 lines carry
// 'ERROR [payment] timeout'
let paymentTimeoutBudget = 17;

const day1Quota = [1, 1, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 8, 7, 6, 5, 4, 3, 2, 1, 1]; // sum 95
const day1 = buildDayLog(1, 2400, day1Quota, 23);

// reset budget (only day 01 uses it)
paymentTimeoutBudget = 0;

// day 02: hour 14 is the unique ERROR peak (9), all other hours <= 6
const day2Quota = [2, 1, 0, 0, 1, 1, 2, 3, 4, 5, 5, 6, 4, 5, 9, 6, 5, 4, 3, 3, 2, 2, 1, 1]; // sum 76
const day2 = buildDayLog(2, 2100, day2Quota, 29);

const day3Quota = [1, 0, 0, 0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 4, 4, 5, 4, 3, 3, 2, 2, 1, 1, 1]; // sum 62
const day3 = buildDayLog(3, 1800, day3Quota, 31);

// --- post-pass: enforce exact special patterns ------------------------------
// The generator loop above may have produced a variable number of payment
// timeout lines; fix day 1 so the count is EXACTLY 17, and re-check day 2's
// per-hour ERROR distribution so hour 14 is the unique peak.

function countPaymentTimeout(lines) {
  return lines.filter((l) => l.includes("ERROR [payment] timeout")).length;
}

function replaceLine(lines, idx, day, hour) {
  lines[idx] = logLine(day, hour, randInt(0, 59), randInt(0, 59), "ERROR", "payment",
    "timeout while charging order=ORD-" + randInt(10000, 99999));
}

// normalize day1 payment-timeout count to 17
{
  let have = countPaymentTimeout(day1);
  while (have > 17) {
    const idx = day1.findIndex((l) => l.includes("ERROR [payment] timeout"));
    // rewrite as a plain payment error (no 'timeout' substring)
    day1[idx] = day1[idx].replace("timeout while charging", "declined by issuer");
    have = countPaymentTimeout(day1);
  }
  while (have < 17) {
    // flip a random INFO/WARN line in business hours into the target pattern
    const idx = randInt(0, day1.length - 1);
    const m = day1[idx].match(/^2026-09-01T(\d{2}):/);
    const hour = Number(m[1]);
    if (hour >= 8 && hour <= 20 && !day1[idx].includes("ERROR [payment] timeout")) {
      replaceLine(day1, idx, 1, hour);
      have = countPaymentTimeout(day1);
    }
  }
}

// normalize day2: ERROR count per hour must match day2Quota exactly
function errorCountByHour(lines, day) {
  const counts = new Array(24).fill(0);
  const re = new RegExp(`^2026-09-${pad2(day)}T(\\d{2}):\\d{2}:\\d{2}Z ERROR`);
  for (const l of lines) {
    const m = l.match(re);
    if (m) counts[Number(m[1])] += 1;
  }
  return counts;
}

function normalizeErrorQuota(lines, day, quota) {
  for (let hour = 0; hour < 24; hour++) {
    // count current
    let counts = errorCountByHour(lines, day);
    while (counts[hour] > quota[hour]) {
      // demote one ERROR at this hour to INFO
      const re = new RegExp(`^2026-09-${pad2(day)}T${pad2(hour)}:\\d{2}:\\d{2}Z ERROR`);
      const idx = lines.findIndex((l) => re.test(l));
      lines[idx] = lines[idx].replace("ERROR", "INFO ");
      counts = errorCountByHour(lines, day);
    }
    while (counts[hour] < quota[hour]) {
      // promote one INFO/WARN at this hour to a generic ERROR
      const re = new RegExp(`^2026-09-${pad2(day)}T${pad2(hour)}:\\d{2}:\\d{2}Z (INFO|WARN)`);
      const idx = lines.findIndex((l) => re.test(l) && !l.includes("[payment] timeout"));
      if (idx < 0) break;
      const comp = pick(COMPONENTS.filter((c) => c !== "payment"));
      lines[idx] = logLine(day, hour, randInt(0, 59), randInt(0, 59), "ERROR", comp,
        fill(pick(ERROR_MSGS[comp])));
      counts = errorCountByHour(lines, day);
    }
  }
}

normalizeErrorQuota(day2, 2, day2Quota);
normalizeErrorQuota(day3, 3, day3Quota);
// day 1: only guarantee quota shape is not needed for judging; keep as-is.

fs.writeFileSync(path.join(WS, "logs", "app-2026-09-01.log"), day1.join("\n") + "\n");
fs.writeFileSync(path.join(WS, "logs", "app-2026-09-02.log"), day2.join("\n") + "\n");
fs.writeFileSync(path.join(WS, "logs", "app-2026-09-03.log"), day3.join("\n") + "\n");

// ===========================================================================
// 3. CSV data file (1500 rows)
// ===========================================================================

const STATUSES = ["pending", "processing", "shipped", "delivered", "cancelled"];
// status weights: delivered is the largest block
const STATUS_POOL = [
  "delivered", "delivered", "delivered", "delivered", "delivered",
  "shipped", "shipped", "shipped",
  "pending", "pending",
  "processing", "processing",
  "cancelled",
];

const csvRows = ["order_id,status,region,total"];
for (let i = 0; i < 1500; i++) {
  const id = "ORD-" + String(10001 + i);
  const status = pick(STATUS_POOL);
  const region = pick(["north", "south", "east", "west"]);
  const whole = randInt(500, 95000); // cents
  const total = (whole / 100).toFixed(2);
  csvRows.push(`${id},${status},${region},${total}`);
}
fs.writeFileSync(path.join(WS, "data", "orders.csv"), csvRows.join("\n") + "\n");

// ===========================================================================
// 4. Ground truth (recomputed from the generated artifacts themselves)
// ===========================================================================

function scanTodos() {
  const out = [];
  const stack = [path.join(WS, "src")];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name.endsWith(".js")) {
        const rel = path.relative(WS, p).split(path.sep).join("/");
        fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
          if (line.includes("TODO(pt07)")) out.push({ file: rel, line: i + 1 });
        });
      }
    }
  }
  out.sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line, "en"));
  return out;
}

function parseCsv() {
  const raw = fs.readFileSync(path.join(WS, "data", "orders.csv"), "utf8").trim().split("\n");
  const header = raw[0].split(",");
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return raw.slice(1).map((l) => {
    const parts = l.split(",");
    return {
      order_id: parts[idx.order_id],
      status: parts[idx.status],
      region: parts[idx.region],
      total: parts[idx.total],
    };
  });
}

const orders = parseCsv();
const deliveredWest = orders.filter((o) => o.status === "delivered" && o.region === "west").length;

// top region by delivered revenue, integer cents to avoid float drift
const revenueCents = { north: 0, south: 0, east: 0, west: 0 };
for (const o of orders) {
  if (o.status === "delivered") {
    revenueCents[o.region] += Math.round(Number(o.total) * 100);
  }
}
let topRegion = "north";
for (const r of Object.keys(revenueCents)) {
  if (revenueCents[r] > revenueCents[topRegion]) topRegion = r;
}

const errByHourDay2 = errorCountByHour(day2, 2);
const maxErr = Math.max(...errByHourDay2);
let peakHour = -1;
let peakCountUnique = errByHourDay2.filter((c) => c === maxErr).length === 1;
for (let h = 0; h < 24; h++) if (errByHourDay2[h] === maxErr) peakHour = h;

const groundtruth = {
  seed: SEED,
  generatedBy: "pt07/generate.mjs",
  todoMarkers: scanTodos(),
  paymentTimeoutDay01: countPaymentTimeout(day1),
  peakErrorHourDay02: peakHour,
  peakErrorHourDay02Unique: peakCountUnique,
  peakErrorHourDay02Count: maxErr,
  deliveredWestCount: deliveredWest,
  topDeliveredRegion: topRegion,
  topDeliveredRegionRevenueCents: revenueCents[topRegion],
  logTotals: {
    "app-2026-09-01.log": day1.length,
    "app-2026-09-02.log": day2.length,
    "app-2026-09-03.log": day3.length,
  },
  csvRowCount: orders.length,
};

fs.writeFileSync(GT, JSON.stringify(groundtruth, null, 2) + "\n");

// ===========================================================================
// 5. Sanity checks + fingerprint
// ===========================================================================

const totalLogLines = day1.length + day2.length + day3.length;
if (totalLogLines < 5000) throw new Error(`log lines ${totalLogLines} < 5000`);
if (orders.length < 1000) throw new Error(`csv rows ${orders.length} < 1000`);
if (groundtruth.todoMarkers.length !== 5) {
  throw new Error(`expected exactly 5 TODO(pt07) markers, found ${groundtruth.todoMarkers.length}`);
}
if (groundtruth.paymentTimeoutDay01 !== 17) {
  throw new Error(`payment timeout count ${groundtruth.paymentTimeoutDay01} != 17`);
}
if (!groundtruth.peakErrorHourDay02Unique) {
  throw new Error("day 02 peak ERROR hour is not unique - fix day2Quota");
}
const srcFiles = Object.keys(files).filter((f) => f.startsWith("src/")).length;
if (srcFiles < 6) throw new Error(`source files ${srcFiles} < 6`);

const hashOf = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);

// Fixture module semantics: the workspace codebase is CommonJS (module.exports),
// but the repo root package.json declares "type": "module". Without this file,
// Node resolves workspace/*.js as ESM and judge.mjs's require()-based behavior
// checks cannot load them (found live during the first GLM baseline run).
fs.writeFileSync(
  path.join(WS, "package.json"),
  JSON.stringify({ name: "pt07-fixture", private: true, type: "commonjs" }, null, 2) + "\n"
);

console.log("PT07 workspace generated");
console.log("  seed:", SEED);
console.log("  source files:", srcFiles, "+ README.md");
console.log("  log lines:", totalLogLines, `(d1=${day1.length} d2=${day2.length} d3=${day3.length})`);
console.log("  csv rows:", orders.length);
console.log("  todo markers:", groundtruth.todoMarkers.length);
// NOTE: ground-truth values are deliberately NOT printed here — the executor
// must derive answers from the fixture, not from generator stdout.
console.log("  fingerprint (sha256-16):");
console.log("    groundtruth.json :", hashOf(GT));
for (const f of ["src/pricing.js", "src/utils/format.js", "logs/app-2026-09-01.log", "data/orders.csv"]) {
  console.log("    " + f.padEnd(22), hashOf(path.join(WS, f)));
}

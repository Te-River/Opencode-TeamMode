// 2.x config surgery, shared by scripts/install.sh and scripts/install.ps1 so the two
// installers cannot drift into two different ideas of what "installed" means.
//
// Adds the plugin entry and/or sets default_agent, then READS THE VALUE BACK from disk
// before reporting success. Comments are masked to spaces at identical offsets, so a
// commented-out key can never be mistaken for a live one (the read-back would pass
// while the config said nothing).
//
// Why the key is `plugins` and not `plugin`, why one entry may not sit in two files,
// and why a directory target needs a root index.js: docs/research/plugin-loader-contract.md
//
// The two `mcp-*` modes write ONE thing: an McpLocalConfig under the container key
// `mcp.<name>`. The sibling shape `mcp.servers.<name>` was measured NOT to be the key
// this host loads (2.2.1: `mcp.<name>` connected, `mcp connected server=… tools=2`), and
// the ENCODED branch that spells the same entry with `disabled` instead of `enabled` is
// ignored in silence — an install that looks successful and does nothing. So this helper
// refuses to emit anything but the measured shape.
// usage: node config-surgery.cjs <file> <plugins|default-agent|mcp-set|mcp-remove> <value> [otherFileToScrub]
//   mcp-set    <name> '<json>'  — merge {type:"local", command:[…], environment:{}, enabled, timeout}
//   mcp-remove <name>           — delete that one key, leave every other server alone
const fs = require("fs");
const [file, mode, value, other] = process.argv.slice(2);
if (!file || !mode || !value) {
  console.error("ERR usage: node this.js <file> <plugins|default-agent|mcp-set|mcp-remove> <value> [otherFileToScrub]");
  process.exit(1);
}

const mask = (s) => {
  let out = "", i = 0, inStr = false, esc = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && s[i + 1] === "*") {
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) { out += s[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
};

const lineOf = (s, idx) => s.slice(0, idx).split("\n").length;
let src = fs.readFileSync(file, "utf8");
const open = mask(src).indexOf("{");
if (open < 0) { console.error("ERR no top-level object in " + file); process.exit(1); }
const nextNonWs = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };
/** insert one member right after an object's opening brace at `at` (top level by
 *  definition: in a JSONC config the first '{' IS the document's own). */
const insertMemberAt = (s, at, member) => {
  const after = nextNonWs(s, at + 1);
  const comma = s[after] === "}" ? "" : ",";   // an empty object takes none
  return s.slice(0, at + 1) + "\n  " + member + comma + s.slice(at + 1);
};
const insertMember = (s, member) => insertMemberAt(s, open, member);

/** index of the bracket that closes the one at `at`, over MASKED text (so a brace
 *  inside a string or a comment cannot shift the count). -1 when unbalanced. */
const matchBrace = (mk, at) => {
  let d = 0;
  for (let i = at; i < mk.length; i++) {
    const c = mk[i];
    if (c === '"') { const j = mk.indexOf('"', i + 1); if (j < 0) return -1; i = j; continue; }
    if (c === "{" || c === "[") d++;
    else if (c === "}" || c === "]") { d--; if (!d) return i; }
  }
  return -1;
};

/** DIRECT members of the object whose `{` sits at `at`: key text plus the spans of
 *  key and value. `null` for anything this helper does not understand — guessing at a
 *  shape is how a config gets half-rewritten. */
const objectMembers = (mk, at) => {
  const end = matchBrace(mk, at);
  if (end < 0 || mk[at] !== "{") return null;
  const out = [];
  let i = at + 1;
  while (i < end) {
    if (mk[i] === "," || /\s/.test(mk[i])) { i++; continue; }
    if (mk[i] !== '"') return null;
    const keyStart = i, keyEnd = mk.indexOf('"', i + 1);
    if (keyEnd < 0 || keyEnd >= end) return null;
    let j = keyEnd + 1;
    while (j < end && /\s/.test(mk[j])) j++;
    if (mk[j] !== ":") return null;
    j++;
    while (j < end && /\s/.test(mk[j])) j++;
    const valStart = j;
    let valEnd;
    if (mk[j] === '"') { const q = mk.indexOf('"', j + 1); if (q < 0) return null; valEnd = q + 1; }
    else if (mk[j] === "{" || mk[j] === "[") { const c = matchBrace(mk, j); if (c < 0 || c > end) return null; valEnd = c + 1; }
    else { let k = j; while (k < end && !/[,}\]\s]/.test(mk[k])) k++; valEnd = k; }
    out.push({ key: mk.slice(keyStart + 1, keyEnd), keyStart, valStart, valEnd });
    i = valEnd;
  }
  return { head: at + 1, end, members: out };
};

/** key-order-insensitive form, so an equivalent entry the user hand-wrote (or a second
 *  run of this helper) reads as "same values" instead of being rewritten for style. */
const stable = (v) =>
  Array.isArray(v) ? "[" + v.map(stable).join(",") + "]"
    : v && typeof v === "object"
      ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}"
      : JSON.stringify(v);

/** The ONLY shape this helper writes. Validated, not trusted: the caller hands JSON in,
 *  and a `disabled` key would silently select the branch the host ignores. */
const readLocalSpec = (raw) => {
  let o;
  try { o = JSON.parse(raw); } catch (e) {
    console.error("ERR the value is not JSON: " + e.message);
    process.exit(1);
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) {
    console.error("ERR the value must be a JSON object (McpLocalConfig)");
    process.exit(1);
  }
  if (Object.prototype.hasOwnProperty.call(o, "disabled")) {
    console.error("ERR `disabled` belongs to Mcp.LocalConfigEncoded, which this host IGNORES — " +
      "an entry written that way looks installed and never starts. Use `enabled`.");
    process.exit(1);
  }
  const allowed = ["type", "command", "environment", "enabled", "timeout"];
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) {
      console.error("ERR unknown key `" + k + "` — the host reads exactly " + allowed.join(" / "));
      process.exit(1);
    }
  }
  if (o.type !== "local") {
    console.error("ERR type must be \"local\" (this helper writes McpLocalConfig only)");
    process.exit(1);
  }
  if (!Array.isArray(o.command) || !o.command.length || o.command.some((c) => typeof c !== "string" || !c)) {
    console.error("ERR command must be a non-empty array of non-empty strings ([\"<exe>\", \"--flag\"]), " +
      "not a shebang string — a 60000 ms timeout does not rescue a command the host cannot spawn");
    process.exit(1);
  }
  const env = o.environment === undefined ? {} : o.environment;
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) {
    console.error("ERR environment must be an object of string values");
    process.exit(1);
  }
  const enabled = o.enabled === undefined ? true : o.enabled;
  if (typeof enabled !== "boolean") { console.error("ERR enabled must be true/false"); process.exit(1); }
  const timeout = o.timeout === undefined ? 60000 : o.timeout;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1000) {
    console.error("ERR timeout must be a number of milliseconds >= 1000 (the host default is 5000, " +
      "which a cold Python start exceeds — 60000 is the measured value here)");
    process.exit(1);
  }
  return { type: "local", command: o.command, environment: env, enabled, timeout };
};

const lineNo = (s, idx) => " (line " + lineOf(s, idx) + " of " + file + ")";

if (mode === "plugins") {
  // OpenCode 2.x reads `config.plugins` (PLURAL). The singular `plugin` key is the
  // 1.18.x spelling; a 2.x host never reads it, so an entry written there looks like
  // an installed plugin and is nothing. It is left in place (a user may still share
  // the file with a 1.18.x install) but REPORTED.
  //
  // Exactly ONE entry for our package, in either spelling: the host loads every entry
  // it finds, and the same plugin loaded twice means two personalities registering the
  // same tools and hooks. So a previous entry of OURS (npm specifier vs ./vendor path)
  // is REPLACED, never duplicated; entries naming anything else are untouched.
  const lit = JSON.stringify(value);
  // Case-insensitive, hyphen-optional and slash-tolerant, because a local install is
  // spelled with the working tree's own directory name (`D:/Github/Opencode-TeamMode`,
  // no hyphen between team and mode) while the npm entry is `opencode-team-mode`. An
  // entry we fail to recognise as ours is one we would ADD next to the existing one —
  // and two entries is two loads, which is the defect this function exists to prevent.
  const ours = (t) => /opencode[-_]?team[-_]?mode|vendor[/\\]team-mode/i.test(t);
  const findArray = (mk, key) => {
    const m = new RegExp('"' + key + '"\\s*:\\s*\\[').exec(mk);
    if (!m) return null;
    let i = m.index + m[0].length, depth = 1;
    while (i < mk.length) {
      const c = mk[i];
      if (c === '"') { const j = mk.indexOf('"', i + 1); if (j < 0) return null; i = j + 1; continue; }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") { depth--; if (depth === 0) return { head: m.index + m[0].length, end: i }; }
      i++;
    }
    return null;
  };
  /** [start,end) spans of the array's own elements in [head,end); commas and whitespace
   *  are skipped, so a trailing comma — which a hand-edited or host-written config often
   *  carries — cannot end up producing ", ,", which would break the parse. */
  const elements = (mk, head, end) => {
    const out = []; let i = head;
    while (i < end) {
      const c = mk[i];
      if (c === "," || /\s/.test(c)) { i++; continue; }
      if (c === '"') { const j = mk.indexOf('"', i + 1); if (j < 0 || j >= end) break; out.push([i, j + 1]); i = j + 1; continue; }
      if (c === "{" || c === "[") {
        let d = 0, k = i;
        for (; k < end; k++) {
          const q = mk[k];
          if (q === '"') { k = mk.indexOf('"', k + 1); if (k < 0 || k >= end) { k = end; break } continue; }
          if (q === "{" || q === "[") d++;
          else if (q === "}" || q === "]") { d--; if (!d) { k++; break; } }
        }
        out.push([i, k]); i = k; continue;
      }
      let k = i; while (k < end && !/[,}\]\s]/.test(mk[k])) k++;
      out.push([i, k]); i = k;
    }
    return out;
  };
  const view = (text) => { const mk = mask(text); const a = findArray(mk, "plugins"); return { mk, a, els: a ? elements(mk, a.head, a.end) : [] }; };

  const v0 = view(src);
  if (findArray(v0.mk, "plugin")) {
    console.log("NOTE this file also has a top-level \"plugin\" (singular) key — OpenCode 2.x loads" +
      "\n     config.plugins (plural) and never reads the singular one. Left untouched; if 1.18.x\n" +
      "     is gone from this machine, the key and its entries are dead weight you can delete.");
  }
  if (!v0.a) {
    fs.writeFileSync(file, insertMember(src, '"plugins": [\n    ' + lit + "\n  ]"));
    console.log("OK  created the plugins array with " + lit);
  } else {
    const same = v0.els.filter(([a, b]) => v0.mk.slice(a, b) === lit);
    const dupe = v0.els.filter(([a, b]) => ours(v0.mk.slice(a, b)) && v0.mk.slice(a, b) !== lit);
    if (dupe.length) {
      // Replace the first, drop the rest: two entries of ours = two loaded personalities.
      let out = src;
      for (let n = dupe.length - 1; n >= 0; n--) {
        const [a, b] = dupe[n];
        out = n === 0 ? out.slice(0, a) + lit + out.slice(b) : out.slice(0, a) + out.slice(b);
      }
      fs.writeFileSync(file, out);
      console.log("OK  replaced " + dupe.length + " previous Team entry/entries with " + lit);
    } else if (same.length) {
      console.log("OK  plugins already lists " + lit +
        (same.length > 1 ? " — " + same.length + " times, which loads the plugin twice" : ""));
    } else {
      const last = v0.els[v0.els.length - 1];
      const at = last ? last[1] : v0.a.head;
      const pad = last ? ",\n    " : "\n    ";
      fs.writeFileSync(file, src.slice(0, at) + pad + lit + src.slice(at));
      console.log("OK  added " + lit + " alongside " + v0.els.length + " existing entr" + (v0.els.length === 1 ? "y" : "ies"));
    }
  }
  // Read it back off the disk. The host's loader skips a plugin directory whose
  // entrypoint it cannot resolve with NO message at all, and a key nobody reads is
  // indistinguishable from an install — so the only claim made here is the measured one.
  const v1 = view(fs.readFileSync(file, "utf8"));
  const got = v1.els.filter(([a, b]) => v1.mk.slice(a, b) === lit).length;
  if (!got) {
    console.error("ERR read-back: plugins does not hold " + lit + " (array " + (v1.a ? "present" : "ABSENT") + ")");
    console.error("    Add it by hand at the top level of " + file + ":  \"plugins\": [" + lit + "]");
    process.exit(1);
  }
  const stillOurs = v1.els.filter(([a, b]) => ours(v1.mk.slice(a, b))).length;
  console.log("OK  read back: plugins holds " + lit + " (" + v1.els.length + " entries, " +
    stillOurs + " of them Team)");
  if (got > 1 || stillOurs > 1) {
    console.error("ERR the array carries our package more than once — the host would load it twice");
    process.exit(1);
  }
  // Reclaim our entry from the OTHER global config file. The two files are merged at
  // parse time and the host dedupes only on an identical string, so leaving our entry
  // in opencode.json while writing this one would register the plugin twice — two
  // personalities, the same tools and hooks bound twice, and a boot log that reads as
  // one healthy install. Foreign entries (another plugin, any other key) are untouched.
  if (other && other !== file && fs.existsSync(other)) {
    const osrc = fs.readFileSync(other, "utf8");
    const ov = view(osrc);
    const mine = ov.els.filter(([a, b]) => ours(ov.mk.slice(a, b)));
    if (mine.length) {
      let out = osrc;
      for (let n = mine.length - 1; n >= 0; n--) {
        const [a, b] = mine[n];
        // Take the comma with the element, and pick the RIGHT side: dropping a trailing
        // comma when the element is the last one would leave `"x",\n  ]`, which only
        // parses because the host reads JSONC with allowTrailingComma — and a config that
        // is valid solely under a lenient parser is a trap for the next hand edit.
        let prev = a - 1;
        while (prev >= 0 && /\s/.test(out[prev])) prev--;
        if (prev >= 0 && out[prev] === ",") {
          out = out.slice(0, prev) + out.slice(b);        // not first: remove prev comma + element
        } else {
          let next = b;
          while (next < out.length && /\s/.test(out[next])) next++;
          out = out.slice(0, a) + out.slice(out[next] === "," ? next + 1 : b);  // first: remove element + its comma
        }
      }
      fs.writeFileSync(other, out);
      // [Q, T,] with T removed keeps a comma either way (a separator on one side, a
      // trailing one on the other), so a single element + comma delete cannot produce
      // strict JSON. Strip a comma that now dangles immediately before THIS array's own
      // closing bracket — that region and no other, because the rest of the file is not
      // ours to reformat.
      const after = view(fs.readFileSync(other, "utf8"));
      if (after.a) {
        let p = after.a.end - 1;
        while (p > after.a.head && /\s/.test(out[p])) p--;
        if (out[p] === ",") {
          out = out.slice(0, p) + out.slice(p + 1);
          fs.writeFileSync(other, out);
        }
      }
      const chk = view(fs.readFileSync(other, "utf8"));
      const left = chk.els.filter(([a, b]) => ours(chk.mk.slice(a, b))).length;
      if (left) {
        console.error("ERR " + other + " still lists Team after the reclaim — the plugin would load twice");
        process.exit(1);
      }
      console.log("OK  reclaimed " + mine.length + " Team entr" + (mine.length === 1 ? "y" : "ies") +
        " from " + other + " (a second copy means a second load)");
    }
  }
} else if (mode === "default-agent") {
  const lit = JSON.stringify(value);
  const re = /"default_agent"(\s*:\s*)("(?:[^"\\]|\\.)*"|[^,}\s][^,}\n]*)/;
  const m = re.exec(mask(src));
  if (m) {
    const vStart = m.index + m[0].length - m[2].length;
    if (m[2].trim() === lit) {
      console.log("OK  default_agent already " + lit + lineNo(src, m.index));
    } else {
      fs.writeFileSync(file, src.slice(0, vStart) + lit + src.slice(vStart + m[2].length));
      console.log("OK  default_agent rewritten (was " + m[2].trim() + ")");
    }
  } else {
    fs.writeFileSync(file, insertMember(src, '"default_agent": ' + lit));
    console.log("OK  default_agent added");
  }
  // Read it back — a fresh read of the file from disk, comments masked again.
  src = fs.readFileSync(file, "utf8");
  const chk = re.exec(mask(src));
  const got = chk ? chk[2].trim() : null;
  if (got !== lit) {
    console.error("ERR default_agent read back as " + (got === null ? "(key absent)" : got) + ", not " + lit);
    console.error("    Add it by hand at the top level of " + file + ":  \"default_agent\": " + lit);
    process.exit(1);
  }
  console.log("OK  read back: " + lit + lineNo(src, chk.index));
} else if (mode === "mcp-set" || mode === "mcp-remove") {
  // The MCP entry. Two facts decide the whole shape here, both measured on 2.2.1:
  //   * the container key is `mcp.<name>` (the host logged `mcp connected
  //     server=computeruse tools=2`); `mcp.servers.<name>` was NOT loaded, so this
  //     helper writes only the working spelling and merely REPORTS the other one;
  //   * `command` is an ARRAY, and `timeout` defaults to 5000 ms — a cold Python
  //     start exceeds that, so the caller's 60000 is not a nicety.
  const name = value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    console.error("ERR the server name must be one token ([A-Za-z0-9._-]) — the host derives the" +
      "\n    tool names from it (computeruse → computeruse_screenshot)");
    process.exit(1);
  }
  const raw = fs.readFileSync(file, "utf8");
  const mk = mask(raw);
  const top = objectMembers(mk, open);
  if (!top) {
    console.error("ERR the top level of " + file + " is not an object this helper can read — nothing written");
    process.exit(1);
  }
  /** fresh read of the file from disk; null when mcp.<name> is not really there. */
  const readBackMcp = (text) => {
    const bmk = mask(text);
    try {
      const j = JSON.parse(bmk);
      const m = j && typeof j === "object" ? j.mcp : null;
      const v = m && typeof m === "object" && !Array.isArray(m) ? m[name] : undefined;
      return { got: v === undefined ? null : v, via: "strict JSON.parse" };
    } catch {
      // A JSONC file (comments are masked above, but a trailing comma or a bare key
      // still fails strict parse): fall back to the span, and parse THE SPAN strictly.
      const bt = objectMembers(bmk, bmk.indexOf("{"));
      const bm = bt && bt.members.find((m) => m.key === "mcp");
      if (!bm || bmk[bm.valStart] !== "{") return { got: null, via: "masked span" };
      const bo = objectMembers(bmk, bm.valStart);
      const bc = bo && bo.members.find((m) => m.key === name);
      if (!bc) return { got: null, via: "masked span" };
      try { return { got: JSON.parse(text.slice(bc.valStart, bc.valEnd)), via: "masked span (JSONC file)" }; }
      catch { return { got: null, via: "masked span" }; }
    }
  };
  const mcp = top.members.find((m) => m.key === "mcp");
  const noteServers = () => {
    if (!mcp || mk[mcp.valStart] !== "{") return;
    const o = objectMembers(mk, mcp.valStart);
    const s = o && o.members.find((m) => m.key === "servers");
    if (!s || mk[s.valStart] !== "{") return;
    const so = objectMembers(mk, s.valStart);
    if (so && so.members.some((m) => m.key === name)) {
      console.log("NOTE this file also carries mcp.servers." + name + " — measured on 2.2.1, the host" +
        "\n     loads mcp." + name + " and never that one. Left untouched; delete it if it is dead weight.");
    }
  };

  if (mode === "mcp-set") {
    // The spec arrives either as the 4th argv slot (design §6.1, what install.sh and the
    // tests use) or — for callers whose shell REWRITES embedded quotes, which Windows
    // PowerShell 5.1 measurably does to a JSON argv element — as TM_MCP_SPEC. Both are
    // read through readLocalSpec, so neither can bypass the shape checks.
    const specRaw = other || process.env.TM_MCP_SPEC || "";
    if (!specRaw) {
      console.error("ERR mcp-set needs the config as JSON, either as the 4th argument or in" +
        "\n    TM_MCP_SPEC: node config-surgery.cjs <file> mcp-set <name> '<json>'");
      process.exit(1);
    }
    const spec = readLocalSpec(specRaw);
    const lit = JSON.stringify(spec);
    let out = raw, wrote = false, action = "";
    if (!mcp) {
      out = insertMemberAt(raw, open, '"mcp": {\n    "' + name + '": ' + lit + "\n  }");
      wrote = true; action = "created mcp." + name + " = " + lit;
    } else {
      if (mk[mcp.valStart] !== "{") {
        console.error("ERR mcp is not an object in " + file + " — refusing to guess. Nothing written.");
        process.exit(1);
      }
      const obj = objectMembers(mk, mcp.valStart);
      if (!obj) {
        console.error("ERR the mcp object's shape is not one this helper can read — nothing written.");
        process.exit(1);
      }
      const cur = obj.members.find((m) => m.key === name);
      if (cur) {
        let same = false;
        try { same = stable(JSON.parse(raw.slice(cur.valStart, cur.valEnd))) === stable(spec); }
        catch { same = false; }           // unparseable value → replace it, and say so below
        if (same) {
          console.log("OK  mcp." + name + " 已存在，未改动（值相同，没有写文件）");
        } else {
          out = raw.slice(0, cur.valStart) + lit + raw.slice(cur.valEnd);
          wrote = true; action = "replaced mcp." + name + lineNo(raw, cur.keyStart) + " = " + lit;
        }
      } else {
        const last = obj.members[obj.members.length - 1];
        const at = last ? last.valEnd : obj.head;
        const pad = last ? ",\n    " : "\n    ";
        out = raw.slice(0, at) + pad + '"' + name + '": ' + lit + raw.slice(at);
        wrote = true; action = "added mcp." + name + " = " + lit;
      }
    }
    if (wrote) {
      fs.writeFileSync(file, out);
      console.log("OK  " + action);
    }
    noteServers();
    if (wrote) {
      const rb = readBackMcp(fs.readFileSync(file, "utf8"));
      if (!rb.got || typeof rb.got !== "object") {
        console.error("ERR read-back: mcp." + name + " is not in " + file + " (" + rb.via + ") — the write" +
          "\n    did not land. Add it by hand:  \"mcp\": { \"" + name + "\": " + lit + " }");
        process.exit(1);
      }
      if (Object.prototype.hasOwnProperty.call(rb.got, "disabled")) {
        console.error("ERR read-back: the entry carries `disabled`, the shape this host ignores. Nothing else done.");
        process.exit(1);
      }
      if (stable(rb.got) !== stable(spec)) {
        console.error("ERR read-back: mcp." + name + " reads back with different values (" + rb.via + ")");
        process.exit(1);
      }
      console.log("OK  read back (" + rb.via + "): mcp." + name + " = " + JSON.stringify(rb.got));
    }
  } else {
    // mcp-remove: exactly our key, and nothing else. An absent key is a success, not an
    // error — a second run of an uninstall must not look like a failure.
    const gone = () => { console.log("OK  mcp." + name + " 不存在，未改动"); process.exit(0); };
    if (!mcp || mk[mcp.valStart] !== "{") gone();
    const obj = objectMembers(mk, mcp.valStart);
    if (!obj) {
      console.error("ERR the mcp object's shape is not one this helper can read — nothing written.");
      process.exit(1);
    }
    const cur = obj.members.find((m) => m.key === name);
    if (!cur) gone();
    let out = raw;
    const a = cur.keyStart, b = cur.valEnd;
    // Same comma rule as the plugins reclaim: take the separator with the member, and
    // pick the right side so a last-element delete cannot leave a dangling comma.
    let prev = a - 1;
    while (prev >= 0 && /\s/.test(out[prev])) prev--;
    if (prev >= 0 && out[prev] === ",") {
      out = out.slice(0, prev) + out.slice(b);
    } else {
      let next = b;
      while (next < out.length && /\s/.test(out[next])) next++;
      out = out.slice(0, a) + out.slice(out[next] === "," ? next + 1 : b);
    }
    fs.writeFileSync(file, out);
    console.log("OK  removed mcp." + name);
    noteServers();
    const rb = readBackMcp(fs.readFileSync(file, "utf8"));
    if (rb.got) {
      console.error("ERR read-back: mcp." + name + " is still in " + file + " (" + rb.via + ")");
      process.exit(1);
    }
    console.log("OK  read back (" + rb.via + "): mcp." + name + " is gone; every other key untouched");
  }
} else {
  console.error("ERR unknown mode '" + mode + "'");
  process.exit(1);
}

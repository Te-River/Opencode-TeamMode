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
// usage: node config-surgery.cjs <file> <plugins|default-agent> <value> [otherFileToScrub]
const fs = require("fs");
const [file, mode, value, other] = process.argv.slice(2);
if (!file || !mode || !value) {
  console.error("ERR usage: node this.js <file> <plugins|default-agent> <value> [otherFileToScrub]");
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
/** insert one member right after the object's opening brace (top level by
 *  definition: in a JSONC config the first '{' IS the document's own). */
const insertMember = (s, member) => {
  const after = nextNonWs(s, open + 1);
  const comma = s[after] === "}" ? "" : ",";   // an empty object takes none
  return s.slice(0, open + 1) + "\n  " + member + comma + s.slice(open + 1);
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
} else {
  console.error("ERR unknown mode '" + mode + "'");
  process.exit(1);
}

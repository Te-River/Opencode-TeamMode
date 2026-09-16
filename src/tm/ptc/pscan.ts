/**
 * tm_ptc_run — static pre-scan: the FIRST gate.  runPtc and buildPtcRunTool
 * both reject a rejected program before any engine runs.  Auxiliary guard,
 * not a security boundary (design §3 trust model).  Split out of the former
 * monolithic ptc.ts.
 *
 * C1 fix batch: the old single-regex stripper deleted an ENTIRE template
 * literal including its `${…}` executable interpolations, so
 * `` `x ${process.exit(1)} y` `` was a FALSE NEGATIVE (a real escape written
 * inside an interpolation sailed through).  The scanner below is a tiny
 * hand-written lexer that:
 *   - drops line/block comments and '…'/"…" string bodies (data, not code),
 *   - drops the LITERAL TEXT of a template but RECURSIVELY SCANS every
 *     `${…}` interpolation body (that text IS executed), and
 *   - drops regex-literal bodies, so `{ pattern: /\brequire\b/ }` (a plain
 *     DATA regex) no longer rejects the whole program.
 * Everything is fail-CLOSED: an unterminated literal/comment/interpolation
 * leaves its remainder in place to be scanned, so an open quote can never
 * hide a banned token behind it.
 */

/** A banned identifier/call-site token, paired with the name reported to the
 *  operator (the old code derived the name from re.source and stripped \b,
 *  which read poorly for the new call-site patterns). */
interface PscanToken {
  name: string
  re: RegExp
}

/** Banned tokens for the program source.  The last three (constructor(,
 *  Function(, eval() are the C1 escape call-sites; dynamic `import(` is
 *  already covered by the `import` word token. */
const PSCAN_PATTERNS: readonly PscanToken[] = [
  { name: "require", re: /\brequire\b/ },
  { name: "import", re: /\bimport\b/ },
  { name: "process", re: /\bprocess\b/ },
  { name: "globalThis", re: /\bglobalThis\b/ },
  { name: "Deno", re: /\bDeno\b/ },
  { name: "Bun", re: /\bBun\b/ },
  { name: "fs", re: /\bfs\b/ },
  { name: "net", re: /\bnet\b/ },
  { name: "child_process", re: /\bchild_process\b/ },
  { name: "constructor(", re: /\bconstructor\s*\(/ },
  { name: "Function(", re: /\bFunction\s*\(/ },
  { name: "eval(", re: /\beval\s*\(/ },
]

// Chars after which a `/` STARTS a regex literal (an operator/punctuator that
// cannot END an operand).  Anything else (identifier, number, `)`, `]`, a
// closing quote) means the `/` is a DIVISION, so its right-hand side stays
// live code and is scanned.
const REGEX_POS_CHARS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*",
  "%", "<", ">", "^", "~", "&", "|",
])

// Keywords after which a `/` is a regex (e.g. `return /x/`, `typeof /x/`).
const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
])

const isWordChar = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") ||
  c === "_" || c === "$"

/** s[start] is a quote; return the index AFTER the closing quote honouring
 *  backslash escapes, or -1 when the string runs off the end (unterminated). */
function scanString(s: string, start: number): number {
  const q = s[start]
  let i = start + 1
  while (i < s.length) {
    const c = s[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === q) return i + 1
    if (c === "\n") return -1 // a plain string cannot span a newline → not a string
    i++
  }
  return -1
}

/** s[start] is `/`; return the index AFTER the closing unescaped `/` (honour
 *  a `[...]` char class where `/` is literal), or -1 if it never closes on
 *  this line (so it is NOT a regex literal). */
function scanRegex(s: string, start: number): number {
  let i = start + 1
  let inClass = false
  while (i < s.length) {
    const c = s[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "\n") return -1
    if (c === "[") inClass = true
    else if (c === "]") inClass = false
    else if (c === "/" && !inClass) return i + 1
    i++
  }
  return -1
}

/** s[start] is a backtick.  Collapse the template's LITERAL TEXT to a single
 *  space (banned words there are data) and RECURSIVELY SCAN each `${…}`
 *  interpolation body (executed code).  Returns the stripped text and the
 *  index after the closing backtick, or null when unterminated. */
function scanTemplate(s: string, start: number): { out: string; end: number } | null {
  let i = start + 1
  let out = ""
  while (i < s.length) {
    const c = s[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "`") return { out: out + " ", end: i + 1 }
    if (c === "$" && s[i + 1] === "{") {
      out += " "
      const inner = scanToCloseBrace(s, i + 2)
      if (!inner) return null
      out += " " + scanCode(inner.code) + " "
      i = inner.end
      continue
    }
    i++ // template text char — dropped (a single space represents the run)
  }
  return null // unterminated
}

/** Start just after a `${`; find the matching `}` (depth-tracked, skipping
 *  strings / comments / regex / nested templates so a `}` inside them cannot
 *  close early).  Returns the inner code (without the braces) + the index
 *  after `}`, or null on an unterminated interpolation. */
function scanToCloseBrace(
  s: string,
  start: number,
): { code: string; end: number } | null {
  let depth = 1
  let i = start
  let lastCode = ""
  let lastWord = ""
  let curWord = ""
  const flushWord = (): void => {
    if (curWord) {
      lastWord = curWord
      curWord = ""
    } else {
      lastWord = ""
    }
  }
  while (i < s.length) {
    const c = s[i]
    if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++
      flushWord()
      continue
    }
    if (c === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2)
      if (e < 0) return null
      i = e + 2
      flushWord()
      continue
    }
    if (c === '"' || c === "'") {
      const e = scanString(s, i)
      if (e < 0) return null
      i = e
      lastCode = c
      flushWord()
      continue
    }
    if (c === "`") {
      const r = scanTemplate(s, i)
      if (!r) return null
      i = r.end
      lastCode = "`"
      flushWord()
      continue
    }
    if (c === "/") {
      const regexPos =
        lastCode === "" || REGEX_POS_CHARS.has(lastCode) || KEYWORDS_BEFORE_REGEX.has(lastWord)
      if (regexPos) {
        const e = scanRegex(s, i)
        if (e > 0) {
          i = e
          lastCode = ")"
          flushWord()
          continue
        }
      }
      lastCode = "/"
      flushWord()
      i++
      continue
    }
    if (c === "{") {
      depth++
      lastCode = "{"
      flushWord()
      i++
      continue
    }
    if (c === "}") {
      depth--
      if (depth === 0) return { code: s.slice(start, i), end: i + 1 }
      lastCode = "}"
      flushWord()
      i++
      continue
    }
    if (isWordChar(c)) {
      curWord += c
      lastCode = c
    } else {
      flushWord()
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") lastCode = c
    }
    i++
  }
  return null // ran off the end before the interpolation closed
}

/** Scan a code region: strip comments / strings / template-text / regex, keep
 *  interpolation bodies (recursively scanned) and all other code. */
function scanCode(s: string): string {
  let out = ""
  let i = 0
  let lastCode = ""
  let lastWord = ""
  let curWord = ""
  const flushWord = (): void => {
    if (curWord) {
      lastWord = curWord
      curWord = ""
    } else {
      lastWord = ""
    }
  }
  while (i < s.length) {
    const c = s[i]
    // line comment → collapse to a single space, keep the newline
    if (c === "/" && s[i + 1] === "/") {
      let k = i + 2
      while (k < s.length && s[k] !== "\n") k++
      out += " "
      i = k
      flushWord()
      continue
    }
    // block comment → collapse to a single space; unterminated = fail closed
    if (c === "/" && s[i + 1] === "*") {
      const e = s.indexOf("*/", i + 2)
      if (e < 0) {
        out += s.slice(i)
        break
      }
      out += " "
      i = e + 2
      flushWord()
      continue
    }
    // string literal → single space; unterminated = fail closed (scan raw rest)
    if (c === '"' || c === "'") {
      const e = scanString(s, i)
      if (e < 0) {
        out += s.slice(i)
        break
      }
      out += " "
      i = e
      lastCode = c
      flushWord()
      continue
    }
    // template literal → text dropped, ${…} bodies scanned; unterminated = raw
    if (c === "`") {
      const r = scanTemplate(s, i)
      if (!r) {
        out += s.slice(i)
        break
      }
      out += r.out
      i = r.end
      lastCode = "`"
      flushWord()
      continue
    }
    // `/` → regex literal (in a regex position) else division operator
    if (c === "/") {
      const regexPos =
        lastCode === "" || REGEX_POS_CHARS.has(lastCode) || KEYWORDS_BEFORE_REGEX.has(lastWord)
      if (regexPos) {
        const e = scanRegex(s, i)
        if (e > 0) {
          out += " "
          i = e
          lastCode = ")"
          flushWord()
          continue
        }
      }
      out += "/"
      i++
      lastCode = "/"
      flushWord()
      continue
    }
    // ordinary code char
    out += c
    if (isWordChar(c)) {
      curWord += c
      lastCode = c
    } else {
      flushWord()
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") lastCode = c
    }
    i++
  }
  return out
}

/** The program source with string / comment / template-text / regex-literal
 *  bodies removed but `${…}` interpolation bodies retained and scanned.
 *  Each removed literal becomes a single SPACE (not "") so a token split
 *  across two literals cannot re-form, and word boundaries stay intact. */
export function stripNonExecutable(program: string): string {
  return scanCode(program)
}

export function staticPscan(program: string): { rejected: boolean; tokens: string[] } {
  // Scan the EXECUTABLE surface only — string/comment/regex/template-text are
  // data, but template interpolations ARE code and are retained by the scan.
  const code = stripNonExecutable(program)
  const tokens: string[] = []
  for (const { name, re } of PSCAN_PATTERNS) {
    if (re.test(code)) tokens.push(name)
  }
  return { rejected: tokens.length > 0, tokens }
}

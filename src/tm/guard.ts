/**
 * JIT layer-2 tools — permission guards (R1 pipeline).
 *
 * P2 (path level, tm_read / tm_grep scope): read scope = project root +
 * blackboard dir + trajectory dir.  Everything else — including `..` escapes
 * and absolute paths outside the scopes — is rejected.  Both the target and
 * each scope are fs.realpathSync'd first (fail-closed): a junction/symlink
 * pointing outside the scope defeats purely lexical resolve/relative checks.
 *
 * P3 (command level, tm_bash): a read-only allowlist gates what R6 does not
 * already forbid.  The two layers are deliberately non-conflicting:
 *   R6      governs what is FORBIDDEN (env dumps, env files — same source);
 *   the P3 allowlist governs what is PERMITTED (read-only heads only).
 * Hardening beyond the head token: output redirection, command substitution
 * ($()/backticks/<>()), VAR=value assignment prefixes (BASH_ENV/LD_PRELOAD/
 * PATH borrow an allowlisted head to run arbitrary scripts — fail closed),
 * find -delete/-exec, tail -f and Get-Content/Get-ChildItem -Wait (hang),
 * awk system() and rg --pre are rejected even under allowlisted heads.
 * Quoted metacharacters (`|`, `;`, `>`, single-quoted `$()`) are literal
 * text in both dialects — one shared quote-blanking view keeps segmentation
 * and the redirect/substitution checks from misreading them (see the
 * blankQuoted helpers; one implementation, never two drifting copies).
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { shorten } from "./config.js"
import { splitShellSegments } from "../shell-text.js"

export interface AllowVerdict {
  ok: boolean
  reason?: string
  suggestion?: string
}

// statement segmentation is the shared implementation in ../shell-text.ts;
// local name kept for the call sites below.
const segments = splitShellSegments

/**
 * Quoted-span blanking — ONE shared implementation for every quote-aware
 * view (two prior review rounds both traced back to drifted copies).  A
 * quoted span is literal text in bash AND PowerShell, so its metacharacters
 * are neither segment boundaries nor operators.
 *   blankQuoted       — blanks single- AND double-quoted spans: used for the
 *                       redirect check and for segmentation (rg "err|warn"
 *                       src, grep -E "a;b" f must not split on quoted `|;/`).
 *   blankSingleQuoted — blanks single-quoted spans ONLY: used by the
 *                       substitution check, because double quotes still
 *                       expand $()/backticks in bash (and $( ) is a PS
 *                       subexpression inside "..."), so blanking them would
 *                       be a real allowance — single quotes are literal in
 *                       both dialects (awk '{print $(NF)}' is a field ref).
 */
const QUOTED_SPAN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g
const SINGLE_QUOTED_SPAN = /'(?:[^'\\]|\\.)*'/g

function blankQuoted(text: string): string {
  return text.replace(QUOTED_SPAN, " ")
}

function blankSingleQuoted(text: string): string {
  return text.replace(SINGLE_QUOTED_SPAN, " ")
}

/**
 * Statement head of one segment: peel subshell/group openers, escaped
 * commands and the `time` keyword until the real command word surfaces (same
 * peeling idea as envprotect).  `assignment` reports that a leading
 * `VAR=value` prefix was peeled on the way — the caller must FAIL CLOSED on
 * it: a read-only aggregate never needs an assignment, and BASH_ENV/
 * LD_PRELOAD/PATH prefixes are exactly how arbitrary scripts borrow an
 * allowlisted head (non-interactive bash sources BASH_ENV before running
 * `ls`).
 */
function headInfo(segment: string): { head: string; assignment: boolean } {
  let s = segment.trim()
  for (;;) {
    const next = s
      .replace(/^[({\\]+/, "")
      .replace(/[)}]+$/, "")
      .replace(/^time\s+/i, "")
      .trim()
    if (next === s) break
    s = next
  }
  const sp = s.search(/\s/)
  const token = sp === -1 ? s : s.slice(0, sp)
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
    const rest = sp === -1 ? "" : s.slice(sp).trim()
    const inner = rest ? headInfo(rest) : { head: "", assignment: false }
    return { head: inner.head, assignment: true }
  }
  return { head: token, assignment: false }
}

function allowVerdict(reason: string, suggestion: string): AllowVerdict {
  return { ok: false, reason, suggestion }
}

/**
 * Classify a tm_bash command against the read-only allowlist.
 * Every segment head (across && ; | & and newlines) must be allowlisted.
 * Matching is case-insensitive (PowerShell is; sh spellings are unaffected).
 */
export function classifyReadonlyCommand(
  command: string,
  allowlist: readonly string[],
): AllowVerdict {
  const text = String(command ?? "").trim()
  if (!text) {
    return allowVerdict("空命令", "提供要执行的只读命令")
  }

  // Output redirection is a write path — reject (stream dups like `2>&1` and
  // `2>>&1` are blanked first so legitimate stream merging still passes —
  // blanking BEFORE segmentation also stops the `&` inside `2>&1` from
  // splitting the command into bogus segments).
  const noDup = text.replace(/\d+>&\d+/g, " ")
  // Quoted `>`/`|`/`;` are literal text (grep "a>b", rg "err|warn" src) —
  // blank quoted spans for the redirect check AND for segmentation; every
  // real unquoted metacharacter still matches (no new allowance surface).
  const noQuote = blankQuoted(noDup)
  if (/(>>|>|&>|<>)/.test(noQuote)) {
    return allowVerdict(
      "只读模式禁止输出重定向（>/>>）",
      "去掉重定向只看输出；需要写文件请改用内置 bash（危险操作会弹官方确认框审批），无 bash 权限则向 HUMAN 申请",
    )
  }

  // Command substitution executes arbitrary commands INSIDE an allowlisted
  // head — the head token never sees it (review probes A1/A2/A3: `ls $(rm
  // -rf x)`, backticks, `cat <(rm …)` all passed the allowlist).  A read-only
  // aggregate never needs substitution: fail closed on all of it.  Only
  // single-quoted spans are blanked here — single quotes are literal in both
  // dialects (awk '{print $(NF)}' is a field reference, not a call), while
  // double-quoted $( ) still expands (grep "$(x)" f stays rejected).
  if (/\$\(|`|<\(|>\(/.test(blankSingleQuoted(noDup))) {
    return allowVerdict(
      "只读模式禁止命令替换（$() / 反引号 / <() / >()）",
      "命令替换会执行任意命令；改用管道组合只读命令，或改用内置 bash 执行（将弹官方确认框审批）",
    )
  }

  const allow = (head: string) =>
    allowlist.some((a) => a.toLowerCase() === head)

  for (const seg of segments(noQuote)) {
    const { head, assignment } = headInfo(seg)
    // Fail closed on assignment prefixes: peeling used to expose the real
    // head (BASH_ENV=./setup.sh ls -> ls) and let env injection borrow an
    // allowlisted head.  No read-only aggregation needs VAR=value.
    if (assignment) {
      return allowVerdict(
        "只读模式禁止环境变量赋值前缀（VAR=value cmd）",
        "BASH_ENV/LD_PRELOAD/PATH 等赋值前缀可借白名单头执行任意脚本；去掉赋值前缀，或改用内置 bash 执行（将弹官方确认框审批）",
      )
    }
    if (!head) continue
    const base = head.replace(/^.*[\\/]/, "").toLowerCase()
    if (!allow(base)) {
      return allowVerdict(
        `命令 "${shorten(base, 40)}" 不在 tm_bash 只读白名单内`,
        "改用白名单只读命令（ls/cat/head/tail/grep/rg/find/awk/sort/uniq/wc/cut/dir/tasklist/ps/Get-Content/Get-ChildItem/Select-String/Measure-Object）；需要执行删除/网络/安装/进程等危险命令请改用内置 bash（将弹官方确认框审批），无 bash 权限则向 HUMAN 申请批准",
      )
    }
  }

  // Write / execute / hang escapes that ride on allowlisted heads.
  // deq view (review round-4 major): the shell dequotes argv, so `find .
  // "-delete"` really arrives as `-delete` — but the raw-text checks below
  // want whitespace before the flag (a `"`/`\` prefix slipped past) and the
  // blanked view erases in-quote flags entirely.  One quote-char-stripped
  // view closes all three; over-rejection is safe (`find . -name "-delete"`
  // also dies — acceptable for a read-only aggregate).
  const deq = text.replace(/["'\\]/g, "")
  if (/\bfind\b/i.test(deq) && /\s-{1,2}(?:delete|exec(?:dir)?|ok(?:dir)?|fls|fprint\w*)\b/i.test(deq)) {
    return allowVerdict(
      "find 的写入/执行参数（-delete/-exec/…）不允许",
      "find 只用于查找；删除或执行请向 HUMAN 申请",
    )
  }
  if (/\bawk\b/i.test(text) && /\bsystem\s*\(/.test(text)) {
    return allowVerdict(
      "awk 的 system() 调用不允许",
      "awk 仅做文本聚合；执行外部命令请向 HUMAN 申请",
    )
  }
  // `--pre` only when NOT `--pre-glob` (lookahead requires [\s=] or EOL —
  // a `\b` between "pre" and "-" also matched, wrongly banning --pre-glob).
  if (/--pre(?=[\s=]|$)/i.test(deq)) {
    return allowVerdict(
      "rg --pre（外部预处理命令）不允许",
      "去掉 --pre；需要预处理请向 HUMAN 申请",
    )
  }
  // Hang escapes: tail -f/--follow, and PowerShell -Wait on Get-Content /
  // Get-ChildItem / its `dir` alias (streams/waits — never returns).
  // Checked on BOTH views: the quote-blanked view keeps `dir "a|b" -Wait`
  // rejected (deq segmentation would split the quoted pipe and strand the
  // -Wait on a non-dir head); the deq view catches in-quote flags the
  // blanked view erases (`tail "-f" x`, `dir "-Wait" x`).
  for (const view of [noQuote, deq]) {
    for (const seg of segments(view)) {
      const tokens = seg.trim().split(/\s+/)
      const head = tokens[0]?.replace(/^.*[\\/]/, "").toLowerCase()
      if (head === "tail") {
        for (const t of tokens.slice(1)) {
          if (t === "-f" || t.startsWith("--follow")) {
            return allowVerdict(
              "tail -f/--follow 会挂起不返回",
              "改用 tail -n <N> 取末尾若干行",
            )
          }
        }
      } else if (head === "get-content" || head === "get-childitem" || head === "dir") {
        // `-wai` still covers PowerShell's unambiguous -Wait prefixes
        // (-wai/-wait) without also matching -WarningAction/-WarningVariable.
        if (tokens.slice(1).some((t) => /^-wai/i.test(t))) {
          return allowVerdict(
            "Get-Content/Get-ChildItem -Wait 会挂起不返回",
            "去掉 -Wait 取当前内容即可",
          )
        }
      }
    }
  }
  return { ok: true }
}

// ---------- P2 path scope ----------

/** True when `target` resolves inside `rootDir` (win32 compares case-insensitively). */
export function isInsideDir(rootDir: string, target: string): boolean {
  const rootAbs = path.resolve(rootDir)
  const targetAbs = path.resolve(target)
  const rel = path.relative(rootAbs, targetAbs)
  if (rel === "") return true
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true
  if (process.platform === "win32") {
    const relLc = path.relative(rootAbs.toLowerCase(), targetAbs.toLowerCase())
    return relLc !== "" && !relLc.startsWith("..") && !path.isAbsolute(relLc)
  }
  return false
}

export type PathScopeVerdict =
  | { ok: true; abs: string }
  | { ok: false; message: string }

/** realpathSync wrapper — null when the path does not exist / cannot resolve. */
function realPathSafe(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/**
 * Resolve a requested path against the tool's directory and enforce the P2
 * read scope (project root + extra dirs, i.e. blackboard + trajectory).
 * Junction/symlink hardening (#6): BOTH the target and each scope dir are
 * fs.realpathSync'd before the containment check — a purely lexical
 * resolve/relative is defeated by a junction pointing outside the scope.
 * Fail-closed: an unresolvable target is rejected; a scope dir that cannot
 * be resolved (not created yet) simply cannot contain anything real and is
 * skipped.  The error message never echoes env-file style paths beyond the
 * scope verdict itself (R6 rejections upstream carry no path text at all).
 */
export function assertReadablePath(
  baseDir: string,
  requested: unknown,
  extraDirs: readonly string[] = [],
): PathScopeVerdict {
  const raw = String(requested ?? "").trim()
  if (!raw) {
    return { ok: false, message: "缺少 path 参数" }
  }
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw)
  const absReal = realPathSafe(abs)
  if (!absReal) {
    return {
      ok: false,
      message: `路径不存在或无法解析（P2 fail-closed）: ${shorten(abs, 160)}`,
    }
  }
  const scopes = [baseDir, ...extraDirs]
  for (const scope of scopes) {
    const scopeReal = realPathSafe(scope)
    if (!scopeReal) continue
    if (isInsideDir(scopeReal, absReal)) {
      return { ok: true, abs }
    }
  }
  return {
    ok: false,
    message: `路径越界（P2 只读范围 = 项目根 + 黑板 + Trajectory）: ${shorten(abs, 160)}`,
  }
}

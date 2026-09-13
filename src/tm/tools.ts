/**
 * JIT layer-2 tools — assembly of the four governed tools.  The machinery
 * lives in sibling modules (one responsibility each):
 *
 *   pipelines.ts     — the four governed pipelines + threshold governance
 *   result.ts        — structured errors + ToolResult rendering contract
 *   client-unwrap.ts — host client result unwrapping + text extraction
 *   shell-bridge.ts  — the host `$` shell bridge + shell error hygiene
 *   args-schema.ts   — zod raw-shape arg schemas (descriptor fallback)
 *
 * Behavior unchanged from the former tools.ts hub.
 */

import type { ToolDefinition } from "../types.js"
import { buildArgsSchemas } from "./args-schema.js"
import { buildPipelines, type TmDeps, type TmPipelines } from "./pipelines.js"
import { toToolResult } from "./result.js"

// ---------- descriptions ----------
// Deliberately explicit about dialect + governance: the model must prefer the
// governed tools over raw bash equivalents (see /#14791 for tm_grep) and must
// learn the handle protocol from the description alone.

const TM_READ_DESCRIPTION = `Read a file inside the project (governed passthrough of the built-in read).
- Path semantics: paths are relative to the PROJECT ROOT (not the agent's working directory). To read pt07/workspace/src/config.js, pass path="pt07/workspace/src/config.js".
- Read scope (P2, fail-closed): project root + blackboard dir + trajectory dir; anything outside is rejected, and so is a nonexistent/unresolvable path (realpath-verified).
- R6 applies: env files (.env, *.env, .bashrc family) are refused — same interception source as the built-in read; tm_* is NOT a bypass.
- Governance: results up to TM_OFFLOAD_THRESHOLD tokens (default 2000, CJK-aware estimate) return inline; larger payloads are offloaded to a handle {offloaded, ref, access_token, expire_at, tokens, preview} — page through with tm_fetch (try mode:"structure" first).
- The preview is content-aware (JSON / CSV / log / code / binary branches, hard-capped at 80 tokens) and embeds retrieval clues.`

const TM_GREP_DESCRIPTION = `Full-text regex search inside the project (governed passthrough of the host's ripgrep index). PREFER this over running rg inside tm_bash: it uses the host's search index and auto-governs oversized results instead of flooding the context.
- Args: pattern (required, regex), path (optional scope directory, relative to project root — default project root itself).
- P2 fail-closed: a path argument that does not exist (or resolves outside project root + blackboard + trajectory) is rejected outright.
- R6 applies: pattern/path naming env files (*.env, .bashrc family) are refused — same source as the built-in grep.
- Governance: results up to TM_OFFLOAD_THRESHOLD tokens return inline; larger ones are offloaded to a handle {offloaded, ref, access_token, expire_at, tokens, preview} whose preview carries match clues (file:line). Page through with tm_fetch.
- Strategy: aggregate first (narrow pattern, counts), fetch raw lines only when needed.`

const TM_BASH_DESCRIPTION = `Run a READ-ONLY shell command in the project (governed passthrough of the built-in bash). Dialect: bash on POSIX, PowerShell-like on Windows (Get-Content / Get-ChildItem / Select-String work; ls/cat/dir are aliased).
- Allowlist only (P3): ls cat head tail grep rg find awk sort uniq wc cut dir Get-Content Get-ChildItem Select-String Measure-Object Select-Object Where-Object Sort-Object Group-Object — extend via TM_BASH_READONLY_ALLOWED. Anything else is rejected with a read-only suggestion or an ask to HUMAN.
- R6 still applies on top: env dumps (env/printenv/set, $env:) and env-file paths are blocked exactly like the built-in bash — two layers, non-conflicting (R6 forbids, the allowlist permits).
- Escapes rejected: output redirection (> >>), command substitution ($(), backticks, <() >()), find -delete/-exec, tail -f, Get-Content/Get-ChildItem -Wait, awk system(), rg --pre.
- Governance: output up to TM_OFFLOAD_THRESHOLD tokens returns inline; larger output is offloaded to a tm_fetch handle. Use for aggregations (count/sort/uniq); for plain search prefer tm_grep (host index, auto-governed).`

const TM_FETCH_DESCRIPTION = `Page through an offloaded tool result by its handle (tm_read / tm_grep / tm_bash return handles for oversized payloads).
- Args: ref (required, tm://runs/{run_id}/steps/{step_id}/result), access_token (required — from the handle; may also ride the ref fragment), offset (0-based line), limit (lines per fetch, capped at TM_FETCH_MAX_LINES, default 2000), mode ("lines" default | "structure" — a ~100-token TOC / key-tree / error-line map; try it FIRST on big payloads).
- Handles are run-scoped and HMAC-signed: a foreign-run, tampered or expired handle (TM_BLACKBOARD_TTL, default 7 days) is rejected with "payload cleared or run mismatch — rerun the original tool".
- Returns the ref, a paging hint (total/returned/remaining/next offset) and the content slice. Aggregate first; fetch further slices only when needed.`

/**
 * Build the four tool definitions.  Async only because of the optional zod
 * load; every pipeline itself is runtime-defensive against raw args.  Every
 * execute() funnels through toToolResult so the return value ALWAYS satisfies
 * the host ToolResult contract ({output: string}) — handles, structured
 * errors, pages and degraded warnings included.
 * `pipelines` lets the caller inject a SHARED pipeline instance (tm/index
 * reuses one instance for the main tools AND tm_webfetch so their step ids
 * never collide); when omitted, a fresh instance is built from deps.
 */
export async function buildTmTools(
  deps: TmDeps,
  pipelines?: TmPipelines,
): Promise<Record<string, ToolDefinition>> {
  const pl = pipelines ?? buildPipelines(deps)
  const argsSchemas = await buildArgsSchemas()
  return {
    tm_read: {
      description: TM_READ_DESCRIPTION,
      args: argsSchemas.tm_read,
      execute: async (args, ctx) => toToolResult(await pl.tmRead(args ?? {}, ctx)),
    },
    tm_grep: {
      description: TM_GREP_DESCRIPTION,
      args: argsSchemas.tm_grep,
      execute: async (args, ctx) => toToolResult(await pl.tmGrep(args ?? {}, ctx)),
    },
    tm_bash: {
      description: TM_BASH_DESCRIPTION,
      args: argsSchemas.tm_bash,
      execute: async (args, ctx) => toToolResult(await pl.tmBash(args ?? {}, ctx)),
    },
    tm_fetch: {
      description: TM_FETCH_DESCRIPTION,
      args: argsSchemas.tm_fetch,
      execute: async (args, ctx) => toToolResult(await pl.tmFetch(args ?? {}, ctx)),
    },
  }
}

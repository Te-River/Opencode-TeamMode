/**
 * #38 runtime fallback — is the configured `default_agent` role actually on disk?
 *
 * The plugin cannot see config-directory roles through `ctx.agent`: a zero-token
 * probe measured `ctx.agent.list({})` returning only the 7 built-ins and
 * `ctx.agent.get({agentID:"team"})` → `Agent not found: team`.  So the only way
 * to warn about a `default_agent` that points at a role file which does not exist
 * is to read the global config from disk ourselves.
 *
 * Why this matters: the host falls back to `build` SILENTLY when `default_agent`
 * names a missing agent, so the user's sessions quietly stop being Team and
 * nothing says so.  This check turns that silence into one warning line.
 *
 * Boundaries, all deliberate:
 *  · never throws — a missing/unreadable/unparseable config is a counted state,
 *    not a startup failure;
 *  · never prints config CONTENT — only the role name and the file path it looked
 *    for (the two facts the user needs to fix it);
 *  · reads only the global config dir the host itself reads.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface DefaultAgentCheck {
  /** ok = the role file exists; missing-role = default_agent names a role with no
   *  file; no-default = the key is absent; no-config = no config file found;
   *  unreadable = the file exists but could not be read or parsed. */
  state: "ok" | "missing-role" | "no-default" | "no-config" | "unreadable"
  defaultAgent?: string
  roleFile?: string
}

/** The global config dir the host reads: `OPENCODE_CONFIG_DIR` when set, else
 *  `~/.config/opencode` (on Windows `os.homedir()` reads `USERPROFILE`). */
export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENCODE_CONFIG_DIR
  if (typeof override === "string" && override.trim()) return override.trim()
  return path.join(os.homedir(), ".config", "opencode")
}

/** Strip `//` line and block comments so a JSONC file parses as JSON.  A tiny
 *  state machine, because a naive regex would eat a `//` inside a string value. */
function stripJsonc(src: string): string {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1]
    if (inLine) {
      if (ch === "\n") {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (ch === "\\") {
        out += next ?? ""
        i++
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      inLine = true
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  return out
}

export function checkDefaultAgentRole(opts: {
  configDir: string
  readFile?: (p: string) => string
  exists?: (p: string) => boolean
}): DefaultAgentCheck {
  const readFile = opts.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"))
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p))
  const candidates = [
    path.join(opts.configDir, "opencode.jsonc"),
    path.join(opts.configDir, "opencode.json"),
  ]
  let raw: string | null = null
  for (const c of candidates) {
    try {
      if (exists(c)) {
        raw = readFile(c)
        break
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (raw === null) return { state: "no-config" }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonc(raw))
  } catch {
    return { state: "unreadable" }
  }
  const def =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).default_agent : undefined
  if (typeof def !== "string" || !def.trim()) return { state: "no-default" }

  const role = def.trim()
  const roleFile = path.join(opts.configDir, "agents", `${role}.md`)
  try {
    if (exists(roleFile)) return { state: "ok", defaultAgent: role, roleFile }
  } catch {
    return { state: "unreadable" }
  }
  return { state: "missing-role", defaultAgent: role, roleFile }
}

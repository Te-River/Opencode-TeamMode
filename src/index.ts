/**
 * opencode-team-mode — OpenCode plugin entry point.
 *
 * Exports the hybrid object shape required by the current OpenCode Desktop
 * loader (v1.18.x):
 *  - `id`      → display name in the Desktop plugin list
 *  - `server`  → v1 loader gate; MUST exist or loading is rejected with
 *                "must default export an object with server()"
 *  - `setup`   → v2 domain injection (agent/command transform), real payload
 *
 * Options (via the tuple plugin form):
 *   "plugin": [["@te-river/opencode-team-mode@latest", { "ttlDays": 7 }]]
 * `ttlDays` controls blackboard auto-cleanup; default 5.
 */

import type { OpenCodePlugin } from "./types.js"
import { agents } from "./agents.js"
import { commands } from "./commands.js"
import {
  startBlackboardMaintenance,
  resolveTtlMs,
  DEFAULT_TTL_DAYS,
} from "./blackboard.js"

/** Best-effort workspace directory from plugin context, else cwd. */
function resolveDirectory(ctx: { directory?: unknown; project?: unknown }): string {
  for (const candidate of [ctx.directory, ctx.project]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return process.cwd()
}

/** Runtime addendum to the team-lead prompt: concrete board + TTL. */
function blackboardNote(root: string, ttlDays: number): string {
  return [
    "",
    "",
    "## Team Blackboard — resolved for this workspace",
    `Root directory: \`${root}\``,
    `- Create exactly ONE task sub-directory per multi-agent task: \`<root>/<task-slug>/\`.`,
    `- Auto-cleanup: the plugin sweeps task directories idle for more than ${ttlDays} days.`,
    `  Your own delete-after-report is the fast path; the sweep is the safety net.`,
  ].join("\n")
}

const plugin: OpenCodePlugin = {
  id: "team-mode",

  /** v1 loader gate — no v1 hooks needed, the v2 setup does everything. */
  server: async () => ({}),

  setup: async (ctx) => {
    // ---------- blackboard maintenance (code-level TTL sweeper) ----------
    const directory = resolveDirectory(ctx)
    const ttlMs = resolveTtlMs(ctx.options)
    const ttlDays = Math.round(ttlMs / (24 * 60 * 60 * 1000)) || DEFAULT_TTL_DAYS
    const boardRoot = startBlackboardMaintenance(directory, ttlMs)

    // ---------- inject team agents (v2 AgentV2Info fields) ----------
    await ctx.agent.transform((agent) => {
      for (const [name, def] of Object.entries(agents)) {
        agent.update(name, (item) => {
          item.description = def.description
          item.mode = def.mode
          item.system =
            name === "team-lead"
              ? (def.system ?? "") + blackboardNote(boardRoot, ttlDays)
              : def.system
          item.color = def.color
          // Authoritative v2 ruleset — overrides any stale file-based agent
          // definition that might deny blackboard writes.
          if (def.permissions) item.permissions = def.permissions
        })
      }
    })

    // ---------- inject team commands (v2 CommandV2Info fields) ----------
    await ctx.command.transform((command) => {
      for (const [name, def] of Object.entries(commands)) {
        command.update(name, (item) => {
          item.name = name
          item.description = def.description
          item.template = def.template ?? ""
          item.agent = def.agent
        })
      }
    })
  },
}

export default plugin

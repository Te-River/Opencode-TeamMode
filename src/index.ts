/**
 * opencode-team-mode — OpenCode v2 plugin entry point.
 *
 * Uses the v2 Promise API with an explicit `id` field.  The `id` is the
 * display name shown in OpenCode Desktop's plugin list (instead of the
 * raw file path).
 *
 * Options (via the tuple plugin form):
 *   "plugin": [["@te-river/opencode-team-mode", { "ttlDays": 7 }]]
 * `ttlDays` controls blackboard auto-cleanup; default 5.
 */

import { define } from "./types.js"
import type { PluginContext } from "./types.js"
import { agents } from "./agents.js"
import { commands } from "./commands.js"
import {
  startBlackboardMaintenance,
  resolveTtlMs,
  DEFAULT_TTL_DAYS,
} from "./blackboard.js"

/** Best-effort workspace directory from plugin context, else cwd. */
function resolveDirectory(ctx: PluginContext): string {
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

export const Plugin = define({
  id: "team-mode",

  setup: async (ctx) => {
    // ---------- blackboard maintenance (code-level TTL sweeper) ----------
    const directory = resolveDirectory(ctx)
    const ttlMs = resolveTtlMs(ctx.options)
    const ttlDays = Math.round(ttlMs / (24 * 60 * 60 * 1000)) || DEFAULT_TTL_DAYS
    const boardRoot = startBlackboardMaintenance(directory, ttlMs)

    // ---------- inject team agents ----------
    await ctx.agent.transform((agent) => {
      for (const [name, def] of Object.entries(agents)) {
        agent.update(name, (item) => {
          item.description = def.description
          item.mode = def.mode
          item.prompt =
            name === "team-lead"
              ? def.prompt + blackboardNote(boardRoot, ttlDays)
              : def.prompt
          item.color = def.color
        })
      }
    })

    // ---------- inject team commands ----------
    await ctx.command.transform((command) => {
      for (const [name, def] of Object.entries(commands)) {
        command.update(name, (item) => {
          item.description = def.description
          item.template = def.template
          item.agent = def.agent
        })
      }
    })
  },
})

export default Plugin

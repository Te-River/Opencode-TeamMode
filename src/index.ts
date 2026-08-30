/**
 * opencode-team-mode — OpenCode plugin entry point.
 *
 * Contract with the SHIPPED OpenCode Desktop loader (1.18.x, verified by
 * reading the binary's own applyPlugin/readV1Plugin code):
 *
 *   export default {
 *     id: "team-mode",                     → Desktop plugin display name
 *     server: async (input, options) => ({ config(cfg) { ...inject... } })
 *   }
 *
 * `server()` is the ONLY function the loader calls; a `setup` property is
 * silently ignored (root cause of v1.1-v1.3 not appearing in the picker).
 * The v1 `config` hook receives the merged opencode config and is the
 * supported way to add agents/commands.
 *
 * Options (via the tuple plugin form):
 *   "plugin": [["@te-river/opencode-team-mode@latest", { "ttlDays": 7 }]]
 * `ttlDays` controls blackboard auto-cleanup; default 5.
 */

import type { OpenCodePlugin, OpenCodeConfig } from "./types.js"
import { agents } from "./agents.js"
import { commands } from "./commands.js"
import {
  startBlackboardMaintenance,
  resolveTtlMs,
  DEFAULT_TTL_DAYS,
} from "./blackboard.js"

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

  server: async (input, options) => {
    // ---------- blackboard maintenance (code-level TTL sweeper) ----------
    const directory =
      typeof input?.directory === "string" && input.directory.length > 0
        ? input.directory
        : process.cwd()
    const ttlMs = resolveTtlMs(options)
    const ttlDays = Math.round(ttlMs / (24 * 60 * 60 * 1000)) || DEFAULT_TTL_DAYS
    const boardRoot = startBlackboardMaintenance(directory, ttlMs)
    const note = blackboardNote(boardRoot, ttlDays)

    return {
      // ---------- v1 config hook: inject agents & commands ----------
      config(cfg: OpenCodeConfig) {
        if (!cfg.agent) cfg.agent = {}
        for (const [name, def] of Object.entries(agents)) {
          // Respect user-defined overrides: never clobber an existing entry.
          if (cfg.agent[name]) continue
          cfg.agent[name] = {
            ...def,
            prompt: name === "team-lead" ? (def.prompt ?? "") + note : def.prompt,
          }
        }

        if (!cfg.command) cfg.command = {}
        for (const [name, def] of Object.entries(commands)) {
          if (cfg.command[name]) continue
          cfg.command[name] = def
        }
      },
    }
  },
}

export default plugin

/**
 * opencode-team-mode — OpenCode v2 plugin entry point.
 *
 * Uses the v2 Promise API with an explicit `id` field.  The `id` is the
 * display name shown in OpenCode Desktop's plugin list (instead of the
 * raw file path).
 */

import { define } from "./types.js"
import { agents } from "./agents.js"
import { commands } from "./commands.js"

export const Plugin = define({
  id: "team-mode",

  setup: async (ctx) => {
    // ---------- inject team agents ----------
    await ctx.agent.transform((agent) => {
      for (const [name, def] of Object.entries(agents)) {
        agent.update(name, (item) => {
          item.description = def.description
          item.mode = def.mode
          item.prompt = def.prompt
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

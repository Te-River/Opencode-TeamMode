/**
 * opencode-team-mode — OpenCode plugin entry point.
 *
 * Registers specialized team agents and workflow commands into the
 * OpenCode config via the `config` hook.  Works in both OpenCode Desktop
 * (Electron) and the terminal TUI.
 */

import type { Plugin, OpenCodeConfig } from "./types.js"
import { agents } from "./agents.js"
import { commands } from "./commands.js"

const plugin: Plugin = async (_input, _options?) => {
  return {
    /**
     * Mutate the merged OpenCode config at startup.
     * We inject our team agents and commands so users see them
     * immediately — no manual file copying required.
     */
    config(cfg: OpenCodeConfig) {
      // ---------- inject agents ----------
      if (!cfg.agent) cfg.agent = {}
      for (const [name, def] of Object.entries(agents)) {
        // Respect user overrides: only inject if the user has not
        // already defined an agent with the same name.
        if (!cfg.agent[name]) {
          cfg.agent[name] = def
        }
      }

      // ---------- inject commands ----------
      if (!cfg.command) cfg.command = {}
      for (const [name, def] of Object.entries(commands)) {
        if (!cfg.command[name]) {
          cfg.command[name] = def
        }
      }
    },
  }
}

export default plugin

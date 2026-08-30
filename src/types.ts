/**
 * OpenCode plugin type definitions — contract for the shipped 1.18.x loader.
 *
 * Verified against the desktop binary's own loader code
 * (app.asar/out/main/chunks/node-*.js, readV1Plugin + applyPlugin):
 *
 *   async function applyPlugin(load, input, hooks) {
 *     const plugin = readV1Plugin(load.mod, load.spec, "server", "detect");
 *     if (plugin) {
 *       hooks.push(await plugin.server(input, load.options));   // ← only server()
 *       return;
 *     }
 *     // legacy: bare function default export also works
 *   }
 *
 * Facts encoded here:
 *  - `setup` is NEVER called on this loader version (v1.1-v1.3 died here).
 *  - default export MUST be an object with a `server(input, options)`
 *    function; `id` on the object controls the Desktop plugin display name.
 *  - server() returns v1 Hooks; the `config(cfg)` hook receives the merged
 *    opencode config and is the working mechanism to inject agents/commands.
 *  - Agent/command entries inside cfg use the v1 config shape:
 *    prompt (string) + permission (object keyed by tool).
 */

// ---------- v1 config shapes (what we mutate in the config hook) ----------

export interface AgentPermission {
  [tool: string]: string | Record<string, string>
}

export interface AgentConfig {
  description?: string
  mode?: "primary" | "subagent" | "all"
  /** v1 config field for the system prompt (NOT `system`). */
  prompt?: string
  model?: string
  color?: string
  hidden?: boolean
  steps?: number
  temperature?: number
  permission?: AgentPermission
  [key: string]: unknown
}

export interface CommandConfig {
  description?: string
  template?: string
  agent?: string
  [key: string]: unknown
}

export interface OpenCodeConfig {
  agent?: Record<string, AgentConfig>
  command?: Record<string, CommandConfig>
  [key: string]: unknown
}

// ---------- v1 hooks returned from server() ----------

export interface Hooks {
  config?: (cfg: OpenCodeConfig) => void | Promise<void>
  [hook: string]: unknown
}

// ---------- input passed to server() ----------

export interface PluginInput {
  client: unknown
  project: string
  directory: string
  worktree?: string
  $?: unknown
  serverUrl?: URL
  [key: string]: unknown
}

// ---------- the hybrid plugin object the loader accepts ----------

export interface OpenCodePlugin {
  readonly id: string
  readonly server: (
    input: PluginInput,
    options?: Record<string, unknown>,
  ) => Promise<Hooks>
}

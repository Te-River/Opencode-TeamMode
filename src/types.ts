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

/** Input to the `tool.execute.before` hook (official 1.x docs shape). */
export interface ToolExecuteBeforeInput {
  tool?: string
  sessionID?: string
  callID?: string
  [key: string]: unknown
}

/** Mutable output of the `tool.execute.before` hook; `args` are the tool args. */
export interface ToolExecuteBeforeOutput {
  args?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Official 1.18.x tool result contract (tool.d.ts:39-46): execute() resolves
 * to a plain string OR an object whose `output` string is what the model
 * sees.  Anything else (bare handles, structured error objects) breaks the
 * host's result pipeline — real-session crash `c.split` on a non-string —
 * so every return path must ride inside `output`.
 */
export interface ToolResultObject {
  output: string
  [key: string]: unknown
}

export type ToolResult = string | ToolResultObject

/**
 * A single statically-registered plugin tool (T0.4 live-probe shape:
 * `{ tool: { <name>: { description, args, execute(args, ctx) } } }`).
 * `args` is a ZodRawShape ({key: validator}) when the host resolves zod —
 * NOT a z.object(): the host serializes the raw shape into the LLM parameter
 * spec, and a z.object wrapper produced `{def:{command:...}}` garbage args
 * in real sessions.  Plain arg descriptors are tolerated when zod is absent;
 * execute() must be defensive either way.
 */
export interface ToolDefinition {
  description?: string
  args?: unknown
  execute?: (args: Record<string, unknown>, ctx?: unknown) => ToolResult | Promise<ToolResult>
  [key: string]: unknown
}

export interface Hooks {
  config?: (cfg: OpenCodeConfig) => void | Promise<void>
  /**
   * Runs before every tool call; throwing inside it turns the call into a
   * failed tool result whose error text is returned to the model (verified
   * live on 1.18.29) — the mechanism behind R6 env protection.
   */
  "tool.execute.before"?: (
    input: ToolExecuteBeforeInput,
    output: ToolExecuteBeforeOutput,
  ) => void | Promise<void>
  /**
   * Static tool registration segment (T0.4-verified): plugin-owned tools
   * appear on the tool surface next to the built-ins.  TeamMode registers
   * tm_read / tm_grep / tm_bash / tm_fetch here.
   */
  tool?: Record<string, ToolDefinition>
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

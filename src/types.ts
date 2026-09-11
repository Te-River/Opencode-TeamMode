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

/**
 * v1 permission block — doubles as the agent tool whitelist (Phase 2 /
 * T2.1, T0.4③-verified): a "deny" entry removes the built-in tool from the
 * model's tool surface entirely, so a whitelist is expressed as
 * deny-everything-excluded + "allow" for the kept set (built-in names plus
 * the "tm_*" wildcard for the governed tools; probe-verified shape).
 */
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
 * A pending host permission request as observed LIVE on 1.18.29
 * (`permission.asked` properties via SSE):
 *   { id, sessionID, permission: "bash", patterns: [<command segments>],
 *     metadata: { command }, always: [<host generalization proposal for the
 *     "always" verdict, e.g. "Get-ChildItem *" for `Get-ChildItem env:PATH`>],
 *     tool: { messageID, callID } }
 * — NOTE the props carry NO `type` field (the tool name rides in
 * `permission`); the shipped SDK d.ts still spells the same payload
 * `Permission` (id/type/pattern?/sessionID/messageID/callID?/title/
 * metadata/time) behind a `permission.updated` event name.  Every field is
 * optional here because the plugin reads it DEFENSIVELY and accepts both
 * spellings.  Never logged verbatim (R6 privacy red line — the audit stores
 * only a derived category).
 */
export interface PendingPermission {
  id?: string
  sessionID?: string
  messageID?: string
  /** SDK d.ts spelling of the tool name; the live host uses `permission`. */
  type?: string
  permission?: string
  pattern?: string | string[]
  patterns?: string | string[]
  /** What "always" would record host-wide — usually BROADER than the ask
   *  (see the READMEs' "prefer once" guidance); never trusted by the gate. */
  always?: string | string[]
  callID?: string
  title?: string
  metadata?: Record<string, unknown>
  tool?: { messageID?: string; callID?: string }
  time?: { created?: number }
}

/**
 * Any event bus payload.  The plugin's `event` hook receives EVERY host
 * event (live-proven on 1.18.29: session.*, message.*, permission.asked,
 * permission.replied, …); index.ts narrows and routes permission events to
 * the approval gate and `message.updated` (UserMessage carries
 * { sessionID, role:"user", agent }) to the gate's exec-role session
 * registry BEFORE forwarding.
 */
export interface HostEvent {
  type?: string
  properties?: Record<string, unknown>
}

/**
 * The subset of the host `Event` union the approval gate consumes
 * (live-host names, with the d.ts spellings kept as accepted aliases):
 *   permission.asked / permission.updated → properties = PendingPermission
 *   (a request is now pending, awaiting a human or the timeout),
 *   permission.replied → properties = { sessionID, requestID, reply } on the
 *   live 1.18.29 wire and sometimes ONLY { sessionID } at the plugin hook —
 *   the d.ts spells the fields { sessionID, permissionID, response }.  The
 *   gate accepts every spelling, cancels the session's whole pending set on
 *   any of them, and only maps a verdict when a reply/response word is
 *   actually present.
 */
export interface PermissionEvent {
  type?: string
  properties?: PendingPermission & {
    permissionID?: string
    requestID?: string
    response?: string
    reply?: string
  }
}

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
   * Event channel (official 1.18.x plugin contract, index.d.ts:175).  The
   * approval gate watches `permission.asked`/`permission.updated` (register
   * a pending timeout + env-face session registration) and
   * `permission.replied` (cancel the session's whole pending set);
   * `message.updated` routes exec-role user prompts into the gate's session
   * registry — the R6 env face and the R2 danger face share this ONE timer.
   */
  event?: (input: { event: HostEvent }) => void | Promise<void>
  /**
   * Called when a new user message enters a session (plugin d.ts:187 — the
   * input carries { sessionID, agent? }).  Secondary pre-tool registration
   * channel for the approval gate's deferral whitelist (the primary one is
   * the `message.updated` event, proven live even where this hook may be
   * absent — cf. `permission.ask` which is d.ts-listed yet never fires on
   * 1.18.29).
   */
  "chat.message"?: (
    input: { sessionID?: string; agent?: string; [key: string]: unknown },
    output?: unknown,
  ) => void | Promise<void>
  /** Process teardown (clear the gate's poll interval + pending timers). */
  dispose?: () => void | Promise<void>
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

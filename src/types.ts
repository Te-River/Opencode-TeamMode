/**
 * Shared type definitions for the v2-only package.
 *
 * This file used to carry the OpenCode 1.18.x loader contract (`server()`,
 * `Hooks`, `OpenCodePlugin`, the `tool.execute.before` payloads).  v1 support
 * was removed in 1.7.0, so those types are gone; what remains is the internal
 * contract the tm_* tools and the v2 adapters share — the tool result /
 * definition shapes, the host event shape, and the agent/command config
 * shapes the v2 config generator reads.
 */

// ---------- agent / command config shapes (read by the v2 config generator) ----------

/**
 * The permission block — doubles as the agent tool whitelist (Phase 2 /
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
  /** The config field for the system prompt (NOT `system`). */
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

// ---------- tool contract ----------

/**
 * The tool result contract: execute() resolves to a plain string OR an object
 * whose `output` string is what the model sees.  Anything else (bare handles,
 * structured error objects) breaks the host's result pipeline — real-session
 * crash `c.split` on a non-string — so every return path must ride inside
 * `output`.
 *
 * `attachments` is the SAME contract (`ToolAttachment`): a
 * `{type:"file", mime, url}` entry the host turns into a FilePart on the tool
 * result, which is how tm_browser hands a screenshot's PIXELS to a vision
 * model instead of only a path.  It is opt-in per call (token economy) and
 * every attachment-producing path still writes the file and prints its path,
 * so a host that ignores `attachments` degrades to the old path-only
 * behavior rather than losing the artifact.
 */
export interface ToolAttachment {
  type: "file"
  mime: string
  /** data: URL (base64) or a file/asset URL the host understands. */
  url: string
  filename?: string
}

export interface ToolResultObject {
  output: string
  attachments?: ToolAttachment[]
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

// ---------- host events ----------

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
 * Any event bus payload.  The v2 event feed forwards only whitelisted type
 * names (see `src/host/v2-events.ts`), and the approval gate reads the
 * permission spellings above; every consumer narrows defensively because the
 * host makes no stability promise about this shape.
 */
export interface HostEvent {
  type?: string
  properties?: Record<string, unknown>
}

// ---------- tm runtime input ----------

/** The host-input shape the tm runtime is built with (v2 assembles one from
 *  the plugin ctx; see `src/host/v2.ts`). */
export interface PluginInput {
  client: unknown
  project: string
  directory: string
  worktree?: string
  $?: unknown
  serverUrl?: URL
  [key: string]: unknown
}

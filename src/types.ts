/**
 * OpenCode plugin type definitions (1.18.x dual-stack loader).
 *
 * IMPORTANT: the current OpenCode Desktop loader validates plugins with the
 * v1 schema (default export MUST have `server()`) while ALSO invoking an
 * optional v2-style `setup(context)` on the same object. The only shape that
 * actually loads is the hybrid:
 *
 *   export default { id, server: async () => ({}), setup: async (ctx) => {} }
 *
 * A pure v2 `define({ id, setup })` export is REJECTED with
 * "must default export an object with server()".
 *
 * v2 agent/command item shapes below are taken from
 * @opencode-ai/sdk/v2/types (AgentV2Info / CommandV2Info).
 */

// ---------- v2 permission ruleset ----------

export type PermissionEffect = "allow" | "deny" | "ask"

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

export const RULE = (
  action: string,
  resource: string,
  effect: PermissionEffect,
): PermissionRule => ({ action, resource, effect })

// ---------- v2 agent / command shapes ----------

export interface AgentItem {
  description?: string
  /** "primary" shows in the Desktop agent switcher; sub-agents use "subagent". */
  mode?: "primary" | "subagent" | "all"
  /** System prompt — v2 field name is `system`, NOT `prompt`. */
  system?: string
  color?: string
  hidden?: boolean
  steps?: number
  temperature?: number
  /** v2 ruleset array — NOT the v1 permission object. */
  permissions?: PermissionRule[]
  [key: string]: unknown
}

export interface CommandItem {
  name?: string
  description?: string
  template?: string
  agent?: string
  subtask?: boolean
  [key: string]: unknown
}

// ---------- v2 draft editors ----------

export interface AgentDraft {
  list(): readonly AgentItem[]
  get(id: string): AgentItem | undefined
  default(id: string | undefined): void
  /** Upsert: creates the entry when missing, then applies the updater. */
  update(id: string, update: (agent: AgentItem) => void): void
  remove(id: string): void
}

export interface CommandDraft {
  list(): readonly CommandItem[]
  get(name: string): CommandItem | undefined
  update(name: string, update: (command: CommandItem) => void): void
  remove(name: string): void
}

// ---------- v2 plugin context ----------

export interface PluginContext {
  agent: {
    transform<T>(
      cb: (draft: AgentDraft) => T | Promise<T>,
    ): Promise<T | undefined>
    reload(): Promise<void>
  }
  command: {
    transform<T>(
      cb: (draft: CommandDraft) => T | Promise<T>,
    ): Promise<T | undefined>
    reload(): Promise<void>
  }
  options?: Record<string, unknown>
  directory?: string
  project?: string
  [key: string]: unknown
}

// ---------- hybrid plugin shape required by the 1.18.x loader ----------

export interface OpenCodePlugin {
  readonly id: string
  /** v1 loader gate: MUST exist. Return the (empty) v1 hooks object. */
  readonly server: () => Promise<Record<string, unknown>>
  /** v2 domain injection: the real payload. */
  readonly setup: (ctx: PluginContext) => Promise<void>
}

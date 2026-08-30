/**
 * OpenCode v2 Plugin type definitions.
 *
 * These types match the v2 Promise plugin API used by OpenCode Desktop.
 * The v2 format requires an `id` field which controls the display name
 * shown in the Desktop UI.
 */

// ---------- plugin context ----------

export interface AgentItem {
  description?: string
  mode?: "primary" | "subagent" | "all"
  prompt?: string
  model?: string
  color?: string
  hidden?: boolean
  permission?: Record<string, unknown>
  [key: string]: unknown
}

export interface CommandItem {
  description?: string
  template?: string
  agent?: string
  model?: string
  [key: string]: unknown
}

export interface TransformEditor<T> {
  update(name: string, updater: (item: T) => void): void
}

export interface PluginContext {
  agent: {
    transform<T = void>(
      callback: (editor: TransformEditor<AgentItem>) => T | Promise<T>,
    ): Promise<T>
    reload(): Promise<void>
  }
  command: {
    transform<T = void>(
      callback: (editor: TransformEditor<CommandItem>) => T | Promise<T>,
    ): Promise<T>
    reload(): Promise<void>
  }
  options?: Record<string, unknown>
  [key: string]: unknown
}

// ---------- plugin definition ----------

export interface PluginDefinition {
  readonly id: string
  readonly setup: (ctx: PluginContext) => Promise<void>
}

export function define(plugin: PluginDefinition): PluginDefinition {
  return plugin
}

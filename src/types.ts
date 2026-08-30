/**
 * OpenCode Plugin type definitions.
 *
 * These are minimal structural types matching the OpenCode plugin API so the
 * plugin compiles without a hard dependency on `@opencode-ai/plugin`.
 * When the official package is available as a peer dependency you can swap
 * these for the real imports.
 */

// ---------- plugin input ----------

export interface PluginInput {
  /** HTTP client for the local OpenCode instance */
  client: unknown
  /** Absolute path to the project root */
  project: string
  /** Working directory (may differ from project in monorepos) */
  directory: string
  /** Shell helper (backtick-style command execution) */
  $: unknown
}

// ---------- config shapes we mutate ----------

export interface AgentPermission {
  [tool: string]: string | Record<string, string>
}

export interface AgentConfig {
  model?: string
  variant?: string
  mode?: "primary" | "subagent" | "all"
  description?: string
  prompt?: string
  hidden?: boolean
  color?: string
  steps?: number
  options?: Record<string, unknown>
  permission?: AgentPermission
  disable?: boolean
  temperature?: number
  top_p?: number
}

export interface CommandConfig {
  description?: string
  template?: string
  agent?: string
  model?: string
  variant?: string
  subtask?: boolean
}

export interface OpenCodeConfig {
  agent?: Record<string, AgentConfig>
  command?: Record<string, CommandConfig>
  [key: string]: unknown
}

// ---------- hooks & plugin ----------

export interface Hooks {
  config?: (cfg: OpenCodeConfig) => void
  tool?: Record<string, unknown>
  [hook: string]: unknown
}

export type Plugin = (
  input: PluginInput,
  options?: Record<string, unknown>,
) => Promise<Hooks>

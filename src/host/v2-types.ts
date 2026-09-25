/**
 * Hand-written structural types for the OpenCode v2 plugin surface.
 *
 * We deliberately do NOT import `@opencode/plugin`: it is a separate package
 * from the v1 SDK, and a v2 SDK that becomes a runtime dependency would break
 * the dual-personality export for every v1 user who cannot resolve it.  The
 * shapes below cover only the members this plugin actually touches, and they
 * are transcribed from `@opencode/plugin@2.0.16/dist/promise/*.d.ts` plus two
 * live-host probes (2026-09-25) — the probe is what proves `hook()` returns a
 * disposable registration and that `execute.before` can really deny.
 *
 * Kept intentionally loose (`unknown` where we only pass values through): a
 * type that is wider than the host's never fails a build, and every field we
 * READ is read defensively because the host makes no stability promise.
 */

export interface V2Registration {
  readonly dispose: () => Promise<void>
}

/** `Hooks<Spec>` in the SDK: register by name, get a disposable back. */
export type V2Hooks<Spec> = <Name extends keyof Spec>(
  name: Name,
  callback: (input: Spec[Name]) => Promise<void> | void,
) => Promise<V2Registration>

/** `Transform<Input>` in the SDK: mutate an in-memory editor. */
export type V2Transform<Input> = (
  callback: (input: Input) => void,
) => Promise<V2Registration>

// ---------- tools ----------

export interface V2TextContent {
  type: "text"
  text: string
}

export interface V2FileContent {
  type: "file"
  uri: string
  mime: string
  name?: string
}

export type V2Content = V2TextContent | V2FileContent

/**
 * `Tool.Result`.  A live probe measured the host's own rejection of the v1
 * shape: returning `{output: "<text>"}` with no declared `output` schema came
 * back as "Tool result declared output without an output schema" for all three
 * probe tools — so this plugin's v2 adapters return `content` instead.
 */
export interface V2ToolResult {
  content?: string | ReadonlyArray<V2Content>
  metadata?: Record<string, unknown>
}

export interface V2ToolContext {
  readonly sessionID: string
  readonly agent: string
  readonly messageID?: string
  readonly id?: string
  readonly signal?: AbortSignal
  readonly progress?: (update: unknown) => Promise<void>
}

export interface V2ToolInfo {
  readonly name: string
  readonly description: string
  /** A JSON Schema object; the host also accepts zod/StandardSchema. */
  readonly input: unknown
  readonly execute: (
    args: Record<string, unknown>,
    context: V2ToolContext,
  ) => Promise<V2ToolResult>
  readonly options?: {
    readonly namespace?: string
    readonly permission?: string
    readonly codemode?: boolean
  }
}

export interface V2ToolEditor {
  list(): ReadonlyArray<V2ToolInfo & { id?: string }>
  get(id: string): (V2ToolInfo & { id?: string }) | undefined
  add(tool: V2ToolInfo): void
  update?(id: string, update: (tool: V2ToolInfo) => void): void
  remove?(id: string): void
  namespace?(namespace: unknown): void
}

export interface V2ToolExecuteBefore {
  readonly tool: string
  readonly sessionID: string
  readonly agent?: string
  input: unknown
}

export interface V2ToolExecuteAfter {
  readonly tool: string
  readonly sessionID: string
  readonly agent?: string
  readonly status: "completed" | "error"
  readonly result?: unknown
  readonly error?: unknown
}

export interface V2ToolHooks {
  readonly "execute.before": V2ToolExecuteBefore
  readonly "execute.after": V2ToolExecuteAfter
}

export interface V2ToolDomain {
  readonly transform: V2Transform<V2ToolEditor>
  readonly list: () => Promise<ReadonlyArray<V2ToolInfo & { id?: string }>>
  readonly hook: V2Hooks<V2ToolHooks>
  readonly reload?: () => Promise<void>
}

// ---------- agents (config-declared; the plugin may only normalize) ----------

export interface V2PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

export interface V2AgentInfo {
  id?: string
  name?: string
  description?: string
  /** v2's spelling of v1's `prompt`. */
  system?: string
  mode?: "subagent" | "primary" | "all"
  hidden?: boolean
  color?: string
  permissions?: V2PermissionRule[]
  [key: string]: unknown
}

export interface V2AgentEditor {
  list(): ReadonlyArray<V2AgentInfo>
  get(id: string): V2AgentInfo | undefined
  default(id: string | undefined): void
  update(id: string, update: (agent: V2AgentInfo) => void): void
  remove(id: string): void
}

export interface V2AgentDomain {
  readonly transform: V2Transform<V2AgentEditor>
  readonly list?: () => Promise<ReadonlyArray<V2AgentInfo>>
}

// ---------- permissions ----------

/**
 * `PermissionEvaluation` — `effect` is the mutable decision.  A live probe saw
 * the host itself produce `effect:"ask"` (for an out-of-workspace
 * `external_directory` read) and publish `permission.asked` afterwards, so an
 * `ask` written here is honored by a real dialog.  Observed `action` values:
 * `shell` / `read` / `edit` / `external_directory`, with `resources` carrying
 * the concrete command line or path.
 */
export interface V2PermissionEvaluation {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  effect: "allow" | "deny" | "ask"
  message?: string
}

export interface V2PermissionDomain {
  readonly hook: V2Hooks<{ evaluate: V2PermissionEvaluation }>
  readonly list?: (input?: unknown) => Promise<unknown>
  readonly get?: (input?: unknown) => Promise<unknown>
  readonly reply?: (input?: unknown) => Promise<unknown>
}

// ---------- session ----------

export interface V2SessionContext {
  readonly agent?: string
  readonly system: unknown[]
  readonly messages: unknown[]
  readonly tools: Record<string, { description: string; input: unknown }>
  options: Record<string, unknown>
}

export interface V2SessionHooks {
  readonly prompt: { sessionID?: string; prompt: unknown }
  readonly context: V2SessionContext
  readonly compaction: V2SessionContext & { result?: unknown }
}

export interface V2SessionDomain {
  readonly hook: V2Hooks<V2SessionHooks>
  readonly [key: string]: unknown
}

// ---------- shell / storage / events ----------

export interface V2ShellCreateBefore {
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

export interface V2ShellDomain {
  readonly hook: V2Hooks<{ "create.before": V2ShellCreateBefore }>
}

export interface V2StorageDomain {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
  readonly remove: (key: string) => Promise<void>
  readonly scan: (options: unknown) => Promise<unknown>
}

export interface V2Event {
  readonly type?: string
  readonly data?: unknown
}

// ---------- the context handed to setup() ----------

export interface V2Context {
  readonly location?: {
    readonly directory?: string
    readonly project?: { readonly directory?: string; readonly id?: string }
  }
  readonly options?: Record<string, unknown>
  readonly tool: V2ToolDomain
  readonly agent?: V2AgentDomain
  readonly permission?: V2PermissionDomain
  readonly session?: V2SessionDomain
  readonly shell?: V2ShellDomain
  readonly storage?: V2StorageDomain
  readonly event?: { readonly subscribe: () => AsyncIterable<V2Event> }
  readonly [key: string]: unknown
}

export type V2Cleanup = () => Promise<void> | void

export interface V2Plugin {
  readonly id: string
  readonly setup: (ctx: V2Context) => Promise<V2Cleanup | void> | V2Cleanup | void
}

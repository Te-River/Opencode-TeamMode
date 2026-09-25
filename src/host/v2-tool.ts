/**
 * v1 tool definitions -> v2 tool registrations.
 *
 * Two shapes have to be translated, and both translations are load-bearing:
 *
 * 1. THE RESULT.  v1 tools answer `{output: string, attachments?: [...]}`.  A
 *    live probe measured what the v2 host does with that: every tool that
 *    returned a bare `output` without declaring an `output` schema came back as
 *    "Tool result declared output without an output schema".  So the v2 adapter
 *    answers with `content` parts instead — text plus `file` entries, which is
 *    also the first time tm_browser's screenshot attachment has had a host
 *    contract we can VERIFY rather than assume (the v1 capability row for it is
 *    still 未验证).
 * 2. THE CONTEXT.  Our tools read `{directory, sessionID, agent, ask}` off the
 *    per-call ctx.  v2's ToolContext carries `{sessionID, agent, messageID, id,
 *    progress}` and NO directory and NO ask bridge.  Directory comes from the
 *    boot location; the missing ask bridge is left missing on purpose, because
 *    `askFnOf` then reports "unavailable" and every governed call fails CLOSED
 *    rather than pretending somebody approved it.
 */

import type { ToolDefinition, ToolResultObject, ToolAttachment } from "../types.js"
import type { V2Content, V2ToolContext, V2ToolInfo, V2ToolResult } from "./v2-types.js"

/** zod is a peer the host ships, never a dependency we require: the same
 *  variable-specifier trick `args-schema.ts` uses for the arg schemas. */
async function loadZod(): Promise<Record<string, unknown> | null> {
  try {
    const spec = "zod"
    const mod = (await import(spec)) as { z?: unknown; default?: { z?: unknown } }
    const z = (mod.z ?? mod.default?.z) as Record<string, unknown> | undefined
    return z && typeof z.object === "function" ? z : null
  } catch {
    return null
  }
}

/**
 * `args` is a ZodRawShape (see `src/tm/args-schema.ts`) — but it is a
 * *descriptor* when zod could not be loaded, and it may already be a JSON
 * Schema.  `exact:false` means the model gets no parameter guidance for this
 * tool, which the caller reports instead of hiding: a tool the model cannot
 * call correctly is a tool that is broken, whatever the code says.
 */
export async function inputSchemaFor(
  args: unknown,
): Promise<{ schema: Record<string, unknown>; exact: boolean; note?: string }> {
  if (args && typeof args === "object") {
    const shape = args as Record<string, unknown>
    if (typeof shape.type === "string" && (shape.properties || shape.additionalProperties !== undefined)) {
      return { schema: shape, exact: true }
    }
    const z = await loadZod()
    const toJSONSchema = z?.toJSONSchema as ((s: unknown) => Record<string, unknown>) | undefined
    if (z && toJSONSchema) {
      try {
        const schema = toJSONSchema((z.object as (s: unknown) => unknown)(shape))
        return { schema, exact: true }
      } catch (err) {
        return {
          schema: { type: "object", additionalProperties: true },
          exact: false,
          note: `zod 形状转换失败：${(err as { message?: unknown })?.message ?? String(err)}`,
        }
      }
    }
  }
  return {
    schema: { type: "object", additionalProperties: true },
    exact: false,
    note: "宿主未提供 zod，参数表退化为不限形状",
  }
}

/** The per-execute literal our pipelines expect. */
export function v2ToolCtx(ctx: V2ToolContext, directory: string): Record<string, unknown> {
  const c = (ctx ?? {}) as V2ToolContext & { directory?: unknown }
  return {
    // A future host may carry a per-call directory (sessions CAN move); honor it
    // when present instead of pinning the boot value.
    directory: typeof c.directory === "string" && c.directory ? c.directory : directory,
    sessionID: String(c.sessionID ?? ""),
    agent: String(c.agent ?? ""),
    // NOTE: no `ask` on purpose — see the header.  Adding a stub that resolves
    // would be the self-allowing this codebase refuses.
  }
}

export function v2Result(res: unknown): V2ToolResult {
  // `ToolResult` is a union: most tm_* answers are already plain strings.
  if (typeof res === "string") return { content: [{ type: "text", text: res }] }
  const out = (res ?? {}) as ToolResultObject
  const text = typeof out.output === "string" ? out.output : String(out.output ?? "")
  const content: V2Content[] = [{ type: "text", text }]
  for (const att of (out.attachments ?? []) as ToolAttachment[]) {
    if (!att || typeof att.url !== "string" || !att.url) continue
    content.push({ type: "file", uri: att.url, mime: att.mime, name: att.filename })
  }
  const metadata = (out as { metadata?: Record<string, unknown> }).metadata
  return metadata && typeof metadata === "object"
    ? { content, metadata }
    : { content }
}

export interface V2ToolBinding {
  readonly tool: V2ToolInfo
  readonly inputExact: boolean
  readonly note?: string
}

/**
 * Wrap one v1 ToolDefinition.  `execute` may be absent on exotic hosts; a tool
 * that cannot run must not be registered at all, because the model would spend
 * a round on it and get nothing.
 */
export async function bindV2Tool(
  name: string,
  def: ToolDefinition,
  directory: string,
): Promise<V2ToolBinding | null> {
  if (typeof def?.execute !== "function") return null
  const { schema, exact, note } = await inputSchemaFor(def.args)
  const tool: V2ToolInfo = {
    name,
    description: String(def.description ?? ""),
    input: schema,
    async execute(args, ctx): Promise<V2ToolResult> {
      // Our tools are defensive about raw model args already (they coerce
      // string booleans and JSON-array strings themselves), so nothing is
      // normalized here beyond a guaranteed object.
      const res = await def.execute?.((args ?? {}) as Record<string, unknown>, v2ToolCtx(ctx, directory))
      return v2Result(res)
    },
  }
  return { tool, inputExact: exact, note }
}

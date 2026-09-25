/**
 * The v2 personality: `Plugin.define({id, setup(ctx)})`.
 *
 * `Plugin.define` in @opencode/plugin@2.0.16 is literally `plugin => plugin`,
 * so this module exports the plain object and the v2 SDK never becomes a
 * runtime dependency — which is what keeps the dual-personality package
 * installable by a v1 user who cannot resolve that package at all.
 *
 * Scope of this file (milestone M2): build the governed runtime on a
 * filesystem-backed client shim, register the tm_* tools through
 * `ctx.tool.transform`, and normalize the permission matrix onto the agents the
 * CONFIG declares. It deliberately does NOT touch: the approval gate (#94), the
 * session hooks / compaction / description appends (#93), or the browser
 * (#95). Those need this seam proven live first.
 *
 * Two v1 behaviors are intentionally absent, and both absences are stated
 * rather than discovered later:
 *  - promoting Team to `default_agent`: v1 read `cfg.default_agent` and only
 *    filled it when empty or "build".  The v2 AgentEditor exposes `default(id)`
 *    with NO getter, so calling it would override a user's chosen default on
 *    every boot.  The installer owns that key instead (#96).
 *  - the official confirmation dialog: probed on the live host, a plugin has no
 *    way to raise one.  `askFnOf` therefore finds no bridge and every governed
 *    call fails closed with the v2-worded refusal set below.
 */

import { agents } from "../agents.js"
import { parseExtraDeny, resolveEnvProtectMode } from "../envprotect.js"
import { createTmTools } from "../tm/index.js"
import { setAskUnavailableNote } from "../tm/perm-ask.js"
import type { PluginInput, ToolDefinition } from "../types.js"
import { createV2Client } from "./v2-client.js"
import { bindV2Tool, type V2ToolBinding } from "./v2-tool.js"
import { mergeTriples, triplesFromAgentPermission } from "./v2-permissions.js"
import type { V2AgentInfo, V2Context, V2Plugin, V2Registration, V2ToolInfo } from "./v2-types.js"

/** The refusal has to name the real reason: on v2 the absence is the new
 *  protocol, and "旧版协议" would send the model looking for an upgrade the
 *  user already installed. */
export const V2_NO_DIALOG_NOTE =
  "这个宿主（OpenCode v2）不给插件弹出确认窗的入口，所以我没有问任何人就直接拒绝了——" +
  "我不会在没有对话框的情况下假装用户同意。请改用白名单内的源，" +
  "或让用户在配置里放行（TM_WEBFETCH_ALLOWED_DOMAINS / 宿主的权限设置），不要重复调用。"

function directoryOf(ctx: V2Context): string {
  const loc = ctx?.location as { directory?: unknown; project?: { directory?: unknown } } | undefined
  if (typeof loc?.directory === "string" && loc.directory) return loc.directory
  if (typeof loc?.project?.directory === "string" && loc.project.directory) return loc.project.directory
  return process.cwd()
}

export const v2Personality: V2Plugin = {
  id: "team-mode",

  async setup(ctx: V2Context) {
    if (!ctx || typeof ctx.tool?.transform !== "function") {
      // Nothing can be registered without the tool domain.  Say it in the
      // server log instead of failing the load silently: a plugin that injects
      // nothing looks identical to one that was never installed.
      console.error("[team-mode] v2 setup aborted: ctx.tool.transform is missing on this host")
      return
    }

    const directory = directoryOf(ctx)
    setAskUnavailableNote(V2_NO_DIALOG_NOTE)

    const options = (ctx.options ?? {}) as Record<string, unknown>
    const envProtectMode = options.envProtect ? resolveEnvProtectMode(process.env.TM_ENV_PROTECT) : "off"
    const envProtectExtra = parseExtraDeny(process.env.TM_ENV_PROTECT_EXTRA_DENY)

    const tmRuntime = await createTmTools(
      { directory, project: "", client: createV2Client(), $: undefined } as unknown as PluginInput,
      {
        mode: envProtectMode,
        extra: envProtectExtra,
      },
    )

    const registrations: V2Registration[] = []
    const notes: string[] = []

    // ---------- register the governed tools ----------
    const entries = Object.entries(tmRuntime.tools as Record<string, ToolDefinition>)
    const bindings: V2ToolBinding[] = []
    for (const [name, def] of entries) {
      const bound = await bindV2Tool(name, def, directory)
      if (!bound) {
        notes.push(`${name}: 没有 execute，未注册`)
        continue
      }
      if (!bound.inputExact) notes.push(`${name}: 参数表不精确（${bound.note ?? "未知原因"}）`)
      bindings.push(bound)
    }
    registrations.push(
      await ctx.tool.transform((editor) => {
        for (const b of bindings) editor.add(b.tool)
      }),
    )

    // Did they actually land?  Ask the host, do not assume — the whole reason
    // this plugin has a capability probe is that "registered" and "live" are
    // different facts on this platform.
    let registeredNames: string[] = []
    try {
      const live = (await ctx.tool.list()) as ReadonlyArray<V2ToolInfo & { id?: string }>
      const ids = new Set(live.map((t) => String((t as { id?: string }).id ?? t.name ?? "")))
      registeredNames = bindings.map((b) => b.tool.name).filter((n) => ids.has(n))
    } catch (err) {
      notes.push(`tool.list 失败：${(err as { message?: unknown })?.message ?? String(err)}`)
    }
    const missing = bindings.map((b) => b.tool.name).filter((n) => !registeredNames.includes(n))

    // ---------- normalize the agents the config declares ----------
    const missingAgents: string[] = []
    const unmappedActions = new Set<string>()
    const wantedIds = Object.keys(agents as Record<string, unknown>)
    // R6 on v2: the plugin cannot raise a dialog (probed), but an `ask` EFFECT
    // the host evaluates DOES open one — coarser than v1's per-pattern
    // escalation, and refined by #94's evaluate hook.
    const escalateShellAsk = envProtectMode !== "off"
    if (typeof ctx.agent?.transform === "function") {
      registrations.push(
        await ctx.agent.transform((editor) => {
          for (const id of wantedIds) {
            const existing = editor.get(id)
            if (!existing) {
              missingAgents.push(id)
              continue
            }
            const { triples, unmapped } = triplesFromAgentPermission(
              (agents as Record<string, { permission?: Record<string, unknown> }>)[id]?.permission,
              { escalateShellAsk },
            )
            for (const u of unmapped) unmappedActions.add(u)
            const merged = mergeTriples((existing as V2AgentInfo).permissions, triples)
            if (merged.changed) editor.update(id, (a) => { a.permissions = merged.triples })
          }
        }),
      )
    } else {
      notes.push("ctx.agent.transform 不存在，角色权限矩阵未规范化")
    }
    if (unmappedActions.size) {
      notes.push(`白名单里这些键在 v2 没有对应动作，已如实丢弃：${[...unmappedActions].join(",")}`)
    }
    if (escalateShellAsk) {
      notes.push("R6 已开：shell 升为 ask（v1 是按模式匹配，v2 现在是每条命令都问，#94 会补回按命令行内容判定）")
    }

    try {
      tmRuntime.pipelines.store.appendTrajectory({
        tool: "host",
        step_id: "v2-boot",
        event: "personality",
        api: 2,
        directory,
        tools_registered: registeredNames.length,
        tools_total: bindings.length,
        tools_missing: missing.join(","),
        agents_missing: missingAgents.join(","),
        env_protect: envProtectMode,
        note: notes.join(" · "),
      })
    } catch {
      /* the trajectory is an extra here, never a reason to fail the boot */
    }

    // A v1 user reading their own logs would otherwise conclude the plugin was
    // silently broken: these two facts are the visible difference between the
    // personalities.
    if (missingAgents.length || missing.length || notes.length) {
      const detail = [
        missingAgents.length ? `配置里缺角色：${missingAgents.join(",")}（v2 插件不能新建角色，交给安装器）` : "",
        missing.length ? `工具未出现在宿主表面：${missing.join(",")}` : "",
        notes.length ? notes.join(" · ") : "",
      ].filter(Boolean).join("；")
      console.warn(`[team-mode] v2 人格已启动，但有缺口：${detail}`)
    }

    return async () => {
      for (const r of registrations) {
        try {
          await r.dispose()
        } catch {
          /* a host that already tore down its own registry has nothing left to free */
        }
      }
      // tm_browser owns a child process — teardown waits on v1 and must wait here too.
      await tmRuntime.dispose()
    }
  },
}

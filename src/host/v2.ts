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
 * Two v1 behaviors do not carry over, and both absences are stated rather than
 * discovered later:
 *  - creating agents: `AgentEditor` has no `add`, so the six roles must come
 *    from the user's config (the installer writes `agents/*.md`).
 *  - the conservative default-agent promotion: v1 read `cfg.default_agent` and
 *    only filled it when empty or "build".  v2 exposes `default(id)` with NO
 *    getter, so "only if the user did not choose" is not expressible — the
 *    choice is between never promoting and promoting every boot.  The user's
 *    standing instruction (2026-09-25) is that Team is ALWAYS the default, so
 *    this promotes unconditionally; `defaultAgent: false` in the plugin options
 *    opts out, exactly as on v1.
 *
 * The official confirmation dialog is absent as well, and for a different
 * reason: probed on the live host, a plugin has no way to raise one.
 * `askFnOf` therefore finds no bridge and every governed call fails closed with
 * the v2-worded refusal set below.
 */

import { agents } from "../agents.js"
import { DEFAULT_TTL_DAYS, resolveTtlMs, startBlackboardMaintenance } from "../blackboard.js"
import { parseExtraDeny, resolveEnvProtectMode } from "../envprotect.js"
import { createTmTools } from "../tm/index.js"
import { setAskUnavailableNote } from "../tm/perm-ask.js"
import type { PluginInput, ToolDefinition } from "../types.js"
import { blackboardNote } from "./note.js"
import { applyV2BackgroundForce, applyV2PermissionGuards, needsCoarseShellAsk } from "./v2-guard.js"
import { applyV2SessionLayer, removalPlan } from "./v2-session.js"
import { createV2Client } from "./v2-client.js"
import { bindV2Tool, type V2ToolBinding } from "./v2-tool.js"
import { mergeTriples, triplesFromAgentPermission, V1_ONLY_TOOLS } from "./v2-permissions.js"
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
    // v1 keeps tm_ptc_run; v2 does not register it.  The host's own `execute`
    // (Code Mode) already runs "one program, N governed calls, zero round-trips,
    // only the aggregate entering the context", and a live session showed our
    // governed results still come back offloaded through it — so shipping a
    // second batch runner would hand the model two tools for one job.  The
    // module stays in the tree because the frozen v1 personality needs it, and
    // the prompts the v2 config files carry are forked by gen-v2-config.mjs.
    const V2_UNREGISTERED = V1_ONLY_TOOLS
    const bindings: V2ToolBinding[] = []
    const derived: string[] = []
    for (const [name, def] of entries) {
      if (V2_UNREGISTERED.has(name)) continue
      const bound = await bindV2Tool(name, def, directory)
      if (!bound) {
        notes.push(`${name}: 没有 execute，未注册`)
        continue
      }
      if (!bound.inputExact) notes.push(`${name}: 参数表不精确（${bound.note ?? "未知原因"}）`)
      else if (bound.inputSource === "descriptor") derived.push(name)
      bindings.push(bound)
    }
    // A descriptor-derived table is `exact` in the sense that the model sees the
    // parameter names, but the TYPES were read off a `name: type` prefix by
    // regex, not by zod.  Saying nothing would let the log imply a zod-grade
    // shape, so name the tools and say how they were obtained.
    if (derived.length) {
      notes.push(
        `${derived.join("/")} 没有 zod 形状，参数表是从描述符文本推出来的（类型靠 name: type 前缀判定，不是 zod 保证）`,
      )
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
    // ---------- the permission guard (egress red line + R6 per command) ----------
    // Installed BEFORE the agent transform because whether the config still needs
    // the coarse `shell -> ask` escalation depends on this hook being there.
    const guards = await applyV2PermissionGuards(ctx, { envProtectMode })
    registrations.push(...guards.registrations)
    const bgForce = await applyV2BackgroundForce(ctx)
    registrations.push(...bgForce.registrations)
    if (!guards.installed) {
      notes.push("ctx.permission.hook 不存在：原生 webfetch 的元数据/私网红线和 R6 的按命令行判定都没地方落")
    }

    const missingAgents: string[] = []
    const unmappedActions = new Set<string>()
    const wantedIds = Object.keys(agents as Record<string, unknown>)
    // R6 on v2: the plugin cannot raise a dialog (probed), but an `ask` EFFECT
    // the host evaluates DOES open one.  Until a live host proves that
    // `permission.evaluate` actually fires for `shell`, the config keeps the
    // COARSE escalation (every command asks) — fail-closed beats a fine classifier
    // nobody has seen run.  TM_R6_FINE_ASK=on hands the decision to the hook.
    const escalateShellAsk =
      envProtectMode !== "off" && needsCoarseShellAsk(process.env, guards.installed)
    // Team is ALWAYS the default (the user's standing instruction — see the
    // header for why this cannot be the conservative v1 form).  `default()` on
    // an agent that does not exist would just make the host fall back to build
    // silently, so it is gated on the role actually being present, and the
    // refusal to promote is reported rather than hidden.
    const promoteTeamDefault = options.defaultAgent !== false
    let defaultPromoted: boolean | null = null
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
          if (promoteTeamDefault) {
            const ok = !missingAgents.includes("team")
            if (ok) editor.default("team")
            defaultPromoted = ok
          }
        }),
      )
    } else {
      notes.push("ctx.agent.transform 不存在，角色权限矩阵未规范化")
    }
    if (defaultPromoted === false) {
      notes.push("Team 没有成为默认：配置里缺 team 角色，宿主会静默回落到 build（先跑安装器写 agents/*.md）")
    }
    if (unmappedActions.size) {
      notes.push(`白名单里这些键在 v2 没有对应动作，已如实丢弃：${[...unmappedActions].join(",")}`)
    }
    if (escalateShellAsk) {
      notes.push(
        "R6 已开：shell 在配置里升为 ask（每条命令都问）。按命令行判定的 evaluate 钩子已装上并在计数，但宿主是否真为 shell 调它还没在活体上证明，所以先不撤粗粒度——TM_R6_FINE_ASK=on 才交给它。",
      )
    }

    // ---------- the request layer ----------
    // The whitelist was only ever a DENY, which stops a call but leaves the
    // tool's description in every request.  Here it becomes a request-level
    // removal, and the two things v1 baked into the team prompt (the resolved
    // board root) or into the agent config (temperature) ride the request
    // instead — a v2 agent is a config FILE and cannot carry a per-workspace
    // path, and `temperature` is a legacy agent field the runner no longer
    // sends.  This also starts the blackboard TTL sweeper, which v1 owns and v2
    // otherwise silently lacked: the note promises a sweep, so shipping it
    // without the sweeper would be the exact overstated claim this product is
    // built to refuse.
    const ttlMs = resolveTtlMs(options as never)
    const ttlDays = Math.round(ttlMs / (24 * 60 * 60 * 1000)) || DEFAULT_TTL_DAYS
    const note = blackboardNote(startBlackboardMaintenance(directory, ttlMs), ttlDays)
    const temperature: number | false =
      options.temperature === false
        ? false
        : typeof options.temperature === "number"
          ? options.temperature
          : 0.2
    const plan = removalPlan(agents as unknown as Record<string, { permission?: Record<string, unknown> }>)
    const session = await applyV2SessionLayer(ctx, { temperature, note, noteAgents: ["team"], plan })
    registrations.push(...session.registrations)
    if (!session.registrations.length) {
      notes.push("ctx.session.hook 不存在：工具面裁剪、温度、黑板根目录三项请求层治理都没装上")
    }
    const removedPlanSizes = [...plan.entries()].map(([id, set]) => `${id}=${set.size}`).join(" ")

    try {
      tmRuntime.pipelines.store.appendTrajectory({
        tool: "host",
        step_id: "v2-boot",
        event: "personality",
        api: 2,
        directory,
        tools_registered: registeredNames.length,
        tools_v1_only: [...V2_UNREGISTERED].join(","),
        tools_total: bindings.length,
        tools_missing: missing.join(","),
        agents_missing: missingAgents.join(","),
        agents_default: defaultPromoted === null ? "n/a" : defaultPromoted ? "team" : "not-promoted",
        request_hooks: session.registrations.length,
        guard_hooks: guards.registrations.length,
        subagent_background: bgForce.registrations.length ? "forced-true" : "no-hook",
        guard_shell_coarse: escalateShellAsk,
        request_temperature: temperature === false ? "off" : temperature,
        request_removed_plan: removedPlanSizes,
        board_ttl_days: ttlDays,
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
      // The counters only exist in this process, so they have to be written down
      // before teardown — otherwise "did permission.evaluate ever fire for
      // shell?" (#12, the thing gating the fine-grained R6 ask) is unanswerable
      // after the fact, and tm_stats would keep showing a boot line that says
      // what was installed but never what it saw.
      try {
        tmRuntime.pipelines.store.appendTrajectory({
          tool: "host",
          step_id: "v2-shutdown",
          event: "personality",
          api: 2,
          guard_seen: guards.report.seen,
          guard_actions: Object.entries(guards.report.byAction).map(([k, v]) => `${k}=${v}`).join(" "),
          guard_shell_matched: guards.report.shellMatched,
          guard_strictened: guards.report.strictened,
          guard_denied: guards.report.denied,
          subagent_seen: bgForce.report.seen,
          subagent_forced: bgForce.report.forced,
          tools_removed: Object.entries(session.report.removed).map(([k, v]) => `${k}=${v}`).join(" "),
          note_pushed: session.report.notePushed,
          compaction_lines: session.report.compactionLines,
        })
      } catch {
        /* the trajectory is an extra, never a reason to fail teardown */
      }
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

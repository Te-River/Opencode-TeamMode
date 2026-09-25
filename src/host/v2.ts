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
import { setPrivateSpacePolicy } from "../tm/webfetch.js"
import type { PluginInput, ToolDefinition } from "../types.js"
import { blackboardNote } from "./note.js"
import { applyV2BackgroundForce, applyV2PermissionGuards, needsCoarseShellAsk } from "./v2-guard.js"
import { applyV2EventFeed } from "./v2-events.js"
import { createV2SessionReader } from "./v2-session-client.js"
import { applyV2Probe, probeSummary } from "./v2-probe.js"
import { applyV2NativeOffload } from "./v2-offload.js"
import { applyV2BrowserGate, browserGateSummary } from "./v2-browser-gate.js"
import { seedWebfetchDomains } from "../tm/webfetch.js"
import { v2CapabilityRows } from "./v2-capabilities.js"
import { applyV2SessionLayer, removalPlan } from "./v2-session.js"
import { createStorageLedgerStore } from "../tm/ledger.js"
import { createTeamScope } from "./v2-scope.js"
import { bindV2Tool, type V2ToolBinding } from "./v2-tool.js"
import { mergeTriples, triplesFromAgentPermission, V1_ONLY_TOOLS } from "./v2-permissions.js"
import type { V2AgentInfo, V2Context, V2Plugin, V2Registration, V2ToolInfo } from "./v2-types.js"

/** The refusal has to name the real reason: on v2 the absence is the new
 *  protocol, and "旧版协议" would send the model looking for an upgrade the
 *  user already installed.  It must ALSO not point at a domain gate this
 *  personality no longer runs (the default is `"*"`), so the knob it names is
 *  the host's own permission config, and the address red line is excluded from
 *  "ask the user" because that one has no consent path at all. */
export const V2_NO_DIALOG_NOTE =
  "这个宿主（OpenCode v2）不给插件弹出确认窗的入口，所以我没有问任何人就直接拒绝了——" +
  "我不会在没有对话框的情况下假装用户同意。请换一个不需要这次访问的源，" +
  "或让用户在宿主的权限设置里放行（私网/元数据地址是红线，那条没有放行路径），不要重复调用。"

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
    // ---------- Team-scope isolation (#22, the user's requirement 2026-09-25) ----------
    // Every v2 hook fires for EVERY agent on this host.  This one object is what
    // each layer asks before it mutates a request, a result, or a permission —
    // build/plan and any third-party agent must look exactly like a fresh install.
    const scope = createTeamScope(Object.keys(agents))
    setAskUnavailableNote(V2_NO_DIALOG_NOTE)

    const options = (ctx.options ?? {}) as Record<string, unknown>
    const envProtectMode = options.envProtect ? resolveEnvProtectMode(process.env.TM_ENV_PROTECT) : "off"
    const envProtectExtra = parseExtraDeny(process.env.TM_ENV_PROTECT_EXTRA_DENY)

    // ---------- the v2 network policy: no domain gate, IP red line only ----------
    // The user's standing instruction for v2 (2026-09-25): do not block network
    // access at all EXCEPT sensitive and internal addresses.  v1's 22-host seed list
    // existed because v1 could open the host's official per-request dialog; on v2 a
    // plugin cannot raise one, so an allowlist became a set of pages the agent can
    // never see and no one can approve -- a gate with no door.  `"*"` therefore
    // replaces the DEFAULT here, and what still holds absolutely is `checkWebUrl`'s
    // address policy underneath it: link-local / metadata / reserved ranges are a hard
    // deny no config can open (and were never consentable), and private space
    // (loopback / RFC1918 / CGNAT / .localhost) stays gated — refused through our
    // tools, which have no dialog to ask with, and opened only by the host's own
    // `effect:"ask"` for the native tools.  IPv4-mapped and DNS64 spellings are
    // unwrapped before that check, so the notation is not a way around it.
    // An explicit TM_WEBFETCH_ALLOWED_DOMAINS always wins; this only changes which
    // default applies, and it is resolved from a COPY of the env so the v1
    // personality in the same process is untouched.
    const v2Env: Record<string, string | undefined> = { ...process.env }
    if (!String(v2Env.TM_WEBFETCH_ALLOWED_DOMAINS ?? "").trim()) v2Env.TM_WEBFETCH_ALLOWED_DOMAINS = "*"
    // The DOMAIN gate is off on this personality (see the note above): 2.x gives a
    // plugin no dialog, so "approve to proceed" is an instruction to wait for a
    // window that never opens.  Private space is NOT opened by the same logic,
    // because that is not a whitelist question — a default that let a governed tool
    // GET 192.168.1.1 would put the user's router in the trajectory for a mistake the
    // model made.  So the answer here is a refusal that names both exits
    // (TM_PRIVATE_SPACE=allow, or the one host in TM_WEBFETCH_ALLOWED_DOMAINS) instead
    // of promising a dialog, and `deny` is what a quiet v2 host gets.
    const privateSpace = setPrivateSpacePolicy(String(v2Env.TM_PRIVATE_SPACE ?? "").trim() || "deny")

    // ---------- how our tools reach the model at all (measured in the binary) ----------
    // 2.0.16 decides tool visibility with `options.codemode`: a tool whose value is
    // not `false` is offered ONLY inside the Code Mode catalog, where the host keeps
    // the first line of its description (≤120 chars) under a ~2 000-token budget.
    // `bindV2Tool` used to send no `options` at all, which is the real explanation
    // for the live session that showed six tools and zero `tm_*` after a successful
    // registration: the tools were there, and almost none of the governance text we
    // wrote for them ever arrived.  `TM_V2_CODEMODE=direct` sends the flag; the
    // default keeps today's behaviour until the token cost is measured, because the
    // other half of that sentence is that a direct tool definition rides EVERY
    // request (our own estimate for the full set is 9 528 tokens).
    // Delivered as REAL tools by default: the user's call (2026-09-25) was "slim the
    // description first, then go direct", and the description is now 729 tokens for
    // tm_browser (was 2 788 for the whole tool), which puts the measured per-role
    // cost at 2 660 build-class / 4 726 tester / 6 391 researcher / 7 793 lead.
    // `TM_V2_CODEMODE=off` restores catalog-only for anyone who wants the tokens back
    // — and the boot note says which world this is, because in catalog mode most of
    // our governance text never reaches the model at all.
    // `TM_V2_CODEMODE` is now OPT-IN for direct delivery. Measured on a live 2.0.16
    // desktop session (export read 2026-09-26): with `options.codemode:false` sent for
    // every tool, the host still delivered all ten `tm_*` inside the Code Mode catalog
    // ("They cannot be called directly…"), and the model's own callable list was the
    // nine native tools. So the flag changes what we send, not what the model gets —
    // and shipping it as the default made the README claim a delivery mode the host
    // never gave. `direct` stays available as an experiment for a build that honours it,
    // and the shutdown line reports both halves: `tools_codemode` (sent) and
    // `tools_in_request` (what the assembled request actually carried).
    const v2CodeModeDirect = /^(1|true|yes|on|direct)$/i.test(String(v2Env.TM_V2_CODEMODE ?? "").trim())

    // No SDK client in the v1 sense.  v1's `client` carried `file.read`, `find.text`,
    // `session.*` and `pty.*`; the v2 plugin ctx has no such object, and the fs shim
    // that used to stand in for the first two went away with `tm_read`/`tm_grep` (the
    // native tools, governed at `execute.after`, are the file ladder now).
    // What IS bridged is the one thing the collect path cannot be honest without:
    // `tm_join` must be able to check whether a named session id is really the
    // caller's child, and a live 2.0.16 run proved that without it the tool reports
    // "no pending dispatch matched" about a child that already finished. v2 has
    // `ctx.session.get`, so `v2-session-client.ts` wraps it in the shape the existing
    // code reads. `session.children` has no counterpart, so adoption from the host's
    // tree keeps reporting `no_seam` rather than implying we looked.
    const sessionReader = createV2SessionReader(ctx)
    const tmRuntime = await createTmTools(
      { directory, project: "", client: sessionReader.client, $: undefined } as unknown as PluginInput,
      {
        mode: envProtectMode,
        extra: envProtectExtra,
        env: v2Env,
        // The matrix is built from observations that do not exist yet at this line
        // (the probe, the guards, the offloader all register below), so it is a
        // LATE-BOUND closure rather than a snapshot taken too early — a row read
        // before the observation would be exactly the "declared" lie this table
        // exists to avoid.
        capabilities: () => v2Matrix(),
        // The LEDGER's home.  v2 has no `todowrite` and no `session.todo` to
        // read, so the lead's list lives in the host's own storage domain and
        // `tm_join`'s goal tripwire checks THAT — see src/tm/ledger.ts.  When the
        // domain is missing the tool refuses with the reason rather than keeping
        // the list in process memory and calling it recorded.
        ledgerStore: createStorageLedgerStore((ctx as { storage?: unknown }).storage),
        sessionReaderReport: () => sessionReader.report,
      },
    )
    let v2Matrix: () => ReturnType<typeof v2CapabilityRows> = () => []

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
      const bound = await bindV2Tool(name, def, directory, (agent, sessionID) => scope.learn(agent, sessionID), {
        codemodeDirect: v2CodeModeDirect,
      })
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
    const retired = entries.map(([name]) => name).filter((n) => V2_UNREGISTERED.has(n))
    if (retired.length) {
      // Deliberate absences are said, not silently missing: an agent that reads a
      // v1 document and finds no `tm_read` needs to learn from the boot log that
      // this is the design, not a failed install.
      notes.push(
        `v2 不注册 ${retired.join("/")} —— 同一件工作交给宿主自己的 read/grep/shell/execute（结果照样被 execute.after 治理），v1 保留这些别名`,
      )
    }
    if (derived.length) {
      notes.push(
        `${derived.join("/")} 没有 zod 形状，参数表是从描述符文本推出来的（类型靠 name: type 前缀判定，不是 zod 保证）`,
      )
    }
    // How our tools reach the model at all — said every boot, because the two
    // answers differ by thousands of tokens and by whether our governance text
    // arrives at all. Both branches describe only what WE send: on 2.0.16 a live
    // session showed `options.codemode:false` does not actually move the tools out of
    // the Code Mode catalog, so the outcome is verified from the shutdown line's
    // `tools_in_request` (or tm_stats), never from this flag.
    notes.push(
      v2CodeModeDirect
        ? "TM_V2_CODEMODE=direct：我们发了 options.codemode=false。宿主是否因此改成直接交付，要看 tm_stats 的 tools_in_request（2.0.16 实测：仍然只在 Code Mode 目录里，模型可直接调用的是那九个原生工具）"
        : "tm_* 未带 options.codemode=false：宿主把它们放进 Code Mode 目录，模型看到的只有描述首行（≤120 字）——我们写在下面的治理文案大部分没送到。2.0.16 实测：TM_V2_CODEMODE=direct 也不改变这一点，所以默认留在此状态，真实交付情况以 tools_in_request 为准",
    )
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
    const guards = await applyV2PermissionGuards(ctx, { envProtectMode, scope })
    // Said out loud because it is a promise with a boundary: the user's rule is
    // that nothing outside Team may be touched, and the honest consequence is that
    // the red lines we inject are therefore NOT protecting a build session either.
    notes.push(
      "已按 Team 作用域收口：工具面裁剪、温度、黑板提示、原生结果卸载、R6 与地址红线、subagent 强制后台，都只对我们六个角色的会话生效；build / plan 等其余模式保持宿主出厂行为（代价：那些会话也不由我们补红线，需要全局红线请让宿主自己的 permission 规则承担）",
    )
    registrations.push(...guards.registrations)
    const bgForce = await applyV2BackgroundForce(ctx, { scope })
    registrations.push(...bgForce.registrations)
    // JIT governance over the HOST's tools, so the offload promise does not depend
    // on which tool the model happened to pick (see v2-offload.ts for why a
    // per-tool promise is no promise).  Registered BEFORE the probe so the probe's
    // throttled snapshot can carry its counters — a counter that only lands at
    // teardown is a counter that does not exist.
    const offload = await applyV2NativeOffload(ctx, { pipelines: tmRuntime.pipelines, scope })
    registrations.push(...(await Promise.all(offload.registrations)))
    // BEFORE the session layer registers its own context hook, so the probe sees
    // the host's full surface rather than the set we trimmed — that difference is
    // exactly what it is there to record.
    // The host's own browser catalog, behind OUR gate (#9): `permission.evaluate` was
    // observed NOT firing for `browser_*`, so until now the domain list, the address
    // red line and the R6 env-file rule had a bypass the length of a tool name — in
    // the one surface that is also the only one with a native side panel.
    const browserGate = applyV2BrowserGate(ctx, {
      allowlist: seedWebfetchDomains(tmRuntime.config.webfetchAllowedDomains),
      scope,
      env: v2Env,
    })
    if (!browserGate.registrations.length) {
      notes.push("原生 browser_* 的门禁没装上（ctx.tool.hook 不可用）：宿主的 45 个浏览器工具在 Team 会话里也不受我们的域名 / 地址规则约束")
    }
    registrations.push(...browserGate.registrations)
    const probe = await applyV2Probe(ctx, {
      onSummary: (summary) => {
        try {
          tmRuntime.pipelines.store.appendTrajectory({
            tool: "host",
            step_id: "v2-surface",
            event: "personality",
            api: 2,
            native_seen: offload.report.seen,
            // The coverage denominator (#23): every call we resolved to a Team
            // session, and the part of it whose tool we do not touch. Printed by
            // tm_stats, so "most tool calls are JIT-governed" is checkable.
            native_ours: offload.report.ours,
            native_unmatched: offload.report.unmatched,
            native_offloaded: offload.report.offloaded,
            native_envelopes: offload.report.envelopes,
            native_tokens_saved: offload.report.tokensSaved,
            native_offload_active: offload.active && offload.registrations.length > 0,
            ...summary,
          })
        } catch {
          /* the probe is an extra */
        }
      },
    })
    registrations.push(...probe.registrations)
    if (probe.report.hooksMissing.length) {
      notes.push(`探针没挂上的钩子：${probe.report.hooksMissing.join(", ")}`)
    }
    // Three states, three sentences: "no seam", "you turned it off" and "it is
    // running" are different facts for the user, and collapsing them is how a
    // fallback gets read as a setting.
    if (offload.registrations.length === 0) {
      notes.push('这个宿主没有 tool.hook("execute.after")：原生 read/shell 的大输出不会被卸载，JIT 承诺只在 tm_* 上成立')
    } else if (!offload.active) {
      notes.push("TM_NATIVE_OFFLOAD=off：原生工具的大输出按宿主原样进上下文（承诺退回 tm_* 范围）")
    }
    if (!guards.installed) {
      notes.push("ctx.permission.hook 不存在：原生 webfetch 的元数据/私网红线和 R6 的按命令行判定都没地方落")
    }

    const missingAgents: string[] = []
    const unmappedActions = new Set<string>()
    const wantedIds = Object.keys(agents as Record<string, unknown>)
    // R6 on v2: the plugin cannot raise a dialog (probed), but an `ask` EFFECT
    // the host evaluates DOES open one.  A live `--standalone` run recorded
    // `{action:"shell", resourceCount:1}` reaching `permission.evaluate` for a real
    // command, so the per-command classifier is now in charge and the config keeps
    // the COARSE escalation (every command asks) only as the fallback:
    // `TM_R6_FINE_ASK=off`, or no hook installed to hand the decision to.
    const escalateShellAsk =
      envProtectMode !== "off" && needsCoarseShellAsk(process.env, guards.installed)
    // Team is ALWAYS the default (the user's standing instruction — see the
    // header for why this cannot be the conservative v1 form).  `default()` on
    // an agent that does not exist would just make the host fall back to build
    // silently, so it is gated on the role actually being present, and the
    // refusal to promote is reported rather than hidden.
    const promoteTeamDefault = options.defaultAgent !== false
    let defaultPromoted: boolean | null = null
    let defaultPostCheck = "not-attempted"
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
              { escalateShellAsk, agentName: id },
            )
            for (const u of unmapped) unmappedActions.add(u)
            // `V1_ONLY_TOOLS` is passed as the reclaim set: a triple naming an
            // action this personality never registers can only have come from an
            // earlier boot, and a permission rule for a tool the host has never
            // heard of reads as a capability the user granted.
            const merged = mergeTriples((existing as V2AgentInfo).permissions, triples, V1_ONLY_TOOLS)
            if (merged.changed) editor.update(id, (a) => { a.permissions = merged.triples })
          }
          if (promoteTeamDefault) {
            // `editor.get("team")` returning nothing is NOT evidence the host does
            // not know the role — the live run is literally executing as `team` while
            // this snapshot lists only the 7 built-ins, so the transform receives the
            // agent set from BEFORE the config directory merged.  Gating the
            // promotion on that stale look-up is how "Team is always the default"
            // silently stopped being true, so the call is attempted regardless and
            // the AFTER view is what gets recorded.
            let ok = true
            try {
              editor.default("team")
            } catch {
              ok = false
            }
            defaultPromoted = ok
            defaultPostCheck = editor.get?.("team") ? "present-after" : "absent-after"
          }
          // Recorded HERE, at the moment of observation.  The host defers this
          // callback (a live boot reached the trajectory line with
          // defaultPromoted still null, which printed as a clean-looking "n/a"), so
          // the boot record cannot claim anything about what has not happened yet —
          // least of all `agents_missing: ""`, which reads as "all six roles found"
          // when the truth at that instant was "nobody has looked".
          try {
            tmRuntime.pipelines.store.appendTrajectory({
              tool: "host",
              step_id: "v2-agents",
              event: "personality",
              api: 2,
              agents_missing: missingAgents.join(" "),
              agents_default: defaultPromoted === null ? "opt-out" : defaultPostCheck === "present-after" ? "team" : "called-unverified",
              agents_unmapped: [...unmappedActions].join(" "),
              agents_normalized: true,
              agents_default_post: defaultPostCheck,
              // Is "all six missing" the host having no roles, or the callback
              // firing before it loaded them?  Those need different fixes and the
              // difference is not guessable from the outside — the editor's own view
              // is the only witness.
              agents_in_editor: (() => {
                try {
                  return (editor.list?.() ?? []).length
                } catch {
                  return -1
                }
              })(),
              agents_editor_ids: (() => {
                try {
                  return (editor.list?.() ?? [])
                    .map((a: { id?: string }) => String(a?.id ?? "?"))
                    .filter((n: string) => wantedIds.includes(n) || n === "build" || n === "plan")
                    .join(" ")
                } catch {
                  return "list-threw"
                }
              })(),
            })
          } catch {
            /* the record is an extra, never a reason to fail the transform */
          }
        }),
      )
    } else {
      notes.push("ctx.agent.transform 不存在，角色权限矩阵未规范化")
    }
    if (defaultPromoted === false) {
      notes.push("Team 没有成为默认：editor.default(\"team\") 抛错了")
    } else if (defaultPromoted && defaultPostCheck !== "present-after") {
      // Measured on a live 2.0.16 standalone boot: the call is accepted, `team` is
      // absent from the editor before AND after, and `default_agent` in
      // opencode.jsonc keeps the user's value.  The plugin therefore cannot promote
      // the default on v2 — the transform receives the agent set from before the
      // config directory merges.  Saying so is the whole point: this file used to
      // claim the promotion was live-verified, and the only thing that actually
      // makes Team the default is the installer writing the key.
      notes.push(
        "Team 默认：editor.default(\"team\") 已被宿主接受但**无法核验生效**（transform 拿到的是配置合并前的角色集，实测调用后 editor 里仍无 team）。真正让这个要求成立的是安装器写 `default_agent: \"team\"`——没装过安装器就别假定 Team 是默认。",
      )
    }
    if (unmappedActions.size) {
      notes.push(`白名单里这些键在 v2 没有对应动作，已如实丢弃：${[...unmappedActions].join(",")}`)
    }
    if (escalateShellAsk) {
      notes.push(
        guards.installed
          ? "R6 已开，但 TM_R6_FINE_ASK=off 显式要回粗粒度：shell 在配置里升为 ask（每条命令都问），按命令行判定的 evaluate 钩子不再决定这件事。"
          : "R6 已开，但这个宿主没给 permission.hook：按命令行的红线无处可挂，只能把 shell 整体升为 ask（每条命令都问）——这是退路，不是设计。",
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
    // ---------- does ctx.storage actually round-trip? ----------
    // The LEDGER needs somewhere to live and `ctx.storage` is the candidate; the
    // difference between "the domain exists" and "a value we wrote comes back"
    // is not something a type file can settle, so boot asks it one question with a
    // key that carries no user data and records the answer.
    const storageProbe: { state: string; detail?: string } = { state: "absent" }
    {
      const st = (ctx as { storage?: { set?: unknown; get?: unknown } } | undefined)?.storage
      if (st && typeof st.set === "function" && typeof st.get === "function") {
        const key = "team-mode/selfcheck"
        const marker = `boot-${process.pid}`
        try {
          await (st.set as (k: string, v: unknown) => unknown)(key, { marker, at: Date.now() })
          const back = await (st.get as (k: string) => unknown)(key)
          const got = (back as { value?: { marker?: unknown } } | null)?.value?.marker ?? (back as { marker?: unknown } | null)?.marker
          storageProbe.state = got === marker ? "round-trip" : "read-back-mismatch"
          if (got !== marker) storageProbe.detail = `写回的值不是刚写进去的那个（拿到 ${JSON.stringify(got)?.slice(0, 40)}）`
        } catch (err) {
          storageProbe.state = "threw"
          storageProbe.detail = String((err as Error)?.message ?? err).slice(0, 80)
        }
      }
    }

    const session = await applyV2SessionLayer(ctx, { temperature, note, noteAgents: ["team"], plan, scope })
    // Everything the matrix reports now exists, so the late-bound closure can be
    // pointed at the real observations.
    v2Matrix = () =>
      v2CapabilityRows({
        ctx,
        probe,
        guardsInstalled: guards.installed,
        backgroundForced: true,
        offload,
        sessionHooks: 2,
        temperature,
        // Both derived, not asserted: "we think v2 has no X" has to come from the
        // object we were handed, so a host that grows the seam shows up here
        // automatically instead of leaving a stale "missing" row forever.
        // tm_join reads the todo list through the SDK client, and this personality
        // passes none — so the row is false until #8 bridges `ctx.session` into the
        // path the tool actually consumes.  Deriving it from ctx rather than
        // hard-coding `false` is what keeps that honest either way.
        eventFeed: feed.report,
        hasTodoSeam: typeof (ctx as { session?: { todo?: unknown } }).session?.todo === "function",
        hasAsk: typeof (ctx as { tool?: unknown }).tool === "function",
        storageState: storageProbe.state,
        scope,
      })
    registrations.push(...session.registrations)
    if (!session.registrations.length) {
      notes.push("ctx.session.hook 不存在：工具面裁剪、温度、黑板根目录三项请求层治理都没装上")
    }
    // v1 handed the plugin a host `event` hook and pumped every session.idle /
    // session.error / session.status into the child registry.  This personality had
    // no subscription at all (#8), so a child that settled two seconds after the
    // dispatch stayed "running" for the whole wait budget and `tm_join` reported a
    // state it had never observed — goal #6's failure shape, and a bug rather than
    // a limitation now that `ctx.event.subscribe()` is measured to work.
    const feed = await applyV2EventFeed(ctx, { onEvent: (ev) => tmRuntime.observeDispatchEvent(ev) })
    if (!feed.report.active) {
      notes.push(`事件流没接通（${feed.report.stopped ?? "原因未知"}）：tm_join 的结算检测只剩等待预算内的轮询，子代理结算了也要等到超时才报告`)
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
        agents_missing: missingAgents.length ? missingAgents.join(",") : defaultPromoted === null ? "待观察" : "",
        agents_default: defaultPromoted === null ? "待观察（宿主异步调用 transform，见 v2-agents 行）" : defaultPromoted ? "team" : "not-promoted",
        request_hooks: session.registrations.length,
        guard_hooks: guards.registrations.length,
        storage_probe: storageProbe.state,
        storage_probe_detail: storageProbe.detail ?? "",
        // Read at teardown, so these are counts of what actually happened in this
        // process — the number that says whether the isolation was exercised at all.
        scope_ours: scope.report.ours,
        scope_foreign: scope.report.foreign,
        scope_unknown: scope.report.unknown,
        browser_gate: browserGate.registrations.length ? "armed" : "absent",
        private_space: privateSpace,
        tools_codemode: v2CodeModeDirect ? "direct" : "catalog",
        guard_foreign_skipped: guards.report.foreignSkipped,
        subagent_background: bgForce.registrations.length ? "forced-true" : "no-hook",
        event_feed: feed.report.active ? "subscribed" : "absent",
        event_feed_detail: feed.report.stopped ?? "",
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
          // Accumulates for the whole process, so it can only be written at
          // teardown: this is the number that answers "did the feed stay alive, and
          // did the host rename the event types under us after the last upgrade?"
          event_received: feed.report.received,
          event_forwarded: feed.report.forwarded,
          event_unknown_types: Object.entries(feed.report.unknown).map(([k, v]) => `${k}=${v}`).join(" "),
          event_stopped: feed.report.stopped ?? "",
          browser_gate_seen: browserGate.report.seen,
          browser_gate_refused: browserGate.report.refused,
          browser_gate_leaked: browserGate.report.leaked,
          browser_gate_held: browserGate.report.held,
          browser_gate_note: browserGateSummary(browserGate.report),
          // What the model could actually call, read off the assembled requests —
          // the half of the delivery story the sent flag cannot tell.
          tools_in_request: session.report.tmInRequestSurface ? "tm-in-request" : "catalog-only",
          native_capped: offload.report.capped,
          ...probeSummary(probe.report),
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

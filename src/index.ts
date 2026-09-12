/**
 * opencode-team-mode — OpenCode plugin entry point.
 *
 * Contract with the SHIPPED OpenCode Desktop loader (1.18.x, verified by
 * reading the binary's own applyPlugin/readV1Plugin code):
 *
 *   export default {
 *     id: "team-mode",                     → Desktop plugin display name
 *     server: async (input, options) => ({
 *       config(cfg) { ...inject agents/commands... },
 *       "tool.execute.before"(...) { ...R6 env protection... },
 *       tool: { tm_read, tm_grep, tm_bash, tm_fetch },   → JIT layer-2 tools
 *     })
 *   }
 *
 * `server()` is the ONLY function the loader calls; a `setup` property is
 * silently ignored (root cause of v1.1-v1.3 not appearing in the picker).
 * The v1 `config` hook receives the merged opencode config and is the
 * supported way to add agents/commands.
 *
 * Options (via the tuple plugin form):
 *   "plugin": [["@te-river/opencode-team-mode@latest", { "ttlDays": 7 }]]
 * - `ttlDays`      → blackboard auto-cleanup TTL; default 5.
 * - `defaultAgent` → Team is the default agent (opt-out: set `false`).
 *                    Owning the default slot means the picker pins it
 *                    FIRST — order becomes team, build, plan.  Set
 *                    `false` for build-as-default with Team in its
 *                    alphabetical slot: build, plan, team (the two are
 *                    mutually exclusive by the server's sort).
 */

import type { OpenCodePlugin, OpenCodeConfig, PermissionEvent, HostEvent } from "./types.js"
import { agents } from "./agents.js"
import { commands } from "./commands.js"
import {
  startBlackboardMaintenance,
  resolveTtlMs,
  DEFAULT_TTL_DAYS,
} from "./blackboard.js"
import {
  createEnvProtectHook,
  parseExtraDeny,
  resolveEnvProtectMode,
  bashAskPatterns,
} from "./envprotect.js"
import {
  createApprovalGate,
  resolveAskTimeoutMs,
  hasPermissionReplyCapability,
} from "./approval-gate.js"
import { createTmTools } from "./tm/index.js"

/** Runtime addendum to the team prompt: concrete board + TTL (hybrid mode). */
function blackboardNote(root: string, ttlDays: number): string {
  return [
    "",
    "",
    "## Team Blackboard — resolved for this workspace",
    `Root directory: \`${root}\``,
    `- Hybrid channel: specialist replies (the STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF`,
    `  skeleton) are the PRIMARY transport — normal work needs no files at all.`,
    `- Board files exist ONLY for oversized deliverables (>~50 lines):`,
    `  \`<root>/<session-key>/<task-slug>/NN-<role>-<topic>[-rN].md\`.  On the FIRST`,
    `  board write of this conversation create the session folder with a compact clock`,
    `  timestamp (PowerShell: \`Get-Date -Format yyyyMMdd-HHmmss\`; POSIX:`,
    `  \`date +%Y%m%d-%H%M%S\`) and reuse it; never write into another conversation's`,
    `  session folder.`,
    `- Auto-cleanup: the plugin sweeps task directories idle for more than ${ttlDays} days (at startup and hourly).`,
    `  This is the ONLY cleanup path — never delete task or session directories yourself.`,
  ].join("\n")
}

const plugin: OpenCodePlugin = {
  id: "team-mode",

  server: async (input, options) => {
    // ---------- blackboard maintenance (code-level TTL sweeper) ----------
    const directory =
      typeof input?.directory === "string" && input.directory.length > 0
        ? input.directory
        : process.cwd()
    const ttlMs = resolveTtlMs(options)
    const ttlDays = Math.round(ttlMs / (24 * 60 * 60 * 1000)) || DEFAULT_TTL_DAYS
    const boardRoot = startBlackboardMaintenance(directory, ttlMs)
    const note = blackboardNote(boardRoot, ttlDays)

    // ---------- R6 env protection (code-level interception) ----------
    // Reading TM_ENV_PROTECT / TM_ENV_PROTECT_EXTRA_DENY here is the PLUGIN
    // configuring ITSELF at startup — program-level configuration, the same
    // category as the ttlDays option.  R6 exists to stop the MODEL reading
    // environment variables through tool calls; these two reads are not
    // that and are out of scope of the protection.
    const envProtectMode = resolveEnvProtectMode(process.env.TM_ENV_PROTECT)
    const envProtectExtra = parseExtraDeny(process.env.TM_ENV_PROTECT_EXTRA_DENY)

    // ---------- unified approval gate (R6 env face + R2 danger face) ----------
    // Layer 2: ONE timer that auto-REJECTS unanswered official-dialog requests
    // after TM_ASK_TIMEOUT_MIN and (Layer 3) fails closed if the SDK reply is
    // broken.  Armed ONLY when R6 is not off AND the client exposes a
    // permission-reply path — otherwise there is no live auto-reject and the
    // R6 hook must keep hard-throwing every env read (fail-closed).
    const approvalGate =
      envProtectMode !== "off" && hasPermissionReplyCapability(input?.client)
        ? createApprovalGate({
            client: input?.client,
            timeoutMs: resolveAskTimeoutMs(process.env),
          })
        : null
    if (approvalGate) approvalGate.start()

    // Sessions are only allowed to DEFER expressible env reads to the dialog
    // once the gate registered them as carrying our injected bash ask set
    // (reviewer C1: a global isArmed() deferral let stock build/plan agents
    // run printenv silently).  The authoritative source of that fact is the
    // config hook below: it records exactly which agents got the escalated
    // ask object, and a `message.updated`/`chat.message` user prompt routed
    // to one of those agents registers its session (live-proven ordering:
    // the user message event arrives before the session's first
    // tool.execute.before, while permission.asked arrives AFTER it).
    const injectedExecAgents = new Set<string>()

    const envProtectHook = createEnvProtectHook(
      input?.client,
      envProtectMode,
      envProtectExtra,
      { deferToApproval: (sessionID?: string) => approvalGate?.canDefer(sessionID) ?? false,
        envApproved: (sessionID?: string) => approvalGate?.isEnvApproved(sessionID) ?? false },
    )

    // ---------- JIT layer-2 tools (tm_read / tm_grep / tm_bash / tm_fetch) ----------
    // T0.4-verified static registration: server() hooks gain a `tool` segment.
    // The R6 mode/extra resolved above are passed in so the tm_* pipelines
    // share the SAME interception source as the built-in tools (anti-backdoor:
    // the global hook ALSO aliases tm_* onto read/grep/bash — see envprotect).
    const tmRuntime = await createTmTools(input, {
      mode: envProtectMode,
      extra: envProtectExtra,
    })

    return {
      // ---------- v1 config hook: inject agents & commands ----------
      config(cfg: OpenCodeConfig) {
        if (!cfg.agent) cfg.agent = {}
        // Execution roles carry permission.bash === "allow"; escalate it to a
        // pattern object so the host opens its official confirmation dialog
        // for the R6 env face + R2 danger face (default `*` stays allow).  A
        // shallow copy keeps the module-level `agents` object pristine.  The
        // R6 env face is only injected while the approval gate can arm: with
        // no arming client the R6 hook hard-throws env reads BEFORE any
        // dialog could be satisfied, so those patterns would be dead popups.
        const bashAsk = bashAskPatterns(envProtectMode, approvalGate !== null)
        for (const [name, def] of Object.entries(agents)) {
          // Respect user-defined overrides: never clobber an existing entry.
          if (cfg.agent[name]) continue
          const permission = def.permission
            ? {
                ...def.permission,
                ...(def.permission.bash === "allow" ? { bash: bashAsk } : null),
              }
            : def.permission
          cfg.agent[name] = {
            ...def,
            permission,
            prompt: name === "team" ? (def.prompt ?? "") + note : def.prompt,
          }
          // deferral-registry seed: agents that ACTUALLY carry our escalated
          // bash ask object (user-overridden agents never get added)
          if (def.permission && def.permission.bash === "allow") injectedExecAgents.add(name)
        }

        if (!cfg.command) cfg.command = {}
        for (const [name, def] of Object.entries(commands)) {
          if (cfg.command[name]) continue
          cfg.command[name] = def
        }

        // ---------- make Team the default agent (opt-out: defaultAgent:false)
        const promote = options?.defaultAgent !== false
        if (promote && (!cfg.default_agent || cfg.default_agent === "build")) {
          cfg.default_agent = "team"
        }
      },

      // ---------- R6: block the model's env-var read paths in code ----------
      "tool.execute.before": envProtectHook,

      // ---------- unified approval gate: watch the host permission dialog ---
      event: ({ event }: { event: HostEvent }) => {
        if (!approvalGate) return
        // Pre-tool session registration: the live host emits message.updated
        // with the full UserMessage ({ sessionID, role:"user", agent }) when
        // a prompt enters a session — BEFORE any tool.execute.before of that
        // turn, which is exactly when the R6 hook needs to know the session
        // carries our injected ask set (permission.asked only fires AFTER
        // the hook, so it can never be the first-command registration).
        if (event?.type === "message.updated") {
          const info = event.properties?.info as
            | { sessionID?: unknown; role?: unknown; agent?: unknown }
            | undefined
          if (
            info &&
            info.role === "user" &&
            typeof info.agent === "string" &&
            typeof info.sessionID === "string" &&
            injectedExecAgents.has(info.agent)
          ) {
            approvalGate.registerExecSession(info.sessionID)
          }
          return
        }
        approvalGate.handleEvent(event as PermissionEvent)
      },
      // secondary registration channel (official 1.18.x contract; the event
      // route above is the one verified against the live 1.18.29 bus)
      "chat.message": (input: { sessionID?: string; agent?: string }) => {
        if (!approvalGate) return
        if (
          input &&
          typeof input.sessionID === "string" &&
          typeof input.agent === "string" &&
          injectedExecAgents.has(input.agent)
        ) {
          approvalGate.registerExecSession(input.sessionID)
        }
      },
      dispose: () => {
        approvalGate?.dispose()
      },

      // ---------- JIT layer-2: tm_read / tm_grep / tm_bash / tm_fetch ----------
      tool: tmRuntime.tools,
    }
  },
}

export default plugin

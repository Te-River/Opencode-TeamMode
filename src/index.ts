/**
 * opencode-team-mode — plugin entry point: the v2-only export.
 *
 * OpenCode 2.x reads
 *   default.{id, setup(ctx)} → Plugin.define() is the identity function in
 * @opencode/plugin@2.0.16, so the plain object IS the definition and the v2
 * SDK is never a runtime dependency.
 *
 * v1 support (the OpenCode 1.18.x `server()` personality, `src/host/v1.ts`)
 * was removed in 1.7.0: this package now targets OpenCode 2.x only.
 *
 * Options (read from `ctx.options`):
 *   "plugin": [["@te-river/opencode-team-mode@latest", { "ttlDays": 7 }]]
 * - `ttlDays`      → blackboard auto-cleanup TTL; default 5.
 * - `defaultAgent` → Team is the default agent (opt-out: set `false`).
 *                    Owning the default slot means the picker pins it
 *                    FIRST — order becomes team, build, plan.  Set
 *                    `false` for build-as-default with Team in its
 *                    alphabetical slot: build, plan, team (the two are
 *                    mutually exclusive by the server's sort).
 */

import type { V2Plugin } from "./host/v2-types.js"
import { v2Personality } from "./host/v2.js"

const plugin: V2Plugin = {
  id: "team-mode",
  // read by an OpenCode 2.x host; `Plugin.define` is the identity function, so
  // handing over the plain {id, setup} pair IS the definition — no v2 SDK at
  // runtime.
  setup: v2Personality.setup,
}

export default plugin

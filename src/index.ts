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
  // #45: the DISPLAY id — what the host's plugin list shows.  It is the npm
  // package name so the user sees the package they installed, not a bare
  // "team-mode".  This is deliberately NOT the same string as our storage and
  // audit names: `team-mode/ledger/` (src/tm/ledger.ts) and
  // `team-mode-env-protect` (src/envprotect/patterns.ts) are DATA keys, and
  // renaming them would orphan every existing ledger and audit trail.  Display
  // id and storage/audit naming are two different things on purpose.
  id: "@te-river/opencode-team-mode",
  // read by an OpenCode 2.x host; `Plugin.define` is the identity function, so
  // handing over the plain {id, setup} pair IS the definition — no v2 SDK at
  // runtime.
  setup: v2Personality.setup,
}

export default plugin

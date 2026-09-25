/**
 * opencode-team-mode — plugin entry point: the DUAL-PERSONALITY export.
 *
 * One module, two host generations. Which one runs is the host's choice, and
 * the two never overlap:
 *
 *   OpenCode 1.18.x (v1 loader, verified against the desktop binary's own
 *   applyPlugin/readV1Plugin code) calls ONLY
 *     default.server(input, options) → v1 Hooks
 *   and silently ignores any other property — that is what killed v1.1-v1.3,
 *   which shipped a `setup` and no `server` (see the project memory on the
 *   loader contract).
 *
 *   OpenCode 2.x (v2) reads
 *     default.{id, setup(ctx)} → Plugin.define() is the identity function in
 *   @opencode/plugin@2.0.16, so the plain object IS the definition and the v2
 *   SDK is never a runtime dependency.  It ignores `server()`.
 *
 * "V1 plugin implementations do not run in V2" is the official statement, so
 * both halves have to be present in the published package or a user upgrading
 * their host simply loses the team.
 *
 * The v1 half lives in `src/host/v1.ts` unchanged from 1.6.0 — a v1 host must
 * not observe one behavioural difference, and test-*.mjs is the oracle.
 *
 * Options (via the tuple plugin form, v1):
 *   "plugin": [["@te-river/opencode-team-mode@latest", { "ttlDays": 7 }]]
 * - `ttlDays`      → blackboard auto-cleanup TTL; default 5.
 * - `defaultAgent` → Team is the default agent (opt-out: set `false`).
 *                    Owning the default slot means the picker pins it
 *                    FIRST — order becomes team, build, plan.  Set
 *                    `false` for build-as-default with Team in its
 *                    alphabetical slot: build, plan, team (the two are
 *                    mutually exclusive by the server's sort).
 */

import type { OpenCodePlugin } from "./types.js"
import type { V2Plugin } from "./host/v2-types.js"
import { createV1Personality } from "./host/v1.js"
import { v2Personality } from "./host/v2.js"

const plugin: OpenCodePlugin & Pick<V2Plugin, "setup"> = {
  id: "team-mode",
  // read by an OpenCode 1.18.x host
  server: createV1Personality,
  // read by an OpenCode 2.x host; `Plugin.define` is the identity function, so
  // handing over the plain {id, setup} pair IS the definition — no v2 SDK at
  // runtime, which is what keeps this package installable by v1 users.
  setup: v2Personality.setup,
}

export default plugin

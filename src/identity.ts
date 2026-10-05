/**
 * Agent-name identity, case-insensitive (#38).
 *
 * The lead role's id changed from `team` to `Team` so the desktop picker shows
 * "Team": the picker renders `Agent.Info.name`, and a config-file role's `name`
 * is its id verbatim (`Config.Agent` has no `name` key, so frontmatter cannot
 * set a display name).  But an existing install, an existing session title, or a
 * `--agent team` invocation still spells it lowercase, and a rename must not
 * break any of them — "改个名就把现有安装打断" is exactly the failure this file
 * exists to prevent.
 *
 * So every identity comparison goes through here: normalize to lower case, then
 * compare.  This is the ONE definition — a second copy would let one call site
 * drift and silently stop recognising the old spelling.
 *
 * NOTE: this is about the AGENT id, not the plugin's display id.  The plugin's
 * display id (`@te-river/opencode-team-mode`) and its storage/audit names
 * (`team-mode/ledger/`, `team-mode-env-protect`) are deliberately different
 * things — see src/index.ts.
 */

/** Lower-case, trimmed agent name.  A non-string (or empty) normalizes to "". */
export function normalizeAgentName(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : ""
}

/** Is this the lead role?  `team` / `Team` / `TEAM` all answer yes. */
export function isLeadAgent(name: unknown): boolean {
  return normalizeAgentName(name) === "team"
}

/** Do two agent names refer to the same role, ignoring case?  "" never matches. */
export function sameAgent(a: unknown, b: unknown): boolean {
  const na = normalizeAgentName(a)
  return na !== "" && na === normalizeAgentName(b)
}

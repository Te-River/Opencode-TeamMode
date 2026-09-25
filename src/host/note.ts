/**
 * The runtime prompt addendum both plugin personalities hand to the team
 * agent. It lives here rather than inside a personality because the board
 * root and the TTL sweeper are the same regardless of host generation.
 */
export function blackboardNote(root: string, ttlDays: number): string {
  return [
    "",
    "",
    "## Team Blackboard — resolved for this workspace",
    `Root directory: \`${root}\``,
    `- Hybrid channel: specialist replies (the STATUS/CHANGES/FINDINGS/EVIDENCE/HANDOFF`,
    `  skeleton) are the PRIMARY transport — normal work needs no files at all.`,
    `- Board files exist ONLY for oversized deliverables (>~50 lines), and they`,
    `  go through \`tm_board_write { task, topic, content, session? }\` — the board's`,
    `  write side, carried by every role including the ones with no file tool.  It`,
    `  places \`<root>/<session-key>/<task-slug>/NN-<role>-<topic>[-rN].md\`, never`,
    `  overwrites, and answers with the PATH (never the content).`,
    `  On the FIRST board write of this conversation pass a session folder made from`,
    `  a compact clock timestamp (PowerShell: \`Get-Date -Format yyyyMMdd-HHmmss\`;`,
    `  POSIX: \`date +%Y%m%d-%H%M%S\`) and reuse it for every later task; omit it and`,
    `  the tool stamps one — that is how a role with no bash reaches the board at`,
    `  all.  Never write into another conversation's session folder.`,
    `- Auto-cleanup: the plugin sweeps task directories idle for more than ${ttlDays} days (at startup and hourly).`,
    `  This is the ONLY cleanup path — never delete task or session directories yourself.`,
  ].join("\n")
}

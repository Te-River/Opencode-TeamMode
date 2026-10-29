# The host's own goal feature (`opencode.goal`) — evidence trail

Read-only investigation on **OpenCode host 2.2.1** (desktop, Windows). Nothing here
modifies the host, its binary, the user's `~/.config/opencode`, or the SQLite DB.
Every claim states how it was observed.

## 1. The feature exists as a plugin, not a tool

The host ships a built-in plugin `opencode.goal`. Two independent observations:

- **RPC registration in the binary** (windowed read of the executable around the
  plugin machinery): the server side registers exactly ONE method —
  `rpc.register(jee, { get: ... })`. There is no `set` / `pause` / `resume` / `clear`
  method.
- **No model-facing tool.** `ctx.tool.list()` on a live 2.2.1 session lists
  `patch / edit / glob / grep / session_rename / session_move / worktree_* / models /
  list_mcp_resources / read_mcp_resource / question / read / shell / skill / subagent /
  webfetch / websearch / write` — no goal tool. So a model can only reach the feature
  through a plugin, and a plugin can only reach it through the RPC (read) or the
  user-facing command (write).

## 2. The RPC definition and the read seam

The portable definition a plugin hands to `ctx.rpc` (this is what
`HOST_GOAL_RPC_DEFINITION` in `src/tm/goal.ts` carries):

```json
{
  "id": "opencode.goal",
  "methods": {
    "get": {
      "input": { "type": "object", "properties": { "sessionID": { "type": "string" } }, "required": ["sessionID"] },
      "output": {}
    }
  },
  "events": {
    "changed": {
      "schema": { "type": "object", "properties": { "sessionID": { "type": "string" }, "goal": {} }, "required": ["sessionID", "goal"] }
    }
  }
}
```

- `ctx.rpc` on the v2 plugin ctx is a **function of length 1** — a client FACTORY, not a
  client. `ctx.rpc(definition)` returns the per-plugin client; `.get({sessionID})` is the
  only method it carries.
- **Live-verified in a zero-token sandbox**: `ctx.rpc({...}).get({sessionID})` returned
  `null` cleanly for a session with no goal. A non-null answer is the goal object (below).

## 3. The state shape

Read out of the host's SQLite `kv` table for a live session (read-only query; no writes):

```json
{
  "id": "...",
  "objective": "...",
  "status": "active",            // "active" | "paused" | "complete"
  "reason": "...",               // present once paused/complete for a reason
  "rounds": 0,
  "maxRounds": 50,
  "stalls": 0,
  "boot": "...",
  "updatedAt": 1760000000000
}
```

Storage key: **`plugin:<utf16hex("opencode.goal")>:session:<sessionID>`** — i.e. the
goal plugin's OWN namespace, keyed by session. Our `ctx.storage` is namespaced the same
way for us (`plugin:<utf16hex(our id)>:...`), so **we cannot read that row**, and
per-plugin namespacing is the reason. That is why the RPC is the only read seam; a
storage read is not merely inconvenient, it is impossible by construction.

## 4. Objective cap (4000) — measured, not borrowed

Read out of `opencode-cli.exe` (goal module, host 2.2.1, read-only windowed scan):

- the constant is `var xy=4000, …`;
- the `/goal` command refuses past it with the host's own sentence
  **`A goal objective is limited to ${xy} characters (got ${C.length}).`**

So 4000 is **the host's** number, not our memory store's coincidentally-equal cap, and
`tm_goal` refuses a 4001-character objective **before** any read RPC or command is issued
(the host would otherwise spend a turn saying the same thing).

Related parsing detail, from the same module: `/goal <text>` treats a trimmed, lowercased
`pause` / `resume` / `clear` (and empty text = status) as a SUBCOMMAND. An objective spelled
exactly like one of those three words would therefore run that subcommand instead of setting
a goal, so `tm_goal { action:"set" }` refuses those three words.

**The quote step.** Before any of that, the host's `OL()` strips ONE matching quote pair:
`^(["'\u201C\u2018])([\s\S]*)(["'\u201D\u2019])$` → the inner text. Two consequences:

- `"clear"`, `“pause”` and `'resume'` are the SAME subcommands as the bare words — so a
  guard comparing the raw objective would let `set { objective: '"clear"' }` clear the
  user's goal. `src/tm/goal.ts` therefore compares the HOST-PARSED value
  (`hostGoalParseTarget`, the same regex) while still sending the user's original text
  verbatim; the refusal stays at `phase=args`, before any read or command call.
- the opening and closing classes DIFFER in the host's regex, so it does not require the
  two quotes to belong to one family (`“x'` is stripped too). The helper mirrors that
  exact shape rather than a tidier "same-family pair", because any mismatch one way lets a
  spelling through that the host still reduces to a subcommand, and any the other way
  rejects text the host would have accepted.
- an objective that is ONLY a quote pair parses to the empty text (= the status
  subcommand), so it is refused as an empty objective.


## 5. Writing is a COMMAND, not an RPC
The host registers a user-facing slash command `goal`:

```
/goal <objective> | pause | resume | clear
```

A plugin reaches it as `ctx.session.command({ sessionID, name: "goal", text })`.

**Fire-and-forget was measured, not assumed.** In the sandbox, a non-awaited
`ctx.session.command({sessionID, name:"goal", text:"PROBE_GOAL_FIRE_AND_FORGET"})`
produced, without anybody awaiting it:

- a goal row `{status:"active", objective:"PROBE_GOAL_FIRE_AND_FORGET", maxRounds:50, ...}`;
- a persisted kickoff message in the session: `"A goal is now active for this session…"`
  with metadata `{source:"goal", goalID}`.

That kickoff message is the host STARTING A TURN. The practical consequence: a tool that
`await`s this call parks the caller for the length of a run the caller does not own, so
`tm_goal` fires it and attaches a rejection handler instead of awaiting it. `tm_goal`'s
own reply therefore says **submitted**, and tells the caller to re-read `status` on the
next turn — the host's `"active"` is the proof, not our call returning.

## 6. Restart behaviour (why a goal can come back paused)

A host boot scans stored goals and pauses any goal that was `active` when the process
died, with `reason` ≈ `"The server restarted while the goal was active"`. So `paused`
after a restart is HOST behaviour, not a failure of the caller — worth knowing before
anybody "fixes" it by resuming in a loop.

## 7. What this means for the plugin

| question | answer |
|---|---|
| can we read the goal? | yes — `ctx.rpc` → `opencode.goal.get({sessionID})` |
| can we read it another way? | no — the state lives in another plugin's storage namespace |
| can we write it by RPC? | no — only `get` is registered |
| how do we write it? | `session.command({sessionID, name:"goal", text})`, **never awaited** |
| what does "submitted" prove? | that the command reached the host; NOT that a goal is active |
| how is "active" proven? | a later `tm_goal { action:"status" }` answering `status:"active"` |
| is there a goal tool? | no — hence `tm_goal` |

Implementation: `src/tm/goal.ts`; wiring from the live ctx: `buildGoalDeps` in
`src/host/v2.ts`; tests: `test-v2-adapter.mjs` group `4b`.

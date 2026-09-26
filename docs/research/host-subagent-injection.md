# OpenCode 2.x — how a background sub-agent is dispatched, acknowledged, and answered

**Scope:** one exported desktop session (`e-f.json`, provided by the user on 2026-09-26),
read as evidence. Nothing in the host was modified and nothing here was inferred from the
v1 behaviour: every claim below is either quoted from that export or measured against it.
The session's workspace path is deliberately not reproduced.

**Why this page exists.** On v2 a plugin cannot create an agent and cannot create a
session it is allowed to read, so delegation goes through the host's own `subagent` tool.
`tm_join` — the collect side — therefore needed to know what that tool gives a plugin at
each of three moments: when the call is made, when the host acknowledges it, and when the
child's answer comes back. Getting the second one wrong is what made the feature look
impossible: the ack is small and the answer is not a tool result at all.

## 1. The dispatch, as the plugin sees it

`[L]` `execute.before` carries the model's own arguments:

```
{ tool: "subagent",
  args: { agent: "architect", background: true,
          description: "注入形状取证", prompt: "…" } }
```

`description` is a task name, `prompt` is the work. Only `description` is worth keeping
and only for the lead's own table: `prompt` is free text and never enters the trajectory
(the R6 rule binds a diagnostic as much as a guard).

## 2. The ack — this is the seam that makes claiming a child possible

`[L]` The synchronous result of a background dispatch is small (98 tokens measured on an
earlier host build) and carries the child's identity twice:

```
content[0].text = "The subagent is working in the background (sessionID: ses_f2417df8…).
                   You will be notified automatically when it finishes.
                   DO NOT sleep, poll for progress, ask the subagent for status, or
                   duplicate this subagent's work; …"
metadata        = { sessionID: "ses_f2417df8…", status: "running", truncated: false }
```

Two consequences that changed the design:

1. **`execute.after` on tool `subagent` yields the child session id.** No `session.get`,
   no `session.children`, no guessing: the host hands it over. Our `ctx.session.get`
   bridge never resolved a shape on a live host, so a tree walk was not an option, and
   this made the question moot.
2. **`status:"running"` is the host telling us the work is open.** A synchronous child
   has no `metadata.sessionID` at all — its result IS the reply — so "no child id" is the
   correct answer for that call, not a failed lookup.

The id is read from `metadata` first and from the ack sentence second, because a field
shape is exactly what a host upgrade changes.

## 3. The answer is a message, not a tool result

`[L]` When the child finishes, the parent receives a synthetic message. From the export,
the message's own fields:

```
type: "synthetic"
description: "注入形状取证"
metadata: { source: "subagent", childID: "ses_f2417df8…", agent: "architect", state: "completed" }
text:     <subagent sessionID="ses_f2417df8…" state="completed" description="注入形状取证">
          PROBE-OK
          </subagent>
```

Note the key names differ between the two moments: the ack says `sessionID`, the
injection says `childID` (and adds `source`, `agent`, `state`). A matcher that assumes one
spelling for both is the bug class this page exists to record — `parseHostEnvelope` in
`src/task-offload.ts` accepts both the v1 `<task id=` and the v2 `<subagent sessionID=`
wrapper for exactly this reason, and rewrites only the body, because the session id inside
the envelope is the pointer the lead uses to fetch the reply back.

What the plugin does NOT get on v2: a hook that sees this message. v1 was handed
`chat.message`; the v2 plugin surface has no equivalent, so the body reaches the model and
not us. `tm_join` therefore reports the child's state and provenance and says where the
text is, rather than printing a reply it never read.

## 4. Ordering, measured, and the one inference it licenses

`[L]` From the export's timestamps (same session, milliseconds):

| moment | ts |
|---|---|
| child injected into the parent | …824730 |
| parent's next assistant message streamed | …824763 → …829026 |
| parent session `idle` | …829038 |

So the injection precedes the parent's idle by construction — the parent cannot go idle
with an undelivered notification. That single ordering fact is what licenses the fallback
in `src/tm/dispatch.ts`: a host-dispatched child still marked running when ITS PARENT goes
idle is settled as `settleSource: "parent-idle"` and printed as 推定已结算, with the reason
in the same line. The child's own `session.idle` on the event feed remains the measured
path (`settleSource: "event"`); the two are never printed the same way, because one is an
observation and the other is an inference from a host ordering we happened to see once.

## 5. What is still unmeasured

`[U]` Whether the host emits `session.idle` for the CHILD session to a plugin subscriber —
the feed forwards it if it arrives, and `tm_stats` shows the counts, so this is answerable
from the next real round rather than from this page. `[U]` Whether `state` can be anything
else besides `completed` in the injection (v1's envelope carried `error` too, and an error
child is never rewritten to save tokens). `[U]` Whether a child of a child is ever
dispatched: the config gives nesting depth one, and the T3 rule says only the lead
dispatches, so this page describes one level.

# OpenCode 2.0.18 — the host's own HTTP API, and what it changes for a plugin

**Status: mapped, not called.** Every route below was read out of the installed host's
embedded JS (the SDK client factory: `method:"GET", path:"/api/…"` entries, both literal and
template-literal), cross-checked against the official v2 API page for the plugin endpoints. **No
request has been made to any of them** — so "exists in the client" is not the same claim as
"works from a plugin process", and nothing here is a verified capability.

**Why it matters.** The v2 plugin context is thin: no SDK client, no `session.children`, no
message domain, no dialog. Several conclusions this repo recorded as host limitations are
actually *ctx* limitations — the server behind the ctx has a much larger surface. This page
separates the two so a future change does not re-accept a limitation that is really a missing
transport.

## 1. Discovery and authentication

`[B]`+`[D]` `GET /api/info` returns "the server identity, connection URLs, paths, and
readiness status". The CLI reaches a server through a helper that yields `{url, password}`, and
the transport is HTTP Basic with a fixed username:

```js
{ type: "basic", username: "opencode", password: e.password }
await fetch(new URL("/api/info", e.url), { headers: X(i), signal: AbortSignal.timeout(r) })
```

`[B]` The password is **not** per-process random-only: `<global-config>/service.json` holds a
single `password` string (43 chars on this machine). The port is dynamic (`serve --stdio
--port 0`), which is why `/api/info` exists.

`[U]` Whether a plugin can obtain `{url, password}` from its own context instead of reading
that file is the open question, and it is the whole cost of every item below: **reading the
user's credential file to call back into the host is a new trust boundary**, and a plugin that
does it silently would be doing exactly what goal #6 forbids. Nothing in this repo does it
today, and `src/host/v2-session-client.ts` says so where the temptation is documented.

## 2. The routes that touch our recorded conclusions

| route family (`[B]`) | what it offers | which claim it reopens |
|---|---|---|
| `GET /api/plugin`, `POST /api/plugin/check`, `POST /api/plugin/update` | the enabled server plugins **with live status**, plus update checking | the install-verification story: this is a cleaner arrival check than grepping `msg="loading plugin"` (which is what `docs/installation-v2.md` currently tells an agent to do) |
| `GET /api/session/{id}/message`, `GET /api/session/{id}/message/{messageID}`, `GET /api/session/{id}/context` | read a session's messages — including a CHILD session | `tm_join`'s "the body arrives by injection, we cannot read it" limit. The in-process `ctx.session.context` is tried first (see §4); the API is the fallback with a price |
| `GET /api/permission/request`, `POST /api/session/{id}/permission`, `GET /api/permission/saved`, `DELETE /api/permission/saved/{id}` | the permission queue, answering it, and the saved-rule store | **"a plugin cannot raise a dialog on v2"** — that was measured against the ctx (`options.permission` on our own tool produced no evaluation). The server clearly has a dialog surface; whether a plugin may drive it is unmeasured, and driving it *for* the user would be self-allowing, which this project never does |
| `GET /api/pty`, `POST /api/pty`, `GET /api/pty/{id}/output?`, `GET /api/experimental/persistent-pty/{id}`, `.../snapshot`, `.../connect-token`, `POST /api/experimental/persistent-pty/{id}/connect-token` | terminal sessions with **snapshot/read**, i.e. exactly the capture capability `tm_pty` lacked | task #21 ("v2 has no `client.pty` → retire `tm_pty`") was decided on the ctx surface. The host has a persistent-pty API. Retirement still looks right (a plugin spawning terminals the user cannot see is its own problem), but the reason is now "no in-process seam + trust boundary", not "the host has no such thing" |
| `GET /api/fs/read/{path}`, `GET /api/fs/list`, `GET /api/fs/find`, `POST /api/experimental/fs/write` | file access through the host's own permission layer | reinforces the 1.7.x decision to retire `tm_read`/`tm_grep`/`tm_bash` in favour of the native ladder — the native path is where the host's `external_directory` dialog lives |
| `POST /api/websearch`, `GET /api/websearch/provider` | server-side search | all four native providers need a key/`/connect`, so `tm_search`'s zero-key front stays (unchanged conclusion, now with the reason visible) |
| `POST /api/session/{id}/wait`, `POST /api/experimental/session/{id}/wait`, `GET /api/experimental/session/stats`, `GET /api/experimental/session/{id}/export`, `POST /api/session/{id}/synthetic`, `.../interrupt`, `.../compact`, `.../fork` | waiting on and injecting into sessions | the shape of what a *session-owning* API looks like — useful for judging whether `tm_join`'s bounded wait is fighting the host or duplicating it |
| `GET /api/event` | the SSE feed | `ctx.event.subscribe()` is this stream, in-process. No reason to prefer HTTP |

## 3. The question the user actually asked: is there a todo list?

**No.** `[B]` Across **136 distinct `METHOD /path` pairs** in the scanned window (55 literal +
81 template-literal paths, deduplicated — a lower bound, since the scan covered 2 MB of the
embedded JS rather than the whole client factory) there is no `todo`, no `plan`, no `task`
resource; the only `message` routes are `GET /api/session/{id}/message` and
`GET /api/session/{id}/message/{messageID}`. `[D]` The official API page lists none either. The
v1 REST endpoint `GET /session/{id}/todo` that `tm_join`'s goal tripwire was written against
does not exist on 2.x, which is the same fact as "the host has no `todowrite` tool" seen from
the other side. So `tm_ledger` is not a workaround we settled for: it is the only ledger there
is. What *is* available for the same purpose is `GET /api/session/{id}/context` (in-process)
and `/message` (HTTP) — reading what the model was told, rather than a list the model
maintains.

## 4. What was verified instead, in-process

`[B]` The host's own call sites give the plugin-facing argument shape, and that fixed a bridge
that had never worked:

```
te = (schema, fn) => (input) => decode(schema, input ?? {}) → fn(decoded)
await e.session.get({ sessionID: n })
await e.message.list({ sessionID: n, limit: 200, cursor: r })
```

`ctx.session.get` therefore takes a **single flat object `{sessionID}`** — not v1's
`{path:{id}}`, and not an array. `src/host/v2-session-client.ts` had both wrong, which is why
every lookup failed silently for a release cycle.

`[L]` **The full ctx domain set, measured 2026-09-26 with zero model tokens** (a plugin that
only inspects its own context, booted under `--standalone --model nope/nope`; every method
called with `{}` so the host's own decode error names the required key):

| domain | what the host gives a plugin |
|---|---|
| `session` | `hook create get switchAgent switchModel prompt generate command synthetic interrupt update move wait context` |
| `permission` | `hook list get reply` — all of `list/get/reply` decode as `{sessionID}` |
| `experimental` | `terminal.read` (decodes as `{sessionID}`; a terminal-id spelling has not been found) |
| `storage` | `get set remove scan` |
| `agent` / `model` / `command` / `mcp` / `worktree` | `list/get/transform/reload` families |
| `event` | `subscribe` (an async iterable, already used by `v2-events.ts`) |
| `rpc` | a single function of arity 1 — its calling convention has NOT been read out |

`[L]` **`ctx.session.context({sessionID})` answers with an ARRAY of flat items**, measured
against a real background child from a live round:

```
array(5) < { id: string, time: { created: number }, text: string, type: string }  // type "user" …
```

That is NOT v1's `[{info:{role},parts:[…]}]`, and it is the reason a child's report was lost for
a release: `v2-session-client.ts` already called `context`, then handed the array to
`lastAssistantMessage`, which tolerates an unknown shape by returning no text. The seam
ANSWERED and the body was discarded, while `tm_join` told the lead 正文不经本工具 — our decode
miss reported as the host's limit. The flat shape is now normalised at the seam
(`normaliseContextMessages`), and no `time.completed` is invented there, because that field *is*
the settle verdict.

## 5. Deliberate non-goals

`[U]` No HTTP call is made by this plugin today. The reasons are recorded rather than implied:
the credential read is a trust boundary the user has not been asked about; a plugin answering
`/api/permission/request` would be self-allowing; and a plugin that can `POST
/api/experimental/fs/write` bypasses the very `session.hook("context")` trim that keeps a
denied role from being offered a tool. If any of these is ever pursued, it goes through the
same gate as everything else here: Team-scoped, counted, and visible in `tm_stats`.

## 6. The #32 decision, and what closed it

The user authorised the HTTP API on one condition — 保证不会被泄露. That condition is the reason
§4's probe happened first, and the probe made the condition moot:

- **子会话正文**: `ctx.session.context` in process (§4). No credential exists to leak.
- **权限队列**: `ctx.permission.list({sessionID})` answers in process — verified as a seam,
  NOT yet used. Reading it to tell the user "N dialogs are waiting" is legitimate; calling
  `reply` is not, because that is self-allowing, and `reply` stays uncalled.
- **pty 捕获**: `ctx.experimental.terminal.read({sessionID})` exists but its second argument
  has not been found, so `tm_pty`'s retirement decision (§21) is unchanged for now — the
  reason is updated from "the host has no such thing" to "the plugin seam is unread".

What the scan still settles on its own: there is **no todo/plan/task resource anywhere**, so
`tm_ledger` is not a compromise. And `~/.config/opencode/service.json` has never been opened by
this plugin, which `test-v2-adapter.mjs` group 12 asserts against the shipped source.


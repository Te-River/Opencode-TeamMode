# OpenCode 2.0.16 — every built-in tool, forensically

**Scope:** read-only static forensics on the installed host. Nothing in the host was
modified, no `opencode` session was run (a live agent owns that lane), and no existing
repo file was touched — this page is the only artifact.

**Privacy:** names, shapes, enums and numeric caps only. No user paths, no URLs, no
command lines, no environment values appear below, in keeping with the R6 red line.

## 0. Where each claim comes from

| Tag | Source | Strength |
|---|---|---|
| `[B]` | Strings read out of the installed host's `resources/opencode-cli.exe` (its sibling `opencode-cli.version` reads `2.0.16`) with a windowed byte scan. The embedded Effect/JS is what actually runs, so a literal read here is the implementation, not a doc. | strongest offline |
| `[L]` | Prior **live** probe records in project memory (`host-v2-tool-surface`, `opencode-desktop-capabilities`) on the same 2.0.16 host | strongest overall |
| `[R]` | Our own code, already measured against a live host (`src/host/v2-*.ts`, `src/tm/*.ts`) | ours, verified |
| `[D]` | Official v2 plugin docs (hook mutability, agents/commands markdown) | corroborating |
| `[U]` | Unknown — written as unknown, never as fact | — |

## 1. The rule that decides what a model can call (the finding that reframes everything)

`[B]` The tool registry, at request-assembly time, splits **every** registered tool by one
field:

```
direct      = tools with options.codemode === false      → sent as provider tool definitions
catalog     = tools with options.codemode !== false      → reachable ONLY inside `execute`
execute     = appended to `direct` unless a permission rule denies action "execute" with resource "*"
```

and renders the catalog into the **system prompt**, not into the tool list:

> `# Code Mode`
> "Use the `execute` tool to call the tools listed below. They cannot be called directly…
> only work inside code you pass to `execute`."
> when the budget is exceeded: "The catalog is partial. Inside `execute`, use `search(...)` to
> find a tool, then call it by the `path` in the result. `search` is synchronous. Call it without
> `await`; it does not return a Promise. Do not guess tool names."

Catalog accounting, verbatim from the same module: each entry prints
`  - <typescript-signature> // <first line of the description>`, the first line is cut at
**120 chars**, the whole catalog is budgeted at **2000 "tokens"** estimated as
`round(chars / 4)`, and namespaces are always listed before entries. So a plugin tool's
description costs the catalog **its first line only**, and the rest of the text is fetched on
demand by `search()`. `[B]`

Three consequences that change a business claim rather than an implementation detail:

1. **The 6-tool measurement is explained, not mysterious.** `[L]` `session.hook("context")`
   carried `edit execute question shell subagent write` and zero `tm_*`. `[B]` says why: every
   host core tool sets `codemode:false` (so it is a real definition), and our
   `bindV2Tool()` sets **no `options` at all** `[R]` → `codemode !== false` → catalog-only. It
   was never "plugin tools are not registered": `ctx.tool.list()` saw them `[R]`, and the model
   reached them through `search()` `[L]`.
2. **A denied action removes a tool from BOTH surfaces.** `[B]` `Qc(name, rules)` drops a
   registration when the *last* matching rule for `options.permission ?? exposedName` is
   `resource:"*" && effect:"deny"` — before the direct/catalog split. Our
   `delete event.tools.<name>` in `v2-session.ts` `[R]` therefore only governs the **direct**
   surface, which on a live v2 request never contained the catalog tools in the first place.
3. **The one real gap this exposes (repo-side, stated as a to-do, not as a defect of the
   host):** `tm_browser: "deny"` translates to the triple `{action:"tm_browser" …}` `[R]`,
   which removes **our** door from the catalog but nothing names the host's `browser` action —
   and the browser tools all share `options.permission:"browser"` `[B]`. Meanwhile
   `toolsToRemove()` pushes the `browser_*` sentinel into the *request-layer* deletion `[R]`,
   where those names are absent by construction. Net effect on v2 today: a role denied
   `tm_browser` still reaches all 45 native browser tools through `execute`. The fix is one
   projected triple `{action:"browser", resource:"*", effect:"deny"}`, which `[B]` shows is
   exactly the mechanism the host honors.

Name derivation, `[B]`: exposed name =
`options.namespace.replace(/[^a-zA-Z0-9_-]/g,"_") + "_" + name.replace(/[^a-zA-Z0-9_-]/g,"_")`,
or the bare name when there is no namespace. That is why `browser.tabs.open` is both
`tools.browser.tabs.open` (Code Mode path) and `browser_tabs_open` (flat tool name) — two
spellings of one registration, which `[L]` already caught in a live probe.

## 2. Core built-in tools — 12, all direct (`codemode:false`) `[B]`

Each is registered by an Effect plugin with `id: "opencode.tool.<name>"`; there are exactly
twelve such ids in the binary, which is the complete list. Fields below are the **model-visible**
parameter names, the host's own caps, the permission action it asserts, and the result shape.

### 2.1 `read`
- **params** `path` (required, "File or directory to read"), `offset?` (1-based line **or**
  directory entry), `limit?` — "defaults to and capped at 2000".
- **caps** `[B]` 2000 lines/entries per page, 51 200 bytes per page, 2 000 chars per line with the
  literal tail `... (line truncated to 2000 chars)`, 256 KiB head probe, 20 MiB media ingestion cap.
  Binary mimes it will attach: `image/png image/jpeg image/gif image/webp application/pdf`;
  anything else binary raises `ReadTool.BinaryFileError`. Other errors: `OffsetOutOfRangeError`,
  `PathKindError`, `MediaIngestLimitError`.
- **output** tagged union `file | text-page | list-page`; every text line comes back prefixed
  `<n>: ` (the description warns the prefix is not file content); directory entries come back as
  `{path, type: file|directory|symlink}` lines. `metadata.truncated` is set for pages, forced
  `false` for a single attached file. **There is no `list` tool** — `read` on a directory is it.
- **permissions** `[B]` two asserts, not one: `action:"read"` with the resource being the path
  **relative to the session directory** (absolute when outside), plus, only when the target is
  outside the session/project root, `action:"external_directory"` with resource
  `<containing-dir>/*`. `[L]` observed that one live at `effect:"ask"` behind a real
  `permission.asked` — i.e. v2's path scope is a **dialog**, where v1's P2 was a hard throw.
- **side effect worth knowing** `[B]` on a read of a file inside a project it walks upward for
  `AGENTS.md` and loads the ones it has not loaded yet — the host does instruction-file JIT itself.
- **for us** the replacement for `tm_read`, and strictly better (paged, images/PDF inline). Already
  retired `[R]`.

### 2.2 `write`
`{path, content}` → output `{operation:"write", target, resource, existed}`; text
`"Wrote file successfully: X"` / `"Created file successfully: X"`. Asserts `action:"edit"`
(`options.permission:"edit"`), creates missing parent dirs, preserves BOM. Replacement floor for a
board-file write, but `tm_board_write`'s never-overwrite + role-from-`ctx.agent` + slug rules are
not anything native gives us.

### 2.3 `edit`
`{path, oldString, newString, replaceAll?}`. Uniqueness enforced by an error that says so
("Found N matches for oldString, but expected exactly one…"). `[B]` the matcher folds typographic
quotes/dashes/non-breaking spaces and trailing whitespace before comparing, and preserves BOM.
Content `"Edited <file> (N replacements)"`, `metadata.files[]`. Asserts `action:"edit"`.

### 2.4 `patch`
`{patchText}` (one string: add/update/delete ops) → `{applied:[{type:"add"|"update"|"delete",
resource,target}], files[]}`; content `"Success. Updated the following files:"` + `A|D|M <resource>`
lines. Asserts `action:"edit"` via `options.permission`. Note `tm_read`-style pagination applies to
nothing here; this is the v2 name of v1's `apply_patch` `[R]`.

### 2.5 `shell`  ← the v2 name of v1's `bash`
- **params** `command` (required) · **`workdir?`** (NOT `cwd` — the host's own words: "avoid
  changing directories in the command and set the working directory here instead") ·
  `timeout?` **ms**, `0` disables, default **120 000** for foreground, **no timeout by default when
  background** · `background?` (bool; "DO NOT poll for completion").
- **description claims** `[B]` "When output is large, the full result is saved to a file and a
  truncated preview is returned" / "Prefer dedicated tools over shell commands when possible" /
  "Background commands return immediately, and you will be notified when they complete".
- **output** `{output, exit?, shellID?, truncated, timeout?, status?:"completed"|"running"}`.
  Truncation keeps **the tail**: last 2 000 lines and last 51 200 bytes (config-overridable via the
  `tool_output` entry), then appends the literal `[full output saved to <file>]`. `[B]`
  Background returns `Command moved to the background (shell ID: X).` + `Output is streaming to:
  <file>`, and completion is injected later as a **synthetic message**
  `<shell id="…" state="…" command="…">…</shell>` with `metadata.source:"shell"`.
  **Note for R6:** that envelope re-enters context carrying the command text.
- **permissions** `[B]` the strongest thing in this section: before executing, the host parses the
  command with **tree-sitter bash/PowerShell grammars**, and asserts
  `action:"shell"` with **one resource per parsed command** — the resource is that command's own
  text (and, for a redirected statement, the text *including* its redirect target) — while the
  `save` half of the same call is a **program-scoped glob**: first N words of the command
  (`cat`, `ls`, `git`→2, `npm`→2, `docker compose`→3, `gh`/`aws`/`gcloud`→3 … a ~110-entry table)
  plus `" *"`. Directory-changing builtins (`cd chdir popd pushd push-location set-location`) are
  not permissions at all; their path arguments are scanned and routed through
  `external_directory`. `[L]` had already recorded `{action:"shell", resourceCount:1}` reaching
  `permission.evaluate` for a real git invocation; `[B]` now explains the number: **1 command, 1
  resource**. This is the evidence #12 needed — the host hands our classifier a per-command face,
  so `TM_R6_FINE_ASK=on` is not a guess layered on a coarse rule, and the config-level
  `shell→ask` blanket is the fallback, not the ceiling. (An *experimental*
  `portable_shell_scanner` alternative exists; when it cannot analyze a command it **errors the
  call** rather than widening — `[B]`, off by default.)
- **for us** replaces `tm_bash` `[R]`, with three prompt-visible differences: `workdir` not `cwd`,
  tail-not-head truncation, and a real `background`. Our bash timeout clamp still applies
  (`shell.hook("create.before")` carries mutable `{command,cwd,timeout,shell,env}` `[L]`), and the
  P3 read-only allowlist has **no native counterpart** — the host never refuses a *read-only*
  command class, so anything that behaves like P3 stays ours.

### 2.6 `glob`
`{pattern, path?, hidden?, limit?}` — default limit **100**, internal timeout **30 s** with the
message "Search timed out after 30 seconds. Consider using a more specific path or pattern."
Output `{entries:[{path,…}], truncated}`; content is resolved absolute paths one per line, or
`No files found`, plus the truncation note. Asserts `action:"glob"` with resource = **the pattern**
(not a path). Replaces `tm_grep`'s enumeration half; note it does not stat, so an empty result is a
true negative.

### 2.7 `grep`
`{pattern, path?, include?, literal?, caseSensitive?, limit?}` — ripgrep regex or **literal**
(`literal:true`), `caseSensitive` defaults **true**, default limit **100**, same 30 s cap. Content:
`Found N matches`, then `<path>:` blocks with `  Line <n>: <text>`; `No matches found` when empty;
truncation note appended. `metadata {matches, truncated}`. Asserts `action:"grep"`, resource = the
pattern. **This is the only place the empty-result self-report (design goal, §6g2) is duplicated by
the host** — it says `No matches found` but never names the widening moves, and it prints nothing
about the scope searched, so our `（0 命中）pattern=… · 范围=…` line remains an improvement, not a
restatement.

### 2.8 `webfetch`
- `{url, format?:"text"|"markdown"|"html" (default markdown), timeout? seconds, max 120, default 30}`.
- Output `{url, contentType, format, output}`; `metadata.contentType`. Response cap **5 242 880 B**
  ("Response too large…"), refuses `image/*` (except svg/fastbidsheet) and any non-text-ish
  content type, and does its own HTML→text/markdown conversion.
- Description admits the host's own offload: "Large text results may be replaced with a preview
  while the complete output is retained in managed storage."
- **Red line: there is none.** `[B]` the only validation is
  `protocol !== http:/https: → "URL must use http:// or https://"`. No literal, no
  link-local/metadata/reserved check, no private-space check — which is precisely the hole
  `src/host/v2-guard.ts` closed by answering the address question at
  `permission.hook("evaluate")` `[R]`, and the reason that guard may not be reordered after any
  future `webfetch`-adjacent retirement.
- Also `[B]` the host's own docs for this tool say "Use a more targeted tool when one is available"
  — the ladder instinct is shared, in words only.

### 2.9 `websearch`
`{query}` → `{provider, results[]}`; content is `## [title](url) Published: <iso>` blocks; empty →
"No search results found. Please try a different query."; HTTP 429/401 mapped to named messages.
Description injects the **current year at registration time** and tells the model to use it — the
same recency problem our `searchDateLine` answers, but note the host stamps it into a *description*,
which for a process living for days is the drift our own test-blackboard date guard exists to
prevent. `[B]`
When no provider is selected it raises **the host's own** ask dialog (allow / choose provider /
disable) — reachable only from inside the host, never from a plugin `[L]`. All providers need a key
or `/connect` `[R]`. It self-removes from the tool surface via `session.hook("context") + delete`
when websearch is switched off `[B]` — the host uses the same request-layer lever we do.
**Verdict:** does not replace `tm_search` (zero-key + multi-engine vote is the whole point).

### 2.10 `question`
`{questions:[{question, header, options:[{label, description}], multiple}]}` →
`{answers: string[][]}`. Asserts `action:"question"` with resource `"*"`, then calls the host's
**internal** ask service with typed fields (`multiselect` when `multiple`). `[B]`
This is the concrete proof of the v2 consent gap: the dialog machinery exists in the same process,
on a seam plugins cannot reach — matching `[L]`'s live result that a plugin-declared
`options.permission:"…"` produced no evaluation and no prompt. The lead's
"blocking question" path on v2 therefore has exactly one home: let the model call `question`.

### 2.11 `skill`
`{id}` (an available skill id, or one the user named) → `{name, directory, output}`;
`metadata{name, directory}`. Asserts `action:"skill"` with resource = the skill id, and
`save:[id]` — an "always" here is scoped to that one skill, unlike `read`'s `save:["*"]`.

### 2.12 `subagent`  ← v2 name of v1's `task`
- `{agent, description, prompt, model?, sessionID?, background?}`. `model` is `"providerID/modelID"`
  or `…#variant` and the description says "NEVER set this unless the user explicitly asks… look the
  model up with the models tool". `agent`'s description carries a live-lesson: a name that is not a
  known subagent "most likely mean a model". `sessionID` continues a previous child conversation;
  omitted = fresh context.
- **permission resource is the target agent id** (`save:[id]`) `[B]` — that is the mechanism behind
  "the parent's `subagent` permission decides which roles it may start" `[D]`, and it is why T3's
  "only the lead dispatches" survives v2 as a triple, not as a prompt.
- **foreground result content** `[B]`, verbatim shape:
  `<subagent sessionID="…" state="completed">\n<reply>\n</subagent>` with
  `metadata {sessionID, status}`; an empty child answers
  `Subagent completed without a text response.`; error/cancelled become tool **errors** naming the
  child sessionID.
- **background**: ack `py()` = "The subagent is working in the background (sessionID: X). You will
  be notified automatically when it finishes." + "DO NOT sleep, poll for progress, ask the
  subagent for status, or duplicate this subagent's work…". Completion is injected through
  `session.synthetic` with
  `<subagent sessionID="…" state="…" description="…">…</subagent>` and
  `metadata {source:"subagent", childID, agent, state}` `[B]` — exactly the envelope
  `parseHostEnvelope` matches on v2 `[R]`.
- **and the host registers `tool.hook("execute.before")` for `subagent` itself** (it deletes empty
  `model`/`sessionID` strings) `[B]` — multiple registrants on the same hook point, our own
  background-forcing `applyV2BackgroundForce` included; order is plugin order `[D]`, so "who wins"
  on the same field is a real question, not a formality.

## 3. `execute` — Code Mode, direct, and the only door to the rest

- **input is exactly `{code: string}`** `[B]` — no label, no budget, no tool list.
- **description** `[B]`, condensed to its clauses: run JS in a confined runtime to script tool
  calls and HTTP requests; `fetch` is available; **imports, direct filesystem access and timers are
  unavailable**; the only callable tools are those in the catalog or returned by `search`; call them
  by exact paths, preserve bracket notation
  `tools.<namespace>["tool-name"](input)`; prefer an explicit `return`, else the last top-level
  expression is the result; await what matters or it is interrupted; run independent calls with
  `Promise.all`.
- **runtime globals** `[B]`: `tools, search, Object, Array, Math, JSON, console, Promise, Iterator,
  Number, String, Boolean, parseInt/parseFloat, isFinite/isNaN, Date, RegExp, Map, Set, URL,
  URLSearchParams, Headers, Uint8Array, TextEncoder/TextDecoder, encode/decodeURI(Component),
  atob/btoa, crypto, structuredClone, NaN, Infinity, undefined`; `Function` throws ("write the
  function inline"); `Symbol` limited to the two iterator symbols. `fetch` is a host-supplied
  wrapper with a **30 000 ms** `AbortSignal.timeout`, GET-shaped as `{method:"GET", url}`.
- **error `kind` enum** `[B]`: `ParseError, UnsupportedSyntax, UnknownTool, InvalidToolInput,
  InvalidToolOutput, InvalidDataValue, ToolCallLimitExceeded, TimeoutExceeded, ToolFailure,
  ExecutionFailure, Truncated`. `UnknownTool` even produces the "Did you mean
  `tools.opencode.read_mcp_resource`?" suggestion `[L]` saw live — and confirms a wrong name is a
  **throw**, while `typeof` on the proxy is a lie (`[L]` §2).
- **output** `[B]` `{output: string, toolCalls:[{tool, status:"running"|"completed"|"error",
  input?}], error?: true, files:[{data, mime, name?}]}`, and the content it hands the model is
  `[{type:"text", text:output}, …files as data:<mime>;base64 URIs]` with `metadata {toolCalls,
  error?}`. So a Code Mode program's whole return — every browser snapshot, every nested result —
  enters context as **one** text part. `[L]` measured a 15 000-token program return arriving as
  `offloaded:true / preview_tokens:58`; `[R]` that is why `execute` sits in
  `NATIVE_GOVERNED_TOOLS`.
- **catalog tool** `search` `[B]` (sandbox global, not a model tool):
  `{query?, namespace?, limit? (default 10), offset?}` → `{items:[{path, description, signature}],
  remaining, next:{offset}|null}`; `path` comes back prefixed `tools.`.

## 4. `opencode.*` — 5 catalog tools `[B]`

| Code Mode path | flat name | params | notes |
|---|---|---|---|
| `tools.opencode.session_rename` | `opencode_session_rename` | `title`, `sessionID?` | renames another session |
| `tools.opencode.session_move` | `opencode_session_move` | `directory`, `sessionID?` | "moves at the next safe boundary; do not run destructive…" |
| `tools.opencode.models` | `opencode_models` | `query?`, `provider?`, `offset?` (default 0), `limit?` (default 20) | turns a spoken model name into an exact ref; filters to the caller's provider first |
| `tools.opencode.list_mcp_resources` | `opencode_list_mcp_resources` | `server?` | `{resources[], templates[]}`; templates need `uriTemplate` filled |
| `tools.opencode.read_mcp_resource` | `opencode_read_mcp_resource` | `server`, `uri` | its own description says oversized output "is truncated automatically and the full content is saved to a file you can read"; images/PDFs shown directly |

Namespace blurb shown to the model: "Tools for managing OpenCode itself, such as working with
sessions, searching the available models, and reading MCP resources." `[B]`
MCP servers' own tools are registered as `options.namespace = <sanitized server name>` with
`codemode: <not false>` and **`permission:"<server>_<tool>"`, resource `"*"`** `[B]` — a user's MCP
tool is therefore an action our triples can name but never refine, which is exactly the case
`mergeTriples` leaves untouched `[R]`.

## 5. `browser.*` — 45 catalog tools, one shared permission action `[B]`

Registered from one table under namespace `browser` (+ `browser.<group>`), every entry carrying
`options.permission:"browser"` and `codemode:true`, so: deny action `browser` with `resource:"*"`
and all 45 vanish from both surfaces (see §1.3); `ask` buys nothing, because nothing asserts it —
`[L]` observed `browser_*` calls not triggering `permission.evaluate` at all, while
`tool.hook("execute.before")` **does** see each call with a writable `input` (it stopped a real
navigation and rewrote a real URL). Shared param objects: `tabID` (required nearly everywhere,
"Exact tab ID returned by browser.tabs.open/list"), `frameID?`, `ref`
(pattern `^@?e[1-9][0-9]*$` — the host's snapshot refs are the **same `e1` convention** our
`SnapshotIndex` minted independently), `fileID` (`file_<uuid>`), `limit` 1–500 default 100,
`timeoutMs` 1–30 000 default 10 000.

| flat name | params (required first) | enums / caps | output |
|---|---|---|---|
| `browser_tabs_list` | — | `{tabs[],focusedTabID}` | |
| `browser_tabs_open` | `url?`, `focus?` | url ≤2048, focus default **true** (false only if the user asked for background) | `Browser.Tab` |
| `browser_tabs_focus` / `_close` | `tabID` | — | Tab / State |
| `browser_preview` | `path` | server-local, relative-to-workspace or absolute; images/svg/audio/video/pdf/html/md/**mermaid**/csv/tsv/font render | `{tab,files[]}` |
| `browser_navigate` | `tabID`,`url` | http/https or `about:blank` only | Tab |
| `browser_back` `_forward` `_reload` `_stop` | `tabID` | — | Tab |
| `browser_frames` | `tabID` | — | `{tab,frames[{id,parentID?,url,name}]}` |
| `browser_snapshot` | `tabID` · `frameID?`,`ref?`,`depth?`,`boxes?` | depth 1–20 | snapshot doc (`Hy`) |
| `browser_find` | `tabID`,`text` · `frameID?` | literal, case-insensitive; **refreshes refs** | `Hy` |
| `browser_evaluate` | `tabID`,`script` · `frameID?` | must return JSON-serializable; **no server fs** | `{tab,value}` |
| `browser_click` | `tabID`,`ref` · `button?`,`count?`,`modifiers?` | left/right/middle · 1/2 · Alt/Control/Meta/Shift | Tab |
| `browser_hover` / `browser_check` | `tabID`,`ref` (+`checked`) | | Tab |
| `browser_drag` | `tabID`,`from`,`to` | refs within one tab | Tab |
| `browser_fill` | `tabID`,`ref`,`text` | text ≤10 000 | Tab |
| `browser_fill_form` | `tabID`,`fields[]` ≤100 | each `{ref,type:text\|select\|check}` | Tab |
| `browser_select` | `tabID`,`ref`,`values[]` 1–100 | matched against option **values** | Tab |
| `browser_press` | `tabID`,`key` | named key or chord (`Enter`, `Control+A`, `Meta+A`) | Tab |
| `browser_scroll` | `tabID`,`deltaY` · `deltaX?` | each −10 000…10 000 CSS px | Tab |
| `browser_wait` | `tabID`,`condition` · `text?`,`timeoutMs?` | `load\|text\|textGone` | Tab |
| `browser_screenshot` | `tabID` · `ref?`,`fullPage?`,`format?`,`quality?`,`maxWidth?` | png/jpeg/webp · quality 1–100 · width 100–4000; **"First use browser.tabs.focus and keep the desktop window visible"** | `{tab,files[]}` |
| `browser_dialog` | `tabID`,`action` · `promptText?` | `get\|accept\|dismiss`; "No dialog is reported as null" | `{tab,dialog{type,message,defaultValue}}` |
| `browser_files_upload` / `_drop` | `tabID`,`paths[]` (+`ref` for drop) | **≤5 MiB total**, bytes copied over RPC | Tab |
| `browser_files_list` | `tabID` | — | `{tab,files[{id,name,mime,bytes,path}]}` |
| `browser_files_get` | `tabID`,`fileID` | ≤5 MiB per transfer, returns a server-local path | `{tab,files}` |
| `browser_console` | `tabID` · `level?`,`limit?` | debug/info/warning/error (cumulative) | `{tab,messages[],truncated,dropped}` |
| `browser_network_list` | `tabID` · `urlContains?`,`resourceType?`,`limit?` | 12 resource types; ids exact | `{tab,requests[],truncated,dropped}` |
| `browser_network_get` | `tabID`,`id` · `includeBody?`,`maxBodyChars?` | body chars 1–20 000, bodies **not re-fetched** | `{tab,request,requestHeaders,responseHeaders,headersTruncated,requestBody,responseBody}` |
| `browser_trace_start` | `tabID` · `durationMs?` | 1 000–30 000; **one recording per desktop app** | |
| `browser_trace_stop` | `tabID` | — | `{tab,files,durationMs,incomplete}` |
| `browser_trace_analyze` | `tabID`,`fileID` · `limit?` | "Does not invent missing Web Vitals" | metrics/events/insights |
| `browser_cpu_start` / `_stop` / `_analyze` | `tabID` (+`fileID`,`limit`) | sampling bounded to 30 s; "self time is sampled, not exact" | |
| `browser_heap_snapshot` | `tabID` | ≤5 MiB **compressed** transfer; "Can briefly pause the page" | `{tab,files}` |
| `browser_heap_summary` `_query` `_object` `_compare` | `tabID`,`fileID`(s) · `limit?`/`text`/`id` | "Shallow size is not retained size; one snapshot does not prove a leak" | |
| `browser_lighthouse` | `tabID` | a11y/SEO/best-practices only; no device emulation, no perf benchmark | `{tab,files,scores[],failures[]}` |

Cross-cutting, from the connection layer `[B]`: every command runs under a **60 s** deadline
(`[browser.timeout]` "its outcome is unknown… do not repeat clicks, submissions, uploads, or
evaluations until their outcome is known"), disconnects surface as
`[browser.disconnected] No desktop browser is connected to this session` `[L]` measured 9 ms in a
standalone session, malformed page-side output becomes
"Check desktop/plugin versions; no action was authorized", and a retried protocol error is
explicitly forbidden ("do not repeat the capture to repair a protocol error").
Two of our product claims are already true on the native side and two are not: it uses **`e1`
refs** and reports **untrusted content** as a first-class warning; it has **no subresource policy,
no headless, no per-target consent** `[R]`, and `[L]` found no plugin-reachable way to establish
the desktop connection.

## 6. Names that do not exist on v2 `[B]`

`todowrite` (one literal, in a v1→v2 migration hint: "no longer available and must not be called"),
`list` (`read` on a directory), `lsp`, `task`, `bash`, `apply_patch`, and — separately — no
`/todo` REST route string anywhere, which is the mechanical reason `tm_join`'s host-todo tripwire
has nothing to read and `tm_ledger` exists `[R]`. The migration hint also states the rename table
`bash→shell · task→subagent · apply_patch→patch`, that `read/edit/write` take **`path`** (v1
`filePath`), that `skill` takes **`id`** (v1 `name`), and that `subagent` takes `agent`/`sessionID`
(v1 `subagent_type`/`task_id`) — the host tells the model this itself when a session crosses the
upgrade, which is the same fork `V2_TEXT` maintains for us `[R]`.

## 7. Table 1 — full inventory

Columns: **name** (model-visible) · **surface** (`direct` = provider tool definition / `catalog` =
reachable only inside `execute`) · **key params** · **output/attachments** ·
**evaluate** (`permission.hook("evaluate")` action + what the resource carries; `[B]` = the source
shows the assert, `[L]` = observed live) · **rewritable by a plugin** (`before` = `execute.before`
input, `after` = `execute.after` result; both proven mutable `[D][L]`, and `after` proven to land
for native `shell`/`execute` `[R]`).

| name | surface | key params | output / attachments | evaluate | rewritten by us today |
|---|---|---|---|---|---|
| `read` | direct | path, offset?, limit? | text-page/list-page/file + inline image·PDF | `read`←relative path; `external_directory`←`<dir>/*` | offload (closed list) `[R]` |
| `write` | direct | path, content | existed/target | `edit`←path | no (no text worth offloading) |
| `edit` | direct | path, oldString, newString, replaceAll? | files[] + replacement count | `edit`←path | no |
| `patch` | direct | patchText | applied[] | `edit`←per-file paths | no |
| `shell` | direct | **workdir?**, command, timeout?, background? | tail-truncated + `[full output saved to …]`, metadata.status/shellID | **`shell`←one resource per parsed command**; dirs→`external_directory` | offload **measured** (12 902→78) `[R]` |
| `glob` | direct | pattern, path?, hidden?, limit?=100 | absolute path lines, metadata.count | `glob`←pattern | in closed list |
| `grep` | direct | pattern, path?, include?, literal?, caseSensitive?, limit?=100 | path/line groups, metadata.matches | `grep`←pattern | in closed list |
| `webfetch` | direct | url, format?=markdown, timeout?s≤120 | text/md/html, 5 MiB cap, no images | `webfetch`←URL, **no address check** | offload + **we add the address red line** |
| `websearch` | direct | query | `## [title](url)` blocks | `websearch`←query | no (denied for non-network roles) |
| `question` | direct | questions[{question,header,options,multiple}] | answers[][] | `question`←`*` | no |
| `skill` | direct | id | name/directory/instructions | `skill`←skill id | no |
| `subagent` | direct | agent, description, prompt, model?, sessionID?, background? | `<subagent …>` envelope + metadata.sessionID/status | **`subagent`←target agent id** | offload + **forced `background:true`** `[R]` |
| `execute` | direct | **code** | `{output, toolCalls[], error?, files[]}`; files as `data:` URIs | none of its own; each nested call asserts its own | offload **measured** (15 000→58) `[R]` |
| `opencode.session_rename` / `.session_move` / `.models` / `.list_mcp_resources` / `.read_mcp_resource` | catalog | see §4 | structured | `[U]` action names not observed | no |
| 45 × `browser_*` | catalog | see §5 | Tab/State/refs/files | **none** — one action `browser` exists but is not asserted per call `[L]`; deny-with-`*` is what removes them | no (only via the request layer, which does not carry them — see §1.3) |
| `<mcpServer>_<tool>` | catalog (default) | server's JSON schema | server's schema | action = `<server>_<tool>`, resource `*` | deliberately untouched `[R]` |
| our 10 `tm_*` | catalog (because `bindV2Tool` sends no `options`) | ours | ours | our own hard-throw governance, since nothing asks | — |

## 8. Table 2 — what this says about each `tm_*`

| tm_* | v2 status | verdict and the evidence it rests on |
|---|---|---|
| `tm_read` | **retired** `[R]` | Stands. Native `read` pages at 2 000/50 KiB, attaches images+PDF, and its P2 equivalent is the host's `external_directory` **ask** (§2.1) — a dialog beats a hard throw. Offload now covers it. |
| `tm_grep` | **retired** `[R]` | Stands, with one loss to name: native `grep` reports `No matches found` without the scope or the widening moves (§2.7), so the empty-result self-report rule is now prompt-side only. |
| `tm_bash` | **retired** `[R]` | Stands **and got stronger**: the host parses the command line per-command (`[B]`, §2.5), which is the substrate #12 wanted. Two must-not-forget deltas: `workdir` (not `cwd`), and truncation keeps the **tail**. P3 (read-only allowlist) has no native equivalent and is **not** retired. |
| `tm_ptc_run` | **retired** `[R]` | Stands: `execute` is that tool with `Promise.all` in its description (§3). Its cost is now explicit — the program's whole return is one text part, which is why `execute` must stay in `NATIVE_GOVERNED_TOOLS`. |
| `tm_search` | **keep** | Native `websearch` needs a paid/keyed provider and offers one engine, one query, no vote (§2.9). Zero-key + CN-reachable + multi-engine fusion is not replaceable here. |
| `tm_webfetch` | **keep**, retirement now *visible* as a future option | The host now does markdown-by-default, a 5 MiB cap and its own managed-storage preview (§2.8). What still is not replaceable: our `checkWebUrl` address policy (the host checks **scheme only**) and the SERP→hit-list collapse. Once the guard's coverage of native `webfetch` is proven live, this becomes a real choice rather than a one-way keep. |
| `tm_browser` | **keep, probe-gated** | The native panel is desktop-connection-only (`[L]`: plugin cannot connect; 9 ms hard error in standalone), catalog-only, has no subresource policy, no headless, no per-target consent — and its output reaches context solely as an `execute` return, so governing it means governing `execute` `[R]`. Genuine convergences worth exploiting: `e1` refs already match our snapshot convention, `preview` renders Mermaid/PDF/CSV for the user, and trace/cpu/heap/lighthouse are a capability class we never had. |
| `tm_fetch` | **keep** | Nothing in the host yields an HMAC-scoped, expiring, paged handle over *our* payloads; the host's `tool-output` files are a path, not a handle, and cross the workspace boundary. |
| `tm_memory` | **keep** | No host analogue for three tiers + dedup + compaction. |
| `tm_board_write` | **keep** | Native `write` overwrites (`existed` is reported, not enforced), takes the path from the model, and cannot source the role from `ctx.agent` (§2.2). The board contract needs all three. |
| `tm_join` | **keep, seam-limited** | The collect side still has no plugin-reachable session tree on v2; the envelope it parses is §2.12's, and the tripwire's host-todo source is gone (§6). |
| `tm_pty` | **candidate for retirement on v2** `[U→needs a decision]` | It fails closed here for the reason it exists elsewhere: `client.pty` is not on the v2 ctx, so it answers "此宿主未暴露 client.pty" `[R]`. Native `shell{background:true}` now gives a real shell ID, **an output file path**, a no-poll directive and a `<shell …>` completion injection (§2.5) — i.e. everything `tm_pty` promised minus output capture-through-REST, which `tm_pty` never had either. Note the R6 consequence before acting: that injection carries the command text back into context. |
| `tm_ledger` | **keep** (v2-only) | Justified harder by §6: `todowrite` is not merely absent from the surface, it is absent from the API and the DB-facing routes. |
| `tm_stats` | **keep** | It is the falsifiability layer; nothing native reads our trajectory. |

**One open, cheap experiment this analysis points at** (not done here — it needs the live lane):
adding `options: { codemode: false }` in `bindV2Tool` would move a chosen `tm_*` onto the **direct**
surface `[B]`. That is the only lever that ends the "find it with `search()` first" round-trip, and
its price is exactly the per-request definition tax the catalog exists to avoid. A tool name must be
provider-safe (`[A-Za-z0-9_-]{1,64}`, `[B]`), and it does **not** buy a UI card: the renderer's
registry is a closed 14-name set `[L]`.

## 9. Insufficient evidence — do not treat these as facts

1. **Whether a plugin registration's `options` (`codemode`, `namespace`, `permission`) is forwarded
   by the v2 plugin host, or only by the internal registry.** `[B]` proves the registry honors them
   and that all *host* tools set them; `[L]` proves our tools land catalog-side, which is consistent
   with "not forwarded" and equally with "we never sent them". Needs one live call.
2. **`execute`'s concrete `ToolCallLimitExceeded` / `TimeoutExceeded` budgets** — the kinds exist
   `[B]`; the numbers come from config we did not read, so "unlimited" would be a guess.
3. **Whether nested (Code Mode) calls fire `permission.hook("evaluate")` for `read`/`grep`/`shell`
   the way direct ones do.** `[B]` shows nested calls re-enter the same dispatcher, `[L]` observed
   `execute.before` per nested `browser_*`; an `evaluate` observation for a *nested native* call is
   still missing, and it decides whether the R6/egress guards have a hole through `execute`.
4. **The host's own offload wording/threshold** for `webfetch` / `read_mcp_resource` / `shell`
   (the descriptions promise a file + preview; the exact sentence and when it fires were read from
   code, not observed in a session).
5. **`external_directory` `ask` behavior for a *background* shell command's directories**, and
   whether the `<shell …>` completion injection can be intercepted by any plugin seam.
6. **Whether the 45 browser tools' shared action `browser` can be `ask`-ed at all** (deny works
   `[B]`; nothing asserts it `[L]`).
7. **`opencode.*` tools' permission actions** — never observed live, inferred absent.
8. **Anything about the desktop renderer's card for a `codemode:false` plugin tool** — the closed
   14-name registry is a 1.18-era finding `[L]` and has not been re-read against the 2.0.16 asar.
9. **`tm_pty` retirement** — the host-side capability is proven (§2.5); the *governance* delta (R6
   classification happens for `shell` at `evaluate`; `tm_pty` refused dangerous faces before even
   asking) is ours to re-implement, not the host's to provide. Marked as needing a decision.

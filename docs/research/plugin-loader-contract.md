# OpenCode 2.0.16 — how the host actually loads a plugin from `config.plugins`

**Scope:** read-only forensics. The strings below were cut out of
`resources/opencode-cli.exe` with a windowed byte scan; the live confirmations were
run against a sandboxed `OPENCODE_CONFIG_DIR` + temp store roots. Nothing in the host
was modified, and no path, URL, command line or env value of the user's appears here.

**Why this page exists.** The official v2 plugin docs document a `"plugins"` key
(a list of package names), and for a while our answer to "can the installer just write
that key?" was "no, it does not load". That answer was **wrong**, and the wrong answer
was the reason the installers carried a cache-purge/re-resolve story that v2 does not
need. This page is the corrected contract, with the host's own code as the evidence.

## 0. Where each claim comes from

| Tag | Source | Strength |
|---|---|---|
| `[B]` | Verbatim from the embedded Effect/JS in `resources/opencode-cli.exe` (`opencode-cli.version` reads `2.0.16`) | strongest offline |
| `[L]` | Our own live boot probe against a sandboxed config dir (`--standalone`, `--print-logs`, `v2-boot` trajectory line) | strongest overall |
| `[R]` | Our repo (`index.js`, `package.json#files`) | ours, verified |
| `[D]` | Official v2 docs | corroborating |

## 1. The entry: `config.plugins` is read, mapped, then resolved

The code blocks below are the host's own minified text **reformatted for reading**:
identifiers, strings and control flow are untouched, whitespace is not. The unmodified
bytes are in the extract window quoted per line.

`[B]` `ConfigPluginSource.scan` (minified `BN`) takes `l.info.plugins ?? []` from every
parsed config **document** and maps each entry through the operation builder `DN`:

```js
function DN(e){
  if (typeof e !== "string") return {type:"add", target:e.package, options:e.options ?? {}}
  if (!e.startsWith("-"))   return {type:"add", target:e, options:{}}
  if (e.length === 1) throw Error("Plugin remove operation requires a target")
  return {type:"remove", target:e.slice(1)}
}
```

So an entry is either a bare string, an object `{package, options}`, or a
**`-<target>` string that removes** a previously-declared plugin. Then the target is
resolved relative to the file that declared it:

```js
let g = l.path ? ln.dirname(l.path) : a.directory
let v = c.target.startsWith("file://")  ? dm(c.target)
      : (c.target.startsWith("./") || c.target.startsWith("../"))
        ? ln.resolve(g, c.target)
        : c.target
```

`[B]` Three branches follow, and they are the whole answer to the installer question:

1. **Not absolute** (a plain npm/git specifier) → handed to the package installer
   (`PluginModule.load` calls `Bun.add(target)` unless `options.install === false`),
   i.e. `"@te-river/opencode-team-mode@latest"` works exactly as documented.
2. **Absolute and a FILE** → `Dt("configured plugin path must be a directory", {target})`
   (a warning) and the entry is dropped (`Ie()`).
3. **Absolute and a DIRECTORY**, or a relative path that resolved to one → the entrypoint
   is resolved for the directory, and **if that resolution yields no server the entry
   returns `[]` — no log, no warning, no error**:

```js
let c = yield*e.isDir(l.target)
let g = c ? yield*y(()=>U0({directory: l.target})) : {server: UN(l.target).href}
if (!g.server) return []            // <-- silent
if (c) { let k = resolve(l.target), f = resolve(dm(g.server))
         if (!contains(k, f)) return [] }   // entrypoint must live inside the dir
```

`[L]` This is the branch that ate our afternoon: `plugins: ["C:/…/team-mode"]` pointing at
a directory that declared only `package.json#exports` produced **one line of output —
nothing** — and a perfectly healthy-looking host with no Team tools.

## 2. What a directory must contain to be loadable

`[B]` `PluginModule.load` (minified `SB`) resolves the entrypoint and only then logs:

```js
// PluginModule.load (SB): `r` = target is absolute, `i.install === false` skips the
// package installer, `U0` is the entrypoint resolver, `rL` is the host's log call.
let p = r ? void 0 : (i?.install === false ? await resolve(e.target) : await add(e.target))
let l = r && (await stat(e.target)).isFile()
        ? {server: fileURL(e.target).href}
        : await U0(p ?? {directory: e.target})
let c = l.server
if (!r && i?.install === false && !c) return {pending: true}
if (!c) return new LoadError({message: `Plugin entrypoint not found: ${e.target}`})
yield* log({msg: "loading plugin", id: e.target, entrypoint: c})
```

and the module must then validate as a definition:

```
Plugin must export a default definition with an id and an effect or setup function.
```

`[L]` For a **directory** target, the entrypoint that `U0` returns on 2.0.16 is
`<dir>/index.js`. Measured with `--print-logs`:

```
msg="loading plugin" id=…\vendor\team-mode entrypoint=file:///…/vendor/team-mode/index.js
```

A directory holding only `package.json` (`exports` → `./dist/index.js`, `main` likewise)
is **not** resolved to `dist/index.js` — it falls into the `if (!g.server) return []`
branch above and is skipped with no message at all. That is why the package now ships a
root [`index.js`](../../index.js) `[R]` re-exporting `./dist/index.js`, and why it is in
`package.json#files`: it is part of the host contract, not a convenience shim.

## 3. Consequences for the installer

- `"plugins"` **is** the right key to write, and the documented npm-specifier form works
  without a cache purge: the host's own `opencode plugin add` installs and writes that
  field (`[D]`+`[L]`). v1's purge machinery has nothing to do on v2.
- A **local** install (this repo, or a copy on disk) must point at a **directory that
  contains `index.js`**, and the value must be relative (`"./vendor/team-mode"`, resolved
  against the config file's own directory) or an absolute directory. An absolute path to
  `index.js` itself is refused as "must be a directory".
- Whatever path style is used, the only proof of success is the host's own
  `msg="loading plugin"` line or our `v2-boot` trajectory row — never the config write
  returning 0. The silent `return []` has no diagnostic to fail on.
- Dedup matters: the same plugin reachable both as an npm cache copy and as a local
  directory is loaded twice, and the second registration is the one that wins the hooks.
  `PluginModule.watch` keeps a per-path set, so two *different* paths are two watchers.

## 5. The entrypoint resolver, in full (`U0`)

`[B]` Everything above funnels into one small function, and it is the reason a local
install has exactly one legal shape. Reformatted for reading; identifiers untouched:

```js
function U0(r){
  let n = (t) => {
    for (let o of t) {
      let i = r.name ? [r.name, o].filter(Boolean).join("/") : s.resolve(r.directory, o || "index")
      try { return R0(i, r.directory) }              // resolve as a module specifier
      catch (e) { if (!["ENOENT","ENOTDIR","MODULE_NOT_FOUND","ERR_MODULE_NOT_FOUND",
                       "ERR_PACKAGE_PATH_NOT_EXPORTED","ERR_UNSUPPORTED_DIR_IMPORT"]
                     .includes(String(e.code))) throw e }
    }
    return                                            // nothing resolved → undefined
  }
  return { server: n(["server",""]), tui: n(["tui"]), rpc: n(["rpc"]) }
}
```

Read it as a decision table:

| target | what `U0` is called with | what resolves |
|---|---|---|
| an installed package | `{name:"@te-river/opencode-team-mode", directory:<cache>}` | the specifier `@te-river/opencode-team-mode/server`, then the package root — i.e. `package.json#exports`, so `dist/index.js` arrives |
| a directory path | `{directory:<path>}` (no `name`) | `resolve(dir, "index")` → **`<dir>/index.js`** and nothing else |

So the asymmetry is not a documentation gap, it is the code: a package may declare its
entrypoint, a directory may not. A directory that resolves nothing returns
`{server: undefined}`, and `ConfigPluginSource.scan` then drops the entry with
`return []` — the silent skip in §1. `[L]` Measured both ways on 2.0.18: with a root
`index.js` the host logs `entrypoint=file:///…/vendor/team-mode/index.js`; without it,
the boot is clean and the plugin is simply absent.

`features.tui` / `features.rpc` in the load result come from the same call, which is why
a TUI-only plugin is recorded somewhere else — see §6.

## 6. What `opencode plugin add` actually does

`[B]` The subcommand (`cli.plugin.add`) is four steps, and each one closes an option the
installer might otherwise reach for:

```js
if (!(yield* ne(()=>pP(e.package))))
  return h(Error("Plugin target must be an npm registry package or Git package specifier"))
let r = yield* (yield* ga).add(e.package)          // install
let l = U0(r), o = k(l.server, l.tui)              // configurationTarget: "server" | "tui"
if (!o) return h(Error(`Plugin package has no server or TUI entrypoint: ${e.package}`))
```

- **A local directory is refused**, by name. Vendoring a tree is therefore a config edit,
  never a `plugin add`.
- A **server** plugin is written by `writePluginConfig` into the global config the Config
  service names (`i.config`). `[L]` Measured with a redirected `HOME`: it created and
  edited `~/.config/opencode/opencode.json` — not the `.jsonc` — and printed the file it
  touched.
- Its dedupe is `d(t, n)`: `r === n || (typeof r === "object" && r.package === n)`, i.e.
  **the identical string only**. Two spellings of one plugin are two entries.
- It parses with `allowTrailingComma`, edits the AST (`Ru(doc, ["plugins"], [...t, n])`,
  tab size 2) and swaps the file through `<file>.tmp` + rename, mode `0o600`. So a
  trailing comma in a user's array is legal to the host — and the reason our own writer
  must not leave one dangling is that the NEXT hand edit may not be a lenient parser.
- A **TUI-only** plugin goes to a different service (`Il`) with its own `plugins` array.
  Our package has a `server` entrypoint, so it always takes the first branch.

## 7. Why two entries really do load twice

`[B]` `PluginSupervisor.resolve` iterates the operations and, before loading, asks only
whether the target matches an already-known plugin **id**:

```js
let l = (N,O) => N === "*" || (N.endsWith(".*") ? O.startsWith(N.slice(0,-1)) : N === O)
let O = S().filter((ee) => l(N.target, ee.id))
if (O.length > 0 || N.target === "*" || …) { O.forEach(ee => g.add(ee.id)); continue }
let Q = yield* e.load(N, { install: s })          // otherwise: load it
```

`N.target` is the config string (`@te-river/opencode-team-mode@latest`, or a path) and
`ee.id` is the plugin's own exported id (`team-mode`). They are never equal, so that
guard is a no-op for package entries, and a second operation for the same package
reaches `e.load` again. `[L]` Confirmed: the same spec present in `opencode.json` and
`opencode.jsonc` produced two `msg="loading plugin"` lines for one id, with no warning —
two personalities, the same tools and hooks bound twice.

A load failure is loud, unlike the directory skip: `failed to load plugin` carries
`target`, a `ref`, and the cause, and `PluginModule.LoadError` is what `@opencode-aide`
1.6.0 produces on a 2.x host —

```
Plugin must export a default definition with an id and an effect or setup function.
(cause: SchemaError(Missing key at ["default"]["effect"] / ["default"]["setup"]))
```

because the accepted shape is a union, `bB = U([ {id, effect:fn}, {id, setup:fn} ])`, and
a v1-only `{id, server}` default satisfies neither. That is the whole reason this package
ships one barrel exporting both personalities.

## 8. What the Extensions panel's row name tells you (and what it does not)

`[L]` Observed on the user's desktop, before and after a config change: a plugin loaded
from `~/.config/opencode/plugins/team-mode.js` (the directory-scan path the docs
describe) is listed as `team-mode`, which is that FILE's basename, while an npm entry is
listed verbatim as `@te-river/opencode-team-mode@latest`. A `plugins` entry pointing at a
local directory also listed itself as `team-mode` — the loaded plugin's own id.

The mechanism is inferred, the consequence is not: **the row name cannot tell you which
spelling is installed**, because a file named `team-mode.js` and a package whose id is
`team-mode` print identically. Two rows that look like one plugin may be two loads, and
one row may be either a loader file or a directory entry. The only channel that
distinguishes them is `msg="loading plugin" id=<target> entrypoint=<url>`, which names
the config string and the resolved file, and our own `v2-boot` trajectory line.

**How the installers use this:** `scripts/lib/config-surgery.cjs` keeps exactly one Team
entry across `opencode.jsonc` and `opencode.json`, matching our own entries by
`/opencode[-_]?team[-_]?mode|vendor[/\\]team-mode/i` — case- and hyphen-tolerant, because
a working tree is `D:/Github/Opencode-TeamMode` and an entry it fails to recognise is one
it would add beside the existing one.


## 9. What this page does NOT establish

`[U]` Whether an object entry's `options` carries anything beyond `install:false` — the
scanned code reads only that field, which is not a claim that nothing else exists.
`[U]` Whether the `<dir>/index` resolution survives a future host: it is read off 2.0.16
and 2.0.18, and the shipped `package.json#exports` stays as the belt while the root
`index.js` is the part this contract requires. `[U]` Which file the Config service names
as `i.config` when both `opencode.json` and `opencode.jsonc` exist — measured only in the
case where the `.jsonc` was absent, so the installers do not depend on it: they write the
`.jsonc` and reclaim their own entry from the `.json`. `[U]` Whether the host prunes the
timestamped `~/.cache/opencode/npm/<pkg>@latest/<ts>/` directories: one existed after
several installs on this machine, which is an observation, not a garbage-collection
guarantee.


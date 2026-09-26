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

## 4. What this page does NOT establish

`[U]` Whether `options` on an object entry can carry anything beyond `install:false`
(nothing in the scanned window reads more of it). `[U]` Whether `U0`'s entrypoint
resolution will keep preferring a bare `index.js` in a future host — the shipped
`exports` map stays, so an `index.js` at the root is the belt, not the whole harness.

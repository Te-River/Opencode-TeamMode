// A fake OpenCode v2 plugin context for the adapter tests.
//
// There was no such thing before the v2 port: every existing suite builds a v1
// tool ctx as an inline literal ({directory, sessionID, agent, ask}), because
// v1 hands tools a plain object.  v2 hands the PLUGIN a context of domains with
// transform()/hook() registrars, so testing the v2 personality needs a host
// double that records what was registered and can replay a hook.
//
// Deliberately faithful on the three points that matter:
//  - transform(cb) runs the callback SYNCHRONOUSLY against a live editor and
//    returns a disposable (a fake that defers would let a plugin pass tests
//    against an API shape the host does not have);
//  - hook callbacks are callable by the test so a hook body can be exercised
//    with a real payload;
//  - nothing here touches the filesystem or the network.

export function makeFakeCtx({
  directory = process.cwd(),
  options = {},
  agents: seedAgents = [],
  tools: seedTools = [],
  sessionData = null,
} = {}) {
  const registrations = []
  const hooks = new Map()

  const disposable = (label) => {
    const rec = { label, disposed: false, dispose: async () => { rec.disposed = true } }
    registrations.push(rec)
    return rec
  }

  const toolMap = new Map()
  for (const t of seedTools) toolMap.set(t.name ?? t.id, { ...t, id: t.id ?? t.name })
  const toolEditor = {
    list: () => [...toolMap.values()],
    get: (id) => toolMap.get(id),
    add: (tool) => { toolMap.set(tool.name, { ...tool, id: tool.name }) },
    update: (id, fn) => { const cur = toolMap.get(id); if (cur) fn(cur) },
    remove: (id) => { toolMap.delete(id) },
    namespace: () => {},
  }

  const agentMap = new Map()
  for (const a of seedAgents) agentMap.set(a.id, { ...a })
  const agentEditor = {
    list: () => [...agentMap.values()],
    get: (id) => agentMap.get(id),
    default: (id) => { agentEditor.__default = id },
    update: (id, fn) => { const cur = agentMap.get(id); if (cur) fn(cur) },
    remove: (id) => { agentMap.delete(id) },
  }

  const hookHandle = (domain, name) => {
    const key = `${domain}.${name}`
    const entry = hooks.get(key) ?? { key, calls: [], fire: async (input) => {
      for (const cb of entry.handlers) await cb(input)
      return input
    }, handlers: [] }
    hooks.set(key, entry)
    return entry
  }

  const mkHook = (domain) => async (name, callback) => {
    hookHandle(domain, name).handlers.push(callback)
    return disposable(`${domain}.hook(${name})`)
  }

  const warnLines = []
  const errorLines = []

  return {
    ctx: {
      location: { directory, project: { directory } },
      options,
      tool: {
        transform: async (cb) => { cb(toolEditor); return disposable("tool.transform") },
        list: async () => [...toolMap.values()],
        hook: mkHook("tool"),
        reload: async () => {},
      },
      agent: {
        transform: async (cb) => { cb(agentEditor); return disposable("agent.transform") },
        list: async () => [...agentMap.values()],
      },
      permission: { hook: mkHook("permission"), list: async () => [], get: async () => ({}), reply: async () => ({}) },
      // `session.get` / `session.context` exist ONLY when a test seeds them, because a fake
      // that always answers would let a plugin pass while the real host refuses — and the
      // shapes below are the ones measured on 2.0.18 (`get` → {id,parentID,…}, `context` →
      // an array of {id,time,text,type}), not a guess.  See src/host/v2-transcript.ts.
      session: sessionData
        ? {
            hook: mkHook("session"),
            async get({ sessionID } = {}) {
              const s = sessionData.sessions?.[sessionID]
              if (!s) throw new Error(`Session not found: ${sessionID}`)
              return { id: sessionID, ...s }
            },
            async context({ sessionID } = {}) {
              return sessionData.messages?.[sessionID] ?? []
            },
          }
        : { hook: mkHook("session") },
      shell: { hook: mkHook("shell") },
      storage: {
        _map: new Map(),
        async get(k) { return this._map.get(k) },
        async set(k, v) { this._map.set(k, v) },
        async remove(k) { this._map.delete(k) },
        async scan() { return { entries: [] } },
      },
      event: { subscribe: () => ({ async [Symbol.asyncIterator]() { return { done: true, value: undefined } } }) },
      app: { name: "opencode-fake", version: "2.0.16", channel: "test" },
    },
    /** Introspection for assertions. */
    registrations,
    tools: toolEditor,
    agents: agentEditor,
    /** Introspection for assertions.  Only the FIRST dot separates the domain
     *  from the hook name — `tool.execute.before` is domain "tool" + hook
     *  "execute.before", and splitting on every dot would look up a key that
     *  nothing ever registered, so a working hook would read as an absent one. */
    hook: (name) => {
      const [domain, ...rest] = name.split(".")
      return hookHandle(domain, rest.join("."))
    },
    hookNames: () => [...hooks.keys()],
    consoleWarn: warnLines,
    consoleError: errorLines,
  }
}

/** Capture what the personality logs during setup — a v2 plugin has no toast,
 *  so the server log IS the user-visible channel for these gaps. */
export function withCapturedConsole(fn) {
  const warns = []
  const errors = []
  const w = console.warn
  const e = console.error
  console.warn = (...a) => { warns.push(a.join(" ")) }
  console.error = (...a) => { errors.push(a.join(" ")) }
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.warn = w; console.error = e })
    .then((value) => ({ value, warns, errors }))
}

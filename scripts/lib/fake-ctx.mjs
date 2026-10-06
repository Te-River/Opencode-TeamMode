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
  models: seedModels = null,
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
  /** #33: which child sessions a stop attempt actually reached, in order. */
  const stopCalls = []
  /** #steer: what each interjection seam actually received, args and all.  A test that
   *  only read the tool's prose could not tell 插话给了子会话 from 插话给了调用者自己,
   *  and that distinction is the whole safety property of the feature. */
  const promptCalls = []
  const syntheticCalls = []
  const inboxListCalls = []
  const inboxCancelCalls = []
  /** How many times the catalog was listed — the prune layer's denominator read, so a
   *  per-request catalog re-read is a number and not a shrug. */
  const modelListCalls = []

  /** Turn a seeded verdict into a host-shaped method: a function is called with the args
   *  (so a test can answer per-session), an Error throws, anything else is returned as-is.
   *  Same construction as `stop` above — a fake that always answered `true` would let the
   *  tool claim 已受理 against a host that never admitted anything. */
  const verdictMethod = (seed, logArr) => async (args = {}) => {
    logArr.push({ ...(args ?? {}) })
    const v = typeof seed === "function" ? seed(args) : seed
    if (v instanceof Error) throw v
    return v
  }
  const has = (key) => sessionData && Object.prototype.hasOwnProperty.call(sessionData, key)

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
      //
      // `session.interrupt` (#33) is seeded through `stop`, so a test can hand back each of
      // the host's documented answers separately — `{interrupted:true}` (an active execution
      // was stopped), `{interrupted:false}` (the idle no-op), no boolean at all, or a throw.
      // A fake that always said `true` would let the tool claim 已停止 against a host that
      // never stops anything, which is the exact overstatement the real code refuses.
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
            ...(sessionData.stop
              ? {
                  async interrupt({ sessionID } = {}) {
                    stopCalls.push({ sessionID })
                    const verdict = typeof sessionData.stop === "function"
                      ? sessionData.stop(sessionID)
                      : sessionData.stop
                    if (verdict instanceof Error) throw verdict
                    return verdict
                  },
                }
              : {}),
            // #steer — the interjection seams, seeded ONLY when a test asks for them, for
            // the same reason `interrupt` is: a host that never admits inbox input must not
            // be able to be described as having accepted one.  `prompt` is the documented
            // `{sessionID, text, delivery}` call; `synthetic` is the fallback seam; the
            // inbox ops exist in TWO spellings (nested `session.inbox.list`, which the
            // published operation ids imply, and flat `session["inbox.list"]`), and
            // `inboxFlat` lets a test drive the fallback and pin which one answered.
            ...(has("prompt") ? { prompt: verdictMethod(sessionData.prompt, promptCalls) } : {}),
            ...(has("synthetic") ? { synthetic: verdictMethod(sessionData.synthetic, syntheticCalls) } : {}),
            ...(has("inbox") && sessionData.inbox && !sessionData.inboxFlat
              ? {
                  inbox: {
                    ...(sessionData.inbox.list !== undefined
                      ? { list: verdictMethod(sessionData.inbox.list, inboxListCalls) }
                      : {}),
                    ...(sessionData.inbox.cancel !== undefined
                      ? { cancel: verdictMethod(sessionData.inbox.cancel, inboxCancelCalls) }
                      : {}),
                  },
                }
              : {}),
            ...(has("inbox") && sessionData.inbox && sessionData.inboxFlat
              ? {
                  "inbox.list": verdictMethod(sessionData.inbox.list, inboxListCalls),
                  "inbox.cancel": verdictMethod(sessionData.inbox.cancel, inboxCancelCalls),
                }
              : {}),
          }
        : { hook: mkHook("session") },
      shell: { hook: mkHook("shell") },
      // `model.list()` measured on 2.0.23: `{location, data:[{id, modelID, providerID,
      // …, limit:{context, output}}]}`. The shape below is that shape, because the prune
      // layer reads `limit.context` as the denominator and a fake with a friendlier
      // shape would test the reading, not the contract.
      model: {
        async list(opts = {}) {
          modelListCalls.push({ ...(opts ?? {}) })
          return { location: { directory }, data: seedModels ?? [] }
        },
      },
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
    /** #33 — the stop attempts this fake actually received, so a test can pin that a
     *  cancel reached the host with the child's id rather than trusting the tool's prose. */
    stopCalls,
    /** #steer — the same for the interjection seams: the args each one really got. */
    promptCalls,
    syntheticCalls,
    inboxListCalls,
    inboxCancelCalls,
    /** The catalog reads, with their args. */
    modelListCalls,
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

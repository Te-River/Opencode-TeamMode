/**
 * The "the engine ignored you" detector (2026-09-19, from a live session).
 *
 * Evidence: one `team` session spent 66 tool calls / 25 LLM steps / 2.8 M
 * input tokens on a three-term lookup.  Calls #5 and #6 asked bing for
 * `"舞萌DX" "你好世界"` and `"舞萌DX" "我的世界"` — two different queries — and
 * got byte-identical 10-hit lists about the Chinese character 舞 (dictionary
 * entries, dance videos).  Nothing in the reply said so, so the agent kept
 * paying for the collapse: 20 more calls hand-building SERP URLs, then a
 * browser session, to work out what one honest signal would have told it in
 * the first minute — that the engine had dropped its qualifiers.
 *
 * Two independent signals, both cheap and deterministic:
 *   - IDENTICAL hit set under a DIFFERENT query  → the engine ignored the
 *     query (a collapse), not "the topic is thin";
 *   - ZERO query-token overlap across every hit  → the answer is unrelated to
 *     what was asked.
 *
 * Either one is reported as a DIRECTIVE (what to do next: split the concept,
 * switch engine, or hand the whole lookups to a dispatched researcher), not
 * as a shrug.  The repetition counter is the circuit-breaker the failing
 * session never had.
 */

/** Stable fingerprint of a result set: the hosts+paths that came back, not
 *  their order (a re-rank of the same pages is the same answer). */
export function hitSignature(hits: ReadonlyArray<{ url?: string }>): string {
  const keys: string[] = []
  for (const h of hits) {
    const u = String(h?.url ?? "")
    if (!u) continue
    try {
      const p = new URL(u)
      keys.push(`${p.hostname.toLowerCase().replace(/^www\./, "")}${p.pathname}`)
    } catch {
      keys.push(u.slice(0, 80))
    }
  }
  return keys.sort().join("|")
}

/** Does ANY hit actually mention the query?  CJK is bigram-indexed (the same
 * 口径 as the RRF relevance score) so "舞萌DX" matches a hit about 舞萌DX,
 *  while a page about the single character 舞 does not match. */
export function hitsShareAnyQueryTerm(
  hits: ReadonlyArray<{ title?: string; snippet?: string; url?: string }>,
  terms: readonly string[],
): boolean {
  if (!terms.length) return true
  // no hits at all is an EMPTY answer, not an irrelevant one — the caller
  // reports that separately (and it must not be labelled "the engine ignored
  // you", which would send the agent off to fix a query that was fine)
  if (!hits.length) return true
  for (const h of hits) {
    const hay = `${h.title ?? ""} ${h.snippet ?? ""} ${h.url ?? ""}`.toLowerCase()
    for (const t of terms) if (t && hay.includes(t.toLowerCase())) return true
  }
  return false
}

export interface DupeVerdict {
  /** how many times this SHAPE has now come back in this process */
  repeats: number
  collapse: boolean
  irrelevant: boolean
  /** the directive appended to the tool output, "" when nothing is wrong */
  note: string
}

/**
 * An engine that has answered a DIFFERENT question with the SAME result set this
 * many times is not listening, and asking it again costs a round and a fetch to
 * produce bytes we already have.  A live session proved the advisory version of
 * this rule does not work: the guard reported `collapse` at repeats 2,3,4,5,6 and
 * the model kept going (≈50 tm_search calls, 424K input tokens).  So past the
 * limit the engine is refused outright — the only form of escalation that cannot
 * be ignored is not making the call.
 */
export const DUPE_BLOCK_AFTER = 3

/** Per-process ledger of (engine → last signature + query).  Deliberately
 *  in-memory: it is a conversation-level observation, and a restart of the
 *  plugin legitimately starts a fresh judgement (the agent is asking afresh). */
export function createDupeGuard(limit = 60): {
  observe: (engine: string, query: string, hits: ReadonlyArray<{ url?: string; title?: string; snippet?: string }>, terms: readonly string[]) => DupeVerdict
  /** ask BEFORE spending a fetch: a stalled engine is refused without calling it */
  stalled: (engine: string) => { blocked: boolean; stalls: number }
  seen: () => number
} {
  const last = new Map<string, { sig: string; query: string; repeats: number; stalls: number }>()
  return {
    observe(engine, query, hits, terms) {
      const sig = hitSignature(hits)
      const prev = last.get(engine)
      let repeats = 1
      let collapse = false
      // A NEW result set is evidence the engine is listening again, so the stall
      // streak resets — otherwise one bad stretch would mute an engine for the
      // rest of the process.
      let stalls = prev?.stalls ?? 0
      if (sig) {
        if (prev && prev.sig === sig) {
          repeats = prev.repeats + 1
          collapse = prev.query !== query
          if (collapse) stalls += 1
        } else {
          stalls = 0
        }
        last.set(engine, { sig, query, repeats, stalls })
        if (last.size > limit) {
          const oldest = last.keys().next().value
          if (oldest) last.delete(oldest)
        }
      }
      const irrelevant = hits.length > 0 && !hitsShareAnyQueryTerm(hits, terms)
      const parts: string[] = []
      if (collapse) {
        parts.push(
          `⚠ 引擎「${engine}」这次和上一次不同问题的返回结果集完全相同——它忽略了你的限定词（引号短语、多概念组合对它是无效的）。继续换措辞再问一次不会有新信息。`,
        )
      }
      if (irrelevant) {
        parts.push(
          `⚠ 这 ${hits.length} 条结果里没有任何一条提到查询词——把「无结果」当成结论，不要从中编故事。`,
        )
      }
      if (collapse || irrelevant) {
        parts.push(
          stalls >= DUPE_BLOCK_AFTER
            ? `下一步：该引擎在本进程已连续 ${stalls} 次给出同一结果集，**它已被封锁，再问它会直接拒绝**（省下的就是你本来要花的两轮）。把概念拆开逐次查、换 engine:"auto" 让其余引擎投票，或用宿主的子代理工具（v1 是 task，v2 是 subagent）派一份自包含的调研任务给 researcher（要并行就加 background:true）；也可以把不确定处直接报告给用户。`
            : `下一步：把一个概念拆成一次查询（先查 A 是什么，再查 A 与 B 的关联），或换 engine:"auto" 让多引擎投票。`,
        )
      }
      return { repeats, collapse, irrelevant, note: parts.join("\n") }
    },
    stalled(engine) {
      const stalls = last.get(engine)?.stalls ?? 0
      return { blocked: stalls >= DUPE_BLOCK_AFTER, stalls }
    },
    seen: () => last.size,
  }
}

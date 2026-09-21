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
 * Per-process ledger of (engine → last signature + query).  Deliberately
 * in-memory: it is a conversation-level observation, and a restart of the
 * plugin legitimately starts a fresh judgement (the agent is asking afresh).
 */
export function createDupeGuard(limit = 60): {
  observe: (engine: string, query: string, hits: ReadonlyArray<{ url?: string; title?: string; snippet?: string }>, terms: readonly string[]) => DupeVerdict
  seen: () => number
} {
  const last = new Map<string, { sig: string; query: string; repeats: number }>()
  return {
    observe(engine, query, hits, terms) {
      const sig = hitSignature(hits)
      const prev = last.get(engine)
      let repeats = 1
      let collapse = false
      if (sig) {
        if (prev && prev.sig === sig) {
          repeats = prev.repeats + 1
          // same answer set, different question = the engine is not listening
          collapse = prev.query !== query
        }
        last.set(engine, { sig, query, repeats })
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
          repeats >= 3
            ? `下一步：这类多概念关联查询已经在本进程失败 ${repeats} 次——用内置 task 派一份自包含的调研任务给 researcher（多个且要持续跟进就加 background:true；让它用自己的上下文去试错），或直接把不确定处报告给用户；不要在本会话里继续串行试。`
            : `下一步：把一个概念拆成一次查询（先查 A 是什么，再查 A 与 B 的关联），或换 engine:"auto" 让多引擎投票。`,
        )
      }
      return { repeats, collapse, irrelevant, note: parts.join("\n") }
    },
    seen: () => last.size,
  }
}

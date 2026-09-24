/**
 * The egress half of the web red line: what an IP LITERAL actually points at.
 *
 * Why this exists: the domain allowlist answers "is this host on the list", and
 * `TM_WEBFETCH_ALLOWED_DOMAINS="*"` (a documented setting) answers it with yes
 * for every string — including `169.254.169.254`, the cloud instance-metadata
 * endpoint that hands out temporary credentials to anything that asks. Fetching
 * that reads a secret into the model context, the run store and the trajectory
 * in one call, and no user is being asked first. Loopback and RFC1918 are the
 * softer half of the same problem: they are genuinely useful (a local dev API,
 * the dev server the tester verifies), so they are not forbidden — but "*" must
 * not answer for them either, so they go to the dialog every time.
 *
 * Borrowed shape, own implementation: ZCode's `webfetch-egress-guard.ts` unwraps
 * IPv4-mapped IPv6 AND the DNS64/NAT64 well-known prefix before applying its
 * policy, because a policy that reads the outer address is a policy that can be
 * put on a diet by changing the notation. Zero dependency here (no ipaddr.js) —
 * a plugin should not add a runtime dep to check fourteen prefixes.
 *
 * Deliberate asymmetry: IPv4 link-local (169.254/16) is FORBIDDEN while IPv6
 * fe80::/10 is only PRIVATE. The metadata service that makes 169.254 dangerous
 * is an IPv4 service; fe80 has no equivalent, and refusing it would break
 * nothing we care about — so the stricter rule applies where the payload is.
 */

export type EgressLevel = "public" | "private" | "forbidden"

export interface EgressVerdict {
  level: EgressLevel
  /** which rule answered, in the words the agent will read back */
  via?: string
}

/** Hostname as the URL parser gives it: lowercased, possibly bracketed (IPv6),
 *  possibly with the root dot. Case and the trailing dot must not change a
 *  security verdict, so they go first. */
export function normalizeEgressHost(raw: unknown): string {
  const s = String(raw ?? "").trim().toLowerCase()
  const noBracket = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s
  return noBracket.endsWith(".") ? noBracket.slice(0, -1) : noBracket
}

/** Dotted quad, strictly — the URL layer has already collapsed the decimal /
 *  hex / octal spellings, and anything still irregular is NOT treated as an IP
 *  (a false "public" on garbage costs nothing; a false parse would be a bug). */
export function parseIpv4(text: string): number | null {
  const parts = text.split(".")
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** Eight 16-bit groups, with `::` compression and an optional trailing IPv4. */
export function parseIpv6Groups(text: string): number[] | null {
  if (!text.includes(":")) return null
  let head = text
  let zone = ""
  const z = text.indexOf("%")
  if (z >= 0) {
    head = text.slice(0, z)
    zone = text.slice(z + 1)
  }
  if (zone) return null // a scope id names an interface; not our business to route
  const v4tail = /\.[0-9]+$/.test(head) ? head.slice(head.lastIndexOf(":") + 1) : ""
  if (v4tail) {
    const n = parseIpv4(v4tail)
    if (n === null) return null
    head = head.slice(0, head.lastIndexOf(":") + 1)
    // two groups carry the four bytes
    head += `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const double = head.indexOf("::")
  let groups: string[]
  if (double >= 0) {
    const left = head.slice(0, double).split(":").filter(Boolean)
    const right = head.slice(double + 2).split(":").filter(Boolean)
    const fill = 8 - left.length - right.length
    if (fill < 0) return null
    groups = [...left, ...Array(fill).fill("0"), ...right]
  } else {
    groups = head.split(":").filter(Boolean)
  }
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

const inCidr4 = (n: number, base: number, bits: number): boolean =>
  bits === 0 || ((n >>> (32 - bits)) << (32 - bits)) === base

function classifyIpv4(n: number): EgressVerdict {
  const a = (n >>> 24) & 0xff
  const b = (n >>> 16) & 0xff
  if (a === 169 && b === 254) return { level: "forbidden", via: "IPv4 link-local 169.254.0.0/16（云元数据端点）" }
  if (a === 0) return { level: "forbidden", via: "IPv4 本网络 0.0.0.0/8" }
  if (a >= 224 && a <= 239) return { level: "forbidden", via: "IPv4 组播 224.0.0.0/4" }
  if (a >= 240) return { level: "forbidden", via: "IPv4 保留 240.0.0.0/4" }
  if (inCidr4(n, 198 << 24 | 18 << 16, 23)) return { level: "forbidden", via: "IPv4 基准测试段 198.18.0.0/15" }
  if (a === 127) return { level: "private", via: "IPv4 回环 127.0.0.0/8" }
  if (a === 10) return { level: "private", via: "IPv4 私网 10.0.0.0/8" }
  if (a === 172 && b >= 16 && b <= 31) return { level: "private", via: "IPv4 私网 172.16.0.0/12" }
  if (a === 192 && b === 168) return { level: "private", via: "IPv4 私网 192.168.0.0/16" }
  if (a === 100 && b >= 64 && b <= 127) return { level: "private", via: "IPv4 运营商 NAT 100.64.0.0/10" }
  return { level: "public" }
}

const SPECIAL_USE_V6: ReadonlyArray<{ readonly prefix: readonly number[]; readonly bits: number; readonly label: string }> = [
  { prefix: [0x0064, 0xff9b, 0x0001], bits: 48, label: "NAT64 本地/发现前缀 64:ff9b:1::/48" },
  { prefix: [0x0100], bits: 64, label: "discard-only 100::/64" },
  { prefix: [0x2001, 0x0002], bits: 48, label: "benchmarking 2001:2::/48" },
  { prefix: [0x2001, 0x0010], bits: 28, label: "ORCHIDv2 2001:10::/28" },
  { prefix: [0x2001, 0x0020], bits: 28, label: "AMT 2001:20::/28" },
]

const matchesBits = (groups: readonly number[], prefix: readonly number[], bits: number): boolean => {
  // A /64 written as one group still has to be zero from group 4 onward — the
  // first version compared only the groups it was given, which made 100::/64
  // match 100:abcd:: and call the rest of the range public.
  let left = bits
  for (let i = 0; i < 8 && left > 0; i++) {
    const take = Math.min(16, left)
    const mask = take >= 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff
    const want = i < prefix.length ? prefix[i] : 0
    if ((groups[i] & mask) !== (want & mask)) return false
    left -= take
  }
  return true
}

function classifyIpv6(groups: readonly number[]): EgressVerdict {
  // The carrier forms first: an IPv6 address can be a costume over an IPv4 one,
  // and the policy that only reads the costume is the one that gets bypassed.
  const mapped =
    groups.slice(0, 5).every((g) => g === 0) &&
    (groups[5] === 0xffff || groups[5] === 0) &&
    (groups[5] === 0xffff || (groups[2] | groups[3] | groups[4]) === 0)
  if (mapped && groups[5] === 0xffff) {
    const inner = ((groups[6] << 16) >>> 0) + groups[7]
    return classifyIpv4(inner >>> 0)
  }
  if (matchesBits(groups, [0x0064, 0xff9b], 96)) {
    const inner = (((groups[6] << 16) & 0xffffffff) >>> 0) + (groups[7] & 0xffff)
    return classifyIpv4(inner >>> 0)
  }
  for (const s of SPECIAL_USE_V6) if (matchesBits(groups, s.prefix, s.bits)) return { level: "forbidden", via: `IPv6 ${s.label}` }
  if (groups.every((g) => g === 0)) return { level: "forbidden", via: "IPv6 未指定 ::" }
  if (groups[0] >= 0xff00) return { level: "forbidden", via: "IPv6 组播 ff00::/12" }
  if (groups[0] === 0x0000 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0 && groups[6] === 0 && groups[7] === 1)
    return { level: "private", via: "IPv6 回环 ::1" }
  if ((groups[0] & 0xffc0) === 0xfe80) return { level: "private", via: "IPv6 链路本地 fe80::/10" }
  if ((groups[0] & 0xfe00) === 0xfc00) return { level: "private", via: "IPv6 唯一本地地址 fc00::/7" }
  return { level: "public" }
}

/** One host, one verdict. Public means "the domain allowlist decides"; private
 *  means "only a dialog decides"; forbidden means nothing decides. */
export function classifyHost(raw: unknown): EgressVerdict {
  const host = normalizeEgressHost(raw)
  if (!host) return { level: "public" }
  if (host === "localhost" || host.endsWith(".localhost")) return { level: "private", via: ".localhost 保留名" }
  const v4 = parseIpv4(host)
  if (v4 !== null) return classifyIpv4(v4)
  if (host.includes(":")) {
    const groups = parseIpv6Groups(host)
    if (groups) return classifyIpv6(groups)
  }
  return { level: "public" }
}

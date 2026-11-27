// The shape the app is reached through: straight on this machine's loopback, or through a proxy the human named in
// Settings → Web. Forwarded headers are believed only when the connection itself comes from that proxy's address: a
// client that can reach the port directly can set any header, so a header alone never makes a caller trusted. The same
// view feeds `shepherdr doctor`, which says whether the proxy and its headers agree.

/** the two Web settings, as the app reads them at this machine's level */
export interface WebConfig {
  /** the proxy's address, as kept: "off", or addresses/CIDRs like "127.0.0.1, 10.8.0.0/24" */
  proxy: string
  /** the address links use, when set; empty: the proxy's X-Forwarded-Host, when it is trusted */
  publicUrl: string
}

/** a proxy rule: an IPv4 network, or one exact IPv6 address */
type ProxyRule = { base: number; bits: number } | { exact: string }

const ipv4 = (a: string): number | null => {
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = [+m[1], +m[2], +m[3], +m[4]]
  if (parts.some((n) => n > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

const maskOf = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0)

/** a peer address as the rules compare it: lowercase, without a port or brackets, and an IPv4-mapped IPv6 as its IPv4 */
export function peerAddress(a: string | null | undefined): string {
  return (a ?? '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1')
}

/** what the Trusted proxy setting means: no rules for "off" (or empty), undefined for something that is not an address */
export function parseProxy(value: string): ProxyRule[] | undefined {
  const v = value.trim().toLowerCase()
  if (!v || v === 'off') return []
  const rules: ProxyRule[] = []
  for (const part of v.split(/[\s,]+/).filter(Boolean)) {
    const [addr, bits, ...rest] = part.split('/')
    if (rest.length || !addr) return undefined
    const a4 = ipv4(addr)
    if (a4 !== null) {
      const n = bits === undefined ? 32 : Number(bits)
      if (!Number.isInteger(n) || n < 0 || n > 32) return undefined
      rules.push({ base: (a4 & maskOf(n)) >>> 0, bits: n })
      continue
    }
    // IPv6: one exact address; a network there is not something this page needs
    if (bits !== undefined || !addr.includes(':') || !/^[0-9a-f:]+$/.test(addr)) return undefined
    rules.push({ exact: addr })
  }
  return rules
}

/** why the Trusted proxy value can't be kept, or nothing */
export function proxyError(value: string): string | undefined {
  return parseProxy(value) ? undefined : 'Write off, or a proxy address or network like 127.0.0.1 or 10.8.0.0/24, separated by commas.'
}

/** why the Public address value can't be kept, or nothing: empty is fine (the proxy's own host is used) */
export function publicUrlError(value: string): string | undefined {
  const v = value.trim()
  if (!v) return undefined
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return 'Write a web address like https://shepherd.example.com, or leave it empty.'
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return 'Write an http or https address like https://shepherd.example.com.'
  if (url.username || url.password || url.search || url.hash) return 'Write it without a name, password, query or #: just the address and a path if it has one.'
  return undefined
}

/** the public address as links use it: no trailing slash, and nothing for an address that makes no sense */
const cleanBase = (value: string) => (publicUrlError(value) ? '' : value.trim().replace(/\/+$/, ''))

/** does this connection come from the configured proxy? Only then are its forwarded headers believed */
export function isProxy(value: string, peer: string | null | undefined): boolean {
  const rules = parseProxy(value)
  if (!rules?.length) return false
  const p = peerAddress(peer)
  if (!p) return false
  const a4 = ipv4(p)
  return rules.some((r) => ('exact' in r ? p === r.exact : a4 !== null && (a4 & maskOf(r.bits)) >>> 0 === r.base))
}

/** one header's first value ("a, b" is a list) */
const first = (v: string | null) => v?.split(',')[0]?.trim() || ''

export interface WebShape {
  /** the connection came from the configured proxy, so its forwarded headers are believed */
  proxied: boolean
  /** the Trusted proxy setting as kept */
  proxy: string
  /** the address of the connection */
  peer: string | null
  /** the host asked for: the proxy's X-Forwarded-Host when trusted, else the request's own Host */
  host: string
  /** X-Forwarded-Host as it arrived, believed or not (doctor says when that matters) */
  forwardedHost: string
  /** X-Forwarded-For as it arrived, believed or not */
  forwardedFor: string
  /** the proxy said the browser's own link is https */
  secure: boolean
  /** the address links should use ("https://shep.example.com"), or empty when nothing trustworthy is known */
  publicUrl: string
}

/** what this request says about the shape, trusting forwarded headers only from the configured proxy */
export function webShape(req: Request, peer: string | null | undefined, cfg: WebConfig): WebShape {
  const proxied = isProxy(cfg.proxy, peer)
  const forwardedHost = first(req.headers.get('x-forwarded-host'))
  const host = (proxied && forwardedHost) || first(req.headers.get('host')) || ''
  const secure = proxied && first(req.headers.get('x-forwarded-proto')) === 'https'
  const explicit = cleanBase(cfg.publicUrl)
  return {
    proxied,
    proxy: cfg.proxy.trim(),
    peer: peerAddress(peer) || null,
    host,
    forwardedHost,
    forwardedFor: first(req.headers.get('x-forwarded-for')),
    secure,
    publicUrl: explicit || (proxied && forwardedHost ? `${secure ? 'https' : 'http'}://${forwardedHost}` : ''),
  }
}

export interface LinkCounts {
  /** upgrade attempts this server saw (plus the refusals a browser reported when the proxy stopped them before here) */
  attempts: number
  /** of those, the ones that opened a live link */
  upgraded: number
  /** of those, the ones refused */
  refused: number
  lastRefusedAt: number | null
}

const state: { last: WebShape | null; address: string; explicit: string; attempts: number; upgraded: number; refused: number; lastRefusedAt: number | null } = {
  last: null,
  address: '',
  explicit: '',
  attempts: 0,
  upgraded: 0,
  refused: 0,
  lastRefusedAt: null,
}

/** the last browser request's shape, and how the live link has been going, as `shepherdr doctor` reports them */
export const web = {
  /** `browser`: this request came from a browser (a page, its fetch or its socket), not a program on this machine:
   *  doctor asks about the web shape a browser is reached through, so the command channel and health checks say nothing */
  see(shape: WebShape, cfg: WebConfig, browser = true) {
    state.explicit = cleanBase(cfg.publicUrl)
    if (!browser) return
    state.last = shape
    if (!parseProxy(cfg.proxy)?.length) state.address = ''
    else if (shape.publicUrl) state.address = shape.publicUrl
  },
  /** a live-link upgrade was tried, and whether the server could take it */
  upgrade(ok: boolean) {
    state.attempts++
    if (ok) state.upgraded++
    else {
      state.refused++
      state.lastRefusedAt = Date.now()
    }
  },
  /**
   * A browser that reached the page but never opened the live link: the proxy refused the upgrade before it got here,
   * so the server could not count it itself. The browser reports it, and doctor can say so.
   */
  refusedByProxy() {
    state.attempts++
    state.refused++
    state.lastRefusedAt = Date.now()
  },
  get last(): WebShape | null {
    return state.last
  },
  get links(): LinkCounts {
    return { attempts: state.attempts, upgraded: state.upgraded, refused: state.refused, lastRefusedAt: state.lastRefusedAt }
  },
  /** the address pushes and other links should open, when one is known: web.publicUrl, else the proxy's host */
  base(): string {
    return state.explicit || state.address
  },
  /** tests only: forget the last request and its counts */
  reset() {
    state.last = null
    state.address = ''
    state.explicit = ''
    state.attempts = 0
    state.upgraded = 0
    state.refused = 0
    state.lastRefusedAt = null
  },
}

/** doctor's one line about the web shape: through what, asked for what, and whether the live link upgrades */
export function webLine(cfg: WebConfig, last: WebShape | null, links: LinkCounts, ago: (at: number) => string): string {
  const live =
    links.attempts === 0
      ? 'the live link has not been tried yet'
      : `the live link upgraded ${links.upgraded} time${links.upgraded === 1 ? '' : 's'}${
          links.refused ? `, ${links.refused} refused${links.lastRefusedAt ? ` (last ${ago(links.lastRefusedAt)} ago)` : ''}` : ''
        }`
  const rules = parseProxy(cfg.proxy) ?? []
  if (!rules.length) {
    const where = last ? `asked for ${last.host || 'no host'}` : 'no request yet'
    return `Web: no proxy configured, ${where}; ${live}.`
  }
  const proxy = cfg.proxy.trim()
  if (!last) return `Web: the proxy ${proxy} is configured, and no request has come yet; ${live}.`
  const address = cfg.publicUrl.trim() ? `links use ${cleanBase(cfg.publicUrl)} (web.publicUrl)` : last.publicUrl ? `links use ${last.publicUrl}` : 'links stay relative to the page'
  if (!last.proxied) {
    return `Web: the proxy ${proxy} is configured, but the last request came from ${last.peer ?? 'an unknown address'} directly; forwarded headers are ignored, the host asked for was ${last.host || 'none'}, and ${address}; ${live}.`
  }
  if (!last.forwardedHost) {
    return `Web: through the proxy ${proxy}, but it sends no X-Forwarded-Host; the host asked for was ${last.host || 'none'}, and ${address}; ${live}.`
  }
  const from = last.forwardedFor ? ` from ${last.forwardedFor}` : ''
  return `Web: through the proxy ${proxy}, asked for ${last.forwardedHost}${from}, and ${address}; ${live}.`
}

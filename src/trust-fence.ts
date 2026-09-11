/**
 * Browser-trust fence for the terminal route.
 *
 * The web GUI's route table dispatches a registered route before the SPA
 * fallback, so a plugin route is reachable without the page's authentication
 * token. That makes the route a local-code-execution surface if it is left
 * open: any page in the browser, or any process that can reach the listen port,
 * could otherwise open a terminal. The fence is the same rule the web `/api`
 * gateway applies — Host must be loopback or a configured trusted authority, a
 * browser must not mark the request cross-site, and a present Origin must name
 * the Host's hostname. It is a DNS-rebinding and cross-site defense, not
 * authentication.
 */
import type { IncomingHttpHeaders } from 'node:http'

/** The request facts the fence reads. */
export interface FenceRequest {
  headers: IncomingHttpHeaders
}

/** One header value, when present exactly once as a string. */
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Parse a Host-header authority, or undefined when it is not a URL authority. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Whether a normalized hostname names the local loopback authority.
 * @param hostname - a URL hostname.
 * @returns true for `localhost`, `[::1]`, and every 127.0.0.0/8 literal.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether the request authority equals a trusted host, with or without its port. */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
    return port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/**
 * Decide whether one request may reach the terminal route.
 * @param request - the request's headers.
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is this server's and the browser markers agree.
 */
export function isTrustedRequest(request: FenceRequest, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // An absent Origin is accepted: the Host check above already bound the
  // authority, and non-browser clients send no Origin. A present Origin must
  // name the same hostname, so a page served from another origin cannot open a
  // terminal here. Hostname rather than host: a loopback page on a non-default
  // port may serialize its Origin without the port.
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

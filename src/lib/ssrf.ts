/**
 * SSRF protection for the website auditor (§17, §11).
 *
 * The auditor fetches URLs that come from discovered/imported business records,
 * which is attacker-influenceable: a CSV import or a discovery source could
 * contain "http://169.254.169.254/latest/meta-data/" and turn the auditor into
 * a proxy into our own infrastructure.
 *
 * Defence is layered:
 *  1. Scheme allowlist — http/https only.
 *  2. Hostname blocklist — localhost and internal names.
 *  3. DNS resolution — the resolved address must be publicly routable.
 *  4. Redirect validation — each hop is re-checked, so a public URL cannot
 *     redirect into a private range.
 *
 * Everything fails closed: if we cannot prove an address is public, we refuse.
 */
import dns from 'dns/promises';
import net from 'net';

export interface UrlVerdict {
  safe: boolean;
  reason?: string;
  hostname?: string;
  resolvedAddresses?: string[];
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Hostnames that must never be fetched, regardless of what they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
  'internal',
]);

/** Suffixes that indicate an internal or cloud-internal name. */
const BLOCKED_SUFFIXES = [
  '.local',
  '.internal',
  '.localdomain',
  '.localnet',
  '.internal.local',
  '.corp',
  '.home',
  '.lan',
  '.intranet',
  '.svc.cluster.local',
  '.cluster.local',
];

/** Cloud metadata endpoints — a classic SSRF target. */
const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254', // AWS / GCP / Azure IMDS
  'metadata.google.internal',
  'fd00:ec2::254', // AWS IPv6 IMDS
]);

/**
 * True when an address is not publicly routable.
 * Fails closed: anything we cannot classify as public is treated as private.
 */
export function isPrivateAddress(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 0) return true; // not an IP at all — cannot prove it is public

  if (kind === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;

    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (IMDS)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
    if (a >= 224) return true; // 224.0.0.0/4 multicast and above (incl. broadcast)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }

  // IPv6
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true; // unspecified / loopback
  if (normalized.startsWith('fe80')) return true; // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
  if (normalized.startsWith('ff')) return true; // multicast
  if (normalized === 'fd00:ec2::254') return true; // AWS IPv6 IMDS

  // IPv4-mapped IPv6 must be judged by its IPv4 half. WHATWG URL parsing
  // normalises "::ffff:127.0.0.1" to the hex form "::ffff:7f00:1", so both
  // spellings have to be handled or the loopback slips through.
  const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return isPrivateAddress(mappedDotted[1]);

  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    const v4 = `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
    return isPrivateAddress(v4);
  }

  return false;
}

/**
 * Validates a URL before any request is made.
 * Does NOT resolve DNS unless `resolve` is true (the default).
 */
export async function assertSafeUrl(rawUrl: string, opts: { resolve?: boolean } = {}): Promise<UrlVerdict> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: 'not a valid URL' };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { safe: false, reason: `scheme "${parsed.protocol}" is not permitted (http/https only)` };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) return { safe: false, reason: 'no hostname' };

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { safe: false, reason: `hostname "${hostname}" is blocked`, hostname };
  }
  if (BLOCKED_METADATA_HOSTS.has(hostname)) {
    return { safe: false, reason: `cloud metadata endpoint "${hostname}" is blocked`, hostname };
  }
  if (BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { safe: false, reason: `internal hostname "${hostname}" is blocked`, hostname };
  }

  // A literal IP is checked directly.
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      return { safe: false, reason: `address ${hostname} is not publicly routable`, hostname, resolvedAddresses: [hostname] };
    }
    return { safe: true, hostname, resolvedAddresses: [hostname] };
  }

  if (opts.resolve === false) {
    return { safe: true, hostname };
  }

  // Resolve and require every resolved address to be public. A hostname that
  // resolves to both a public and a private address is refused — an attacker
  // could otherwise race which record we connect to.
  let addresses: string[] = [];
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((r) => r.address);
  } catch (err) {
    return { safe: false, reason: `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`, hostname };
  }

  if (!addresses.length) {
    return { safe: false, reason: 'hostname resolved to no address', hostname };
  }

  const privateOnes = addresses.filter((a) => isPrivateAddress(a));
  if (privateOnes.length) {
    return {
      safe: false,
      reason: `hostname "${hostname}" resolves to a non-public address (${privateOnes.join(', ')})`,
      hostname,
      resolvedAddresses: addresses,
    };
  }

  return { safe: true, hostname, resolvedAddresses: addresses };
}

/**
 * Validates every hop of a redirect chain.
 *
 * This is the part most SSRF defences miss: a public URL that 302s to
 * http://169.254.169.254/ is still an SSRF. Callers must pass each Location
 * header here before following it.
 */
export async function assertSafeRedirectChain(urls: string[]): Promise<UrlVerdict> {
  for (const url of urls) {
    const verdict = await assertSafeUrl(url);
    if (!verdict.safe) {
      return { ...verdict, reason: `redirect to ${url} refused: ${verdict.reason}` };
    }
  }
  return { safe: true };
}

/** Non-blocking check for places that only need a synchronous sanity filter. */
export function isObviouslyUnsafeUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) return true;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!hostname) return true;
    if (BLOCKED_HOSTNAMES.has(hostname)) return true;
    if (BLOCKED_METADATA_HOSTS.has(hostname)) return true;
    if (BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) return true;
    if (net.isIP(hostname) && isPrivateAddress(hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

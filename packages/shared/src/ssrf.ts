import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for outbound webhook delivery (adoption package #10).
 *
 * One function, used at BOTH write time (endpoint create/update rejects
 * bad targets with a typed 400) and at send time (the worker re-checks
 * before EVERY attempt, retries included - DNS answers can change
 * between attempts, and a hostname that was public at creation can be
 * flipped private later).
 *
 * Policy:
 *  - scheme must be https; http is allowed ONLY for loopback hosts
 *    (local development receivers), never for anything else;
 *  - URLs with embedded credentials are rejected;
 *  - the hostname is resolved and EVERY resolved address must be a
 *    public unicast address - any private / loopback / link-local /
 *    reserved / multicast / documentation address rejects the URL;
 *  - IP literals are checked directly (no DNS involved).
 *
 * Known limit (accepted, see docs/outbound-webhooks.md): the check
 * resolves and then the HTTP client resolves again at connect time, so
 * a DNS answer that flips between the two lookups inside one attempt
 * (rebinding TOCTOU) is not fully pinned. Re-checking on every attempt
 * bounds the window to a single send.
 */

export type DnsLookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: DnsLookupFn = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export type OutboundUrlCheck =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: string };

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv4In(ip: number, base: string, prefixBits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

/** Blocked IPv4 ranges: [base, prefixBits, label]. */
const IPV4_BLOCKED: ReadonlyArray<readonly [string, number, string]> = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "cgnat"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "protocol-assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.31.196.0", 24, "reserved"],
  ["192.52.193.0", 24, "reserved"],
  ["192.88.99.0", 24, "deprecated-relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

/** Why an IPv4 address is not a public unicast target, or null when it is fine. */
export function ipv4BlockReason(ip: string): string | null {
  const value = ipv4ToInt(ip);
  if (value === null) return "invalid-ipv4";
  for (const [base, bits, label] of IPV4_BLOCKED) {
    if (ipv4In(value, base, bits)) return label;
  }
  return null;
}

export function isLoopbackIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return value !== null && ipv4In(value, "127.0.0.0", 8);
}

/** Expand an IPv6 literal to its 8 16-bit groups (embedded IPv4 handled), or null. */
export function ipv6Groups(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const v4Tail = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Tail) {
    const v4 = ipv4ToInt(v4Tail[1]!);
    if (v4 === null) return null;
    addr = `${addr.slice(0, addr.length - v4Tail[1]!.length)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const groups: number[] = [];
    for (const part of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };
  const left = parseSide(halves[0]!);
  if (left === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const right = parseSide(halves[1]!);
  if (right === null) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/** Why an IPv6 address is not a public unicast target, or null when it is fine. */
export function ipv6BlockReason(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (g === null) return "invalid-ipv6";
  const isV4Mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  const isNat64WellKnown = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  if (isV4Mapped || isNat64WellKnown) {
    const embedded = `${(g[6]! >>> 8) & 0xff}.${g[6]! & 0xff}.${(g[7]! >>> 8) & 0xff}.${g[7]! & 0xff}`;
    return ipv4BlockReason(embedded);
  }
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  if ((g[0]! & 0xffc0) === 0xfe80) return "link-local";
  if ((g[0]! & 0xfe00) === 0xfc00) return "unique-local";
  if ((g[0]! & 0xff00) === 0xff00) return "multicast";
  if (g[0] === 0x2001 && g[1] === 0x0db8) return "documentation";
  if (g[0] === 0x100 && (g[1]! & 0xffc0) === 0) return "discard-only";
  return null;
}

export function isLoopbackIp(ip: string): boolean {
  if (isIP(ip) === 4) return isLoopbackIpv4(ip);
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    return g !== null && g.slice(0, 7).every((x) => x === 0) && g[7] === 1;
  }
  return false;
}

function blockReasonForAddress(address: string): string | null {
  const kind = isIP(address);
  if (kind === 4) return ipv4BlockReason(address);
  if (kind === 6) return ipv6BlockReason(address);
  return "unresolvable-address";
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * Validate an outbound webhook target URL. Async because hostnames are
 * resolved through DNS; `lookupFn` is injectable for tests.
 */
export async function checkOutboundWebhookUrl(
  rawUrl: string,
  lookupFn: DnsLookupFn = defaultLookup,
): Promise<OutboundUrlCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL is not a valid absolute URL." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed." };
  }
  // WHATWG URL keeps the brackets on IPv6 literal hosts in some
  // runtimes; normalize them away before the IP-literal checks.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) return { ok: false, reason: "URL has no host." };

  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "https" && scheme !== "http") {
    return { ok: false, reason: `URL scheme "${scheme}" is not allowed (https required).` };
  }

  const hostIsIp = isIP(hostname) !== 0;
  const loopbackHost = isLoopbackHostname(hostname) || (hostIsIp && isLoopbackIp(hostname));

  if (scheme === "http" && !loopbackHost) {
    return {
      ok: false,
      reason: "Plain http is only allowed for loopback hosts (local development); use https.",
    };
  }

  let addresses: string[];
  if (hostIsIp) {
    addresses = [hostname];
  } else {
    try {
      addresses = await lookupFn(hostname);
    } catch {
      return { ok: false, reason: `Host "${hostname}" could not be resolved.` };
    }
    if (addresses.length === 0) {
      return { ok: false, reason: `Host "${hostname}" could not be resolved.` };
    }
  }

  for (const address of addresses) {
    // The http loopback exception demands loopback addresses only; for
    // https the full public-unicast policy applies to every address.
    if (scheme === "http") {
      if (!isLoopbackIp(address)) {
        return { ok: false, reason: `Host "${hostname}" resolves to ${address}, which is not a loopback address.` };
      }
      continue;
    }
    const reason = blockReasonForAddress(address);
    if (reason) {
      return {
        ok: false,
        reason: `Host "${hostname}" resolves to ${address} (${reason}), which is not a public address.`,
      };
    }
  }
  return { ok: true, url, addresses };
}

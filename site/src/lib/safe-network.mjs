// Network safety for build-time lookups (project pages, README images, GitHub). Project URLs come from README
// contributions, so a URL can point anywhere, including at services on the build machine or its network
// (http://127.0.0.1/..., cloud metadata at 169.254.169.254, a hostname that resolves to a private address, a redirect
// to any of these). The build must never contact them.
//
// The rule is enforced where the connection is made, not in front of it:
//   1. `vetDestination` resolves the host name itself and checks every resulting address (IP literals are checked
//      directly). One non-public address among the answers refuses the whole destination.
//   2. `pinnedGet` connects only to those validated addresses. Node's `lookup` hook returns the validated list instead
//      of asking DNS again, so a name that answers differently the second time (DNS rebinding) cannot change where the
//      socket goes. The URL keeps its host name, so the Host header, SNI and certificate verification still use it.
// The HTTP client (`createHttp` in image-discovery.mjs) runs both steps for every request attempt, including every
// redirect hop, so no code path can reach the network without them.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

/** The destination of a request is not a public internet address. Not a build failure: the lookup just fails. */
export class BlockedDestinationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedDestinationError';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Address classification

function ipv4Octets(text) {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

const ipv4Number = ([a, b, c, d]) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

// IANA special-purpose IPv4 registry: everything that is not ordinary public unicast.
const IPV4_BLOCKS = [
  ['0.0.0.0', 8, 'an unspecified or "this network" address'],
  ['10.0.0.0', 8, 'a private address'],
  ['100.64.0.0', 10, 'a shared (carrier-grade NAT) address'],
  ['127.0.0.0', 8, 'a loopback address', true],
  ['169.254.0.0', 16, 'a link-local address'],
  ['172.16.0.0', 12, 'a private address'],
  ['192.0.0.0', 24, 'a reserved protocol-assignment address'],
  ['192.0.2.0', 24, 'a documentation address'],
  ['192.88.99.0', 24, 'a reserved 6to4 relay address'],
  ['192.168.0.0', 16, 'a private address'],
  ['198.18.0.0', 15, 'a benchmarking address'],
  ['198.51.100.0', 24, 'a documentation address'],
  ['203.0.113.0', 24, 'a documentation address'],
  ['224.0.0.0', 4, 'a multicast address'],
  ['240.0.0.0', 4, 'a reserved or broadcast address'],
].map(([base, bits, label, loopback = false]) => ({ base: ipv4Number(ipv4Octets(base)), bits, label, loopback }));

function ipv4Problem(octets, allowLoopback) {
  const value = ipv4Number(octets);
  const block = IPV4_BLOCKS.find(({ base, bits }) => value >>> (32 - bits) === base >>> (32 - bits));
  return block && !(block.loopback && allowLoopback) ? block.label : null;
}

function ipv6Bytes(text) {
  let address = text.split('%')[0];
  if (address.includes('.')) { // ::ffff:1.2.3.4 — the dotted tail stands for the last two groups
    const split = address.lastIndexOf(':') + 1;
    const tail = ipv4Octets(address.slice(split));
    if (!tail) return null;
    address = `${address.slice(0, split)}${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const groups = (part) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const all = halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill('0'), ...rest] : head;
  if (all.length !== 8 || !all.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return all.flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 0xff]);
}

function ipv6Problem(bytes, allowLoopback) {
  const zero = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  if (zero(0, 16)) return 'an unspecified address';
  if (zero(0, 15) && bytes[15] === 1) return allowLoopback ? null : 'a loopback address';
  // IPv4-mapped (::ffff:a.b.c.d): the embedded IPv4 address decides.
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const problem = ipv4Problem(bytes.slice(12), allowLoopback);
    return problem && `an IPv4-mapped address of ${problem}`;
  }
  if (zero(0, 12)) return 'a deprecated IPv4-compatible address';
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address that decides.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) {
    const problem = ipv4Problem(bytes.slice(12), allowLoopback);
    return problem && `a NAT64 address of ${problem}`;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const problem = ipv4Problem(bytes.slice(2, 6), allowLoopback);
    return problem && `a 6to4 address of ${problem}`;
  }
  // Only global unicast (2000::/3) can be public. That excludes unique-local (fc00::/7), link-local (fe80::/10),
  // site-local (fec0::/10), multicast (ff00::/8), the discard prefix and everything still unallocated.
  if ((bytes[0] & 0xe0) !== 0x20) return 'not a global unicast address';
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] < 0x02) return 'a reserved protocol-assignment address'; // 2001::/23 (Teredo, benchmarking, ORCHID, ...)
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return 'a documentation address'; // 2001:db8::/32
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return 'a documentation address'; // 3fff::/20
  return null;
}

/**
 * Why an IP address is not a public destination, or null if it is. `allowLoopback` (test fixtures only) additionally
 * accepts loopback addresses; every other non-public range stays refused.
 */
export function addressProblem(address, { allowLoopback = false } = {}) {
  const family = net.isIP(address);
  if (family === 4) return ipv4Problem(ipv4Octets(address), allowLoopback);
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    return bytes ? ipv6Problem(bytes, allowLoopback) : 'an unreadable IPv6 address';
  }
  return 'not an IP address';
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution and validation

/** The system resolver: every address of a host name, in the resolver's own order. */
export async function resolveHost(hostname) {
  const found = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return found.map(({ address, family }) => ({ address, family }));
}

/**
 * Checks a request URL and returns the validated `[{ address, family }]` the connection must use. Throws
 * `BlockedDestinationError` for a URL or destination that may not be contacted. With `resolve: null` (the injected-fetch
 * test seam) host names are not resolved here and `null` is returned; IP literals are still checked.
 */
export async function vetDestination(url, { allowLoopback = false, resolve = resolveHost } = {}) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedDestinationError(`unsupported protocol ${url.protocol}`);
  if (url.username || url.password) throw new BlockedDestinationError('the URL contains credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new BlockedDestinationError('the URL has no host');
  const literal = net.isIP(host);
  let candidates = null;
  if (literal) candidates = [{ address: host, family: literal }];
  else if (resolve) candidates = await resolve(host);
  if (!candidates) return null;
  if (candidates.length === 0) throw Object.assign(new Error(`cannot resolve ${host}`), { code: 'ENOTFOUND' });
  for (const { address } of candidates) {
    const problem = addressProblem(address, { allowLoopback });
    if (problem) throw new BlockedDestinationError(literal ? `${host} is ${problem}` : `${host} resolves to ${address}, ${problem}`);
  }
  return candidates;
}

// ---------------------------------------------------------------------------------------------------------------
// Pinned transport

/** The server answered, but not with an HTTP response a client can represent (a status outside 200-599, say). */
export class InvalidResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidResponseError';
  }
}

function toResponse(incoming) {
  // `Response` only represents statuses 200-599. Anything else is the server's fault, and is reported as such rather
  // than as a RangeError from inside the Response constructor.
  const status = incoming.statusCode;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new InvalidResponseError(`invalid HTTP status ${status}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    for (const item of [].concat(value)) {
      try {
        headers.append(name, item);
      } catch { /* a header value the Headers class cannot represent is not needed here */ }
    }
  }
  const noBody = [204, 205, 304].includes(status);
  if (noBody) incoming.resume();
  return new Response(noBody ? null : Readable.toWeb(incoming), { status, headers });
}

/**
 * GET `url` over a socket that connects only to `addresses` (from `vetDestination`). Resolves with a fetch `Response`
 * whose body is streamed; the caller bounds and cancels it. No content decoding is requested, so a size limit on the
 * bytes read is a limit on the content. `tlsOptions.ca` is an extra certificate authority (tests); certificate and
 * host name verification always use the URL's host name, never the pinned address.
 */
export function pinnedGet(url, { headers = {}, signal, addresses, tlsOptions = {} }) {
  if (!Array.isArray(addresses) || addresses.length === 0) throw new BlockedDestinationError('no validated address to connect to');
  const lookup = (_hostname, options, callback) => {
    if (typeof options === 'function') [options, callback] = [{}, options];
    const requested = typeof options === 'number' ? options : options?.family;
    const family = { IPv4: 4, IPv6: 6 }[requested] ?? requested ?? 0;
    const usable = addresses.filter((candidate) => !family || candidate.family === family);
    if (usable.length === 0) return callback(Object.assign(new Error(`no validated address for ${url.hostname}`), { code: 'ENOTFOUND' }));
    return options?.all ? callback(null, usable) : callback(null, usable[0].address, usable[0].family);
  };
  const secure = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const request = (secure ? https : http).request(url, {
      method: 'GET',
      headers: { 'accept-encoding': 'identity', ...headers },
      agent: false,
      autoSelectFamily: true,
      lookup,
      signal,
      ...(secure && tlsOptions.ca ? { ca: tlsOptions.ca } : {}),
    }, (incoming) => {
      // This callback runs outside the Promise executor, so an exception here would be uncaught and end the process.
      // Converting the response can fail (see InvalidResponseError); that rejects the request like any other failure,
      // and the unread response and its socket are released.
      try {
        resolve(toResponse(incoming));
      } catch (error) {
        incoming.destroy();
        request.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
    request.end();
  });
}

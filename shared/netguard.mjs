// Decide whether a network address is safe for our servers to talk to on behalf of a stranger.
//
// Anyone can submit a URL and a browser on our server will open it, so every address a
// submitted page can lead to (redirects, sub-resources, DNS tricks) has to be checked:
// loopback, private ranges, link-local and the cloud metadata address (100.100.100.200 on
// Alibaba Cloud sits inside 100.64.0.0/10) must never be reachable.

import { BlockList, isIP } from 'node:net';
import dns from 'node:dns/promises';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 can smuggle any IPv4 address
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

// Only the ports real web works run on. Anything else is likely an internal service.
export const ALLOWED_PORTS = new Set([80, 443]);

// 16 bytes of an IPv6 address, or null.
function ipv6Bytes(ip) {
  let text = ip;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const o = tail[1].split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    text = text.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest];
  const bytes = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(g) || Number.isNaN(n)) return null;
    bytes.push(n >> 8, n & 255);
  }
  return bytes.length === 16 ? bytes : null;
}

// `::ffff:10.0.0.1` and `::10.0.0.1` are IPv4 addresses in disguise.
function embeddedV4(bytes) {
  const zeros = (n) => bytes.slice(0, n).every((b) => b === 0);
  const mapped = zeros(10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = zeros(12) && bytes.slice(12).some((b) => b !== 0) && !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && bytes[15] <= 1);
  return mapped || compatible ? bytes.slice(12).join('.') : null;
}

// True when the address is not a plain public one. Anything unparseable counts as unsafe.
export function isPrivateAddress(address) {
  const ip = String(address).trim().replace(/^\[|\]$/g, '').split('%')[0];
  const family = isIP(ip);
  if (!family) return true;
  if (family === 4) return blocked.check(ip, 'ipv4');
  const bytes = ipv6Bytes(ip);
  if (!bytes) return true;
  const v4 = embeddedV4(bytes);
  if (v4) return blocked.check(v4, 'ipv4');
  return blocked.check(ip, 'ipv6');
}

export class GuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'private' | 'nxdomain' | 'dns' | 'port' | 'literal'
  }
}

// Resolve a hostname and refuse unless every address is public. IPv4 first, so the caller
// can pin the connection to the address that was checked (no second lookup to trick).
export async function resolvePublic(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  let records;
  if (isIP(bare)) {
    records = [{ address: bare, family: isIP(bare) }];
  } else {
    try {
      records = await dns.lookup(bare, { all: true, verbatim: true });
    } catch (e) {
      throw new GuardError(e.code === 'ENOTFOUND' ? 'nxdomain' : 'dns', `cannot resolve ${bare}: ${e.code || e.message}`);
    }
  }
  if (!records.length) throw new GuardError('nxdomain', `no address for ${bare}`);
  for (const r of records) {
    if (isPrivateAddress(r.address)) throw new GuardError('private', `${bare} resolves to a non-public address`);
  }
  return records.sort((a, b) => a.family - b.family).map((r) => r.address);
}

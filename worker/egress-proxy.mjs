// The only way out for the browser.
//
// Chrome is started with --proxy-server pointing here, so every request a submitted page makes
// (the page itself, redirects, scripts, images, WebSockets) is checked before a connection is
// opened. The proxy does its own DNS lookup, refuses anything that is not a public address and
// then connects to that very address, so a name that resolves to something internal (or
// changes its answer between two lookups) cannot get through. Only ports 80 and 443 are open.
//
// Optional relay: from a mainland server some platform hosts (GitHub Pages) lose a lot of packets,
// so a page there can stay blank for longer than we wait. With `relay` set, HTTPS tunnels to the
// listed host patterns go through an upstream HTTP proxy that sits outside the country, and fall
// back to a direct connection when the relay does not answer. The address check above still comes
// first, and the relay is asked for the address that passed it, never for the name, so it cannot
// be used to look a name up again somewhere else. Keep the pattern list to hosts whose DNS the
// platform controls (*.github.io); for names anyone can point anywhere the relay gains nothing
// and the direct path is the one that is measured.

import http from 'node:http';
import net from 'node:net';
import { ALLOWED_PORTS, GuardError, resolvePublic } from '../shared/netguard.mjs';

// "*.github.io" matches any subdomain, anything else must match exactly.
export function matchesRelayHost(host, patterns = []) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    return pat.startsWith('*.') ? h.endsWith(pat.slice(1)) && h.length > pat.length - 1 : h === pat;
  });
}

// "http://host:port" (and the host list) from the environment, or null when no relay is set.
export function parseRelay(url, hosts = '*.github.io') {
  if (!url) return null;
  const u = new URL(url);
  const patterns = hosts.split(',').map((s) => s.trim()).filter(Boolean);
  if (u.protocol !== 'http:' || !u.port || !patterns.length) throw new Error('UPSTREAM_PROXY must look like http://host:port');
  return { host: u.hostname, port: Number(u.port), hosts: patterns };
}

// Ask an HTTP proxy for a tunnel to ip:port; resolves with the connected socket (paused).
function connectViaRelay(relay, ip, port, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(relay.port, relay.host);
    let buf = Buffer.alloc(0);
    const fail = (e) => {
      clearTimeout(timer);
      s.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error('relay did not answer in time')), timeoutMs);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return buf.length > 8192 ? fail(new Error('relay reply too long')) : undefined;
      s.removeListener('data', onData);
      s.pause();
      clearTimeout(timer);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1];
      if (status !== '200') return fail(new Error(`relay answered ${status ?? 'something else'}`));
      s.removeListener('error', fail);
      s.on('error', () => {});
      if (buf.length > end + 4) s.unshift(buf.subarray(end + 4));
      resolve(s);
    };
    s.once('error', fail);
    s.on('data', onData);
    s.once('connect', () => {
      const hp = `${net.isIPv6(ip) ? `[${ip}]` : ip}:${port}`;
      s.write(`CONNECT ${hp} HTTP/1.1\r\nHost: ${hp}\r\n\r\n`);
    });
  });
}

function connectDirect(ip, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, ip);
    s.once('connect', () => {
      s.removeListener('error', reject);
      s.on('error', () => {});
      s.pause();
      resolve(s);
    });
    s.once('error', reject);
  });
}

// Resolve host and return the one address to connect to, or throw a GuardError.
export async function checkTarget(host, port) {
  if (!ALLOWED_PORTS.has(port)) throw new GuardError('port', `port ${port} is not allowed`);
  const [ip] = await resolvePublic(host);
  return ip;
}

const HOP_BY_HOP = /^(proxy-connection|proxy-authorization|connection|keep-alive|te|trailer|upgrade|transfer-encoding)$/i;

export function startEgressProxy({ port = 3128, host = '127.0.0.1', log = () => {}, resolve = checkTarget, relay = null } = {}) {
  const deny = (res, status, why) => {
    log(`${status === 403 ? 'blocked' : 'failed'}: ${why}`);
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(`blocked: ${why}\n`);
  };

  const server = http.createServer(async (req, res) => {
    let target;
    try {
      target = new URL(req.url);
      if (target.protocol !== 'http:') throw new Error('not http');
    } catch {
      return deny(res, 400, 'proxy requests must carry an absolute http URL');
    }
    const targetPort = Number(target.port || 80);
    let ip;
    try {
      ip = await resolve(target.hostname, targetPort);
    } catch (e) {
      return deny(res, e instanceof GuardError ? 403 : 502, `${target.hostname}:${targetPort} (${e.message})`);
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.test(k)) headers[k] = v;
    headers.host = target.host;
    const upstream = http.request({ host: ip, port: targetPort, method: req.method, path: target.pathname + target.search, headers }, (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
    upstream.setTimeout(60000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', (e) => deny(res, 502, e.message));
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  // HTTPS (and WebSockets) arrive as CONNECT host:port and are tunnelled untouched.
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    let target;
    try {
      target = new URL(`http://${req.url}`);
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const targetPort = Number(target.port || 443);
    let ip;
    try {
      ip = await resolve(target.hostname, targetPort);
    } catch (e) {
      log(`${e instanceof GuardError ? 'blocked' : 'failed'}: ${target.hostname}:${targetPort} (${e.message})`);
      client.end(`HTTP/1.1 ${e instanceof GuardError ? 403 : 502} Blocked\r\n\r\n`);
      return;
    }
    let upstream;
    try {
      if (relay && matchesRelayHost(target.hostname, relay.hosts)) {
        try {
          upstream = await connectViaRelay(relay, ip, targetPort);
        } catch (e) {
          log(`relay unavailable for ${target.hostname} (${e.message}); connecting directly`);
        }
      }
      upstream ??= await connectDirect(ip, targetPort);
    } catch {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    // The browser may have given up while we were still connecting.
    if (client.destroyed) return upstream.destroy();
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });

  server.on('clientError', (_, socket) => socket.destroy());
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveStart(server));
  });
}

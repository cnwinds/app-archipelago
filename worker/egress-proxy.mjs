// The only way out for the browser.
//
// Chrome is started with --proxy-server pointing here, so every request a submitted page makes
// (the page itself, redirects, scripts, images, WebSockets) is checked before a connection is
// opened. The proxy does its own DNS lookup, refuses anything that is not a public address and
// then connects to that very address, so a name that resolves to something internal (or
// changes its answer between two lookups) cannot get through. Only ports 80 and 443 are open.

import http from 'node:http';
import net from 'node:net';
import { ALLOWED_PORTS, GuardError, resolvePublic } from '../shared/netguard.mjs';

// Resolve host and return the one address to connect to, or throw a GuardError.
export async function checkTarget(host, port) {
  if (!ALLOWED_PORTS.has(port)) throw new GuardError('port', `port ${port} is not allowed`);
  const [ip] = await resolvePublic(host);
  return ip;
}

const HOP_BY_HOP = /^(proxy-connection|proxy-authorization|connection|keep-alive|te|trailer|upgrade|transfer-encoding)$/i;

export function startEgressProxy({ port = 3128, host = '127.0.0.1', log = () => {}, resolve = checkTarget } = {}) {
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
    const upstream = net.connect(targetPort, ip, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
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

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { GuardError } from '../shared/netguard.mjs';
import { matchesRelayHost, parseRelay, startEgressProxy } from '../worker/egress-proxy.mjs';

// A pretend internet: allowed.test is a "public" name that leads to our local upstream, everything
// else is treated as an internal address. The real address check is covered in netguard.test.mjs.
async function setup() {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits += 1;
    res.setHeader('content-type', 'text/plain');
    res.end(`hello from ${req.headers.host}${req.url}`);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const resolve = async (host) => {
    if (host === 'allowed.test') return '127.0.0.1';
    throw new GuardError('private', `${host} is not public`);
  };
  const proxy = await startEgressProxy({ port: 0, resolve });
  const proxyPort = proxy.address().port;
  return {
    upstreamPort,
    proxyPort,
    hits: () => hits,
    close: () => Promise.all([new Promise((r) => upstream.close(r)), new Promise((r) => proxy.close(r))]),
  };
}

function viaProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: targetUrl, headers: { host: u.host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = '';
    s.on('data', (c) => {
      buf += c;
      if (buf.includes('\r\n\r\n')) resolve({ socket: s, head: buf });
    });
    s.on('error', reject);
    s.on('end', () => resolve({ socket: s, head: buf }));
  });
}

test('forwards a request to a public name', async () => {
  const t = await setup();
  try {
    const r = await viaProxy(t.proxyPort, `http://allowed.test:${t.upstreamPort}/hello?x=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body, `hello from allowed.test:${t.upstreamPort}/hello?x=1`);
  } finally {
    await t.close();
  }
});

test('refuses a name that leads somewhere internal, without touching it', async () => {
  const t = await setup();
  try {
    const r = await viaProxy(t.proxyPort, `http://internal.test:${t.upstreamPort}/secret`);
    assert.equal(r.status, 403);
    assert.equal(t.hits(), 0);
  } finally {
    await t.close();
  }
});

test('refuses requests that are not absolute http URLs', async () => {
  const t = await setup();
  try {
    const r = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: t.proxyPort, path: '/just-a-path' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    assert.equal(r, 400);
    assert.equal(t.hits(), 0);
  } finally {
    await t.close();
  }
});

test('CONNECT to an internal name is refused', async () => {
  const t = await setup();
  try {
    const { socket, head } = await connect(t.proxyPort, `internal.test:${t.upstreamPort}`);
    assert.match(head, /^HTTP\/1\.1 403/);
    socket.destroy();
    assert.equal(t.hits(), 0);
  } finally {
    await t.close();
  }
});

test('CONNECT to a public name is tunnelled', async () => {
  const t = await setup();
  try {
    const { socket, head } = await connect(t.proxyPort, `allowed.test:${t.upstreamPort}`);
    assert.match(head, /^HTTP\/1\.1 200/);
    const reply = await new Promise((resolve) => {
      let buf = '';
      socket.on('data', (c) => {
        buf += c;
        if (buf.includes('hello from')) resolve(buf);
      });
      socket.write('GET /tunnel HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n');
    });
    assert.match(reply, /hello from allowed.test\/tunnel/);
    socket.destroy();
  } finally {
    await t.close();
  }
});

// ---- relay: an upstream HTTP proxy for a few platform hosts ----

// pages.github.io and evil.github.io are "public" names that lead to the local upstream (the real
// proxy asks for the address, which would otherwise be a real GitHub one); leak.github.io is
// internal. `mode` says how the pretend relay behaves: ok | refuse | bad-gateway.
async function relaySetup(mode) {
  const upstream = http.createServer((req, res) => res.end(`hello from ${req.headers.host}${req.url}`));
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const asked = [];
  const relayServer = net.createServer((c) => {
    c.once('data', (d) => {
      asked.push(d.toString().split('\r\n')[0]);
      if (mode === 'bad-gateway') return c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      const t = net.connect(upstreamPort, '127.0.0.1', () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n');
        t.pipe(c);
        c.pipe(t);
      });
      t.on('error', () => c.destroy());
    });
  });
  await new Promise((r) => relayServer.listen(0, '127.0.0.1', r));
  let relayPort = relayServer.address().port;
  if (mode === 'refuse') {
    await new Promise((r) => relayServer.close(r)); // nothing listens there any more
  }

  const resolve = async (host) => {
    if (host === 'allowed.test' || host === 'pages.github.io') return '127.0.0.1';
    throw new GuardError('private', `${host} is not public`);
  };
  const proxy = await startEgressProxy({ port: 0, resolve, relay: { host: '127.0.0.1', port: relayPort, hosts: ['*.github.io'] } });
  return {
    upstreamPort,
    proxyPort: proxy.address().port,
    asked,
    close: () =>
      Promise.all([
        new Promise((r) => upstream.close(r)),
        new Promise((r) => proxy.close(r)),
        mode === 'refuse' ? null : new Promise((r) => relayServer.close(r)),
      ]),
  };
}

async function fetchThroughTunnel(proxyPort, target, hostHeader) {
  const { socket, head } = await connect(proxyPort, target);
  if (!/^HTTP\/1\.1 200/.test(head)) {
    socket.destroy();
    return head.split('\r\n')[0];
  }
  const reply = await new Promise((resolve) => {
    let buf = '';
    socket.on('data', (c) => {
      buf += c;
      if (buf.includes('hello from')) resolve(buf);
    });
    socket.write(`GET /x HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
  });
  socket.destroy();
  return reply;
}

test('relay: which names it applies to', () => {
  const pats = ['*.github.io'];
  assert.equal(matchesRelayHost('someone.github.io', pats), true);
  assert.equal(matchesRelayHost('A.B.GitHub.io.', pats), true);
  assert.equal(matchesRelayHost('github.io', pats), false);
  assert.equal(matchesRelayHost('evilgithub.io', pats), false);
  assert.equal(matchesRelayHost('github.io.evil.com', pats), false);
  assert.equal(matchesRelayHost('example.com', pats), false);
  assert.equal(matchesRelayHost('exact.example', ['exact.example']), true);
  assert.equal(matchesRelayHost('sub.exact.example', ['exact.example']), false);
});

test('relay: configuration is checked, empty means off', () => {
  assert.equal(parseRelay(''), null);
  assert.equal(parseRelay(undefined), null);
  assert.deepEqual(parseRelay('http://host.docker.internal:7890'), { host: 'host.docker.internal', port: 7890, hosts: ['*.github.io'] });
  assert.deepEqual(parseRelay('http://10.0.0.2:8080', ' *.github.io , *.example.org '), { host: '10.0.0.2', port: 8080, hosts: ['*.github.io', '*.example.org'] });
  assert.throws(() => parseRelay('socks5://x:1080'));
  assert.throws(() => parseRelay('http://noport'));
});

test('relay: a listed host is tunnelled through it, asked for by address and not by name', async () => {
  const t = await relaySetup('ok');
  try {
    const reply = await fetchThroughTunnel(t.proxyPort, `pages.github.io:${t.upstreamPort}`, 'pages.github.io');
    assert.match(reply, /hello from pages.github.io\/x/);
    assert.deepEqual(t.asked, [`CONNECT 127.0.0.1:${t.upstreamPort} HTTP/1.1`]);
  } finally {
    await t.close();
  }
});

test('relay: other hosts never touch it', async () => {
  const t = await relaySetup('ok');
  try {
    const reply = await fetchThroughTunnel(t.proxyPort, `allowed.test:${t.upstreamPort}`, 'allowed.test');
    assert.match(reply, /hello from allowed.test\/x/);
    assert.deepEqual(t.asked, []);
  } finally {
    await t.close();
  }
});

test('relay: the address check comes first, an internal name on a listed host is refused', async () => {
  const t = await relaySetup('ok');
  try {
    const reply = await fetchThroughTunnel(t.proxyPort, `leak.github.io:${t.upstreamPort}`, 'leak.github.io');
    assert.match(reply, /^HTTP\/1\.1 403/);
    assert.deepEqual(t.asked, [], 'the relay must not even be asked');
  } finally {
    await t.close();
  }
});

test('relay: if it is down, the connection goes out directly instead', async () => {
  const t = await relaySetup('refuse');
  try {
    const reply = await fetchThroughTunnel(t.proxyPort, `pages.github.io:${t.upstreamPort}`, 'pages.github.io');
    assert.match(reply, /hello from pages.github.io\/x/);
  } finally {
    await t.close();
  }
});

test('relay: if it refuses the tunnel, the connection goes out directly instead', async () => {
  const t = await relaySetup('bad-gateway');
  try {
    const reply = await fetchThroughTunnel(t.proxyPort, `pages.github.io:${t.upstreamPort}`, 'pages.github.io');
    assert.match(reply, /hello from pages.github.io\/x/);
    assert.equal(t.asked.length, 1);
  } finally {
    await t.close();
  }
});

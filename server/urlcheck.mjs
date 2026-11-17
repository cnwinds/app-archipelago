// Is this a URL we are willing to open and, maybe, list? The messages are shown to visitors.
//
// This is the friendly first gate. The real protection against pointing our browser at internal
// addresses is the worker's egress proxy, which checks every connection again.

import { isIP } from 'node:net';
import { ALLOWED_PORTS, GuardError, resolvePublic } from '../shared/netguard.mjs';
import { OWN_HOST, SKIP_HOST, SKIP_PATH } from '../shared/rules.mjs';
import { normalizeUrl } from '../shared/url.mjs';

export class UserError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function checkSubmittedUrl(raw, { resolveDns = true } = {}) {
  let text = String(raw ?? '').trim();
  if (!text) throw new UserError('empty', '请填写作品的网址');
  if (text.length > 2048) throw new UserError('too_long', '网址太长了');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new UserError('invalid', '这不是一个有效的网址');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new UserError('scheme', '只收录 http 或 https 网址');
  if (u.username || u.password) throw new UserError('credentials', '网址里不能带账号和密码');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  // new URL() already turns 2130706433 or 0x7f.1 into 127.0.0.1, so this catches those too.
  if (isIP(host.replace(/^\[|\]$/g, ''))) throw new UserError('literal', '请使用域名，不要使用 IP 地址');
  if (!host.includes('.') || /\.(local|localhost|internal|lan|home|corp|intranet|test|invalid)$/.test(host)) {
    throw new UserError('internal', '这看起来不是一个公开的网站');
  }
  if (u.port && !ALLOWED_PORTS.has(Number(u.port))) throw new UserError('port', '只支持默认端口（80 或 443）的网址');
  if (OWN_HOST.test(host)) throw new UserError('own', '这就是本站，请提交别的作品');
  if (SKIP_HOST.test(host) || SKIP_PATH.test(u.pathname)) {
    throw new UserError('not_playable', '代码仓库、应用商店、视频、文档这类链接不是能直接试玩的作品，请提交作品本身的网址');
  }
  const url = normalizeUrl(u.toString());
  if (resolveDns) {
    try {
      await resolvePublic(host);
    } catch (e) {
      if (e instanceof GuardError && e.code === 'private') throw new UserError('private', '这个网址指向的不是公开的网站');
      if (e instanceof GuardError && e.code === 'nxdomain') throw new UserError('nxdomain', '这个域名解析不到，请检查是否拼错');
      // Other DNS trouble (a timeout from here, say) is not the visitor's fault: the worker will find out.
    }
  }
  return url;
}

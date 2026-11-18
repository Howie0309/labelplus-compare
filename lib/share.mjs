// 局域网协作：发起人的电脑当服务器，同事用浏览器打开分享链接一起标注同一批数据。
// 本机（127.0.0.1）访问的是发起人，拥有全部权限；从局域网 IP 访问的是协作者，必须带分享口令，只能查看、标注和导出。
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';

export const COOKIE = 'lp_share';
const ONLINE_MS = 30000;
const presence = new Map(); // 名字 -> { role, lastSeen, itemId }
let lanServers = [];

export const newToken = () => crypto.randomBytes(18).toString('base64url');

// 本机的局域网 IPv4 地址（排除回环、虚拟网卡上的链路本地地址）
export function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(utun|tun|tap|llw|awdl)/i.test(name)) // 排除 VPN / 点对点网卡，这些地址同事连不上
    .flatMap(([, list]) => list || [])
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address);
}

// 开启时在每个局域网地址上各监听一份（与 127.0.0.1 并存，互不影响）；关闭时全部停掉
export async function bindLan(enabled, port, handler) {
  await Promise.all(lanServers.map((s) => new Promise((r) => {
    s.close(() => r());
    s.closeAllConnections?.(); // 断开协作者的长连接，否则 close 会一直等
  })));
  lanServers = [];
  if (!enabled) return [];
  const ok = [];
  for (const ip of lanAddresses()) {
    const s = http.createServer(handler);
    await new Promise((resolve) => {
      s.once('error', (e) => (console.error(`局域网监听 ${ip}:${port} 失败：${e.message}`), resolve()));
      s.listen(port, ip, () => (ok.push(ip), lanServers.push(s), resolve()));
    });
  }
  return ok;
}

export const urls = (port, token) => lanServers.map((s) => `http://${s.address().address}:${port}/?token=${encodeURIComponent(token)}`);

export function cookieToken(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

export const sameToken = (a, b) => !!a && !!b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// 页面每次请求都带上 X-Labeler（标注人名字），用来显示谁在线、正在看哪一条
export function touch(name, role, itemId) {
  if (!name) return;
  const p = presence.get(name) || {};
  presence.set(name, { role, lastSeen: Date.now(), itemId: itemId ?? p.itemId ?? null });
}

export const online = () =>
  [...presence.entries()].filter(([, p]) => Date.now() - p.lastSeen < ONLINE_MS).map(([name, p]) => ({ name, role: p.role, itemId: p.itemId }));

export async function closeAll() {
  await bindLan(false);
}

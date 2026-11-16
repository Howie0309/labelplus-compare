// 自动获取 Cookie：用专用 Chrome 资料目录（labelplus/.chrome-profile）登录一次 labelplus，
// 之后从这个资料目录读取 Cookie。过期时先无头打开一次页面，让 UUAP 单点登录自动续期；续不上再请用户重新登录。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import * as lp from './labelplus.mjs';

const PROFILE = process.env.LABELPLUS_PROFILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.chrome-profile');
const ORIGIN = new URL(lp.BASE).origin;
const LOGIN_TIMEOUT = 10 * 60 * 1000;
export const state = { status: 'idle', error: null, at: null, debug: null }; // idle | waiting | done | failed
let session = null; // 正在打开的登录窗口（资料目录同一时间只能被一个 Chrome 使用）
let refreshing = null;

// 登录后要打开的页面：有评估链接就打开对应评估页，否则打开 labelplus 首页
const target = (link) => {
  const l = lp.parseLink(link);
  return l ? `${ORIGIN}/labelplus/task/chat/query/${l.chatId}/${l.evaluationId}/0/132` : `${ORIGIN}/labelplus/`;
};
const HOST = new URL(lp.BASE).hostname;
const onSite = (page) => new URL(page.url() || 'about:blank', 'about:blank').hostname === HOST;
// 取能发给接口域名的全部 Cookie（含父域如 .baidu-int.com 下的 UUAP 票据），不按 path / secure 过滤
async function readCookie(ctx) {
  const list = (await ctx.cookies()).filter((c) => {
    const d = c.domain.replace(/^\./, '');
    return HOST === d || HOST.endsWith(`.${d}`);
  });
  return list.map((c) => `${c.name}=${c.value}`).join('; ');
}
const launch = (headless) => chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless, viewport: headless ? { width: 1280, height: 800 } : null });

// verify(cookie)：可用则正常返回，过期抛 CookieError。把最近一次检查情况记到 state.debug，方便排查
async function grab(ctx, page, verify) {
  const url = page.url();
  const cookie = await readCookie(ctx);
  state.debug = { url: url.slice(0, 200), cookies: cookie ? cookie.split('; ').map((p) => p.split('=')[0]) : [], check: '' };
  if (!onSite(page) || !cookie) return null;
  try {
    await verify(cookie);
    return cookie;
  } catch (e) {
    state.debug.check = e.message;
    if (e instanceof lp.CookieError) return null;
    throw e;
  }
}

// 打开可见的登录窗口，轮询到可用 Cookie 后保存并关闭窗口
export async function openLogin({ link, verify, save }) {
  if (session) {
    await session.page.bringToFront().catch(() => {});
    return state;
  }
  Object.assign(state, { status: 'waiting', error: null, at: new Date().toISOString(), debug: null });
  let ctx;
  try {
    ctx = await launch(process.env.LABELPLUS_LOGIN_HEADLESS === '1');
  } catch (e) {
    Object.assign(state, { status: 'failed', error: `无法打开 Chrome：${e.message}` });
    return state;
  }
  const page = ctx.pages()[0] || (await ctx.newPage());
  session = { ctx, page };
  ctx.on('close', () => {
    session = null;
    if (state.status === 'waiting') Object.assign(state, { status: 'failed', error: '登录窗口已关闭，还没拿到 Cookie' });
  });
  page.goto(target(link), { timeout: 60000 }).catch(() => {});
  (async () => {
    const end = Date.now() + LOGIN_TIMEOUT;
    while (session?.ctx === ctx && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = ctx.pages().find(onSite) || page;
      const cookie = await grab(ctx, p, verify).catch((e) => ((state.debug = { ...(state.debug || {}), check: `检查失败：${e.cause?.code || e.message}` }), null));
      if (cookie) {
        save(cookie);
        // 先关窗口再报告完成：资料目录被占用时，紧接着的续期会启动失败
        session = null;
        await ctx.close().catch(() => {});
        Object.assign(state, { status: 'done', error: null, at: new Date().toISOString() });
        return;
      }
    }
    if (session?.ctx === ctx) {
      Object.assign(state, { status: 'failed', error: '等待登录超时（10 分钟）' });
      await ctx.close().catch(() => {});
    }
  })();
  return state;
}

// 无头续期：成功返回新 Cookie，失败返回 null（例如从没登录过、UUAP 会话也过期了、登录窗口正开着）
export function silentRefresh({ link, verify }) {
  if (session) return Promise.resolve(null);
  refreshing ??= (async () => {
    let ctx;
    try {
      ctx = await launch(true).catch(async () => {
        await new Promise((r) => setTimeout(r, 1500)); // 上一个 Chrome 可能还没完全退出
        return launch(true);
      });
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(target(link), { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(3000); // 等单点登录的跳转走完
      return await grab(ctx, page, verify);
    } catch {
      return null;
    } finally {
      await ctx?.close().catch(() => {});
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function shutdown() {
  await session?.ctx.close().catch(() => {});
}

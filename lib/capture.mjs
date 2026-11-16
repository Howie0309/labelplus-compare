// 截图：顺着 next_chat_id 拉取 chat 列表（enumerate），再用本机 Chrome（无头）渲染各环境答案页，按轮裁剪。
// 多个环境时每轮再拼一张左右对比图。Cookie 失效时整体暂停，更新 Cookie 后自动继续。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import * as lp from './labelplus.mjs';
import * as store from './store.mjs';

export const VIEWPORT = { width: 430, height: 932 };
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const queue = []; // [{ batchId, chatId }]
export const state = { running: false, paused: false, pauseReason: '', active: 0 };
let getConfig = () => ({});
let refreshCookie = async () => false;
let browser = null;
let context = null;
let idleTimer = null;
const enumerating = new Set();

// refresh：Cookie 失效时调用，返回 true 表示已自动换上新 Cookie
export function init(configGetter, { refresh } = {}) {
  getConfig = configGetter;
  if (refresh) refreshCookie = refresh;
}

export const pending = (batchId) => queue.filter((q) => !batchId || q.batchId === batchId).length;
export const shotName = (chatId, envId, turn) => `c${chatId}_e${envId}_t${turn}.png`;
export const compareName = (chatId, turn) => `c${chatId}_t${turn}_cmp.png`;

function pause(reason) {
  state.paused = true;
  state.pauseReason = reason;
}

// Cookie 失效：先暂停，再尝试自动续期；续上了就接着跑，续不上保持暂停等用户登录
let refreshing = false;
function cookieExpired(reason) {
  pause(reason);
  if (refreshing) return;
  refreshing = true;
  state.pauseReason = `${reason}，正在自动续期…`;
  refreshCookie()
    .then((ok) => (ok ? resume() : (state.pauseReason = `${reason}，自动续期失败，请点「登录获取」`)))
    .catch(() => (state.pauseReason = reason))
    .finally(() => (refreshing = false));
}

// 更新 Cookie 或手动点「继续」后：恢复截图队列，并把因 Cookie 暂停的拉取接着跑
export function resume() {
  state.paused = false;
  state.pauseReason = '';
  for (const b of store.all()) if (b.enum?.status === 'paused' && b.enum.cookie) startEnumerate(b.id);
  pump();
}

// ---------- 拉取 chat 列表 ----------
// enum.remaining：本次还要新增多少段对话（null=一直取到链尾）；已在批次里的对话直接跳过，不占名额
export function startEnumerate(batchId) {
  const b = store.get(batchId);
  if (!b || enumerating.has(batchId) || !b.enum.next) return;
  if (b.enum.remaining === undefined) b.enum.remaining = b.source.limit ? Math.max(0, b.source.limit - b.enum.count) : null; // 旧批次
  if (b.enum.remaining === 0) return;
  b.enum = { ...b.enum, status: 'running', error: null, cookie: false };
  store.save(b);
  enumerating.add(batchId);
  enumerate(b).finally(() => enumerating.delete(batchId));
}

// 补充截图：从指定对话（默认接着上次的位置）再往后取 more 段，more=0 表示取到链尾
export function extend(batchId, { chatId, more }) {
  const b = store.get(batchId);
  if (!b) throw new Error('批次不存在');
  if (enumerating.has(batchId)) throw new Error('正在拉取中，请先停止拉取或等它完成');
  const next = chatId || b.enum.next;
  if (!next) throw new Error('已经取到最后一条了；要补其它对话，请粘贴那一条的链接');
  b.enum = { ...b.enum, next, remaining: more > 0 ? more : null };
  store.save(b);
  startEnumerate(batchId);
}

async function enumerate(b) {
  const { evaluationId, envIds } = b.source;
  const seen = new Set(); // 本次经过的对话，用于发现链表成环
  let fails = 0;
  while (store.get(b.id) === b && b.enum.status === 'running' && b.enum.next && b.enum.remaining !== 0) {
    const cid = b.enum.next;
    if (seen.has(cid)) {
      b.enum.next = null;
      break;
    }
    seen.add(cid);
    try {
      const exist = b.chats.find((c) => c.chatId === cid);
      if (exist) {
        // 已截过：跳过，只取它的下一条（旧批次没存 next，查一次接口）
        exist.next ??= (await lp.baseInfo(getConfig().cookie, cid, evaluationId)).next_chat_id || null;
        b.enum.next = exist.next;
        store.save(b);
        continue;
      }
      const info = await lp.chatInfo(getConfig().cookie, cid, evaluationId);
      fails = 0;
      if (envIds?.length) info.pages = info.pages.filter((p) => envIds.includes(p.envId));
      store.addChat(b, info);
      b.enum.count++;
      if (b.enum.remaining) b.enum.remaining--;
      b.enum.total = info.total;
      b.enum.next = info.next;
      store.save(b);
      enqueue(b.id, [info.chatId]);
    } catch (e) {
      seen.delete(cid);
      if (e instanceof lp.CookieError) {
        b.enum = { ...b.enum, status: 'paused', error: e.message, cookie: true };
        store.save(b);
        cookieExpired(e.message);
        return;
      }
      if (++fails > 2) {
        b.enum = { ...b.enum, status: 'failed', error: e.message };
        store.save(b);
        return;
      }
      await sleep(2000 * fails);
    }
  }
  if (store.get(b.id) === b && b.enum.status === 'running') {
    b.enum = { ...b.enum, status: 'done', error: null };
    store.save(b);
  }
}

export function stopEnumerate(batchId) {
  const b = store.get(batchId);
  if (b?.enum.status === 'running') {
    b.enum = { ...b.enum, status: 'paused', error: '已手动停止拉取' };
    store.save(b);
  }
}

// ---------- 截图队列 ----------
export function enqueue(batchId, chatIds) {
  const b = store.get(batchId);
  if (!b) throw new Error('批次不存在');
  let n = 0;
  for (const c of b.chats) {
    if (!chatIds.includes(c.chatId) || ['queued', 'shooting'].includes(c.status)) continue;
    c.status = 'queued';
    c.tries = 0;
    c.error = null;
    for (const it of store.chatItems(b, c.chatId)) {
      it.status = 'queued';
      it.error = null;
    }
    queue.push({ batchId, chatId: c.chatId });
    n++;
  }
  if (n) b.summary = null;
  store.save(b);
  pump();
  return n;
}

export function cancel(batchId, chatIds) {
  const hit = (q) => q.batchId === batchId && (!chatIds || chatIds.includes(q.chatId));
  for (let i = queue.length - 1; i >= 0; i--) if (hit(queue[i])) queue.splice(i, 1);
  const b = store.get(batchId);
  if (!b) return;
  for (const c of b.chats) {
    if (c.status !== 'queued' || (chatIds && !chatIds.includes(c.chatId))) continue;
    c.status = c.shotAt ? 'done' : 'pending';
    for (const it of store.chatItems(b, c.chatId)) it.status = it.shotAt ? 'done' : 'pending';
  }
  store.save(b);
}

async function ensureBrowser() {
  clearTimeout(idleTimer);
  if (context) return context;
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    // 答案页会从 http 静态资源域加载组件，不放行会被当混合内容拦掉，渲染成无样式纯文本
    args: ['--allow-running-insecure-content', '--disable-web-security', '--ignore-certificate-errors'],
  });
  context = await browser.newContext({ viewport: VIEWPORT, userAgent: MOBILE_UA, deviceScaleFactor: 2, ignoreHTTPSErrors: true });
  return context;
}

// 空闲 1 分钟后关闭无头 Chrome，下次有任务再启动
function scheduleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (state.active || queue.length) return;
    const b = browser;
    browser = context = null;
    await b?.close().catch(() => {});
  }, 60000);
}

function pump() {
  const limit = Math.max(1, Number(getConfig().captureConcurrency || 3));
  while (!state.paused && state.active < limit && queue.length) {
    const task = queue.shift();
    state.active++;
    state.running = true;
    runOne(task).finally(() => {
      state.active--;
      state.running = state.active > 0;
      if (!state.active && !queue.length) scheduleClose();
      pump();
    });
  }
}

async function runOne(task) {
  const b = store.get(task.batchId);
  const chat = b?.chats.find((c) => c.chatId === task.chatId);
  if (!chat || chat.status !== 'queued') return;
  const items = store.chatItems(b, chat.chatId);
  chat.status = 'shooting';
  chat.tries++;
  for (const it of items) it.status = 'shooting';
  store.save(b);
  const cfg = getConfig();
  let page;
  try {
    const ctx = await ensureBrowser();
    await ctx.clearCookies();
    await ctx.addCookies(lp.browserCookies(cfg.cookie || ''));
    page = await ctx.newPage();
    const dir = store.batchDir(b.id);
    const shots = {}; // turn -> { envId: file }
    for (const p of chat.pages) {
      await prepare(page, lp.pageUrl(b.source.evaluationId, p));
      const rects = await page.evaluate(RECT_JS, !!b.source.trim);
      if (!rects.length) {
        await lp.baseInfo(cfg.cookie, chat.chatId, b.source.evaluationId); // Cookie 失效会在这里抛 CookieError
        throw new Error(`${p.envName} 页面里没找到对话内容（可能尚未抓取完成）`);
      }
      for (const [i, clip] of rects.entries()) {
        const file = shotName(chat.chatId, p.envId, i + 1);
        await page.screenshot({ path: path.join(dir, file), fullPage: true, clip });
        (shots[i + 1] ??= {})[p.envId] = file;
      }
    }
    if (chat.pages.length > 1) await composeAll(page, b, chat, items, shots);
    if (store.get(b.id) !== b) return;
    const at = new Date().toISOString();
    Object.assign(chat, { status: 'done', error: null, shotAt: at });
    for (const it of items) {
      const s = shots[it.turn] || {};
      const missing = chat.pages.filter((p) => !s[p.envId]).map((p) => p.envName);
      Object.assign(it, {
        status: Object.keys(s).length ? 'done' : 'failed',
        error: missing.length ? `${missing.join('、')} 没有第 ${it.turn} 轮` : null,
        shots: s,
        compare: chat.pages.length > 1 && fs.existsSync(path.join(dir, compareName(chat.chatId, it.turn))) ? compareName(chat.chatId, it.turn) : null,
        shotAt: at,
        eval: null, // 截图变了，旧评估与人工标注不再适用
        envEvals: {},
        manual: { gsb: null, pref: null, rating: null, note: '' },
      });
    }
  } catch (e) {
    if (store.get(b.id) !== b) return;
    if (e instanceof lp.CookieError) {
      // 不计入重试次数，放回队首，等更新 Cookie 后继续
      chat.status = 'queued';
      chat.tries--;
      queue.unshift(task);
      cookieExpired(e.message);
    } else if (chat.tries <= Number(cfg.captureRetries ?? 2)) {
      chat.status = 'queued';
      chat.error = `第 ${chat.tries} 次失败，稍后自动重试：${e.message}`;
      queue.push(task);
    } else {
      chat.status = 'failed';
      chat.error = e.message;
    }
    for (const it of items) Object.assign(it, { status: chat.status === 'failed' ? 'failed' : 'queued', error: chat.error || e.message });
  } finally {
    await page?.close().catch(() => {});
    if (store.get(b.id) === b) store.save(b);
  }
}

// 渲染前改造页面：等组件加载、触发懒加载、去掉固定浮层、放开内层滚动容器
export async function prepare(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(4000); // genui 组件 JS 走 http 静态资源域，等它渲染完
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    document.querySelectorAll('.vc-switch, .vc-mask, .vc-panel, #__vconsole').forEach((e) => e.remove());
    // 全屏遮罩、底部输入栏、「有新内容」提示等固定元素在长图里会重复盖住内容
    [...document.querySelectorAll('*')].forEach((el) => {
      const pos = getComputedStyle(el).position;
      if ((pos === 'fixed' || pos === 'sticky') && !el.closest('.chat-qa-container')) el.remove();
    });
    // 对话区是 overflow:hidden + 固定高度的内层容器，文档只有一屏高；放开祖先链才能一次截全
    let el = document.querySelector('.chat-qa-container');
    while (el && el !== document.documentElement) {
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('overflow', 'visible', 'important');
      el = el.parentElement;
    }
    document.documentElement.style.setProperty('height', 'auto', 'important');
    document.body.style.setProperty('height', 'auto', 'important');
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1500);
}

// 每轮一个 .chat-qa-container；trim 时以最后一块 .ai-entry-block 为正文底边，裁掉工具栏、推荐问题、评估角标
export const RECT_JS = (trim) => {
  if (trim) document.querySelectorAll('[class*="_eval-trigger-wrap"]').forEach((el) => el.remove());
  return [...document.querySelectorAll('.chat-qa-container')]
    .map((qa) => {
      const r = qa.getBoundingClientRect();
      let bottom = r.bottom;
      if (trim) {
        let blocks = [...qa.querySelectorAll('.ai-entry-block')];
        if (!blocks.length) blocks = [...qa.querySelectorAll('[class*="answer-container"]')];
        if (blocks.length) bottom = Math.max(...blocks.map((b) => b.getBoundingClientRect().bottom));
      }
      return { x: 0, y: Math.round(r.top + window.scrollY), width: Math.round(r.width), height: Math.round(bottom - r.top) };
    })
    .filter((r) => r.width > 0 && r.height > 0);
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COMPOSE_CSS = `body{margin:0;background:#fff;font:14px/1.5 -apple-system,"PingFang SC",sans-serif;color:#1f2937}
.hd{padding:14px 16px 10px;border-bottom:1px solid #e5e7eb}.hd .m{color:#6b7280;font-size:12px}.hd .q{font-size:16px;font-weight:600;margin-top:2px}
.row{display:flex;gap:12px;padding:12px;align-items:flex-start}.col{width:430px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
.col .n{padding:6px 10px;background:#f3f4f6;font-weight:600;font-size:13px}.col img{width:430px;display:block}.col .no{padding:40px 10px;text-align:center;color:#9ca3af}`;

// 同一轮各环境左右拼成一张：顶部 chat / 轮次 / 问题，每栏标环境名
export async function composeAll(page, b, chat, items, shots) {
  const n = chat.pages.length;
  await page.setViewportSize({ width: 430 * n + 12 * (n + 1) + 2 * n, height: 600 });
  const dir = store.batchDir(b.id);
  for (const it of items) {
    const s = shots[it.turn];
    if (!s) continue;
    const cols = chat.pages.map((p) => {
      const f = s[p.envId] && path.join(dir, s[p.envId]);
      const body = f ? `<img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}">` : '<div class="no">无截图</div>';
      return `<div class="col"><div class="n">${esc(p.envName)}</div>${body}</div>`;
    });
    await page.setContent(
      `<style>${COMPOSE_CSS}</style><div class="hd"><div class="m">chat ${chat.chatId} · 第 ${it.turn} 轮</div><div class="q">${esc(it.query)}</div></div><div class="row">${cols.join('')}</div>`,
      { waitUntil: 'load' },
    );
    await page.screenshot({ path: path.join(dir, compareName(chat.chatId, it.turn)), fullPage: true });
  }
  await page.setViewportSize(VIEWPORT);
}

export async function shutdown() {
  await browser?.close().catch(() => {});
}

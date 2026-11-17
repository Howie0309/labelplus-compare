// 本地网页服务：labelplus 评估页批量截图（多环境逐轮）、对比评估（单条/批量）、整体分析、Excel / JSONL 导出
// 启动：npm start，然后浏览器打开 http://127.0.0.1:3230
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lp from './lib/labelplus.mjs';
import * as login from './lib/login.mjs';
import * as share from './lib/share.mjs';
import * as store from './lib/store.mjs';
import { GSB, gsbPref } from './lib/store.mjs';
import * as capture from './lib/capture.mjs';
import * as evaluate from './lib/evaluate.mjs';
import { exportBatch, exportJsonl } from './lib/excel.mjs';
import { DEFAULT_COMPARE_PROMPT, DEFAULT_SINGLE_PROMPT, DEFAULT_SUMMARY_PROMPT, DEFAULT_FIELDS, DEFAULT_LABELS, EFFORTS, chat, fieldsOf, normalizeEval } from './lib/vlm.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3230);
const HOST = '127.0.0.1'; // 只监听本机：服务无鉴权，且配置里有 API Key 和 Cookie
const CONFIG_FILE = process.env.LABELPLUS_CONFIG || path.join(ROOT, 'config.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };
const CHROME = '/Applications/Google Chrome.app';

// ---------- 配置 ----------
const CONFIG_KEYS = ['baseUrl', 'model', 'reasoningEffort', 'judgePrompt', 'singlePrompt', 'summaryPrompt', 'cacheControl', 'captureConcurrency', 'captureRetries', 'evalConcurrency', 'evalRetries',
  'field_gsb', 'field_preference', 'field_summary', 'field_dimensions', 'fieldLabels'];
const FIELD_KEYS = CONFIG_KEYS.filter((k) => k.startsWith('field'));
const DEFAULTS = { captureConcurrency: 3, captureRetries: 2, evalConcurrency: 3, evalRetries: 2, reasoningEffort: 'auto' };

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return { baseUrl: '', apiKey: '', model: '', cookie: '', ...DEFAULTS };
  }
}
const writeConfig = (cfg) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
const mask = (k) => (k ? `${k.slice(0, 4)}****${k.slice(-4)}` : '');

function publicConfig(cfg) {
  return {
    ...Object.fromEntries(CONFIG_KEYS.map((key) => [key, cfg[key] ?? ''])),
    cacheControl: !!cfg.cacheControl,
    defaultComparePrompt: DEFAULT_COMPARE_PROMPT,
    defaultSinglePrompt: DEFAULT_SINGLE_PROMPT,
    defaultSummaryPrompt: DEFAULT_SUMMARY_PROMPT,
    defaultFields: DEFAULT_FIELDS,
    defaultLabels: DEFAULT_LABELS,
    hasKey: !!cfg.apiKey,
    keyMask: mask(cfg.apiKey),
    hasCookie: !!cfg.cookie,
    cookieMask: cfg.cookie ? `${cfg.cookie.slice(0, 24)}…（${cfg.cookie.length} 字符）` : '',
    cookieSavedAt: cfg.cookieSavedAt || null,
  };
}

store.load();
// 已有评估按当前的字段映射与显示名重新解析、排版；只用保存的模型原文，不重新调用模型。启动时和改了字段设置后各跑一次
function rerenderEvals() {
  const fields = fieldsOf(loadConfig());
  let n = 0;
  for (const b of store.all()) {
    let changed = false;
    const names = (e) => (e.envs || b.envs.map((x) => x.id)).map((id) => b.envs.find((x) => x.id === id)?.name || String(id));
    for (const it of b.items) {
      for (const e of [it.eval, ...Object.values(it.envEvals || {})]) {
        if (e?.status !== 'done' || !e.raw) continue;
        const r = normalizeEval(e.raw, names(e), fields);
        const next = { kind: r.kind, text: r.text, dims: r.dims, scores: r.scores, pref: r.pref, gsb: r.gsb, score: r.score, data: r.data ?? null };
        if (Object.entries(next).some(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(e[k] ?? null))) {
          Object.assign(e, next);
          changed = true;
          n++;
        }
      }
    }
    if (changed) store.save(b);
  }
  return n;
}
rerenderEvals();
evaluate.init(loadConfig);

// ---------- Cookie：手动粘贴，或用专用 Chrome 登录后自动读取 / 过期自动续期 ----------
const saveCookie = (cookie) => writeConfig({ ...loadConfig(), cookie, cookieSavedAt: new Date().toISOString() });
const recentLink = () => store.all()[0]?.source.link || '';
// 接口返回 JSON 即视为已登录（chat 不存在之类的业务错误不算 Cookie 问题）
async function verifyCookie(cookie, link) {
  const l = lp.parseLink(link) || { chatId: 0, evaluationId: 0 };
  try {
    await lp.baseInfo(cookie, l.chatId, l.evaluationId);
  } catch (e) {
    if (e instanceof lp.CookieError) throw e;
  }
}
async function refreshCookie() {
  const link = recentLink();
  const cookie = await login.silentRefresh({ link, verify: (c) => verifyCookie(c, link) });
  if (!cookie) return false;
  saveCookie(cookie);
  return true;
}
capture.init(loadConfig, { refresh: refreshCookie });

function shareView() {
  const s = loadConfig().share || {};
  return { enabled: !!s.enabled, urls: s.enabled && s.token ? share.urls(PORT, s.token) : [], online: share.online() };
}

// ---------- 视图数据 ----------
function counts(b) {
  const c = { total: b.items.length, chats: b.chats.length, done: 0, failed: 0, queued: 0, pending: 0, evaluated: 0, rated: 0 };
  for (const it of b.items) {
    if (it.status === 'done') c.done++;
    else if (it.status === 'failed') c.failed++;
    else if (['queued', 'shooting'].includes(it.status)) c.queued++;
    else c.pending++;
    if (it.eval?.status === 'done') c.evaluated++;
    if (Object.values(it.envEvals || {}).some((e) => e?.status === 'done')) c.envEvaluated = (c.envEvaluated || 0) + 1;
    if (it.manual?.pref || it.manual?.rating) c.rated++;
  }
  return c;
}

const brief = (b) => ({
  id: b.id, name: b.name, createdAt: b.createdAt, envs: b.envs, evaluationId: b.source.evaluationId,
  counts: counts(b), enumStatus: b.enum.status, summaryStatus: b.summary?.status || null,
});

function tokenStats(b) {
  const s = { prompt: 0, cached: 0, completion: 0, calls: 0 };
  for (const u of [...b.items.flatMap((i) => [i.eval, ...Object.values(i.envEvals || {})]), b.summary]) {
    if (!u?.usage) continue;
    s.calls++;
    s.prompt += u.usage.prompt_tokens || u.usage.input_tokens || 0;
    s.completion += u.usage.completion_tokens || u.usage.output_tokens || 0;
    s.cached += u.cachedTokens || 0;
  }
  return s;
}

function full(b) {
  const v = (it) => `?v=${encodeURIComponent(it.shotAt || '')}`;
  return {
    ...b,
    chats: undefined,
    counts: counts(b),
    tokens: tokenStats(b),
    evalPending: evaluate.pending(b.id),
    capturePending: capture.pending(b.id),
    items: b.items.map((it) => ({
      ...it,
      images: Object.fromEntries(Object.entries(it.shots || {}).map(([env, f]) => [env, store.imageUrl(b.id, f) + v(it)])),
      compareImage: it.compare ? store.imageUrl(b.id, it.compare) + v(it) : null,
      chatError: b.chats.find((c) => c.chatId === it.chatId)?.error || null,
    })),
  };
}

function mustBatch(id) {
  const b = store.get(id);
  if (!b) throw Object.assign(new Error('批次不存在'), { code: 404 });
  return b;
}

// 按 ids 或范围选条目：failed / unfinished（未成功）/ all
function pickIds(b, body) {
  if (Array.isArray(body.ids) && body.ids.length) return body.ids.map(Number);
  const f = { failed: (it) => it.status === 'failed', unfinished: (it) => it.status !== 'done', all: () => true }[body.scope];
  if (!f) throw new Error('请先选择条目');
  return b.items.filter(f).map((it) => it.id);
}
// 截图以 chat 为单位：选中某一轮即重截它所在的整段对话
const pickChats = (b, body) => [...new Set(pickIds(b, body).map((id) => b.items.find((i) => i.id === id)?.chatId).filter(Boolean))];

function parseSource(body) {
  const link = lp.parseLink(body.link);
  if (!link) throw new Error('链接里没找到 /labelplus/task/chat/query/<chat_id>/<evaluation_id>');
  return link;
}
// ---------- 路由 ----------
const routes = [
  ['GET', '/api/config', () => publicConfig(loadConfig())],
  ['POST', '/api/config', ({ body }) => {
    const cfg = loadConfig();
    const fieldsBefore = JSON.stringify(FIELD_KEYS.map((k) => cfg[k] ?? ''));
    for (const k of CONFIG_KEYS) if (k in body) cfg[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
    const num = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) && v !== '' ? Math.round(Number(v)) : d));
    cfg.captureConcurrency = num(cfg.captureConcurrency, 1, 6, DEFAULTS.captureConcurrency);
    cfg.captureRetries = num(cfg.captureRetries, 0, 5, DEFAULTS.captureRetries);
    cfg.evalConcurrency = num(cfg.evalConcurrency, 1, 8, DEFAULTS.evalConcurrency);
    cfg.evalRetries = num(cfg.evalRetries, 0, 5, DEFAULTS.evalRetries);
    cfg.reasoningEffort = EFFORTS.includes(cfg.reasoningEffort) ? cfg.reasoningEffort : 'auto';
    cfg.cacheControl = !!cfg.cacheControl;
    if (body.apiKey) cfg.apiKey = body.apiKey.trim(); // 留空表示保留原 Key
    writeConfig(cfg);
    // 字段映射或显示名改了：已有评估按新设置重新排版
    const rerendered = fieldsBefore !== JSON.stringify(FIELD_KEYS.map((k) => cfg[k] ?? '')) ? rerenderEvals() : 0;
    return { ...publicConfig(cfg), rerendered };
  }],
  ['POST', '/api/config/test', async () => {
    const { text } = await chat(loadConfig(), [{ role: 'user', content: '请只回复：ok' }]);
    return { reply: text.slice(0, 100) };
  }],
  // 保存 Cookie（可粘贴整段 cURL）；给了链接就顺便验证一次。保存后自动继续因 Cookie 暂停的任务
  ['POST', '/api/cookie', async ({ body }) => {
    const cookie = lp.extractCookie(body.cookie);
    if (!cookie.includes('=')) throw new Error('没认出 Cookie，请粘贴整段 Cookie 或「Copy as cURL」的命令');
    const link = body.link && lp.parseLink(body.link);
    if (link) await lp.baseInfo(cookie, link.chatId, link.evaluationId);
    saveCookie(cookie);
    capture.resume();
    return { ok: true, verified: !!link };
  }],
  // 打开专用 Chrome 窗口登录 labelplus，登录成功后自动保存 Cookie 并关闭窗口
  ['POST', '/api/cookie/login', async ({ body }) => {
    const link = body.link || recentLink();
    return login.openLogin({
      link,
      verify: (c) => verifyCookie(c, link),
      save: (c) => {
        saveCookie(c);
        capture.resume();
      },
    });
  }],
  // 不弹窗口，用上次登录留下的单点登录会话续期
  ['POST', '/api/cookie/refresh', async () => {
    if (!(await refreshCookie())) throw new Error('自动续期失败，请点「登录获取」重新登录');
    capture.resume();
    return { ok: true };
  }],
  ['GET', '/api/status', ({ role }) => ({
    labelplus: true,
    role,
    chrome: process.platform !== 'darwin' || fs.existsSync(CHROME),
    cookie: !!loadConfig().cookie,
    login: login.state,
    share: { enabled: !!loadConfig().share?.enabled, online: share.online() },
    display: fieldsOf(loadConfig()), // 字段映射与显示名，前端据此按字段分块渲染
    capture: { ...capture.state, queue: capture.pending() },
  })],
  ['POST', '/api/capture/resume', () => (capture.resume(), { ok: true })],
  ['POST', '/api/parse', async ({ body }) => {
    const { chatId, evaluationId } = parseSource(body);
    const info = await lp.chatInfo(loadConfig().cookie, chatId, evaluationId);
    return {
      chatId, evaluationId, pos: info.pos, total: info.total, turns: info.turns,
      envs: info.pages.map((p) => ({ id: p.envId, name: p.envName })),
      batches: store.all().filter((b) => b.source.evaluationId === evaluationId).map(brief),
    };
  }],

  ['GET', '/api/batches', () => store.all().map(brief)],
  ['POST', '/api/batches', async ({ body }) => {
    const src = parseSource(body);
    const { evaluationId } = src;
    // fromFirst：不从链接这一条，而是从评估的第 1 条开始（与 labelplus 里看到的顺序一致）
    const chatId = body.fromFirst ? await lp.firstChat(loadConfig().cookie, src.chatId, evaluationId) : src.chatId;
    const info = await lp.chatInfo(loadConfig().cookie, chatId, evaluationId); // 顺便校验 Cookie
    const all = info.pages.map((p) => ({ id: p.envId, name: p.envName }));
    // 环境顺序即对比顺序：第一个是 A（通常为基线），第二个是 B
    const order = (Array.isArray(body.envIds) ? body.envIds.map(Number) : []).filter((id) => all.some((e) => e.id === id));
    const envs = order.length ? order.map((id) => all.find((e) => e.id === id)) : all;
    if (!envs.length) throw new Error('这条 chat 没有可截图的环境');
    const limit = Math.max(0, Math.round(Number(body.limit) || 0));
    const b = store.create({
      name: String(body.name || '').trim(),
      source: { link: String(body.link).trim(), evaluationId, startChatId: chatId, limit, envIds: envs.map((e) => e.id), trim: body.trim !== false },
      envs,
    });
    capture.startEnumerate(b.id);
    return brief(b);
  }],
  ['GET', '/api/batches/:id', ({ id }) => full(mustBatch(id))],
  ['PATCH', '/api/batches/:id', ({ id, body }) => {
    const b = mustBatch(id);
    if (body.name) b.name = String(body.name).trim();
    store.save(b);
    return brief(b);
  }],
  ['DELETE', '/api/batches/:id', ({ id }) => {
    mustBatch(id);
    capture.stopEnumerate(id);
    capture.cancel(id);
    evaluate.cancel(id);
    store.remove(id);
    return { ok: true };
  }],
  ['POST', '/api/batches/:id/enumerate', ({ id }) => (capture.startEnumerate(mustBatch(id).id), { ok: true })],
  ['POST', '/api/batches/:id/enumerate/stop', ({ id }) => (capture.stopEnumerate(mustBatch(id).id), { ok: true })],
  // 补充截图：给了链接就从那一条开始，否则接着上次的位置；more=0 取到最后。已截过的对话自动跳过
  ['POST', '/api/batches/:id/extend', async ({ id, body }) => {
    const b = mustBatch(id);
    let chatId = null;
    if (String(body.link || '').trim()) {
      const l = parseSource(body);
      if (l.evaluationId !== b.source.evaluationId) throw new Error(`这条链接属于 evaluation ${l.evaluationId}，和本批次（${b.source.evaluationId}）不是同一个评估，请新建批次`);
      chatId = l.chatId;
    }
    if (body.fromFirst) chatId = await lp.firstChat(loadConfig().cookie, chatId || b.source.startChatId, b.source.evaluationId);
    capture.extend(b.id, { chatId, more: Math.max(0, Math.round(Number(body.more) || 0)) });
    return brief(b);
  }],
  ['PATCH', '/api/batches/:id/items/:itemId', ({ id, itemId, body, user }) => {
    const b = mustBatch(id);
    const it = b.items.find((x) => x.id === Number(itemId));
    if (!it) throw new Error('条目不存在');
    if (body.manual) {
      const m = body.manual;
      // 多环境人工打分：gsb 为 B 相对 A 的五档分数（-1 A 明显更好 … 1 B 明显更好），pref 由它推出，供筛选与胜率统计
      const gsb = 'gsb' in m ? (GSB.includes(Number(m.gsb)) && m.gsb !== null && m.gsb !== '' ? Number(m.gsb) : null) : it.manual?.gsb ?? null;
      // 多人协作：同一条后改的覆盖先改的，记下最后修改人和时间
      it.manual = {
        gsb,
        pref: 'gsb' in m ? gsbPref(gsb) : 'pref' in m ? (['A', 'B', 'C', 'D', 'same'].includes(m.pref) ? m.pref : null) : it.manual?.pref ?? null,
        rating: 'rating' in m ? (['good', 'ok', 'bad'].includes(m.rating) ? m.rating : null) : it.manual?.rating ?? null,
        note: 'note' in m ? String(m.note ?? '') : it.manual?.note ?? '',
        by: user,
        at: new Date().toISOString(),
      };
      b.summary = null;
    }
    store.upd(it);
    store.save(b);
    return { ok: true, manual: it.manual };
  }],
  // 轻量同步：只返回 since 之后改过的人工标注，协作时每几秒拉一次，不用整批重新下载
  // 增量刷新：只返回 since 之后变过的条目 + 批次级状态，页面不用每次重下整批
  ['GET', '/api/batches/:id/updates', ({ id, query }) => {
    const b = mustBatch(id);
    const since = query.get('since') || '';
    const v = (it) => `?v=${encodeURIComponent(it.shotAt || '')}`;
    return {
      now: new Date().toISOString(),
      counts: counts(b), enum: b.enum, summary: b.summary,
      evalPending: evaluate.pending(b.id), capturePending: capture.pending(b.id),
      items: b.items.filter((i) => (i.upd || '') > since).map((it) => ({
        ...it,
        images: Object.fromEntries(Object.entries(it.shots || {}).map(([env, f]) => [env, store.imageUrl(b.id, f) + v(it)])),
        compareImage: it.compare ? store.imageUrl(b.id, it.compare) + v(it) : null,
        chatError: b.chats.find((c) => c.chatId === it.chatId)?.error || null,
      })),
    };
  }],
  ['GET', '/api/batches/:id/manual', ({ id, query }) => {
    const b = mustBatch(id);
    const since = query.get('since') || '';
    return { now: new Date().toISOString(), items: b.items.filter((i) => i.manual?.at && i.manual.at > since).map((i) => ({ id: i.id, manual: i.manual })) };
  }],
  ['GET', '/api/share', () => shareView()],
  ['POST', '/api/share', async ({ body }) => {
    const cfg = loadConfig();
    const cur = cfg.share || {};
    cfg.share = { enabled: !!body.enabled, token: body.regenerate || !cur.token ? share.newToken() : cur.token };
    writeConfig(cfg);
    const ips = await applyShare();
    if (cfg.share.enabled && !ips.length) throw new Error('没有找到可用的局域网地址，请确认电脑已连上公司网络');
    return shareView();
  }],
  ['POST', '/api/batches/:id/capture', ({ id, body }) => ({ queued: capture.enqueue(id, pickChats(mustBatch(id), body)) })],
  ['POST', '/api/batches/:id/capture/cancel', ({ id }) => (capture.cancel(id), { ok: true })],
  ['POST', '/api/batches/:id/eval', ({ id, body }) => {
    // envId 为空 = 多环境对比评估；给了 envId = 只评这个环境（单环境打分，结果另存，不覆盖对比评估）
    const envId = body.envId == null || body.envId === '' ? null : Number(body.envId);
    return { queued: evaluate.enqueue(id, pickIds(mustBatch(id), body), envId) };
  }],
  ['POST', '/api/batches/:id/eval/cancel', ({ id }) => (evaluate.cancel(id), { ok: true })],
  ['POST', '/api/batches/:id/summary', async ({ id, body }) => ({ count: await evaluate.runSummary(id, pickIds(mustBatch(id), body)) })],
];

// ---------- HTTP ----------
function send(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5 * 1024 * 1024) throw new Error('请求体过大');
  }
  return raw ? JSON.parse(raw) : {};
}

function serveFile(res, abs) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(abs).pipe(res);
}

function match(method, pathname) {
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    const hit = pathname.match(re);
    if (hit) return { handler, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(hit[i + 1])])) };
  }
  return null;
}

// 协作者（局域网访问）能用的接口：查看、人工标注、导出、看谁在线。其余（设置、Cookie、建批次、截图、模型评估、删除）只有发起人能用
const GUEST_OK = [
  ['GET', /^\/api\/status$/], ['GET', /^\/api\/batches$/], ['GET', /^\/api\/batches\/[^/]+$/], ['GET', /^\/api\/batches\/[^/]+\/manual$/],
  ['PATCH', /^\/api\/batches\/[^/]+\/items\/\d+$/], ['GET', /^\/api\/batches\/[^/]+\/export(\.jsonl)?$/],
];
const guestAllowed = (method, pathname) =>
  (method === 'GET' && (pathname === '/' || pathname === '/app.js' || pathname.startsWith('/batches/'))) || GUEST_OK.some(([m, re]) => m === method && re.test(pathname));

const handler = (role) => async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const pathname = url.pathname;
  try {
    if (role === 'guest') {
      const token = loadConfig().share?.token || '';
      const q = url.searchParams.get('token');
      // 打开分享链接：校验口令后写入 Cookie，再跳回干净的地址（避免口令留在地址栏里被转发）
      if (q && share.sameToken(q, token)) {
        res.writeHead(302, { 'Set-Cookie': `${share.COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, Location: '/' });
        return res.end();
      }
      if (!loadConfig().share?.enabled || !share.sameToken(share.cookieToken(req), token)) {
        if (pathname === '/') return res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }), res.end('<p style="font:15px sans-serif;padding:40px">需要发起人给的分享链接才能打开（链接可能已失效或协作已关闭）。</p>');
        return send(res, 401, { error: '需要分享链接' });
      }
      if (!guestAllowed(req.method, pathname)) return send(res, 403, { error: '只有发起人可以做这个操作' });
    }
    let user = '';
    try {
      user = decodeURIComponent(req.headers['x-labeler'] || '').trim().slice(0, 30);
    } catch {}
    share.touch(user, role, Number(req.headers['x-viewing']) || null);
    const ctx = { role, user: user || (role === 'owner' ? '发起人' : '协作者') };
    // 导出：直接返回文件
    const exp = pathname.match(/^\/api\/batches\/([^/]+)\/export(\.jsonl)?$/);
    if (req.method === 'GET' && exp) {
      const b = mustBatch(decodeURIComponent(exp[1]));
      const ids = url.searchParams.get('ids')?.split(',').filter(Boolean).map(Number);
      const name = encodeURIComponent(b.name);
      if (exp[2]) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${name}.jsonl` });
        return res.end(exportJsonl(b, ids?.length ? ids : null));
      }
      const fields = url.searchParams.has('fields') ? new Set((url.searchParams.get('fields') || '').split(',').filter(Boolean)) : null;
      const buf = await exportBatch(b, ids?.length ? ids : null, fields, { quality: url.searchParams.get('quality') === 'preview' ? 'preview' : 'full' });
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${name}.xlsx`,
      });
      return res.end(Buffer.from(buf));
    }
    const m = match(req.method, pathname);
    if (m) {
      const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, await m.handler({ ...m.params, body, query: url.searchParams, ...ctx }));
    }
    if (req.method === 'GET' && pathname === '/') return serveFile(res, path.join(ROOT, 'public', 'index.html'));
    if (req.method === 'GET' && pathname === '/app.js') return serveFile(res, path.join(ROOT, 'public', 'app.js'));
    if (req.method === 'GET' && pathname.startsWith('/batches/')) {
      const abs = path.resolve(store.BATCH_ROOT, '.' + decodeURIComponent(pathname).slice('/batches'.length));
      if (!abs.startsWith(store.BATCH_ROOT + path.sep) || abs.endsWith('.json')) return send(res, 403, { error: 'forbidden' });
      return serveFile(res, abs);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.code === 404 ? 404 : 400, { error: e.message, cookie: e instanceof lp.CookieError || undefined });
  }
};

const server = http.createServer(handler('owner')).listen(PORT, HOST, () => console.log(`已启动：http://${HOST}:${PORT}`));
// 上次开着协作的话，启动时恢复局域网监听
const applyShare = () => share.bindLan(!!loadConfig().share?.enabled, PORT, handler('guest'));
applyShare().then((ips) => ips.length && console.log(`局域网协作已开启：${ips.join('、')}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  server.close();
  await share.closeAll();
  await capture.shutdown();
  await login.shutdown();
  process.exit(0);
});

// 重启前没拉完的批次（enum.status 为 paused）需要用户点「继续拉取」，未截图的条目在界面上点「截取未完成」

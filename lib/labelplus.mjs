// labelplus 接口：登录态（Cookie）解析、评估链接解析、三个取数接口
//   POST /query/base_info  {query_id: chat_id, evaluation_id} → 各轮 query、cur_pos/total、next_chat_id
//   POST /query/env_info   {query_id: 某轮 query_id, evaluation_id} → 各环境 env_id/env_name、crawl_status、page_key
//   GET  /task/pageKey?page_key=&evaluation_id=&state= → 该环境整页渲染 HTML（一页含全部轮次）
export const BASE = process.env.LABELPLUS_BASE || 'http://ab.baidu-int.com/labelplusapi';

export class CookieError extends Error {}

// 接受原始 Cookie 串，或 DevTools「Copy as cURL」的整段命令
export function extractCookie(text) {
  const t = String(text || '').trim();
  const pats = [/-b \$?'([^']*)'/, /-b "([^"]*)"/, /--cookie \$?'([^']*)'/, /-H \$?'[Cc]ookie: ([^']*)'/, /-H "[Cc]ookie: ([^"]*)"/];
  for (const p of pats) {
    const m = t.match(p);
    if (m) return m[1].trim();
  }
  if (/^curl\s/i.test(t)) return '';
  return t.replace(/^cookie:\s*/i, '').trim();
}

// 评估页链接：/labelplus/task/chat/query/<chat_id>/<evaluation_id>[/0/<131|132>]
// 末段 131 = PC 网页版，132 = 手机版（WISE）；页面对 UA 和视口宽度敏感，两种必须分别截图
export function parseLink(text) {
  const t = String(text || '');
  const m = t.match(/\/labelplus\/task\/(?:chat\/)?query\/(\d+)\/(\d+)/);
  if (!m) return null;
  const tail = t.slice(m.index + m[0].length).match(/^\/(?:\d+)\/(\d+)/);
  const code = tail ? tail[1] : '';
  return { chatId: Number(m[1]), evaluationId: Number(m[2]), device: code === '131' ? 'pc' : code === '132' ? 'mobile' : null };
}

const headers = (cookie) => ({
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  Referer: `${new URL(BASE).origin}/labelplus/task/chat/query/0/0/0/132`,
  Cookie: cookie,
});

async function post(cookie, path, body) {
  if (!cookie) throw new CookieError('还没有 Cookie，请在「设置」里粘贴');
  const res = await fetch(BASE + path, { method: 'POST', headers: headers(cookie), body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
  if ([301, 302, 401, 403].includes(res.status)) throw new CookieError('Cookie 已过期，请在「设置」里重新粘贴');
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // 登录态失效时可能返回 UUAP 登录页 HTML；其它纯文本（如 chat 不存在时的 "record not found"）是业务错误
    if (/^\s*</.test(raw)) throw new CookieError('Cookie 已过期，请重新登录获取');
    throw new Error(`${path} 返回：${raw.slice(0, 200)}`);
  }
  if (needLogin(data)) throw new CookieError('Cookie 已过期或未登录，请重新登录获取');
  if (!res.ok || data?.data == null) throw new Error(`${path} 返回异常：${raw.slice(0, 200)}`);
  return data.data;
}

// 未登录时接口返回 200 + {status:"401", message:"请登录！", data:"https://uuap…"}
const needLogin = (d) => String(d?.status) === '401' || String(d?.code) === '401' || /请登录|未登录/.test(String(d?.message ?? d?.msg ?? ''));

export const baseInfo = (cookie, chatId, evaluationId) => post(cookie, '/query/base_info', { query_id: chatId, evaluation_id: evaluationId });

// 顺着 pre_chat_id 往前走到评估的第 1 条（cur_pos=1），返回它的 chat_id
export async function firstChat(cookie, chatId, evaluationId) {
  let cid = chatId;
  const seen = new Set();
  for (;;) {
    const d = await baseInfo(cookie, cid, evaluationId);
    if (Number(d.cur_pos) <= 1 || !d.pre_chat_id || seen.has(d.pre_chat_id)) return cid;
    seen.add(cid);
    cid = d.pre_chat_id;
  }
}
export const envInfo = (cookie, queryId, evaluationId) => post(cookie, '/query/env_info', { query_id: queryId, evaluation_id: evaluationId });

// 一个 chat 的完整信息：各轮问题 + 各环境渲染页（page_key 按 (evaluation, env) 粒度，同环境多轮共用一页）
export async function chatInfo(cookie, chatId, evaluationId) {
  const base = await baseInfo(cookie, chatId, evaluationId);
  const turns = (base.query_info || []).map((q) => String(q.query ?? ''));
  if (!turns.length) throw new Error(`chat ${chatId} 没有 query`);
  const envs = await envInfo(cookie, base.query_info[0].query_id, evaluationId);
  const seen = new Set();
  const pages = [];
  for (const e of envs || []) {
    const key = e.page_info?.page_key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pages.push({ envId: e.env_info.env_id, envName: String(e.env_info.env_name || `env${e.env_info.env_id}`), pageKey: key, state: e.crawl_info?.crawl_status ?? '' });
  }
  return { chatId, pos: base.cur_pos, total: base.total, next: base.next_chat_id || null, turns, pages };
}

export const pageUrl = (evaluationId, p) =>
  `${BASE}/task/pageKey?${new URLSearchParams({ page_key: p.pageKey, evaluation_id: String(evaluationId), state: String(p.state) })}`;

// Playwright 需要的 cookie 列表
export function browserCookies(cookie) {
  const url = new URL(BASE).origin;
  return cookie
    .split(/;\s*/)
    .map((part) => {
      const i = part.indexOf('=');
      return i > 0 ? { name: part.slice(0, i).trim(), value: part.slice(i + 1), url } : null;
    })
    .filter(Boolean);
}

// VLM 调用：OpenAI 兼容接口（/chat/completions）。
// 逐条评估：system=固定 judge prompt（可缓存），user=问题/上文/各环境截图；整体分析只读逐条结果文本。
import fs from 'node:fs';
import sharp from 'sharp';
import { DEFAULT_COMPARE_PROMPT, DEFAULT_SINGLE_PROMPT, DEFAULT_SUMMARY_PROMPT } from './prompts.mjs';

export { DEFAULT_COMPARE_PROMPT, DEFAULT_SINGLE_PROMPT, DEFAULT_SUMMARY_PROMPT };
export const LETTERS = ['A', 'B', 'C', 'D'];
const MAX_TILES = 8; // 单个环境最多发几段，避免超长回答撑爆请求
const MAX_PREV_TILES = 3; // 上一轮回答只用于判断承接与重复，少发几段
export const GSB = [-1, -0.5, 0, 0.5, 1];

// 把长图切成若干段 JPEG，避免整张长图被模型压缩到看不清
async function tiles(file, maxTiles = MAX_TILES) {
  const src = fs.readFileSync(file);
  const { width, height } = await sharp(src).metadata();
  const step = Math.round(width * 1.8);
  const out = [];
  for (let top = 0; top < height && out.length < maxTiles; top += step) {
    const buf = await sharp(src)
      .extract({ left: 0, top, width, height: Math.min(step, height - top) })
      .resize({ width: Math.min(width, 1100) })
      .jpeg({ quality: 80 })
      .toBuffer();
    out.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
  }
  return { urls: out, truncated: height > step * maxTiles };
}

const systemMsg = (text, cacheControl) =>
  cacheControl
    ? { role: 'system', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }
    : { role: 'system', content: text };

export function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const mean10 = (xs) => {
  const s = xs.filter((x) => x >= 1 && x <= 5);
  return s.length ? Math.round((s.reduce((a, x) => a + x, 0) / s.length) * 2 * 10) / 10 : null;
};
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');

// ---------- 评估结果的字段映射与通用渲染 ----------
// 只有这几个字段参与统计（GSB、偏好、结论、维度），字段名可在设置里改；其余字段按模型输出的顺序原样展示
export const DEFAULT_FIELDS = { gsb: 'gsb', preference: 'preference', summary: 'summary', dimensions: 'dimensions' };
export const DEFAULT_LABELS = 'intent=意图\nsummary=结论\npreference=偏好\ngsb=GSB\na_issues=A 的问题\nb_issues=B 的问题\nissues=问题\nstrengths=亮点\ndimensions=维度明细\nname=维度\nreason=理由\nscore=分数';

// 设置里的字段映射 / 显示名（「字段名=显示名」每行一个）
export function fieldsOf(cfg = {}) {
  const map = Object.fromEntries(Object.entries(DEFAULT_FIELDS).map(([k, d]) => [k, String(cfg[`field_${k}`] || '').trim() || d]));
  const labels = {};
  for (const line of `${DEFAULT_LABELS}\n${cfg.fieldLabels || ''}`.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) labels[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { map, labels };
}

const fmtGsb = (g) => `${g > 0 ? '+' : ''}${g}`;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v) => (v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// 任意 JSON 值转 Markdown：文字→段落，字符串数组→列表，对象数组→表格，对象→「键：值」列表
function renderValue(label, v, colName) {
  if (Array.isArray(v)) {
    if (!v.length) return [`**${label}**：无`];
    if (v.every(isObj)) {
      const cols = [...new Set(v.flatMap((o) => Object.keys(o)))];
      return [`**${label}**`, `| ${cols.map((c) => cell(colName(c))).join(' | ')} |`, `|${cols.map(() => '---|').join('')}`, ...v.map((o) => `| ${cols.map((c) => cell(scalar(o[c]))).join(' | ')} |`)];
    }
    return [`**${label}**`, ...v.map((x) => `- ${scalar(x)}`)];
  }
  if (isObj(v)) return [`**${label}**`, ...Object.entries(v).map(([k, x]) => `- ${colName(k)}：${scalar(x)}`)];
  return [`**${label}**：${scalar(v)}`];
}

// 规整模型输出：kind=compare（多环境对比）/ score（单环境按维度打分）/ json（其它结构）/ raw（不是 JSON）
export function normalizeEval(rawText, envNames, fields = fieldsOf()) {
  const j = parseJson(rawText);
  const letters = LETTERS.slice(0, envNames.length);
  if (!isObj(j)) {
    const m = String(rawText).match(/总分\s*[:：]\s*(\d+(?:\.\d+)?)/);
    return { kind: 'raw', text: rawText, dims: null, scores: null, pref: null, gsb: null, score: m ? Number(m[1]) : null };
  }
  const { map, labels } = fields;
  const multi = envNames.length > 1;
  // 维度表头：a/b → 「A 线上」，其余用显示名
  const colName = (c) => {
    const l = letters.find((x) => x.toLowerCase() === String(c).toLowerCase());
    return l && multi ? `${l} ${envNames[letters.indexOf(l)]}` : labels[c] || c;
  };
  const labelOf = (k) => {
    const m = String(k).match(/^([a-d])_(.+)$/i); // a_issues → 「A 的问题」之类，环境名一起带上
    if (multi && m && letters.includes(m[1].toUpperCase()) && !labels[k]) return `${m[1].toUpperCase()}（${envNames[letters.indexOf(m[1].toUpperCase())]}）${labels[m[2]] || m[2]}`;
    return labels[k] || k;
  };

  // 统计用字段：两个环境时以五档 gsb（B 相对 A）为准，偏好由其符号推出；gsb 缺失或越界时退回偏好字段
  const g = j[map.gsb] === null || j[map.gsb] === '' ? NaN : Number(j[map.gsb]);
  const gsb = letters.length === 2 && GSB.includes(g) ? g : null;
  const p = String(j[map.preference] ?? '').trim().toUpperCase();
  const pref = !multi ? null : gsb !== null ? (gsb < 0 ? 'A' : gsb > 0 ? 'B' : 'same') : letters.includes(p) ? p : /^(SAME|S|TIE|EQUAL|持平|相当)$/.test(p) ? 'same' : null;
  const rawDims = Array.isArray(j[map.dimensions]) ? j[map.dimensions].filter((d) => isObj(d) && d.name) : [];
  const compareDims = multi && rawDims.some((d) => letters.some((l) => l.toLowerCase() in d));
  const dims = rawDims.length
    ? rawDims.map((d) => compareDims
      ? { name: String(d.name), ...Object.fromEntries(letters.map((l) => [l, Number(d[l.toLowerCase()]) || null])), reason: String(d.reason ?? '') }
      : { name: String(d.name), score: Number(d.score) || null, reason: String(d.reason ?? '') })
    : null;
  // 单环境给一个 10 分制总分：模型输出了 total 就用它，否则按维度均分 ×2；对比评估不再自动算总分，以 GSB 为准
  const score = multi ? null : typeof j.total === 'number' ? j.total : dims ? mean10(dims.map((d) => d.score)) : null;

  // 展示：GSB / 偏好、结论放最前，其余字段按模型输出顺序
  const lines = [];
  if (multi && (gsb !== null || pref)) {
    const degree = gsb === null ? '更好' : Math.abs(gsb) === 1 ? '明显更好' : '略好';
    const who = pref === 'same' ? '持平' : pref ? `${pref}（${envNames[letters.indexOf(pref)]}）${degree}` : '';
    lines.push(`**偏好**：${gsb !== null ? `${fmtGsb(gsb)}，` : ''}${who}`);
  }
  if (j[map.summary] !== undefined) lines.push('', ...renderValue(labelOf(map.summary), j[map.summary], colName));
  const skip = new Set([map.gsb, map.preference, map.summary].filter((k) => multi || k === map.summary));
  for (const [k, v] of Object.entries(j)) {
    if (skip.has(k)) continue;
    lines.push('', ...renderValue(labelOf(k), v, colName));
  }
  return { kind: multi && (gsb !== null || pref || compareDims) ? 'compare' : dims ? 'score' : 'json', text: lines.join('\n').trim(), dims, scores: null, pref, gsb, score };
}

function cacheStats(usage) {
  if (!usage) return { cachedTokens: 0, cacheWriteTokens: 0 };
  const cached = usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || usage.claude_cache_read_tokens || 0;
  const write = usage.cache_creation_input_tokens || (usage.claude_cache_creation_5_m_tokens || 0) + (usage.claude_cache_creation_1_h_tokens || 0) || 0;
  return { cachedTokens: cached, cacheWriteTokens: write };
}

// 对比用 judgePrompt，单环境用 singlePrompt；各自留空时用对应的默认 Prompt
export const judgePrompt = (cfg, envCount) => (envCount > 1 ? cfg.judgePrompt || DEFAULT_COMPARE_PROMPT : cfg.singlePrompt || DEFAULT_SINGLE_PROMPT);

// shots: [{ name, file }]，按环境顺序依次标为 A、B…；prevShots 与 shots 一一对应，是同一环境上一轮的截图（没有则为 null）
// 发给模型的标签只用字母，不带环境名，避免模型看出哪边是线上、哪边是新策略
export async function evaluateItem(cfg, { query, context, shots, prevShots = [] }) {
  const content = [];
  let intro = `用户问题：${query}`;
  if (context?.length) intro = `之前几轮的问题（上文）：\n${context.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n本轮${intro}`;
  content.push({ type: 'text', text: intro });
  if (shots.length > 1 && prevShots.some(Boolean)) {
    content.push({ type: 'text', text: `以下是上一轮（第 ${context?.length} 轮）各环境的回答截图，只用于判断本轮是否正确承接上文、是否重复上一轮内容，不对上一轮本身打分。` });
    for (const [i, f] of prevShots.entries()) {
      if (!f) {
        content.push({ type: 'text', text: `环境 ${LETTERS[i]} 没有上一轮截图。` });
        continue;
      }
      const t = await tiles(f, MAX_PREV_TILES);
      content.push({ type: 'text', text: `环境 ${LETTERS[i]} 上一轮的回答截图，共 ${t.urls.length} 段${t.truncated ? '（只给出了前面部分）' : ''}：` });
      content.push(...t.urls.map((url) => ({ type: 'image_url', image_url: { url } })));
    }
    content.push({ type: 'text', text: '以下是本轮各环境的回答截图，请评估本轮。' });
  }
  for (const [i, s] of shots.entries()) {
    const t = await tiles(s.file);
    const label = shots.length > 1 ? `环境 ${LETTERS[i]}` : `回答（${s.name}）`;
    content.push({ type: 'text', text: `${label}的回答截图，共 ${t.urls.length} 段${t.truncated ? '（回答过长，只给出了前面部分，请仅评估可见内容）' : ''}：` });
    content.push(...t.urls.map((url) => ({ type: 'image_url', image_url: { url } })));
  }
  const r = await chat(cfg, [systemMsg(judgePrompt(cfg, shots.length), cfg.cacheControl), { role: 'user', content }]);
  return { raw: r.text, ...normalizeEval(r.text, shots.map((s) => s.name), fieldsOf(cfg)), usage: r.usage, ...cacheStats(r.usage) };
}

const PREF = { A: 'A 更好', B: 'B 更好', same: '持平' };
export const GSB_TEXT = { '-1': 'A 明显更好', '-0.5': 'A 略好', 0: '持平', 0.5: 'B 略好', 1: 'B 明显更好' };
const RATING = { good: '好', ok: '中', bad: '差' };

export async function summarize(cfg, { envs, items }) {
  const head = envs.length > 1 ? `对比环境：${envs.map((e, i) => `${LETTERS[i]}=${e.name}`).join('，')}` : `评估环境：${envs[0]?.name || ''}`;
  const blocks = items.map((it) => {
    const lines = [`### ${it.id}. ${it.query}${it.turn > 1 ? `（第 ${it.turn} 轮）` : ''}`];
    if (typeof it.manual?.gsb === 'number') lines.push(`人工打分（B 相对 A，-1~1）：${it.manual.gsb}（${GSB_TEXT[it.manual.gsb]}）`);
    else if (it.manual?.pref) lines.push(`人工偏好：${PREF[it.manual.pref] || it.manual.pref}`);
    if (it.manual?.rating) lines.push(`人工评级：${RATING[it.manual.rating]}`);
    if (it.manual?.note) lines.push(`人工备注：${it.manual.note}`);
    if (typeof it.eval?.gsb === 'number') lines.push(`模型打分（B 相对 A，-1~1）：${it.eval.gsb}（${GSB_TEXT[it.eval.gsb]}）`);
    lines.push(it.eval?.text || '（无对比评估）');
    for (const [k, e] of envs.entries()) {
      const s = it.envEvals?.[e.id];
      if (s?.text) lines.push(`#### ${envs.length > 1 ? `${LETTERS[k]}（${e.name}）` : e.name} 单独评估${typeof s.score === 'number' ? `，总分 ${s.score}/10` : ''}`, s.text);
    }
    return lines.join('\n');
  });
  const user = { role: 'user', content: `${head}\n共 ${items.length} 条的逐条评估结果如下：\n\n${blocks.join('\n\n')}` };
  const r = await chat(cfg, [systemMsg(cfg.summaryPrompt || DEFAULT_SUMMARY_PROMPT, cfg.cacheControl), user]);
  return { ...r, ...cacheStats(r.usage) };
}

// 思考强度：auto=不加参数（跟随网关默认）；off=显式关闭；low/medium/high 发 reasoning_effort（与「自动评估」工具同一套网关写法）
export const EFFORTS = ['auto', 'off', 'low', 'medium', 'high'];
const effortBody = (e) => (!e || e === 'auto' ? {} : e === 'off' ? { thinking: { type: 'disabled' } } : { reasoning_effort: e });

export async function chat(cfg, messages) {
  const { baseUrl, apiKey, model } = cfg;
  if (!baseUrl || !apiKey || !model) throw new Error('请先在设置中填写 Base URL、API Key 和模型名');
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, ...effortBody(cfg.reasoningEffort) }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`VLM 接口返回 ${res.status}：${body.slice(0, 300)}`);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`VLM 接口返回非 JSON：${body.slice(0, 300)}`);
  }
  const out = data.choices?.[0]?.message?.content;
  if (!out) throw new Error(`VLM 返回内容为空：${body.slice(0, 300)}`);
  return { text: typeof out === 'string' ? out : JSON.stringify(out), usage: data.usage || null };
}

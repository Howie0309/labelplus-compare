// VLM 调用：OpenAI 兼容接口（/chat/completions）。
// 逐条评估：system=固定 judge prompt（可缓存），user=问题/上文/各环境截图；整体分析只读逐条结果文本。
import fs from 'node:fs';
import sharp from 'sharp';
import { DEFAULT_COMPARE_PROMPT, DEFAULT_SINGLE_PROMPT, DEFAULT_SUMMARY_PROMPT } from './prompts.mjs';

export { DEFAULT_COMPARE_PROMPT, DEFAULT_SINGLE_PROMPT, DEFAULT_SUMMARY_PROMPT };
export const LETTERS = ['A', 'B', 'C', 'D'];
const MAX_TILES = 8; // 单个环境最多发几段，避免超长回答撑爆请求

// 把长图切成若干段 JPEG，避免整张长图被模型压缩到看不清
async function tiles(file) {
  const src = fs.readFileSync(file);
  const { width, height } = await sharp(src).metadata();
  const step = Math.round(width * 1.8);
  const out = [];
  for (let top = 0; top < height && out.length < MAX_TILES; top += step) {
    const buf = await sharp(src)
      .extract({ left: 0, top, width, height: Math.min(step, height - top) })
      .resize({ width: Math.min(width, 1100) })
      .jpeg({ quality: 80 })
      .toBuffer();
    out.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
  }
  return { urls: out, truncated: height > step * MAX_TILES };
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
const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []);

// 规整模型输出：compare=多环境对比；score=单环境打分；raw=其它
export function normalizeEval(rawText, envNames) {
  const j = parseJson(rawText);
  const letters = LETTERS.slice(0, envNames.length);
  if (envNames.length > 1 && Array.isArray(j?.dimensions) && j.dimensions.some((d) => d && 'a' in d)) {
    const dims = j.dimensions
      .filter((d) => d?.name)
      .map((d) => ({ name: String(d.name), ...Object.fromEntries(letters.map((l) => [l, Number(d[l.toLowerCase()]) || null])), reason: String(d.reason || '') }));
    const scores = Object.fromEntries(letters.map((l) => [l, mean10(dims.map((d) => d[l]))]));
    const p = String(j.preference ?? '').trim().toUpperCase();
    const pref = letters.includes(p) ? p : /^(SAME|S|TIE|EQUAL|持平|相当)$/.test(p) ? 'same' : null;
    // 展示顺序固定为：结论 → 问题 → 意图与维度明细（与 Prompt 里 JSON 字段的顺序无关）
    const lines = [`**偏好**：${pref === 'same' ? '持平' : pref ? `${pref}（${envNames[letters.indexOf(pref)]}）更好` : '未给出'}`];
    if (j.summary) lines.push('', `**结论**：${j.summary}`);
    for (const l of letters) {
      const issues = list(j[`${l.toLowerCase()}_issues`]);
      if (issues.length) lines.push('', `**${l} 的问题**`, ...issues.map((s) => `- ${s}`));
    }
    if (j.intent) lines.push('', `**意图**：${j.intent}`);
    lines.push('', `| 维度 | ${letters.map((l, i) => `${l} ${cell(envNames[i])}`).join(' | ')} | 理由 |`, `|---|${letters.map(() => '---|').join('')}---|`);
    for (const d of dims) lines.push(`| ${cell(d.name)} | ${letters.map((l) => d[l] ?? '-').join(' | ')} | ${cell(d.reason)} |`);
    return { kind: 'compare', text: lines.join('\n'), dims, scores, pref, score: null };
  }
  if (Array.isArray(j?.dimensions)) {
    const dims = j.dimensions.filter((d) => d?.name).map((d) => ({ name: String(d.name), score: Number(d.score) || null, reason: String(d.reason || '') }));
    const lines = [];
    if (j.summary) lines.push(`**结论**：${j.summary}`, '');
    if (list(j.issues).length) lines.push('**问题**', ...list(j.issues).map((s) => `- ${s}`), '');
    if (list(j.strengths).length) lines.push('**亮点**', ...list(j.strengths).map((s) => `- ${s}`), '');
    if (j.intent) lines.push(`**意图**：${j.intent}`, '');
    lines.push('| 维度 | 分数 | 理由 |', '|---|---|---|', ...dims.map((d) => `| ${cell(d.name)} | ${d.score ?? '-'} | ${cell(d.reason)} |`));
    return { kind: 'score', text: lines.join('\n'), dims, scores: null, pref: null, score: mean10(dims.map((d) => d.score)) };
  }
  const m = String(rawText).match(/总分\s*[:：]\s*(\d+(?:\.\d+)?)/);
  return { kind: 'raw', text: rawText, dims: null, scores: null, pref: null, score: m ? Number(m[1]) : null };
}

function cacheStats(usage) {
  if (!usage) return { cachedTokens: 0, cacheWriteTokens: 0 };
  const cached = usage.prompt_tokens_details?.cached_tokens || usage.cache_read_input_tokens || usage.claude_cache_read_tokens || 0;
  const write = usage.cache_creation_input_tokens || (usage.claude_cache_creation_5_m_tokens || 0) + (usage.claude_cache_creation_1_h_tokens || 0) || 0;
  return { cachedTokens: cached, cacheWriteTokens: write };
}

export const judgePrompt = (cfg, envCount) => cfg.judgePrompt || (envCount > 1 ? DEFAULT_COMPARE_PROMPT : DEFAULT_SINGLE_PROMPT);

// shots: [{ name, file }]，按环境顺序依次标为 A、B…
export async function evaluateItem(cfg, { query, context, shots }) {
  const content = [];
  let intro = `用户问题：${query}`;
  if (context?.length) intro = `之前几轮的问题（上文）：\n${context.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n本轮${intro}`;
  content.push({ type: 'text', text: intro });
  for (const [i, s] of shots.entries()) {
    const t = await tiles(s.file);
    const label = shots.length > 1 ? `环境 ${LETTERS[i]}（${s.name}）` : `回答（${s.name}）`;
    content.push({ type: 'text', text: `${label}的回答截图，共 ${t.urls.length} 段${t.truncated ? '（回答过长，只给出了前面部分，请仅评估可见内容）' : ''}：` });
    content.push(...t.urls.map((url) => ({ type: 'image_url', image_url: { url } })));
  }
  const r = await chat(cfg, [systemMsg(judgePrompt(cfg, shots.length), cfg.cacheControl), { role: 'user', content }]);
  return { raw: r.text, ...normalizeEval(r.text, shots.map((s) => s.name)), usage: r.usage, ...cacheStats(r.usage) };
}

const PREF = { A: 'A 更好', B: 'B 更好', same: '持平' };
const RATING = { good: '好', ok: '中', bad: '差' };

export async function summarize(cfg, { envs, items }) {
  const head = envs.length > 1 ? `对比环境：${envs.map((e, i) => `${LETTERS[i]}=${e.name}`).join('，')}` : `评估环境：${envs[0]?.name || ''}`;
  const blocks = items.map((it) => {
    const lines = [`### ${it.id}. ${it.query}${it.turn > 1 ? `（第 ${it.turn} 轮）` : ''}`];
    if (it.manual?.pref) lines.push(`人工偏好：${PREF[it.manual.pref] || it.manual.pref}`);
    if (it.manual?.rating) lines.push(`人工评级：${RATING[it.manual.rating]}`);
    if (it.manual?.note) lines.push(`人工备注：${it.manual.note}`);
    lines.push(it.eval?.text || '（无模型评估）');
    return lines.join('\n');
  });
  const user = { role: 'user', content: `${head}\n共 ${items.length} 条的逐条评估结果如下：\n\n${blocks.join('\n\n')}` };
  const r = await chat(cfg, [systemMsg(cfg.summaryPrompt || DEFAULT_SUMMARY_PROMPT, cfg.cacheControl), user]);
  return { ...r, ...cacheStats(r.usage) };
}

export async function chat({ baseUrl, apiKey, model }, messages) {
  if (!baseUrl || !apiKey || !model) throw new Error('请先在设置中填写 Base URL、API Key 和模型名');
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages }),
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

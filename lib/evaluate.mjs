// 评估队列：逐条（每轮）VLM 对比评估按并发数执行；整体分析每个批次同时只跑一个
import path from 'node:path';
import * as store from './store.mjs';
import { evaluateItem, summarize } from './vlm.mjs';

const queue = []; // [{ batchId, itemId, evaluation }]
let active = 0;
let getConfig = () => ({});

export function init(configGetter) {
  getConfig = configGetter;
}

function assertConfig() {
  const c = getConfig();
  if (!c.baseUrl || !c.apiKey || !c.model) throw new Error('请先在设置中填写 VLM 的 Base URL、API Key 和模型名');
}

// 条目里实际有截图的环境，按批次环境顺序（第一个为 A）
export const itemShots = (b, it) =>
  b.envs.filter((e) => it.shots?.[e.id]).map((e) => ({ id: e.id, name: e.name, file: path.join(store.batchDir(b.id), it.shots[e.id]) }));

// 评估结果的存放位置：envId 为空 = 多环境对比（it.eval）；否则 = 该环境单独打分（it.envEvals[envId]），两者互不覆盖
const getSlot = (it, envId) => (envId == null ? it.eval : it.envEvals?.[envId]);
function setSlot(it, envId, v) {
  if (envId == null) it.eval = v;
  else {
    it.envEvals ??= {};
    if (v) it.envEvals[envId] = v;
    else delete it.envEvals[envId];
  }
}

export function enqueue(batchId, itemIds, envId = null) {
  assertConfig();
  const b = store.get(batchId);
  if (!b) throw new Error('批次不存在');
  if (envId != null && !b.envs.some((e) => e.id === envId)) throw new Error('本批次没有这个环境');
  let n = 0;
  for (const it of b.items) {
    if (!itemIds.includes(it.id) || it.status !== 'done' || (envId != null && !it.shots?.[envId])) continue;
    const old = getSlot(it, envId);
    if (['queued', 'running'].includes(old?.status)) continue;
    const evaluation = { ...(old || {}), status: 'queued', error: null, tries: 0 };
    setSlot(it, envId, evaluation);
    b.summary = null;
    queue.push({ batchId, itemId: it.id, envId, evaluation });
    n++;
  }
  store.save(b);
  pump();
  return n;
}

export function cancel(batchId) {
  const b = store.get(batchId);
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].batchId === batchId) queue.splice(i, 1);
  if (b) {
    const reset = (e) => (e?.status === 'queued' ? (e.text ? { ...e, status: 'done', error: null } : null) : e);
    for (const it of b.items) {
      it.eval = reset(it.eval);
      for (const k of Object.keys(it.envEvals || {})) setSlot(it, k, reset(it.envEvals[k]));
    }
    store.save(b);
  }
}

export const pending = (batchId) => queue.filter((q) => q.batchId === batchId).length;

function pump() {
  const limit = Math.max(1, Number(getConfig().evalConcurrency || 3));
  while (active < limit && queue.length) {
    const task = queue.shift();
    active++;
    runOne(task).finally(() => {
      active--;
      pump();
    });
  }
}

async function runOne({ batchId, itemId, envId = null, evaluation }) {
  const b = store.get(batchId);
  const it = b?.items.find((x) => x.id === itemId);
  if (!it || getSlot(it, envId) !== evaluation || it.status !== 'done' || evaluation.status !== 'queued') return;
  const current = () => store.get(batchId) === b && b.items.includes(it) && getSlot(it, envId) === evaluation && it.status === 'done';
  evaluation.status = 'running';
  evaluation.tries = (evaluation.tries || 0) + 1;
  evaluation.startedAt = new Date().toISOString(); // 页面据此显示「已等待 N 秒」
  store.save(b);
  const cfg = getConfig();
  const t0 = Date.now();
  try {
    const shots = itemShots(b, it).filter((s) => envId == null || s.id === envId);
    if (!shots.length) throw new Error('这一轮没有可评估的截图');
    // 同一对话上一轮、同一环境的截图，供模型判断承接与重复
    const prev = it.turn > 1 ? b.items.find((x) => x.chatId === it.chatId && x.turn === it.turn - 1) : null;
    const prevShots = shots.map((s) => (prev?.shots?.[s.id] ? path.join(store.batchDir(b.id), prev.shots[s.id]) : null));
    const r = await evaluateItem(cfg, { query: it.query, context: it.context, shots, prevShots });
    if (!current()) return;
    b.summary = null;
    setSlot(it, envId, {
      status: 'done', kind: r.kind, text: r.text, raw: r.raw, dims: r.dims, scores: r.scores, pref: r.pref, gsb: r.gsb, score: r.score, data: r.data ?? null,
      envs: shots.map((s) => s.id), usage: r.usage, cachedTokens: r.cachedTokens, cacheWriteTokens: r.cacheWriteTokens,
      model: cfg.model, effort: cfg.reasoningEffort || 'auto', sourceShotAt: it.shotAt, tries: evaluation.tries, durationMs: Date.now() - t0, at: new Date().toISOString(),
    });
  } catch (e) {
    if (!current()) return;
    if (evaluation.tries <= Number(cfg.evalRetries ?? 2)) {
      // 指数退避后重新排队：接口限流、超时等多为暂时性错误
      const delay = Math.min(30000, 2000 * 2 ** (evaluation.tries - 1));
      Object.assign(evaluation, { status: 'queued', error: `第 ${evaluation.tries} 次失败，${Math.round(delay / 1000)}s 后自动重试：${e.message}` });
      store.save(b);
      setTimeout(() => {
        if (current() && evaluation.status === 'queued') {
          queue.push({ batchId, itemId, envId, evaluation });
          pump();
        }
      }, delay);
      return;
    }
    b.summary = null;
    setSlot(it, envId, { ...evaluation, status: 'failed', error: e.message });
  }
  store.save(b);
}

const hasEnvEval = (it) => Object.values(it.envEvals || {}).some((e) => e?.text);

// 整体分析：基于所选条目的模型评估（对比与单环境）与人工标注，纯文本调用
export async function runSummary(batchId, itemIds) {
  assertConfig();
  const b = store.get(batchId);
  if (!b) throw new Error('批次不存在');
  if (b.summary?.status === 'running') throw new Error('整体分析进行中');
  const items = b.items.filter((it) => itemIds.includes(it.id) && (it.eval?.text || hasEnvEval(it) || it.manual?.pref || it.manual?.rating || it.manual?.note));
  if (!items.length) throw new Error('所选条目还没有评估结果或人工标注，请先逐条评估');
  const summary = { status: 'running', itemIds: items.map((i) => i.id), startedAt: new Date().toISOString() };
  b.summary = summary;
  store.save(b);
  const cfg = getConfig();
  summarize(cfg, { envs: b.envs, items })
    .then((r) => b.summary === summary && Object.assign(summary, { status: 'done', text: r.text, usage: r.usage, cachedTokens: r.cachedTokens, model: cfg.model, at: new Date().toISOString() }))
    .catch((e) => b.summary === summary && Object.assign(summary, { status: 'failed', error: e.message }))
    .finally(() => store.save(b));
  return items.length;
}

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

export function enqueue(batchId, itemIds) {
  assertConfig();
  const b = store.get(batchId);
  if (!b) throw new Error('批次不存在');
  let n = 0;
  for (const it of b.items) {
    if (!itemIds.includes(it.id) || it.status !== 'done' || ['queued', 'running'].includes(it.eval?.status)) continue;
    it.eval = { ...(it.eval || {}), status: 'queued', error: null, tries: 0 };
    b.summary = null;
    queue.push({ batchId, itemId: it.id, evaluation: it.eval });
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
    for (const it of b.items) if (it.eval?.status === 'queued') it.eval = it.eval.text ? { ...it.eval, status: 'done', error: null } : null;
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

async function runOne({ batchId, itemId, evaluation }) {
  const b = store.get(batchId);
  const it = b?.items.find((x) => x.id === itemId);
  if (!it || it.eval !== evaluation || it.status !== 'done' || evaluation.status !== 'queued') return;
  const current = () => store.get(batchId) === b && b.items.includes(it) && it.eval === evaluation && it.status === 'done';
  evaluation.status = 'running';
  evaluation.tries = (evaluation.tries || 0) + 1;
  store.save(b);
  const cfg = getConfig();
  try {
    const shots = itemShots(b, it);
    const r = await evaluateItem(cfg, { query: it.query, context: it.context, shots });
    if (!current()) return;
    b.summary = null;
    it.eval = {
      status: 'done', kind: r.kind, text: r.text, raw: r.raw, dims: r.dims, scores: r.scores, pref: r.pref, score: r.score,
      envs: shots.map((s) => s.id), usage: r.usage, cachedTokens: r.cachedTokens, cacheWriteTokens: r.cacheWriteTokens,
      model: cfg.model, sourceShotAt: it.shotAt, tries: evaluation.tries, at: new Date().toISOString(),
    };
  } catch (e) {
    if (!current()) return;
    if (evaluation.tries <= Number(cfg.evalRetries ?? 2)) {
      // 指数退避后重新排队：接口限流、超时等多为暂时性错误
      const delay = Math.min(30000, 2000 * 2 ** (evaluation.tries - 1));
      Object.assign(evaluation, { status: 'queued', error: `第 ${evaluation.tries} 次失败，${Math.round(delay / 1000)}s 后自动重试：${e.message}` });
      store.save(b);
      setTimeout(() => {
        if (current() && evaluation.status === 'queued') {
          queue.push({ batchId, itemId, evaluation });
          pump();
        }
      }, delay);
      return;
    }
    b.summary = null;
    it.eval = { ...evaluation, status: 'failed', error: e.message };
  }
  store.save(b);
}

// 整体分析：基于所选条目的模型评估与人工标注，纯文本调用
export async function runSummary(batchId, itemIds) {
  assertConfig();
  const b = store.get(batchId);
  if (!b) throw new Error('批次不存在');
  if (b.summary?.status === 'running') throw new Error('整体分析进行中');
  const items = b.items.filter((it) => itemIds.includes(it.id) && (it.eval?.text || it.manual?.pref || it.manual?.rating || it.manual?.note));
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

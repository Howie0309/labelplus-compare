// 批次存储：每个批次一个目录 batches/<id>/，内含 batch.json 与截图文件
// 截图按 chat 渲染（一页含全部轮次），评估与导出按「轮」——所以批次里同时有 chats（截图任务）与 items（每轮一条）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BATCH_ROOT = process.env.LABELPLUS_BATCHES || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'batches');
const cache = new Map();

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export const batchDir = (id) => path.join(BATCH_ROOT, id);
export const imageUrl = (id, file) => (file ? `/batches/${encodeURIComponent(id)}/${encodeURIComponent(file)}` : null);

// 人工 GSB 五档：B 相对 A，-1 A 明显更好 / -0.5 A 略好 / 0 持平 / 0.5 B 略好 / 1 B 明显更好
export const GSB = [-1, -0.5, 0, 0.5, 1];
export const gsbPref = (g) => (g == null ? null : g > 0 ? 'B' : g < 0 ? 'A' : 'same');
const OLD_PREF = { A: -1, same: 0, B: 1 }; // 旧版三档标注迁移成五档的两端与中间

export function load() {
  fs.mkdirSync(BATCH_ROOT, { recursive: true });
  for (const id of fs.readdirSync(BATCH_ROOT)) {
    const f = path.join(BATCH_ROOT, id, 'batch.json');
    if (!fs.existsSync(f)) continue;
    try {
      const b = JSON.parse(fs.readFileSync(f, 'utf8'));
      // 服务重启时把进行中的状态复位，避免卡死
      for (const c of b.chats) if (['queued', 'shooting'].includes(c.status)) c.status = 'pending';
      for (const it of b.items) {
        if (['queued', 'shooting'].includes(it.status)) it.status = 'pending';
        if (it.manual?.pref && it.manual.gsb === undefined && it.manual.pref in OLD_PREF) it.manual.gsb = OLD_PREF[it.manual.pref];
        if (['queued', 'running'].includes(it.eval?.status)) it.eval = { ...it.eval, status: 'failed', error: '服务重启中断' };
        for (const [k, e] of Object.entries(it.envEvals || {})) {
          if (['queued', 'running'].includes(e?.status)) it.envEvals[k] = { ...e, status: 'failed', error: '服务重启中断' };
        }
      }
      if (b.enum?.status === 'running') b.enum = { ...b.enum, status: 'paused', error: '服务重启中断，点「继续」接着拉取' };
      if (b.summary?.status === 'running') b.summary = { ...b.summary, status: 'failed', error: '服务重启中断' };
      cache.set(b.id, b);
    } catch {
      /* 跳过损坏文件 */
    }
  }
}

export function save(b) {
  if (cache.get(b.id) !== b) return; // 批次已被删除（后台任务晚到的写入直接丢弃）
  b.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(batchDir(b.id), 'batch.json'), JSON.stringify(b, null, 2));
}

export const get = (id) => cache.get(id);
export const all = () => [...cache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function create({ name, source, envs }) {
  let id = stamp();
  while (cache.has(id)) id += 'a';
  fs.mkdirSync(batchDir(id), { recursive: true });
  const b = {
    id,
    name: name || `评估 ${source.evaluationId} · ${id}`,
    createdAt: new Date().toISOString(),
    source,
    envs,
    enum: { status: 'running', next: source.startChatId, count: 0, remaining: source.limit || null, total: null, error: null },
    chats: [],
    items: [],
    summary: null,
  };
  cache.set(id, b);
  save(b);
  return b;
}

export function remove(id) {
  const dir = batchDir(id);
  if (!cache.has(id) || path.dirname(dir) !== BATCH_ROOT) throw new Error('批次不存在');
  fs.rmSync(dir, { recursive: true, force: true });
  cache.delete(id);
}

// 拉到一个 chat：登记截图任务，并按轮生成条目（第 N 轮附带前几轮问题作为上文）
export function addChat(b, info) {
  if (b.chats.some((c) => c.chatId === info.chatId)) return null;
  const chat = { chatId: info.chatId, pos: info.pos, next: info.next, status: 'pending', tries: 0, error: null, pages: info.pages, shotAt: null };
  b.chats.push(chat);
  let next = Math.max(0, ...b.items.map((i) => i.id)) + 1;
  info.turns.forEach((query, i) => {
    b.items.push({
      id: next++, chatId: info.chatId, pos: info.pos, turn: i + 1, query, context: info.turns.slice(0, i),
      status: 'pending', error: null, shots: {}, compare: null, shotAt: null, upd: new Date().toISOString(),
      manual: { gsb: null, pref: null, rating: null, note: '' }, eval: null, envEvals: {},
    });
  });
  return chat;
}

export const chatItems = (b, chatId) => b.items.filter((i) => i.chatId === chatId);

// 条目更新时间：页面增量刷新时只拉 upd 变过的条目，不用每次重下整批（6MB+）
export const upd = (it) => {
  it.upd = new Date().toISOString();
  return it;
};

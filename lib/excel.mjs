// 导出：Excel（每轮一行，各环境截图各占一列并锚定在本行单元格内，可直接上传「自动评估」做多模态 judge）与 JSONL（给脚本用）
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { batchDir } from './store.mjs';
import { LETTERS } from './vlm.mjs';

const STATUS = { pending: '未开始', queued: '排队中', shooting: '截图中', done: '成功', failed: '失败' };
const RATING = { good: '好', ok: '中', bad: '差' };
const ROW_PX = 540; // Excel 行高上限约 409pt ≈ 545px
const COL_PX = 200;
const MAX_EDGE = 8000; // 自动评估会把图片长边压到 8000 以内，这里先压好控制体积

export const EXPORT_FIELDS = [
  ['context', '上文（多轮时前几轮问题）'],
  ['status', '截图状态'],
  ['img', '各环境截图（嵌入图片）'],
  ['cmp', '左右拼图（嵌入图片）'],
  ['model', '模型偏好与总分'],
  ['dims', '各维度分数'],
  ['eval', '模型评估全文'],
  ['single', '单环境评估（各环境总分与全文）'],
  ['manual', '人工偏好 / 评级与备注'],
  ['file', '截图文件路径'],
  ['summary', '整体分析（单独工作表）'],
];

export const prefText = (pref, envs) => (pref === 'same' ? '持平' : pref ? `${pref}（${envs[LETTERS.indexOf(pref)]?.name || ''}）更好` : '');
// 五档人工打分转文字，带上环境名：-0.5 → 「A（线上）略好」
export const gsbText = (g, envs) => (g === 0 ? '持平' : `${g < 0 ? 'A' : 'B'}（${envs[g < 0 ? 0 : 1]?.name || ''}）${Math.abs(g) === 1 ? '明显更好' : '略好'}`);

async function embedImage(wb, ws, abs, col, rowIdx, quality) {
  const width = quality === 'full' ? 860 : 480;
  const buf = await sharp(abs).resize({ width, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
  const meta = await sharp(buf).metadata();
  const scale = Math.min(ROW_PX / meta.height, (COL_PX - 10) / meta.width);
  const imageId = wb.addImage({ buffer: buf, extension: 'jpeg' });
  // 锚点 0 基：col/row 落在本行本列单元格内，自动评估按左上角单元格把图片归到这一行
  ws.addImage(imageId, { tl: { col: col + 0.05, row: rowIdx + 0.02 }, ext: { width: meta.width * scale, height: meta.height * scale } });
  return meta.height * scale;
}

export async function exportBatch(b, itemIds, fields, { quality = 'full' } = {}) {
  const on = (k) => !fields || fields.has(k);
  const wb = new ExcelJS.Workbook();
  const items = b.items.filter((it) => !itemIds || itemIds.includes(it.id));
  const envs = b.envs;
  const multi = envs.length > 1;
  const dimNames = on('dims') ? [...new Set(items.flatMap((it) => it.eval?.dims?.map((d) => d.name) || []))] : [];
  // 单环境评估只在多环境批次里另存；有结果时才加列
  const singleCols = on('single') && multi && items.some((it) => Object.values(it.envEvals || {}).some((e) => e?.status === 'done'));
  const ws = wb.addWorksheet('对比评估');
  ws.columns = [
    { header: '序号', key: 'id', width: 6 },
    { header: 'chat_id', key: 'chat', width: 12 },
    { header: '轮次', key: 'turn', width: 6 },
    { header: 'query', key: 'query', width: 28 },
    ...(on('context') ? [{ header: '上文', key: 'context', width: 24 }] : []),
    ...(on('status') ? [{ header: '截图状态', key: 'status', width: 9 }] : []),
    ...(on('img') ? envs.map((e) => ({ header: `截图_${e.name}`, key: `img_${e.id}`, width: COL_PX / 7 })) : []),
    ...(on('cmp') && multi ? [{ header: '左右拼图', key: 'cmp', width: COL_PX / 7 }] : []),
    ...(on('model') && multi ? [{ header: '模型偏好', key: 'pref', width: 14 }] : []),
    ...(on('model') ? (multi ? envs.map((e, i) => ({ header: `${LETTERS[i]}总分(/10)_${e.name}`, key: `score_${i}`, width: 12 })) : [{ header: '模型总分(/10)', key: 'score', width: 11 }]) : []),
    ...dimNames.flatMap((n, k) => (multi ? envs.map((e, i) => ({ header: `${n}_${LETTERS[i]}`, key: `dim${k}_${i}`, width: 9 })) : [{ header: n, key: `dim${k}`, width: 9 }])),
    ...(on('eval') ? [{ header: '模型评估', key: 'eval', width: 60 }] : []),
    ...(singleCols ? envs.flatMap((e) => [{ header: `单评总分(/10)_${e.name}`, key: `ss_${e.id}`, width: 12 }, { header: `单评_${e.name}`, key: `st_${e.id}`, width: 50 }]) : []),
    ...(on('manual') ? [
      ...(multi ? [{ header: '人工打分(B相对A,-1~1)', key: 'gsb', width: 12 }] : []),
      { header: multi ? '人工偏好' : '人工评级', key: 'manual', width: 16 }, { header: '人工备注', key: 'note', width: 30 }] : []),
    ...(on('file') ? envs.map((e) => ({ header: `截图文件_${e.name}`, key: `file_${e.id}`, width: 30 })) : []),
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const colOf = (key) => ws.columns.findIndex((c) => c.key === key);

  for (const [i, it] of items.entries()) {
    const ev = it.eval?.status === 'done' ? it.eval : null;
    const evEnvIdx = (k) => (ev?.envs ? ev.envs.indexOf(envs[k].id) : k); // 评估时实际参与的环境顺序
    const values = {
      id: it.id, chat: String(it.chatId), turn: it.turn, query: it.query,
      ...(on('context') ? { context: (it.context || []).map((q, n) => `${n + 1}. ${q}`).join('\n') } : {}),
      ...(on('status') ? { status: STATUS[it.status] || it.status } : {}),
      ...(on('eval') ? { eval: ev?.text || it.eval?.error || '' } : {}),
    };
    if (on('model')) {
      if (multi) {
        values.pref = prefText(ev?.pref, envs.filter((e) => !ev?.envs || ev.envs.includes(e.id)));
        envs.forEach((_, k) => (values[`score_${k}`] = ev?.scores?.[LETTERS[evEnvIdx(k)]] ?? ''));
      } else values.score = ev?.score ?? '';
    }
    dimNames.forEach((n, k) => {
      const d = ev?.dims?.find((x) => x.name === n);
      if (multi) envs.forEach((_, e) => (values[`dim${k}_${e}`] = d?.[LETTERS[evEnvIdx(e)]] ?? ''));
      else values[`dim${k}`] = d?.score ?? '';
    });
    if (singleCols) for (const e of envs) {
      const s = it.envEvals?.[e.id];
      values[`ss_${e.id}`] = s?.status === 'done' ? s.score ?? '' : '';
      values[`st_${e.id}`] = s?.status === 'done' ? s.text : s?.error || '';
    }
    if (on('manual')) {
      const g = it.manual?.gsb;
      if (multi) values.gsb = typeof g === 'number' ? g : '';
      values.manual = multi ? (typeof g === 'number' ? gsbText(g, envs) : prefText(it.manual?.pref, envs)) : RATING[it.manual?.rating] || '';
      values.note = it.manual?.note || '';
    }
    if (on('file')) for (const e of envs) {
      const f = it.shots?.[e.id];
      values[`file_${e.id}`] = f ? { text: f, hyperlink: path.join(batchDir(b.id), f) } : '';
    }
    const row = ws.addRow(values);
    row.alignment = { vertical: 'top', wrapText: true };
    let tallest = 0;
    const imgs = [
      ...(on('img') ? envs.map((e) => [colOf(`img_${e.id}`), it.shots?.[e.id]]) : []),
      ...(on('cmp') && multi ? [[colOf('cmp'), it.compare]] : []),
    ];
    for (const [col, f] of imgs) {
      const abs = f && path.join(batchDir(b.id), f);
      if (col >= 0 && abs && fs.existsSync(abs)) tallest = Math.max(tallest, await embedImage(wb, ws, abs, col, i + 1, quality));
    }
    if (tallest) row.height = Math.min(409, tallest * 0.75 + 6);
  }

  if (on('summary') && b.summary?.text) {
    const s = wb.addWorksheet('整体分析');
    s.columns = [{ header: '整体分析', key: 't', width: 120 }];
    s.getRow(1).font = { bold: true };
    s.addRow({ t: `基于 ${b.summary.itemIds?.length || 0} 条，模型 ${b.summary.model || ''}，${b.summary.at ? new Date(b.summary.at).toLocaleString('zh-CN') : ''}` });
    for (const line of b.summary.text.split('\n')) s.addRow({ t: line });
  }
  return wb.xlsx.writeBuffer();
}

// 每轮一行 JSON，图片给本机绝对路径，方便脚本直接读图评估
export function exportJsonl(b, itemIds) {
  const dir = batchDir(b.id);
  return b.items
    .filter((it) => !itemIds || itemIds.includes(it.id))
    .map((it) => JSON.stringify({
      id: it.id, chat_id: it.chatId, turn: it.turn, query: it.query, context: it.context || [], status: it.status,
      envs: b.envs.map((e, i) => ({ letter: LETTERS[i], env_id: e.id, name: e.name, image: it.shots?.[e.id] ? path.join(dir, it.shots[e.id]) : null })),
      compare_image: it.compare ? path.join(dir, it.compare) : null,
      model: it.eval?.status === 'done' ? { pref: it.eval.pref, scores: it.eval.scores, score: it.eval.score, dims: it.eval.dims, text: it.eval.text, model: it.eval.model } : null,
      env_evals: Object.fromEntries(b.envs.filter((e) => it.envEvals?.[e.id]?.status === 'done').map((e) => {
        const s = it.envEvals[e.id];
        return [e.name, { env_id: e.id, score: s.score, dims: s.dims, text: s.text, model: s.model }];
      })),
      manual: it.manual,
    }))
    .join('\n') + '\n';
}

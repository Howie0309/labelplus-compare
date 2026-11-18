// 端到端冒烟：假 labelplus + 假 VLM → 解析链接 → 建批次（拉 2 段对话）→ 无头 Chrome 截图 → 单条评估 → 人工标注 → 导出 Excel / JSONL。
// 导出的 Excel 按图片锚点核对每轮截图是否归到对应行。需要本机装有 Google Chrome。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import * as fake from './fake-labelplus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lp = await fake.start();
const port = 32000 + Math.floor(Math.random() * 1000);
const cfgFile = path.join(os.tmpdir(), `labelplus-smoke-${port}.json`);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'labelplus-profile-'));
// 用临时批次目录，避免和正在运行的服务同时读写真实批次
const batches = fs.mkdtempSync(path.join(os.tmpdir(), 'labelplus-batches-'));
fs.writeFileSync(cfgFile, JSON.stringify({ baseUrl: `http://127.0.0.1:${lp.port}/v1`, apiKey: 'k', model: 'fake-vlm' }));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), LABELPLUS_BASE: `http://127.0.0.1:${lp.port}/labelplusapi`, LABELPLUS_CONFIG: cfgFile, LABELPLUS_PROFILE: profile, LABELPLUS_BATCHES: batches, LABELPLUS_LOGIN_HEADLESS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(d));
const base = `http://127.0.0.1:${port}`;
const call = async (method, url, body, status = 200) => {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  assert.equal(res.status, status, `${method} ${url} -> ${res.status} ${status === 200 ? await res.clone().text() : ''}`);
  return res;
};
const json = async (...a) => (await call(...a)).json();
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
let batchId;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('启动超时')), 10000);
    child.once('exit', (code) => reject(new Error(`服务退出 ${code}`)));
    child.stdout.on('data', (d) => String(d).includes('已启动') && (clearTimeout(timer), resolve()));
  });
  assert.match(await (await call('GET', '/')).text(), /labelplus 对比截图与评估/);

  // 没 Cookie 时解析会提示更新 Cookie
  const noCookie = await (await call('POST', '/api/parse', { link: lp.link }, 400)).json();
  assert.equal(noCookie.cookie, true);
  await call('POST', '/api/cookie', { cookie: 'not a cookie' }, 400);

  // 自动获取：专用 Chrome 打开登录页，登录完成后 Cookie 自动保存
  await json('POST', '/api/cookie/login', { link: lp.link });
  await until(async () => (await json('GET', '/api/status')).login.status === 'done', 30000, '自动登录');
  assert.equal((await json('POST', '/api/parse', { link: lp.link })).total, 3);
  // Cookie 失效后无头续期：复用专用资料目录里的登录会话
  await json('POST', '/api/cookie', { cookie: 'expired=1' });
  assert.equal((await (await call('POST', '/api/parse', { link: lp.link }, 400)).json()).cookie, true);
  await json('POST', '/api/cookie/refresh');
  assert.equal((await json('POST', '/api/parse', { link: lp.link })).total, 3);

  // 手动粘贴整段 cURL 也可以
  const saved = await json('POST', '/api/cookie', { cookie: `curl 'http://x' -H 'Accept: */*' -b '${fake.COOKIE}'`, link: lp.link });
  assert.equal(saved.verified, true);

  const parsed = await json('POST', '/api/parse', { link: lp.link });
  assert.equal(parsed.total, 3);
  assert.deepEqual(parsed.envs.map((e) => e.id), [11, 22]);

  // A=线上(11)，B=联调(22)；只取前 2 段对话（共 3 轮）
  batchId = (await json('POST', '/api/batches', { link: lp.link, envIds: [11, 22], limit: 2, trim: true })).id;
  const b = await until(async () => {
    const x = await json('GET', `/api/batches/${batchId}`);
    return x.enum.status === 'done' && x.items.length === 3 && x.items.every((i) => ['done', 'failed'].includes(i.status)) && x;
  }, 90000, '截图完成');
  for (const it of b.items) assert.equal(it.status, 'done', `${it.query}: ${it.error}`);
  const second = b.items.find((i) => i.turn === 2);
  assert.deepEqual(second.context, ['iPhone 17 和 16 有什么区别']);
  assert.ok(second.images['11'] && second.images['22'] && second.compareImage);
  assert.equal((await call('GET', second.images['22'])).headers.get('content-type'), 'image/png');

  // 单条评估：偏好 B，总分 A 7 / B 9
  await json('POST', `/api/batches/${batchId}/eval`, { ids: [second.id] });
  const ev = await until(async () => (await json('GET', `/api/batches/${batchId}`)).items.find((i) => i.id === second.id).eval?.status === 'done' &&
    (await json('GET', `/api/batches/${batchId}`)).items.find((i) => i.id === second.id).eval, 20000, '评估完成');
  assert.equal(ev.pref, 'B');
  // 对比评估以模型给的 GSB 为准，不再自动算总分；展示时偏好、结论在前，其余字段（含自定义字段）按模型输出顺序
  assert.equal(ev.gsb, 0.5);
  assert.ok(ev.data && ev.data.gsb === 0.5);
  assert.equal(ev.scores, null);
  assert.match(ev.text, /^\*\*偏好\*\*：\+0\.5，B（策略-genui-联调）略好\n\n\*\*结论\*\*：B 更好/);
  assert.ok(ev.text.indexOf('risk_note') > ev.text.indexOf('意图') && ev.text.indexOf('risk_note') < ev.text.indexOf('维度明细'));
  // 改字段映射 / 显示名：已有评估立即按新设置重新排版，不重新调用模型
  const calls = lp.calls();
  const re = await json('POST', '/api/config', { field_gsb: 'my_gsb', fieldLabels: 'risk_note=风险提示' });
  assert.ok(re.rerendered >= 1);
  const ev2 = (await json('GET', `/api/batches/${batchId}`)).items.find((i) => i.id === second.id).eval;
  assert.deepEqual([ev2.gsb, ev2.pref], [null, 'B']); // gsb 字段对不上时退回 preference
  assert.match(ev2.text, /\*\*风险提示\*\*：无明显风险/);
  await json('POST', '/api/config', { field_gsb: '', fieldLabels: '' });
  assert.equal((await json('GET', `/api/batches/${batchId}`)).items.find((i) => i.id === second.id).eval.gsb, 0.5);
  assert.equal(lp.calls(), calls);
  // 思考强度：默认不加参数；high 发 reasoning_effort；off 发 thinking disabled
  assert.equal(lp.payloads.at(-1).reasoning_effort, undefined);
  await json('POST', '/api/config', { reasoningEffort: 'high' });
  await json('POST', `/api/batches/${batchId}/eval`, { ids: [second.id], envId: 11 });
  await until(async () => lp.payloads.at(-1)?.reasoning_effort === 'high', 20000, 'reasoning_effort=high');
  assert.equal(lp.payloads.at(-1).thinking, undefined);
  await json('POST', '/api/config', { reasoningEffort: 'off' });
  await json('POST', `/api/batches/${batchId}/eval`, { ids: [second.id], envId: 11 });
  await until(async () => lp.payloads.at(-1)?.thinking?.type === 'disabled', 20000, 'thinking disabled');
  assert.equal(lp.payloads.at(-1).reasoning_effort, undefined);
  await json('POST', '/api/config', { reasoningEffort: 'auto' });
  await call('PATCH', `/api/batches/${batchId}/items/${second.id}`, { manual: { gsb: 0.5, note: 'smoke' } });
  await call('PATCH', `/api/batches/${batchId}/items/${b.items[0].id}`, { manual: { gsb: 0.3 } }); // 不在五档里的值视为清空

  // 单环境评估：只评 B（env 22），结果另存在 envEvals，不覆盖对比评估
  await json('POST', `/api/batches/${batchId}/eval`, { ids: [second.id], envId: 22 });
  const single = await until(async () => {
    const it = (await json('GET', `/api/batches/${batchId}`)).items.find((i) => i.id === second.id);
    return it.envEvals?.['22']?.status === 'done' && it;
  }, 20000, '单环境评估完成');
  assert.equal(single.envEvals['22'].score, 7);
  assert.equal(single.eval.pref, 'B');
  await call('POST', `/api/batches/${batchId}/eval`, { ids: [second.id], envId: 999 }, 400);

  // Excel：表头 + 每轮一行，两列截图锚在本行
  const buf = Buffer.from(await (await call('GET', `/api/batches/${batchId}/export?quality=preview&fields=context,status,img,model,dims,eval,single,manual`)).arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  const header = ws.getRow(1).values.slice(1);
  assert.ok(header.includes('query') && header.includes('截图_线上') && header.includes('截图_策略-genui-联调') && header.includes('上文'));
  assert.ok(header.includes('单评总分(/10)_策略-genui-联调') && header.includes('人工打分(B相对A,-1~1)'));
  // 每张图按左上角锚点归属单元格（「自动评估」就是这样把图片归到行的）：第 2 轮那一行应正好有两个环境的截图
  const headerOf = (c) => ws.getRow(1).getCell(c).text;
  const rowOfQuery = (q) => { let n = 0; ws.eachRow((row, i) => { if (row.getCell(4).text === q) n = i; }); return n; };
  const r2 = rowOfQuery('那价格呢');
  const images = ws.getImages();
  const owned = images.filter((im) => Math.floor(im.range.tl.row) + 1 === r2).map((im) => headerOf(Math.floor(im.range.tl.col) + 1)).sort();
  assert.deepEqual(owned, ['截图_策略-genui-联调', '截图_线上']);
  assert.equal(images.length, 6);
  const jsonl = (await (await call('GET', `/api/batches/${batchId}/export.jsonl`)).text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(jsonl.length, 3);
  assert.ok(fs.existsSync(jsonl[1].envs[1].image));
  assert.deepEqual([jsonl.find((x) => x.turn === 2).manual.gsb, jsonl.find((x) => x.turn === 2).manual.pref, jsonl[0].manual.gsb], [0.5, 'B', null]);

  // 补充截图：接着上次往后取 → 拿到第 3 段；再从第 1 条的链接开始补 → 已截过的全部跳过，不重复
  await json('POST', `/api/batches/${batchId}/extend`, { more: 5 });
  const ext = await until(async () => {
    const x = await json('GET', `/api/batches/${batchId}`);
    return x.enum.status === 'done' && x.items.length === 4 && x.items.every((i) => i.status === 'done') && x;
  }, 60000, '补充截图完成');
  assert.equal(ext.items.find((i) => i.id === second.id).manual.gsb, 0.5); // 原有标注不受影响
  await json('POST', `/api/batches/${batchId}/extend`, { link: lp.link, more: 0 });
  const again = await until(async () => {
    const x = await json('GET', `/api/batches/${batchId}`);
    return x.enum.status === 'done' && x;
  }, 20000, '从头补充');
  assert.equal(again.items.length, 4);
  const otherEval = lp.link.replace('/1258076/', '/999/');
  assert.match((await (await call('POST', `/api/batches/${batchId}/extend`, { link: otherEval }, 400)).json()).error, /不是同一个评估/);

  // 从评估第 1 条开始：链接给的是第 3 条，也应顺着「上一条」回到第 1 条
  const b2 = (await json('POST', '/api/batches', { link: lp.link.replace('/101/', '/103/'), envIds: [11], limit: 1, fromFirst: true })).id;
  const first = await until(async () => (await json('GET', `/api/batches/${b2}`)).items[0], 20000, '从第 1 条建批次');
  assert.equal(first.chatId, 101);
  await call('DELETE', `/api/batches/${b2}`);

  // 局域网协作：开启后同事凭分享链接访问，只能看、标注、导出；标注记录修改人
  const sh = await json('POST', '/api/share', { enabled: true });
  if (sh.urls.length) {
    const u = new URL(sh.urls[0]);
    const lan = `${u.protocol}//${u.host}`;
    assert.equal((await fetch(`${lan}/api/status`)).status, 401); // 没口令
    const go = await fetch(sh.urls[0], { redirect: 'manual' });
    assert.equal(go.status, 302);
    const cookie = go.headers.get('set-cookie').split(';')[0];
    const g = (p, o = {}) => fetch(lan + p, { ...o, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Labeler': encodeURIComponent('张三'), ...(o.headers || {}) } });
    assert.equal((await (await g('/api/status')).json()).role, 'guest');
    assert.equal((await g(`/api/batches/${batchId}`)).status, 200);
    const pr = await (await g(`/api/batches/${batchId}/items/${second.id}`, { method: 'PATCH', body: JSON.stringify({ manual: { gsb: -1 } }) })).json();
    // 多人各存一份：张三的打分不覆盖发起人的备注，汇总取平均
    assert.deepEqual([pr.manuals['张三'].gsb, pr.manuals['发起人'].note, pr.manual.gsb], [-1, 'smoke', -0.25]);
    const pr2 = await (await g(`/api/batches/${batchId}/items/${second.id}`, { method: 'PATCH', body: JSON.stringify({ manual: { gsb: 0 } }), headers: { 'X-Labeler': encodeURIComponent('李四') } })).json();
    assert.deepEqual(Object.keys(pr2.manuals).sort(), ['发起人', '张三', '李四']);
    assert.equal(pr2.manual.gsb, -0.17); // (0.5 - 1 + 0) / 3
    assert.equal((await g('/api/batches', { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await g('/api/share')).status, 403);
    const sync = await json('GET', `/api/batches/${batchId}/manual?since=`);
    assert.ok(sync.items.find((x) => x.id === second.id).manuals['李四']);
    assert.ok((await json('GET', '/api/status')).share.online.some((p) => p.name === '张三'));
    await json('POST', '/api/share', { enabled: false });
    assert.ok(await fetch(`${lan}/api/status`, { headers: { Cookie: cookie } }).then(() => false, () => true)); // 关闭后不再监听
  } else console.log('（没有局域网地址，跳过协作测试）');
  console.log('冒烟通过：Cookie 校验、解析、拉取 2 段对话、截图 3 轮 × 2 环境 + 拼图、单条对比评估、人工偏好、Excel（截图按行归属）、JSONL、局域网协作');
} finally {
  if (batchId) await call('DELETE', `/api/batches/${batchId}`).catch(() => {});
  child.kill();
  lp.server.close();
  fs.rmSync(cfgFile, { force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(batches, { recursive: true, force: true });
}

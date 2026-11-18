// 前端：批次管理、条目网格（每轮一张卡，各环境缩略图并排）、对比查看与人工标注、单条/批量模型评估、整体分析、导出
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ST = { pending: '未开始', queued: '排队中', shooting: '截图中', done: '成功', failed: '失败' };
const EV = { queued: '评估排队', running: '评估中', done: '已评估', failed: '评估失败' };
const RT = { good: '好', ok: '中', bad: '差' };
const ENUM = { running: '拉取中', paused: '已暂停拉取', done: '已拉完', failed: '拉取失败' };
const L = ['A', 'B', 'C', 'D'];
// 人工 GSB 五档：B 相对 A 的分数
const GSB = [-1, -0.5, 0, 0.5, 1];
const fmtG = (g) => (g > 0 ? `+${g}` : String(g));
const gsbShort = (g) => `${fmtG(g)} ${g === 0 ? '持平' : `${g < 0 ? 'A' : 'B'} ${Math.abs(g) === 1 ? '明显更好' : '略好'}`}`;
const gsbTag = (g) => `<span class="pref ${g > 0 ? 'B' : g < 0 ? 'A' : 'same'}">${esc(gsbShort(g))}</span>`;

const S = {
  batches: [],
  cur: null, // 当前批次完整数据
  view: 'new', // new | batch
  tab: 'items',
  sel: new Set(),
  filter: 'all',
  search: '',
  parsed: null, // 新建批次时解析出的链接信息
  viewer: { open: false, id: null, mode: localStorage.getItem('lpViewMode') || 'split', zoom: 'fit', scale: 1 },
  cfg: null,
  me: localStorage.getItem('lpName') || '', // 标注人名字，多人协作时记录谁改的
  evalN: Math.max(1, Number(localStorage.getItem('lpEvalN')) || 100), // 「只评前 N 条」的 N
  evalFrom: Math.max(1, Number(localStorage.getItem('lpEvalFrom')) || 1), // 「第 x 到 y 条」的起止（卡片上的序号）
  evalTo: Math.max(1, Number(localStorage.getItem('lpEvalTo')) || 100),
  sinced: '', // 增量刷新游标（上次拉到的服务端时间）
  build: '', // 服务端前端版本号，变了自动刷新
  role: 'owner', // owner=发起人（本机）；guest=通过分享链接进来的同事
  canWrite: true, // 协作者是否在可标注名单里；不在就只能查看
  share: { enabled: false, online: [] },
  manualSince: '',
};

async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json', 'X-Labeler': encodeURIComponent(S.me || '') };
  if (S.viewer.open) headers['X-Viewing'] = String(S.viewer.id);
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { cookie: !!data.cookie });
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  if (isErr) el.style.background = '#b91c1c';
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

// 统一的操作包装：执行 → 提示 → 刷新；Cookie 问题直接弹出更新窗口
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
    if (e.cookie) openCookie(e.message);
  }
}
// 轻量 Markdown：标题、加粗、列表、表格、段落
function md(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      i--;
      out.push(`<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) out.push(`<h4>${inline(h[2])}</h4>`);
    else if (/^\s*[-*]\s+/.test(l)) out.push(`<p>• ${inline(l.replace(/^\s*[-*]\s+/, ''))}</p>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return `<div class="md">${out.join('')}</div>`;
}
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

// 环境标签与偏好文本：批次环境顺序即 A、B…
const envTag = (i, name) => `<span class="tag ${L[i]}">${L[i]} ${esc(name)}</span>`;
const multi = () => (S.cur?.envs.length || 0) > 1;
function prefLabel(p, envs = S.cur.envs) {
  if (!p) return '';
  if (p === 'same') return '<span class="pref same">持平</span>';
  const i = L.indexOf(p);
  return `<span class="pref ${p}" title="${esc(envs[i]?.name || '')}">${p} 更好</span>`;
}
// 模型评估时参与的环境可能少于批次环境（某环境缺这一轮），把模型给的字母映射回批次字母
function modelPref(it) {
  const ev = it.eval;
  if (ev?.status !== 'done' || !ev.pref) return null;
  if (ev.pref === 'same' || !ev.envs) return ev.pref;
  const envId = ev.envs[L.indexOf(ev.pref)];
  const i = S.cur.envs.findIndex((e) => e.id === envId);
  return i >= 0 ? L[i] : null;
}
function modelScore(it, k) {
  const ev = it.eval;
  if (ev?.status !== 'done') return null;
  if (!ev.scores) return k === 0 ? ev.score : null;
  const j = ev.envs ? ev.envs.indexOf(S.cur.envs[k].id) : k;
  return j >= 0 ? ev.scores[L[j]] ?? null : null;
}
// 模型给的五档 GSB（B 相对 A）；只有评估时正好是批次的 A、B 两个环境才有意义
// 我自己在这条上的标注（多人协作时每人一份）；没有则回退到汇总
const myName = () => S.me || (S.role === 'owner' ? '发起人' : '我'); // 与服务端默认标注人一致
const myMark = (it) => it.manuals?.[myName()] || (it.manuals ? {} : it.manual) || {};
const othersMarks = (it) => Object.entries(it.manuals || {}).filter(([k, m]) => k !== myName() && hasMark(m));
// 只算真正标过的人（空记录不算）
const hasMark = (m) => !!m && (typeof m.gsb === 'number' || !!m.rating || (!!m.note && m.note.trim() !== '' && m.note.trim() !== '/'));
const annotators = (it) => Object.entries(it.manuals || {}).filter(([, m]) => hasMark(m)).map(([k]) => k);
const diverge = (it) => {
  const gs = annotators(it).map((k) => it.manuals[k]?.gsb).filter((g) => typeof g === 'number');
  return gs.length > 1 && Math.max(...gs) - Math.min(...gs) >= 0.5;
};
const markText = (m) => (typeof m?.gsb === 'number' ? gsbShort(m.gsb) : m?.note ? '仅备注' : '未标');

function modelGsb(it) {
  const ev = it.eval;
  if (ev?.status !== 'done' || typeof ev.gsb !== 'number') return null;
  return !ev.envs || (ev.envs[0] === S.cur.envs[0]?.id && ev.envs[1] === S.cur.envs[1]?.id) ? ev.gsb : null;
}

// ---------- 顶栏状态 ----------
async function refreshStatus() {
  const s = await api('GET', '/api/status').catch(() => null);
  if (!s) return;
  // 版本变了（发起人更新了工具）：等手头输入结束就自动刷新，协作的同事也一样
  if (s.build) {
    if (!S.build) S.build = s.build;
    else if (s.build !== S.build && !S.reloading) {
      const typing = ['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName);
      if (!typing) {
        S.reloading = true;
        toast('工具已更新，页面将在 2 秒后自动刷新');
        setTimeout(() => location.reload(), 2000);
      }
    }
  }
  S.role = s.role || 'owner';
  S.canWrite = s.canWrite !== false;
  S.share = s.share || { enabled: false, online: [] };
  document.body.classList.toggle('guest', S.role === 'guest');
  renderPresence();
  if (S.role === 'guest') {
    $('cookieState').innerHTML = '<span class="dot on"></span>协作模式（由发起人负责截图和模型评估）';
    $('queueState').textContent = s.capture.running ? `发起人正在截图 · 队列剩余 ${s.capture.queue} 段对话` : '';
    return s;
  }
  $('cookieState').innerHTML = `<span class="dot ${s.cookie ? 'on' : ''}"></span>${s.login?.status === 'waiting' ? '等待在弹出的 Chrome 里登录…' : s.cookie ? 'Cookie 已配置' : '缺 Cookie'}${s.chrome ? '' : ' · <span class="err">未找到 Google Chrome</span>'}`;
  renderLoginState(s.login);
  const c = s.capture;
  if (c.paused) {
    $('queueState').innerHTML = `<span class="pausebar">截图已暂停：${esc(c.pauseReason)} <button type="button" id="btnCk2">登录获取</button> <button type="button" id="btnResume">继续</button></span>`;
    $('btnResume').onclick = () => act(() => api('POST', '/api/capture/resume'), '已继续');
    $('btnCk2').onclick = startLogin;
  } else {
    $('queueState').textContent = c.running ? `截图中 ${c.active} 路并发 · 队列剩余 ${c.queue} 段对话` : c.queue ? `队列 ${c.queue} 段对话` : '';
  }
  return s;
}

// ---------- Cookie ----------
async function openCookie(msg) {
  const c = await api('GET', '/api/config').catch(() => ({}));
  $('ckText').value = '';
  $('ckMsg').textContent = '';
  if (msg) $('ckLoginMsg').innerHTML = `<span class="err">${esc(msg)}</span>`;
  $('ckSaved').textContent = c.hasCookie ? `当前：${c.cookieMask}${c.cookieSavedAt ? `，保存于 ${new Date(c.cookieSavedAt).toLocaleString('zh-CN')}` : ''}` : '当前未配置';
  if (!$('dlgCookie').open) $('dlgCookie').showModal();
  $('ckLogin').focus();
}
$('btnCookie').onclick = () => openCookie();

// 自动获取：服务端弹出专用 Chrome，前端轮询登录状态
const LOGIN_TEXT = { waiting: '已打开 Chrome，请在窗口里完成登录（10 分钟内）…', done: 'Cookie 已自动获取并保存', failed: '' };
let lastLogin = null;
function renderLoginState(l) {
  if (!l) return;
  const el = $('ckLoginMsg');
  el.innerHTML = l.status === 'idle' ? '' : l.status === 'failed' ? `<span class="err">${esc(l.error || '获取失败')}</span>` : `<span class="${l.status === 'done' ? 'ok' : ''}">${LOGIN_TEXT[l.status]}</span>`;
  if (l.status === 'waiting' && l.debug) {
    el.innerHTML += `<br>窗口当前页面：${esc(l.debug.url || '-')}<br>可用 Cookie：${esc(l.debug.cookies?.join('、') || '无')}${l.debug.check ? `<br>校验：${esc(l.debug.check)}` : ''}`;
  }
  $('ckLogin').disabled = l.status === 'waiting';
  if (lastLogin === 'waiting' && l.status === 'done') {
    toast('已自动获取 Cookie，暂停的任务会继续');
    $('dlgCookie').open && $('dlgCookie').close();
    refresh().catch(() => {});
  }
  lastLogin = l.status;
}
async function startLogin() {
  try {
    const link = S.cur?.source?.link || $('nLink')?.value || '';
    renderLoginState(await api('POST', '/api/cookie/login', { link }));
    if (!$('dlgCookie').open) $('dlgCookie').showModal();
  } catch (e) {
    toast(e.message, true);
  }
}
$('ckLogin').onclick = startLogin;
$('ckSave').onclick = async () => {
  $('ckMsg').textContent = '保存并验证中…';
  try {
    const link = S.cur?.source?.link || $('nLink')?.value || '';
    const r = await api('POST', '/api/cookie', { cookie: $('ckText').value, link });
    $('dlgCookie').close();
    toast(r.verified ? 'Cookie 已保存并验证通过，暂停的任务会自动继续' : 'Cookie 已保存');
    await refresh();
    refreshStatus();
  } catch (e) {
    $('ckMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
};
// ---------- 设置 ----------
async function openSettings() {
  const c = (S.cfg = await api('GET', '/api/config'));
  $('sBase').value = c.baseUrl;
  $('sModel').value = c.model;
  $('sAllow').value = c.allowNames || '';
  $('sEffort').value = c.reasoningEffort || 'auto';
  $('sKey').value = '';
  $('sKey').placeholder = c.hasKey ? `已保存 ${c.keyMask}（留空则不修改）` : '未设置';
  $('sEval').value = c.judgePrompt;
  $('sEval').placeholder = `留空时使用默认对比 Prompt：\n\n${c.defaultComparePrompt}`;
  $('sSingle').value = c.singlePrompt;
  $('sSingle').placeholder = `留空时使用默认单环境 Prompt：\n\n${c.defaultSinglePrompt}`;
  $('sSum').value = c.summaryPrompt;
  $('sSum').placeholder = c.defaultSummaryPrompt;
  $('sCache').checked = c.cacheControl;
  $('sCConc').value = c.captureConcurrency;
  $('sCRetry').value = c.captureRetries;
  $('sConc').value = c.evalConcurrency;
  $('sEvalRetry').value = c.evalRetries;
  $('fGsb').value = c.field_gsb;
  $('fPref').value = c.field_preference;
  $('fSum').value = c.field_summary;
  $('fDims').value = c.field_dimensions;
  $('fLabels').value = c.fieldLabels;
  $('fLabelsDefault').textContent = `内置显示名：${c.defaultLabels.split('\n').join('，')}（在上面写同名字段可覆盖）`;
  $('sMsg').textContent = '';
  renderShare(await api('GET', '/api/share').catch(() => ({ enabled: false, urls: [], online: [] })));
  $('dlgSettings').showModal();
}
async function saveSettings() {
  S.cfg = await api('POST', '/api/config', {
    baseUrl: $('sBase').value, apiKey: $('sKey').value, model: $('sModel').value, reasoningEffort: $('sEffort').value,
    judgePrompt: $('sEval').value, singlePrompt: $('sSingle').value, summaryPrompt: $('sSum').value, cacheControl: $('sCache').checked,
    captureConcurrency: Number($('sCConc').value), captureRetries: Number($('sCRetry').value),
    evalConcurrency: Number($('sConc').value), evalRetries: Number($('sEvalRetry').value),
    field_gsb: $('fGsb').value, field_preference: $('fPref').value, field_summary: $('fSum').value, field_dimensions: $('fDims').value,
    fieldLabels: $('fLabels').value, allowNames: $('sAllow').value,
  });
}
$('btnSettings').onclick = openSettings;

// 协作开关立即生效（不用点保存）
function renderShare(v) {
  $('shOn').checked = v.enabled;
  $('shRegen').disabled = !v.enabled;
  $('shBox').innerHTML = v.enabled
    ? `${v.urls.map((u) => `<div class="row" style="margin-top:4px"><code style="word-break:break-all">${esc(u)}</code><button type="button" class="sm" data-copy="${esc(u)}">复制链接</button></div>`).join('')}
       <div style="margin-top:4px">在线：${(v.online || []).map((p) => esc(p.name)).join('、') || '暂无'}</div>`
    : '未开启。';
  $('shBox').querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('分享链接已复制，发给同事即可'), () => toast('复制失败，请手动选中复制', true))));
}
async function setShare(body) {
  try {
    renderShare(await api('POST', '/api/share', body));
    refreshStatus();
  } catch (e) {
    toast(e.message, true);
    renderShare(await api('GET', '/api/share'));
  }
}
$('shOn').onchange = (e) => {
  if (e.target.checked) ensureName();
  setShare({ enabled: e.target.checked });
};
$('shRegen').onclick = () => confirm('重新生成后，之前发出去的链接会立即失效，同事需要用新链接重新打开。继续？') && setShare({ enabled: true, regenerate: true });
$('sSave').onclick = async () => {
  try {
    await saveSettings();
    $('dlgSettings').close();
    toast(S.cfg.rerendered ? `设置已保存，已按新字段设置重新排版 ${S.cfg.rerendered} 条评估` : '设置已保存');
    if (S.cfg.rerendered) refresh();
  } catch (e) {
    $('sMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
};
$('sTest').onclick = async () => {
  $('sMsg').textContent = '测试中…';
  try {
    await saveSettings();
    const r = await api('POST', '/api/config/test');
    $('sMsg').innerHTML = `<span class="ok">连接成功，模型回复：${esc(r.reply)}</span>`;
  } catch (e) {
    $('sMsg').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
};
document.querySelectorAll('[data-default]').forEach((b) => {
  b.onclick = () => {
    const k = b.dataset.default;
    if (k === 'summary') $('sSum').value = S.cfg.defaultSummaryPrompt;
    else if (k === 'single') $('sSingle').value = S.cfg.defaultSinglePrompt;
    else $('sEval').value = S.cfg.defaultComparePrompt;
  };
});

// ---------- 批次列表 ----------
function renderList() {
  $('batchList').innerHTML = S.batches.length
    ? S.batches
        .map((b) => {
          const c = b.counts;
          return `<button type="button" class="bt ${S.view === 'batch' && S.cur?.id === b.id ? 'active' : ''}" data-id="${esc(b.id)}">
            <div class="n">${esc(b.name)}</div>
            <div class="hint">${b.envs.map((e, i) => envTag(i, e.name)).join('')}</div>
            <div class="hint">${c.chats} 段对话 · ${c.done}/${c.total} 轮${c.failed ? ` · <span class="err">失败 ${c.failed}</span>` : ''}${c.queued ? ` · 进行中 ${c.queued}` : ''}${c.evaluated ? ` · 评估 ${c.evaluated}` : ''}${b.enumStatus === 'running' ? ' · 拉取中' : ''}</div>
          </button>`;
        })
        .join('')
    : '<p class="hint">还没有批次</p>';
}
$('batchList').onclick = (e) => {
  const id = e.target.closest('.bt')?.dataset.id;
  if (id) openBatch(id);
};
$('btnNew').onclick = () => {
  S.view = 'new';
  S.cur = null;
  renderList();
  renderNew();
};
// ---------- 新建批次：粘贴链接 → 解析 → 选环境顺序与范围 → 创建 ----------
function renderNew() {
  $('main').dataset.batch = '';
  if (S.role === 'guest') {
    $('main').innerHTML = '<div class="card" style="max-width:820px"><h2>还没有批次</h2><p class="hint">由发起人新建批次并截图，建好后会出现在左侧列表里。</p></div>';
    return;
  }
  $('main').innerHTML = `<div class="card" style="max-width:820px">
    <h2>新建批次</h2>
    <label class="f" for="nLink">labelplus 评估页链接（从哪一条开始）</label>
    <div class="row"><input id="nLink" type="text" style="flex:1" placeholder="http://ab.baidu-int.com/labelplus/task/chat/query/947652422/1258076/0/132" value="${esc(localStorage.getItem('lpLink') || '')}" />
      <button id="nParse" class="pri" type="button">解析</button></div>
    <div id="nInfo"></div>
  </div>`;
  $('nParse').onclick = parseLink;
  // 注意不能写成 onkeydown = e => cond && fn()：返回 false 会被当成 preventDefault，导致无法输入和粘贴
  $('nLink').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') parseLink();
  });
  if (S.parsed && S.parsed.link === $('nLink').value) renderParsed();
}

async function parseLink() {
  $('nInfo').innerHTML = '<p class="hint">解析中…</p>';
  try {
    const link = $('nLink').value.trim();
    S.parsed = { ...(await api('POST', '/api/parse', { link })), link };
    S.parsed.order = S.parsed.envs.map((e) => e.id);
    S.parsed.on = new Set(S.parsed.order);
    localStorage.setItem('lpLink', link);
    renderParsed();
  } catch (e) {
    $('nInfo').innerHTML = `<p class="err">${esc(e.message)}</p>`;
    if (e.cookie) openCookie(e.message);
  }
}

function renderParsed() {
  const p = S.parsed;
  p.fromFirst ??= p.pos > 1; // 默认从评估第 1 条开始，和 labelplus 里看到的顺序一致
  const remain = p.fromFirst ? p.total : p.total - p.pos + 1;
  const on = p.order.filter((id) => p.on.has(id));
  const name = (id) => p.envs.find((e) => e.id === id)?.name || id;
  $('nInfo').innerHTML = `
    <p class="hint" style="margin:10px 0 0">evaluation <b>${p.evaluationId}</b> · 当前是第 ${p.pos} / ${p.total} 条 · 这段对话 ${p.turns.length} 轮：${esc(p.turns.map((t, i) => `${i + 1}. ${t}`).join('  '))}</p>
    ${p.batches.length ? `<p class="hint warn">这个评估已有批次：${p.batches.map((b) => `<a href="#" data-open-batch="${esc(b.id)}">${esc(b.name)}</a>`).join('、')}</p>` : ''}
    <label class="f">对比环境（按顺序标为 A、B；A 一般选基线，如「线上」）</label>
    ${p.order.map((id) => {
      const k = on.indexOf(id);
      return `<div class="envrow"><input type="checkbox" data-env="${id}" ${p.on.has(id) ? 'checked' : ''} aria-label="截取 ${esc(name(id))}" />
        ${k >= 0 ? envTag(k, name(id)) : `<span class="hint">${esc(name(id))}（不截）</span>`}<span class="hint">env ${id}</span><span class="spacer"></span>
        <button type="button" class="sm" data-up="${id}" ${p.order[0] === id ? 'disabled' : ''}>上移</button></div>`;
    }).join('')}
    <fieldset style="border:none;padding:0;margin:12px 0 0">
      <legend class="hint">从哪一条开始</legend>
      <label><input type="radio" name="nFrom" value="first" ${p.fromFirst ? 'checked' : ''} /> 评估的第 1 条</label>
      <label style="margin-left:16px"><input type="radio" name="nFrom" value="link" ${p.fromFirst ? '' : 'checked'} /> 链接这一条（第 ${p.pos} 条）</label>
    </fieldset>
    <fieldset style="border:none;padding:0;margin:8px 0 0">
      <legend class="hint">范围（顺着「下一条」往后取）</legend>
      <label><input type="radio" name="nScope" value="1" checked /> 仅这一条</label>
      <label style="margin-left:16px"><input type="radio" name="nScope" value="n" /> 前 <input id="nN" type="number" min="1" value="${Math.min(100, remain)}" style="width:80px" /> 条</label>
      <label style="margin-left:16px"><input type="radio" name="nScope" value="0" /> ${p.fromFirst ? '全部' : '剩余全部'}（${remain} 条，3 并发约 ${Math.ceil((remain * 6) / 60)} 分钟）</label>
    </fieldset>
    <label style="display:block;margin-top:10px"><input id="nTrim" type="checkbox" checked /> 只保留问题与答案正文（裁掉工具栏、推荐问题、评估角标）</label>
    <label class="f" for="nName">批次名称（可选）</label>
    <input id="nName" type="text" placeholder="例如 genui 联调 vs 线上 · 11月第3周" />
    <div class="row" style="margin-top:14px"><button id="nGo" class="pri" type="button" ${on.length ? '' : 'disabled'}>创建并开始截图</button>
      <span class="hint">${on.length > 1 ? `将对比 ${on.map((id, i) => `${L[i]}=${esc(name(id))}`).join('，')}` : on.length ? '单环境：模型评估按单图打分' : '至少选一个环境'}</span></div>`;
  $('nInfo').querySelectorAll('input[name=nFrom]').forEach((r) => (r.onchange = () => {
    p.fromFirst = r.value === 'first';
    renderParsed();
  }));
  $('nInfo').querySelectorAll('[data-env]').forEach((c) => (c.onchange = () => {
    c.checked ? p.on.add(Number(c.dataset.env)) : p.on.delete(Number(c.dataset.env));
    renderParsed();
  }));
  $('nInfo').querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => {
    const i = p.order.indexOf(Number(b.dataset.up));
    [p.order[i - 1], p.order[i]] = [p.order[i], p.order[i - 1]];
    renderParsed();
  }));
  $('nInfo').querySelectorAll('[data-open-batch]').forEach((a) => (a.onclick = (e) => (e.preventDefault(), openBatch(a.dataset.openBatch))));
  $('nGo').onclick = () => act(async () => {
    const scope = document.querySelector('input[name=nScope]:checked').value;
    const limit = scope === 'n' ? Number($('nN').value) || 1 : Number(scope);
    const b = await api('POST', '/api/batches', { link: p.link, name: $('nName').value, envIds: on, limit, trim: $('nTrim').checked, fromFirst: p.fromFirst });
    S.parsed = null;
    await openBatch(b.id);
    return b;
  }, '已创建，开始拉取并截图');
}
// ---------- 数据刷新 ----------
async function refresh() {
  S.batches = await api('GET', '/api/batches');
  if (S.view === 'batch' && S.cur) {
    try {
      await mergeBatch(S.cur.id);
    } catch {
      S.view = 'new';
      S.cur = null;
      renderNew();
    }
  }
  renderList();
  if (S.view === 'batch' && S.cur) renderBatch();
  if (S.viewer.open) renderViewer(false);
}

async function openBatch(id) {
  S.view = 'batch';
  S.tab = 'items';
  S.sel.clear();
  S.filter = 'all';
  S.search = '';
  S.sinced = '';
  S.cur = await api('GET', `/api/batches/${encodeURIComponent(id)}`);
  // 留 10 秒重叠，避免整批加载和增量刷新之间漏掉变动
  S.sinced = new Date(Date.now() - 10000).toISOString();
  gridWin = { key: '', start: -1, cols: 0 };
  localStorage.setItem('lpBatch', id);
  renderList();
  renderBatch(true);
}

// 增量刷新：只拉变过的条目（几 KB），不再每次重下整批（6 MB+）
async function mergeBatch(id) {
  if (!S.sinced) {
    S.cur = await api('GET', `/api/batches/${encodeURIComponent(id)}`);
    S.sinced = new Date(Date.now() - 10000).toISOString();
    return;
  }
  const u = await api('GET', `/api/batches/${encodeURIComponent(id)}/updates?since=${encodeURIComponent(S.sinced)}`);
  S.sinced = u.now;
  if (u.items.length) {
    const map = new Map(u.items.map((i) => [i.id, i]));
    S.cur.items = S.cur.items.map((i) => map.get(i.id) || i);
  }
  Object.assign(S.cur, { counts: u.counts, enum: u.enum, summary: u.summary, evalPending: u.evalPending, capturePending: u.capturePending });
}

// 有进行中的任务时 2 秒轮询，否则 8 秒
async function loop() {
  const s = await refreshStatus();
  const b = S.cur;
  const busy =
    s?.capture.running || s?.login?.status === 'waiting' ||
    (b && (b.enum.status === 'running' || b.counts.queued || b.evalPending || b.summary?.status === 'running' ||
      b.items.some((i) => [i.eval, ...Object.values(i.envEvals || {})].some((e) => ['running', 'queued'].includes(e?.status)))));
  if (busy) await refresh().catch(() => {});
  setTimeout(loop, busy ? 2000 : 8000);
}

// ---------- 多人协作：只同步人工标注的增量（几 KB），别人改的几秒内出现在自己页面上 ----------
async function syncManual() {
  const b = S.cur;
  if (b && S.view === 'batch' && (S.share.enabled || S.role === 'guest')) {
    try {
      const r = await api('GET', `/api/batches/${encodeURIComponent(b.id)}/manual?since=${encodeURIComponent(S.manualSince)}`);
      if (S.cur === b) {
        S.manualSince = r.now;
        let changed = false;
        for (const x of r.items) {
          const it = b.items.find((i) => i.id === x.id);
          if (!it || JSON.stringify(it.manual) === JSON.stringify(x.manual)) continue;
          it.manual = x.manual;
          it.manuals = x.manuals || it.manuals;
          changed = true;
        }
        if (changed) {
          b.counts.rated = b.items.filter((i) => i.manual?.pref || i.manual?.rating).length; // 统计里的「人工已标注」跟着更新
          renderBatch();
          if (S.viewer.open) renderViewer(false);
        }
      }
    } catch {}
  }
  setTimeout(syncManual, 3000);
}

// 顶栏显示谁在线、各自正在看哪一条
function renderPresence() {
  const list = S.share.online || [];
  const show = S.share.enabled || S.role === 'guest';
  $('presence').hidden = !show;
  $('btnName').hidden = !show;
  $('btnName').textContent = S.me ? `我：${S.me}` : '设置名字';
  if (!show) return;
  $('presence').innerHTML = `协作中 · ${list.length} 人在线：${list.map((p) => `<span class="tag" title="${p.itemId ? `正在看第 ${p.itemId} 条` : ''}">${esc(p.name)}${p.role === 'owner' ? '（发起人）' : ''}${p.name === S.me ? '（我）' : ''}</span>`).join('') || '—'}`;
}

function ensureName(force) {
  if (S.me && !force) return;
  const n = (prompt('你的名字（标注时记录是谁改的）', S.me || '') || '').trim().slice(0, 30);
  if (n) {
    S.me = n;
    localStorage.setItem('lpName', n);
  }
}
$('btnName').onclick = () => (ensureName(true), refreshStatus());

// ---------- 批次详情 ----------
const FILTERS = {
  all: ['全部', () => true],
  done: ['截图成功', (i) => i.status === 'done'],
  failed: ['失败', (i) => i.status === 'failed'],
  unfinished: ['未完成', (i) => i.status !== 'done'],
  evaluated: ['已评估', (i) => i.eval?.status === 'done'],
  unevaluated: ['待评估', (i) => i.status === 'done' && i.eval?.status !== 'done'],
  unrated: ['未人工标注', (i) => i.status === 'done' && !i.manual?.pref && !i.manual?.rating],
  multiturn: ['多轮（第 2 轮及以后）', (i) => i.turn > 1],
};
function filterDefs() {
  const defs = { ...FILTERS };
  if (S.share.enabled || S.role === 'guest' || S.cur.items.some((i) => i.manual?.by)) {
    const marked = (i) => i.manual?.gsb != null || i.manual?.rating || i.manual?.note;
    defs['by:me'] = ['我标注的', (i) => annotators(i).includes(myName())];
    defs['by:other'] = ['别人也标注的', (i) => othersMarks(i).length > 0];
    defs.diverge = ['多人标注有分歧', (i) => diverge(i)];
  }
  if (multi()) {
    for (const p of [...L.slice(0, S.cur.envs.length), 'same']) {
      const label = p === 'same' ? '持平' : `${p} 更好`;
      defs[`m:${p}`] = [`模型：${label}`, (i) => modelPref(i) === p];
    }
    for (const g of GSB) defs[`g:${g}`] = [`人工：${gsbShort(g)}`, (i) => i.manual?.gsb === g];
    defs.conflict = ['人工与模型方向不一致', (i) => i.manual?.pref && modelPref(i) && i.manual.pref !== modelPref(i)];
    if (S.cur.items.some((i) => modelGsb(i) !== null)) {
      for (const g of GSB) defs[`mg:${g}`] = [`模型：${gsbShort(g)}`, (i) => modelGsb(i) === g];
      defs.gsbDiff = ['人工与模型分档不一致', (i) => typeof i.manual?.gsb === 'number' && modelGsb(i) !== null && i.manual.gsb !== modelGsb(i)];
    }
  } else {
    for (const [k, t] of Object.entries(RT)) defs[`r:${k}`] = [`人工评${t}`, (i) => i.manual?.rating === k];
  }
  return defs;
}
const visibleItems = () => {
  const pred = (filterDefs()[S.filter] || FILTERS.all)[1];
  const q = S.search.toLowerCase();
  // 按在评估里的位置排序：后补的前面的对话也能排回原位
  return S.cur.items
    .filter((i) => pred(i) && (!q || i.query.toLowerCase().includes(q) || String(i.chatId).includes(q)))
    .sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.turn - b.turn);
};
const selIds = () => [...S.sel].filter((id) => S.cur.items.some((i) => i.id === id));
const bid = () => encodeURIComponent(S.cur.id);

function renderBatch(rebuild) {
  const b = S.cur;
  if (rebuild || $('main').dataset.batch !== b.id) {
    $('main').dataset.batch = b.id;
    $('main').innerHTML = `
      <div class="card">
        <div class="row"><h2 id="bName" style="margin:0"></h2><span id="bMeta" class="hint"></span><span class="spacer"></span>
          <button type="button" id="bRename" class="owner-only">重命名</button><button type="button" id="bDel" class="danger owner-only">删除批次</button></div>
        <div id="bEnum" class="hint" style="margin-top:6px"></div>
        <div id="bStats" class="stats hint" style="margin-top:4px"></div>
        <div class="toolbar" id="bTools" style="margin-top:10px"></div>
        <details id="bExt" class="owner-only" style="margin-top:10px"><summary>补充截图（接着往后取，或从另一条开始补）</summary>
          <div class="row" style="margin-top:8px">
            <input id="xLink" type="text" style="flex:1;min-width:320px" placeholder="从哪一条开始（粘贴同一评估的链接）；留空 = 接着上次的位置往后" />
          </div>
          <div class="row" style="margin-top:8px">
            <label><input type="radio" name="xScope" value="n" checked /> 往后 <input id="xN" type="number" min="1" value="50" style="width:80px" /> 条</label>
            <label><input type="radio" name="xScope" value="0" /> 一直到最后</label>
            <label><input type="checkbox" id="xFirst" /> 从评估第 1 条开始（补齐前面漏掉的）</label>
            <button type="button" id="xGo" class="pri">开始补充</button>
            <span class="hint">已截过的对话会自动跳过，不重复截、不占名额；新条目沿用本批次的环境和裁剪设置。</span>
          </div>
        </details>
      </div>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="items">条目</button>
        <button type="button" role="tab" data-tab="summary">整体分析</button>
      </div>
      <div id="tabItems">
        <div class="row" style="margin-bottom:10px">
          <label><input type="checkbox" id="selAll" /> 全选当前列表</label>
          <span id="selInfo" class="hint"></span>
          <span class="spacer"></span>
          <label for="fSel" class="hint">筛选</label>
          <select id="fSel"></select>
          <input id="fSearch" type="search" placeholder="搜索 query / chat_id" aria-label="搜索" />
        </div>
        <div class="grid" id="grid"></div>
      </div>
      <div id="tabSummary" class="card" hidden></div>`;
    $('xLink').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('xGo').click();
    });
    $('xGo').onclick = () => act(async () => {
      const more = document.querySelector('input[name=xScope]:checked').value === 'n' ? Number($('xN').value) || 1 : 0;
      const r = await api('POST', `/api/batches/${bid()}/extend`, { link: $('xLink').value, more, fromFirst: $('xFirst').checked });
      $('xLink').value = '';
      return r;
    }, '开始补充，新拉到的对话会自动截图');
    $('bRename').onclick = () => {
      const name = prompt('批次名称', S.cur.name);
      if (name?.trim()) act(() => api('PATCH', `/api/batches/${bid()}`, { name }), '已重命名');
    };
    $('bDel').onclick = () => {
      if (!confirm(`确定删除「${S.cur.name}」？截图、评估结果和人工标注都会被删除且无法恢复。`)) return;
      act(async () => {
        await api('DELETE', `/api/batches/${bid()}`);
        S.view = 'new';
        S.cur = null;
        renderNew();
      }, '已删除');
    };
    document.querySelectorAll('[data-tab]').forEach((t) => (t.onclick = () => ((S.tab = t.dataset.tab), renderBatch())));
    $('fSel').onchange = (e) => ((S.filter = e.target.value), renderGrid());
    $('fSearch').oninput = (e) => ((S.search = e.target.value.trim()), renderGrid());
    $('selAll').onchange = (e) => {
      for (const it of visibleItems()) e.target.checked ? S.sel.add(it.id) : S.sel.delete(it.id);
      renderGrid();
    };
    $('grid').onclick = onGridClick;
  }
  $('bName').textContent = b.name;
  $('bMeta').innerHTML = `${b.envs.map((e, i) => envTag(i, e.name)).join('')} evaluation ${b.source.evaluationId} · 创建于 ${new Date(b.createdAt).toLocaleString('zh-CN')}`;
  renderEnum();
  const c = b.counts;
  renderStats(b);
  renderTools();
  document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === S.tab));
  $('tabItems').hidden = S.tab !== 'items';
  $('tabSummary').hidden = S.tab !== 'summary';
  if (S.tab === 'items') renderGrid();
  else renderSummary();
}
// 拉取进度：顺着 next_chat_id 往后取，暂停后可继续
function renderEnum() {
  const e = S.cur.enum;
  const plan = e.status === 'running' ? (e.remaining == null ? '，取到最后为止' : `，本次还要取 ${e.remaining} 条`) : '';
  const btn = e.status === 'running' ? '<button type="button" class="sm owner-only" id="enStop">停止拉取</button>'
    : e.status === 'paused' && e.next ? '<button type="button" class="sm owner-only" id="enGo">继续拉取</button>' : '';
  const where = e.next ? '' : e.status === 'done' ? ' · 已到评估的最后一条' : '';
  $('bEnum').innerHTML = `${ENUM[e.status] || e.status}：本批次已有 ${S.cur.counts.chats} 段对话${e.total ? `（评估共 ${e.total} 条）` : ''}${plan}${where} ${btn}${e.error ? ` <span class="${e.status === 'failed' ? 'err' : 'warn'}">${esc(e.error)}</span>` : ''}`;
  if ($('enStop')) $('enStop').onclick = () => act(() => api('POST', `/api/batches/${bid()}/enumerate/stop`), '已停止拉取，已取到的会继续截图');
  if ($('enGo')) $('enGo').onclick = () => act(() => api('POST', `/api/batches/${bid()}/enumerate`), '继续拉取');
  $('xGo').disabled = e.status === 'running';
}

// 胜率条：模型与人工各一行
// ---------- 批次统计：拆成独立的小项，可在「统计项」里选择显示哪些 ----------
const STAT_LABELS = {
  scope: '对话 / 轮次总数', done: '截图成功', failed: '失败', queued: '进行中', pending: '未开始',
  evaluated: '模型已评估', rated: '人工已标注', mPref: '模型胜率', hPref: '人工胜率',
  mAvg: '模型均分', hAvg: '人工均分', avg: '平均总分（单环境）', single: '单评平均', tokens: 'token 用量',
};
function statsParts(b) {
  const c = b.counts;
  const parts = [
    ['scope', `<span>${c.chats} 段对话 · ${c.total} 轮</span>`],
    ['done', `<span class="ok">成功 ${c.done}</span>`],
    ['failed', `<span class="err">失败 ${c.failed}</span>`],
    ['queued', `<span>进行中 ${c.queued}</span>`],
    ['pending', `<span>未开始 ${c.pending}</span>`],
    ['evaluated', `<span>模型已评估 ${c.evaluated}</span>`],
    ['rated', `<span>人工已标注 ${c.rated}</span>`],
  ];
  // 胜率与均分：从 prefStats 里拆出来
  const p = prefParts(b);
  for (const k of ['mPref', 'hPref', 'mAvg', 'hAvg', 'avg', 'single']) if (p[k]) parts.push([k, p[k]]);
  const t = tokenInfo(b.tokens);
  if (t) parts.push(['tokens', t]);
  return parts;
}
function hiddenStats() {
  try {
    return new Set(JSON.parse(localStorage.getItem('lpStatsHide') || '[]'));
  } catch {
    return new Set();
  }
}
function renderStats(b) {
  const hide = hiddenStats();
  const parts = statsParts(b);
  const shown = parts.filter(([k]) => !hide.has(k));
  $('bStats').innerHTML = `${shown.map(([, h]) => h).join('') || '<span class="hint">统计已全部隐藏</span>'}<button type="button" class="sm" id="stCfg" title="选择显示哪些统计项">统计项</button>`;
  $('stCfg').onclick = () => openStatsDialog(b);
}
function openStatsDialog(b) {
  const hide = hiddenStats();
  const have = new Set(statsParts(b).map(([k]) => k));
  $('showStats').innerHTML = Object.entries(STAT_LABELS).filter(([k]) => have.has(k) || ['mPref', 'hPref', 'mAvg', 'hAvg'].includes(k))
    .map(([k, l]) => `<label><input type="checkbox" value="${k}" ${hide.has(k) ? '' : 'checked'} /> ${esc(l)}</label>`).join('');
  $('dlgStats').showModal();
}
function applyStatsDialog() {
  const s = new Set();
  $('showStats').querySelectorAll('input').forEach((c) => !c.checked && s.add(c.value));
  localStorage.setItem('lpStatsHide', JSON.stringify([...s]));
  $('dlgStats').close();
  if (S.cur) renderStats(S.cur);
}
$('statsAll').onclick = () => $('showStats').querySelectorAll('input').forEach((c) => (c.checked = true));
$('statsNone').onclick = () => $('showStats').querySelectorAll('input').forEach((c) => (c.checked = false));
$('statsGo').onclick = applyStatsDialog;

// 胜率条与均分（对比批次）
function prefParts(b) {
  if (b.envs.length < 2) {
    const s = b.items.map((i) => (i.eval?.status === 'done' ? i.eval.score : null)).filter((x) => typeof x === 'number');
    return { avg: s.length ? `<span>平均总分 <b class="score">${(s.reduce((a, x) => a + x, 0) / s.length).toFixed(1)}</b></span>` : '' };
  }
  const keys = [...L.slice(0, b.envs.length), 'same'];
  const color = { A: 'var(--a)', B: 'var(--b)', C: '#d97706', D: '#db2777', same: '#d1d5db' };
  const line = (label, get) => {
    const cnt = Object.fromEntries(keys.map((k) => [k, 0]));
    let n = 0;
    for (const it of b.items) { const p = get(it); if (p in cnt) { cnt[p]++; n++; } }
    if (!n) return '';
    const text = keys.map((k) => `${k === 'same' ? '持平' : `${k} 胜`} ${cnt[k]}（${Math.round((cnt[k] / n) * 100)}%）`).join(' · ');
    return `<span title="${text}">${label} <span class="bar3">${keys.map((k) => `<i style="width:${(cnt[k] / n) * 100}%;background:${color[k]}"></i>`).join('')}</span> ${text}</span>`;
  };
  const avg = b.envs.map((e, k) => {
    const s = b.items.map((i) => modelScore(i, k)).filter((x) => typeof x === 'number');
    return s.length ? `${L[k]} <b class="score">${(s.reduce((a, x) => a + x, 0) / s.length).toFixed(1)}</b>` : '';
  }).filter(Boolean).join(' / ');
  const gAvgOf = (label, list) => (list.length ? `<span title="B 相对 A，-1~1">${label}均分 <b class="score">${fmtG(Math.round((list.reduce((a, x) => a + x, 0) / list.length) * 100) / 100)}</b>（${list.length} 条）</span>` : '');
  return {
    mPref: line('模型', modelPref),
    hPref: line('人工', (i) => i.manual?.pref),
    mAvg: gAvgOf('模型', b.items.map(modelGsb).filter((g) => g !== null)),
    hAvg: gAvgOf('人工', b.items.map((i) => i.manual?.gsb).filter((g) => typeof g === 'number')),
    avg: avg ? `<span>平均总分 ${avg}</span>` : '',
    single: singleAvg(b),
  };
}
function prefStats(b) {
  const p = prefParts(b);
  return `${p.mPref || ''}${p.hPref || ''}${p.mAvg || ''}${p.hAvg || ''}${p.avg || ''}${p.single || ''}`;
}

function singleAvg(b) {
  const parts = b.envs.map((e, k) => {
    const s = b.items.map((i) => i.envEvals?.[e.id]).filter((x) => x?.status === 'done' && typeof x.score === 'number').map((x) => x.score);
    return s.length ? `${L[k]} <b class="score">${(s.reduce((a, x) => a + x, 0) / s.length).toFixed(1)}</b>（${s.length} 条）` : '';
  }).filter(Boolean);
  return parts.length ? `<span>单评平均 ${parts.join(' / ')}</span>` : '';
}

const fmtK = (n) => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function tokenInfo(t) {
  if (!t?.calls) return '';
  const rate = t.prompt ? Math.round((t.cached / t.prompt) * 100) : 0;
  return `<span title="评估调用 ${t.calls} 次">输入 ${fmtK(t.prompt)} tokens · 缓存命中 ${rate}% · 输出 ${fmtK(t.completion)}</span>`;
}

function renderTools() {
  const b = S.cur;
  const c = b.counts;
  const n = selIds().length;
  const mode = evalMode();
  const unevaluated = b.items.filter((i) => needsEval(i, mode)).length;
  // 范围评估：按卡片上的序号（第几条）取，只算这个范围内还没评的
  const rangeItems = () => S.cur.items.filter((i) => i.id >= S.evalFrom && i.id <= S.evalTo);
  const rangeCount = rangeItems().filter((i) => needsEval(i, mode)).length;
  const evalBusy = b.evalPending || b.items.some((i) => [i.eval, ...Object.values(i.envEvals || {})].some((e) => ['queued', 'running'].includes(e?.status)));
  const modeSel = multi()
    ? `<select id="evMode" aria-label="评估方式">${[['compare', `对比评估（${b.envs.map((e, k) => L[k]).join(' vs ')}）`], ...b.envs.map((e, k) => [String(e.id), `单评 ${L[k]} ${e.name}`])]
        .map(([v, t]) => `<option value="${v}" ${v === mode ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : '';
  $('bTools').innerHTML = `
    <div class="grp owner-only"><span>截图</span>
      <button type="button" data-a="retryFailed" ${c.failed ? '' : 'disabled'}>重试失败（${c.failed}）</button>
      <button type="button" data-a="shootUnfinished" ${c.failed + c.pending ? '' : 'disabled'}>截取未完成（${c.failed + c.pending}）</button>
      <button type="button" data-a="reshootSel" ${n ? '' : 'disabled'} title="按所在对话整段重截">重截选中（${n}）</button>
      <button type="button" data-a="cancelShoot" ${c.queued ? '' : 'disabled'}>取消排队</button></div>
    <div class="grp owner-only"><span>模型评估</span>${modeSel}
      <button type="button" data-a="evalSel" ${n ? '' : 'disabled'}>评估选中（${n}）</button>
      <button type="button" data-a="evalRest" class="pri" ${unevaluated ? '' : 'disabled'}>批量评估待评估（${unevaluated}）</button>
      <span class="hint">或只评前</span><input id="evN" type="number" min="1" value="${S.evalN}" style="width:72px" aria-label="只评估前几条" />
      <button type="button" data-a="evalFirst" ${unevaluated ? '' : 'disabled'}>条待评估</button>
      <span class="hint">或第</span><input id="evFrom" type="number" min="1" value="${S.evalFrom}" style="width:72px" aria-label="从第几条开始" />
      <span class="hint">到</span><input id="evTo" type="number" min="1" value="${S.evalTo}" style="width:72px" aria-label="到第几条结束" />
      <span class="hint">条</span>
      <button type="button" data-a="evalRange" ${rangeCount ? '' : 'disabled'}>评估这个范围（${rangeCount} 条待评）</button>
      <button type="button" data-a="cancelEval" ${evalBusy ? '' : 'disabled'}>取消评估</button></div>
    <div class="grp"><span>分析 / 导出</span>
      <button type="button" class="owner-only" data-a="summary" ${b.summary?.status === 'running' ? 'disabled' : ''}>整体分析（${n ? `选中 ${n}` : '全部'}）</button>
      <button type="button" data-a="export">导出 Excel / JSONL（${n ? `选中 ${n}` : '全部'}）</button></div>`;
  $('bTools').onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a) runAction(a);
  };
  if ($('evMode')) $('evMode').onchange = (e) => {
    S.evalMode = e.target.value;
    localStorage.setItem('lpEvalMode', S.evalMode);
    renderTools();
  };
  if ($('evN')) $('evN').onchange = (e) => {
    S.evalN = Math.max(1, Math.round(Number(e.target.value) || 100));
    localStorage.setItem('lpEvalN', String(S.evalN));
    renderTools();
  };
  for (const [id, k] of [['evFrom', 'evalFrom'], ['evTo', 'evalTo']]) {
    if (!$(id)) continue;
    $(id).onchange = (e) => {
      S[k] = Math.max(1, Math.round(Number(e.target.value) || 1));
      // 起止填反了自动对调
      if (S.evalFrom > S.evalTo) k === 'evalFrom' ? (S.evalTo = S.evalFrom) : (S.evalFrom = S.evalTo);
      localStorage.setItem('lpEvalFrom', String(S.evalFrom));
      localStorage.setItem('lpEvalTo', String(S.evalTo));
      renderTools();
    };
  }
}

// 评估方式：compare = 多环境对比（A vs B）；环境 id = 只评这一个环境（单环境打分，结果另存，不覆盖对比）
function evalMode() {
  const m = S.evalMode ?? localStorage.getItem('lpEvalMode') ?? 'compare';
  return multi() && S.cur.envs.some((e) => String(e.id) === m) ? m : 'compare';
}
const modeEnv = () => (evalMode() === 'compare' ? null : Number(evalMode()));
function modeLabel() {
  const k = S.cur.envs.findIndex((e) => e.id === modeEnv());
  return k < 0 ? (multi() ? '对比评估' : '评估') : `单评 ${L[k]}`;
}
function needsEval(it, mode) {
  if (it.status !== 'done') return false;
  if (mode === 'compare') return it.eval?.status !== 'done';
  return !!it.images[mode] && it.envEvals?.[mode]?.status !== 'done';
}

function runAction(a) {
  const p = `/api/batches/${bid()}`;
  const ids = selIds();
  const ops = {
    retryFailed: () => act(() => api('POST', `${p}/capture`, { scope: 'failed' }), (r) => `已加入队列 ${r.queued} 段对话`),
    shootUnfinished: () => act(() => api('POST', `${p}/capture`, { scope: 'unfinished' }), (r) => `已加入队列 ${r.queued} 段对话`),
    reshootSel: () => confirm(`重新截取选中条目所在的对话？原截图、模型评估和人工标注会被清空。`) &&
      act(() => api('POST', `${p}/capture`, { ids }), (r) => `已加入队列 ${r.queued} 段对话`),
    cancelShoot: () => act(() => api('POST', `${p}/capture/cancel`), '已取消排队'),
    evalSel: () => act(() => api('POST', `${p}/eval`, { ids, envId: modeEnv() }), (r) => `已提交${modeLabel()} ${r.queued} 条（仅截图成功的会评估）`),
    evalRest: () => act(() => api('POST', `${p}/eval`, { ids: S.cur.items.filter((i) => needsEval(i, evalMode())).map((i) => i.id), envId: modeEnv() }), (r) => `已提交${modeLabel()} ${r.queued} 条`),
    // 只评某个序号区间：按卡片上的编号取，跳过已有结果的
    evalRange: () => {
      const mode = evalMode();
      const targets = S.cur.items.filter((i) => i.id >= S.evalFrom && i.id <= S.evalTo && needsEval(i, mode)).sort((a, b) => a.id - b.id);
      if (!targets.length) return toast('这个范围内没有待评估的条目');
      return act(() => api('POST', `${p}/eval`, { ids: targets.map((i) => i.id), envId: modeEnv() }),
        (r) => `已提交${modeLabel()} ${r.queued} 条（第 ${S.evalFrom}～${S.evalTo} 条里未评估的）`);
    },
    // 只评前 N 条待评估：按评估顺序（从上到下）取，跳过已有结果的
    evalFirst: () => {
      const mode = evalMode();
      const targets = S.cur.items.filter((i) => needsEval(i, mode)).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || a.turn - b.turn).slice(0, S.evalN);
      if (!targets.length) return toast('没有待评估的条目');
      return act(() => api('POST', `${p}/eval`, { ids: targets.map((i) => i.id), envId: modeEnv() }),
        (r) => `已提交${modeLabel()} ${r.queued} 条（按顺序取前 ${S.evalN} 条待评估的）`);
    },
    cancelEval: () => act(() => api('POST', `${p}/eval/cancel`), '已取消排队中的评估'),
    summary: () => act(async () => {
      const r = await api('POST', `${p}/summary`, ids.length ? { ids } : { scope: 'all' });
      S.tab = 'summary';
      return r;
    }, (r) => `整体分析已开始，基于 ${r.count} 条`),
    export: () => openExportDialog(ids),
  };
  ops[a]?.();
}
function populateFilter() {
  const sel = $('fSel');
  const defs = filterDefs();
  if (!defs[S.filter]) S.filter = 'all';
  sel.innerHTML = Object.entries(defs)
    .map(([k, [label, pred]]) => `<option value="${esc(k)}">${esc(label)}（${S.cur.items.filter(pred).length}）</option>`)
    .join('');
  sel.value = S.filter;
}

function cardHtml(it) {
  const sel = S.sel.has(it.id);
  const envs = S.cur.envs;
  const thumbs = envs.map((e, k) => `<div class="c">${it.images[e.id] ? `<img src="${it.images[e.id]}" alt="" loading="lazy" />` : `<span>${it.status === 'done' ? '无此轮' : ST[it.status]}</span>`}${envs.length > 1 ? `<span class="lb">${L[k]} ${esc(e.name)}</span>` : ''}</div>`).join('');
  const ev = it.eval?.status ? `<span class="badge ${it.eval.status === 'failed' ? 'failed' : it.eval.status === 'done' ? 'done' : ''}">${EV[it.eval.status]}</span>` : '';
  const mp = modelPref(it);
  const scores = envs.map((_, k) => modelScore(it, k)).filter((x) => typeof x === 'number');
  const mineM = myMark(it);
  const nMark = annotators(it).length;
  return `<div class="it ${sel ? 'sel' : ''}" data-id="${it.id}">
    <input type="checkbox" class="ck" ${sel ? 'checked' : ''} aria-label="选择 ${esc(it.query)}" />
    <button type="button" class="th" data-open="${it.id}" aria-label="查看 ${esc(it.query)}">${thumbs}</button>
    <div class="bd">
      <div class="q" title="${esc(it.query)}">${it.id}. ${esc(it.query)}</div>
      <div class="hint">chat ${it.chatId}${it.turn > 1 || it.context?.length ? ` · 第 ${it.turn} 轮` : ''}</div>
      <div class="row" style="gap:4px;margin-top:4px">
        <span class="badge ${it.status}">${ST[it.status]}${it.status === 'shooting' ? '…' : ''}</span>${ev}
        ${modelGsb(it) !== null ? `<span class="tag">模型 ${gsbTag(modelGsb(it))}</span>` : mp ? `<span class="tag">模型 ${prefLabel(mp)}</span>` : ''}
        ${scores.length ? `<span class="score">${scores.join(' : ')}</span>` : ''}
        ${envs.length > 1 ? envs.map((e, k) => { const x = it.envEvals?.[e.id]; return x?.status === 'done' && typeof x.score === 'number' ? `<span class="tag" title="单环境评估">单评 ${L[k]} <b class="score">${x.score}</b></span>` : x?.status === 'failed' ? `<span class="tag err">单评 ${L[k]} 失败</span>` : ['queued', 'running'].includes(x?.status) ? `<span class="tag">单评 ${L[k]}…</span>` : ''; }).join('') : ''}
        ${(() => {
          const val = typeof mineM?.gsb === 'number' ? gsbTag(mineM.gsb) : mineM?.rating ? RT[mineM.rating] : '';
          if (!val) {
            // 我还没标：别人标过就提示一句，不算成我的标注
            return nMark ? `<span class="tag" style="background:#f3f4f6;color:#9ca3af" title="${esc(annotators(it).map((k) => `${k} ${markText(it.manuals[k])}`).join(' / '))}">他人已标 ${nMark} 人${diverge(it) ? ' · <span class="warn">有分歧</span>' : ''}</span>` : '';
          }
          return `<span class="tag" title="${esc(annotators(it).map((k) => `${k} ${markText(it.manuals[k])}`).join(' / '))}">人工 ${val}${nMark > 1 ? `（${nMark} 人，均 ${fmtG(it.manual?.gsb ?? 0)}）` : ''}${diverge(it) ? ' <span class="warn" title="多人标注有分歧">●</span>' : ''}</span>`;
        })()}
      </div>
      ${it.error ? `<div class="hint ${it.status === 'failed' ? 'err' : 'warn'}" style="margin-top:4px">${esc(it.error)}</div>` : ''}
      ${it.eval?.status === 'failed' ? `<div class="hint err" style="margin-top:4px">评估失败：${esc(it.eval.error)}</div>` : ''}
    </div></div>`;
}

// 虚拟滚动：只渲染可视区域附近的卡片，4923 条也不会一次画出上万个节点
const ROW_H = 346; // 卡片固定高度 + 行间距
const COL_W = 262; // 每列最小宽度
let gridWin = { key: '', start: -1, cols: 0 };

function gridCols() {
  const w = $('grid').clientWidth || 900;
  return Math.max(1, Math.floor((w + 12) / COL_W));
}

function renderGridWindow() {
  const list = visibleItems();
  const main = document.querySelector('section.main');
  if (!list.length) {
    $('grid').innerHTML = `<p class="hint">${S.cur.items.length ? '没有符合条件的条目' : S.cur.enum.status === 'running' ? '正在拉取对话列表…' : '还没有条目'}</p>`;
    return;
  }
  const cols = gridCols();
  const rows = Math.ceil(list.length / cols);
  const gridTop = $('grid').getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
  const viewRows = Math.ceil(main.clientHeight / ROW_H) + 4;
  const start = Math.max(0, Math.min(rows - 1, Math.floor((main.scrollTop - gridTop) / ROW_H)));
  gridWin = { key: `${S.cur.id}|${S.filter}|${S.search}|${list.length}|${cols}`, start, cols };
  const end = Math.min(rows, start + viewRows);
  const slice = list.slice(start * cols, end * cols);
  const rowHtml = [];
  for (let r = start; r < end; r++) {
    rowHtml.push(`<div class="grow" style="grid-template-columns:repeat(${cols}, minmax(0,1fr))">${slice.slice((r - start) * cols, (r - start + 1) * cols).map(cardHtml).join('')}</div>`);
  }
  $('grid').innerHTML = `<div style="height:${start * ROW_H}px"></div>${rowHtml.join('')}<div style="height:${(rows - end) * ROW_H}px"></div>`;
}

function renderGrid() {
  populateFilter();
  const list = visibleItems();
  const cols = gridCols();
  const key = `${S.cur.id}|${S.filter}|${S.search}|${list.length}|${cols}`;
  // 只有换批次 / 换筛选 / 列数变化才重置滚动位置，轮询刷新时保持不动
  if (key !== gridWin.key && gridWin.key) {
    const main = document.querySelector('section.main');
    main.scrollTop = 0;
  }
  renderGridWindow();
  const n = selIds().length;
  $('selInfo').textContent = n ? `已选 ${n} 条` : '';
  $('selAll').checked = list.length > 0 && list.every((i) => S.sel.has(i.id));
  renderTools();
}

// 滚动时按需补渲染（节流到下一帧）
let scrollTick = null;
document.addEventListener('scroll', (e) => {
  if (!e.target.matches?.('section.main') || S.tab !== 'items' || !S.cur) return;
  if (scrollTick) return;
  scrollTick = requestAnimationFrame(() => {
    scrollTick = null;
    const list = visibleItems();
    if (!list.length) return;
    const cols = gridCols();
    const main = e.target;
    const rows = Math.ceil(list.length / cols);
    const gridTop = $('grid').getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    const start = Math.max(0, Math.min(rows - 1, Math.floor((main.scrollTop - gridTop) / ROW_H)));
    if (start !== gridWin.start || cols !== gridWin.cols) renderGridWindow();
  });
}, true);

function onGridClick(e) {
  const card = e.target.closest('.it');
  if (!card) return;
  const id = Number(card.dataset.id);
  if (e.target.classList.contains('ck')) {
    e.target.checked ? S.sel.add(id) : S.sel.delete(id);
    return renderGrid();
  }
  if (e.target.closest('[data-open]')) openViewer(id);
}

function renderSummary() {
  const s = S.cur.summary;
  const n = selIds().length;
  const head = `<div class="row"><h2 style="margin:0">整体分析</h2><span class="spacer"></span>
    <button type="button" id="sumRun" class="owner-only" ${s?.status === 'running' ? 'disabled' : ''}>${s ? '重新分析' : '开始分析'}（${n ? `选中 ${n}` : '全部'}）</button></div>
    <p class="hint">基于逐条的模型评估和人工标注生成，不会重新读图。重截、重新评估或修改标注后需重新分析。</p>`;
  let body = '<p class="hint">还没有整体分析。</p>';
  if (s?.status === 'running') body = '<p>分析中…</p>';
  else if (s?.status === 'failed') body = `<p class="err">分析失败：${esc(s.error)}</p>`;
  else if (s?.text) body = `<p class="hint">基于 ${s.itemIds?.length || 0} 条 · 模型 ${esc(s.model || '')} · ${s.at ? new Date(s.at).toLocaleString('zh-CN') : ''}</p>${md(s.text)}`;
  $('tabSummary').innerHTML = head + body;
  $('sumRun').onclick = () => runAction('summary');
}
// ---------- 对比查看：左侧各环境并排（共用滚动条），右侧上文 / 人工标注 / 模型评估 ----------
const curItem = () => S.cur?.items.find((i) => i.id === S.viewer.id);

function openViewer(id) {
  S.viewer.open = true;
  S.viewer.id = id;
  $('viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  renderViewer(true);
}

function closeViewer() {
  S.viewer.open = false;
  $('viewer').hidden = true;
  document.body.style.overflow = '';
  renderGrid();
}

function stepViewer(d) {
  const list = visibleItems();
  const next = list[list.findIndex((x) => x.id === S.viewer.id) + d];
  if (!next) return toast(d > 0 ? '已经是最后一条' : '已经是第一条');
  S.viewer.id = next.id;
  renderViewer(true);
  $('vimgWrap').scrollTop = 0;
}

let stageKey = '';
function renderStage(force) {
  const it = curItem();
  const mode = S.viewer.mode === 'compare' && it.compareImage ? 'compare' : 'split';
  const key = `${it.id}|${mode}|${it.shotAt}|${it.compareImage}`;
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.mode === mode);
    if (b.dataset.mode === 'compare') b.disabled = !it.compareImage;
  });
  if (!force && key === stageKey) return; // 轮询刷新时不重建图片，避免滚动位置被重置
  stageKey = key;
  const cols = mode === 'compare'
    ? [`<div class="col"><img data-w="1" src="${it.compareImage}" alt="左右拼图" /></div>`]
    : S.cur.envs.map((e, k) => `<div class="col"><div class="hd">${S.cur.envs.length > 1 ? `${L[k]} · ` : ''}${esc(e.name)}</div>${it.images[e.id]
        ? `<img src="${it.images[e.id]}" alt="${esc(e.name)} 的回答截图" />` : `<div class="none">${it.status === 'done' ? '这个环境没有这一轮' : ST[it.status]}</div>`}</div>`);
  $('vstage').innerHTML = cols.join('');
  $('vstage').querySelectorAll('img').forEach((img) => (img.onload = applyZoom));
  applyZoom();
}

// fit=各栏平分可用宽度（单栏不超过 2 倍手机宽）；phone=按手机 CSS 宽度 430；数字=百分比
function applyZoom() {
  const imgs = [...$('vstage').querySelectorAll('img')];
  if (!imgs.length) return;
  const n = $('vstage').children.length;
  const avail = $('vimgWrap').clientWidth - 32 - 16 * (n - 1);
  const z = S.viewer.zoom;
  const isCmp = imgs[0].dataset.w;
  const base = isCmp ? (imgs[0].naturalWidth || 1000) / 2 : 430; // 截图为 2 倍像素
  let w = z === 'fit' ? Math.min(avail / n, base * 2) : z === 'phone' ? base : base * (z / 100);
  w = Math.max(120, w);
  S.viewer.scale = w / base;
  for (const img of imgs) img.style.width = `${Math.round(w)}px`;
  $('vstage').querySelectorAll('.none').forEach((x) => (x.style.width = `${Math.round(w)}px`));
  $('zoomText').textContent = `${Math.round(S.viewer.scale * 100)}%`;
}

document.querySelector('.vimg .bar').onclick = (e) => {
  const m = e.target.closest('[data-mode]')?.dataset.mode;
  if (m) {
    S.viewer.mode = m;
    localStorage.setItem('lpViewMode', m);
    return renderStage(true);
  }
  const z = e.target.closest('[data-zoom]')?.dataset.zoom;
  if (!z) return;
  const pct = Math.round(S.viewer.scale * 100);
  S.viewer.zoom = z === '+' ? Math.min(300, pct + 10) : z === '-' ? Math.max(20, pct - 10) : z;
  applyZoom();
};
window.addEventListener('resize', () => S.viewer.open && applyZoom());

document.addEventListener('keydown', (e) => {
  if (!S.viewer.open || ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowRight') stepViewer(1);
  else if (e.key === 'ArrowLeft') stepViewer(-1);
  else if (multi() && ['1', '2', '3', '4', '5'].includes(e.key)) setManual('gsb', GSB[Number(e.key) - 1]);
  else if (['1', '2', '3'].includes(e.key)) setManual('rating', { 1: 'good', 2: 'ok', 3: 'bad' }[e.key]);
  else if ((e.key === 'e' || e.key === 'E') && S.role === 'owner') $('vEval')?.click();
});

async function setManual(k, v) {
  const it = curItem();
  if (!it) return;
  if (!S.canWrite) return toast('你不在可标注名单里，只能查看', true);
  const mineM = myMark(it);
  const val = mineM?.[k] === v ? null : v;
  it.manuals ??= {};
  it.manuals[myName()] = { ...(it.manuals[myName()] || {}), [k]: val, at: new Date().toISOString() };
  renderViewer(false);
  const r = await api('PATCH', `/api/batches/${bid()}/items/${it.id}`, { manual: { [k]: val } }).catch((e) => toast(e.message, true));
  // 以服务端返回的「我的标注 + 汇总」为准
  if (r?.manuals) it.manuals = r.manuals;
  if (r?.manual) it.manual = r.manual;
}
// 评估进行中显示已等待时长；完成后显示耗时（模型要读图并写较长的理由，单条通常 30–90 秒）
const waitText = (e) => e.status === 'queued' ? '评估排队中…' : `评估中… 已 ${e.startedAt ? Math.max(0, Math.round((Date.now() - new Date(e.startedAt)) / 1000)) : '?'} 秒（读图并写理由，通常 30–90 秒）`;
const took = (e) => (e?.durationMs ? ` · 耗时 ${Math.round(e.durationMs / 1000)} 秒` : '');

function renderViewer(force) {
  const it = curItem();
  if (!it) return closeViewer();
  renderStage(force);
  if (!force && document.activeElement?.id === 'vNote') return; // 正在写备注时不刷新，避免打断输入
  const list = visibleItems();
  const pos = list.findIndex((x) => x.id === it.id) + 1;
  const ev = it.eval;
  const envs = S.cur.envs;
  let evalHtml = '';
  if (ev?.status === 'queued' || ev?.status === 'running') evalHtml = `<p>${waitText(ev)}${ev.error ? `<br><span class="hint warn">${esc(ev.error)}</span>` : ''}</p>`;
  else if (ev?.status === 'failed') evalHtml = `<p class="err">评估失败：${esc(ev.error)}</p>`;
  if (ev?.text && ev.status !== 'running') {
    const u = ev.usage;
    const usage = u ? ` · 输入 ${u.prompt_tokens || u.input_tokens || 0} tokens，缓存命中 ${ev.cachedTokens || 0}` : '';
    const sc = envs.map((e, k) => [k, modelScore(it, k)]).filter(([, x]) => typeof x === 'number');
    const head = [modelGsb(it) !== null ? `模型 ${gsbTag(modelGsb(it))}` : modelPref(it) ? `偏好 ${prefLabel(modelPref(it))}` : '', sc.length ? `总分 ${sc.map(([k, x]) => `${envs.length > 1 ? `${L[k]} ` : ''}<b class="score">${x}</b>`).join(' / ')}` : ''].filter(Boolean).join(' · ');
    evalHtml += `<p class="hint">${head ? `${head} · ` : ''}${esc(ev.model || '')}${ev.effort && ev.effort !== 'auto' ? ` · 思考 ${esc(ev.effort)}` : ''} · ${ev.at ? new Date(ev.at).toLocaleString('zh-CN') : ''}${took(ev)}${usage}</p>${md(ev.text)}`;
  }
  if (!evalHtml) evalHtml = '<p class="hint">尚未进行模型评估。</p>';
  // 多环境批次：每个环境还可以单独打分（不和另一个环境比较），结果与对比评估分开保存。结论直接显示，明细折叠
  const singleHtml = multi() ? envs.map((e, k) => {
    const s = it.envEvals?.[e.id];
    const busy = ['queued', 'running'].includes(s?.status);
    const head = s?.status === 'done' ? `${typeof s.score === 'number' ? `总分 <b class="score">${s.score}</b>/10 · ` : ''}${esc(s.model || '')} · ${s.at ? new Date(s.at).toLocaleString('zh-CN') : ''}${took(s)}`
      : busy ? `${waitText(s)}${s.error ? ` <span class="warn">${esc(s.error)}</span>` : ''}` : s?.status === 'failed' ? `<span class="err">评估失败：${esc(s.error)}</span>` : '未评估';
    const [lead, ...rest] = String(s?.text || '').split(/\n\n/);
    const showLead = s?.text && s.status !== 'running' && /^\*\*结论\*\*/.test(lead);
    const detail = showLead ? rest.join('\n\n') : s?.text;
    return `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">
      <div class="row">${envTag(k, e.name)}<span class="hint">${head}</span><span class="spacer"></span>
        <button type="button" class="sm owner-only" data-single="${e.id}" ${it.images[e.id] && !busy ? '' : 'disabled'}>${s?.text ? '重新单评' : '单独评估'}</button></div>
      ${showLead ? md(lead) : ''}
      ${detail && s.status !== 'running' ? `<details data-sd="${e.id}" ${S.viewer.sd?.has(String(e.id)) ? 'open' : ''}><summary>${showLead ? '问题与维度明细' : '查看单评详情'}</summary>${md(detail)}</details>` : ''}</div>`;
  }).join('') : '';
  const m = myMark(it);
  const SUB = { '-1': '明显', '-0.5': '略好', 0: '持平', 0.5: '略好', 1: '明显' };
  const manual = multi()
    ? `<div class="gsb-ends"><span class="a">← A ${esc(envs[0]?.name)} 更好</span><span class="b">B ${esc(envs[1]?.name)} 更好 →</span></div>
      <div class="gsb" role="group" aria-label="人工打分" ${S.canWrite ? '' : 'style="opacity:.5;pointer-events:none"'}>${GSB.map((g, i) => `<button type="button" data-gsb="${g}" class="${g < 0 ? 'A' : g > 0 ? 'B' : 'S'}" aria-pressed="${m.gsb === g}"
        title="${esc(g === 0 ? '两者相当' : `${g < 0 ? envs[0]?.name : envs[1]?.name} ${Math.abs(g) === 1 ? '明显更好' : '略好'}`)}（快捷键 ${i + 1}）"><b>${fmtG(g)}</b><small>${SUB[g]}</small></button>`).join('')}</div>`
    : `<div class="row rate" role="group" aria-label="人工评级">${Object.entries(RT).map(([k, t], i) => `<button type="button" data-rating="${k}" aria-pressed="${m.rating === k}">${t}（${i + 1}）</button>`).join('')}</div>`;
  $('vside').innerHTML = `
    <div class="row"><button type="button" id="vPrev">← 上一条</button><span class="hint">${pos}/${list.length}</span>
      <button type="button" id="vNext">下一条 →</button><span class="spacer"></span><button type="button" id="vClose">关闭</button></div>
    <p class="hint" style="margin:12px 0 0">chat ${it.chatId} · 第 ${it.turn} 轮 · ${envs.map((e, k) => envTag(k, e.name)).join('')}</p>
    ${it.context?.length ? `<details open style="margin-top:6px"><summary>上文（前 ${it.context.length} 轮问题）</summary><ol class="ctx">${it.context.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></details>` : ''}
    <h3 style="margin:8px 0 4px">${it.id}. ${esc(it.query)}</h3>
    <div class="row hint"><span class="badge ${it.status}">${ST[it.status]}</span>
      ${it.shotAt ? `截于 ${new Date(it.shotAt).toLocaleString('zh-CN')}` : ''}
      <a href="${esc(S.cur.source.link.replace(/\/query\/\d+\/\d+/, `/query/${it.chatId}/${S.cur.source.evaluationId}`))}" target="_blank" rel="noopener">打开 labelplus</a>
      ${it.compareImage ? `<a href="${it.compareImage}" download>下载拼图</a> <button type="button" class="sm" id="vCopy">复制拼图</button>` : ''}</div>
    ${it.error ? `<p class="${it.status === 'failed' ? 'err' : 'warn'} hint">${esc(it.error)}</p>` : ''}
    <div class="row" style="margin-top:8px">
      <button type="button" id="vShoot" class="owner-only" title="整段对话重截，会清空该对话各轮的评估与人工标注">重截这段对话</button>
      <button type="button" id="vEval" class="pri owner-only" ${it.status === 'done' ? '' : 'disabled'}>${multi() ? (ev?.text ? '重新对比评估（E）' : '对比评估（E）') : ev?.text ? '重新评估（E）' : '模型评估（E）'}</button></div>

    <h4 style="margin:16px 0 6px">人工${multi() ? '偏好' : '评级'} <span class="hint" style="font-weight:400">快捷键 ${multi() ? '1–5' : '1–3'}</span>${S.canWrite ? '' : ' <span class="warn">你不在可标注名单里，只能查看</span>'}</h4>
    ${manual}
    ${m.at ? `<p class="hint" style="margin:4px 0 0">我的标注${m.by && m.by !== S.me ? `（记在 ${esc(m.by)} 名下）` : ''} · ${new Date(m.at).toLocaleString('zh-CN')} 修改</p>` : ''}
    ${othersMarks(it).length ? `<details style="margin-top:4px"><summary class="hint">其他人也标了（${othersMarks(it).length} 人）${diverge(it) ? ' · <span class="warn">有分歧</span>' : ''}</summary>
      <ul class="ctx">${othersMarks(it).map(([k, x]) => `<li><b>${esc(k)}</b>：${esc(markText(x))}${x.note ? `，备注：${esc(x.note)}` : ''}</li>`).join('')}</ul></details>` : ''}
    ${(S.share.online || []).filter((p) => p.name !== S.me && p.itemId === it.id).map((p) => `<p class="hint warn" style="margin:2px 0 0">${esc(p.name)} 也正在看这一条</p>`).join('')}
    <label class="f" for="vNote">备注</label>
    <textarea id="vNote" rows="3" ${S.canWrite ? '' : 'readonly placeholder="你不在可标注名单里，只能查看"'}>${esc(m.note || '')}</textarea>

    <h4 style="margin:16px 0 6px">${multi() ? '对比评估' : '模型评估'}</h4>${evalHtml}
    ${singleHtml ? `<h4 style="margin:16px 0 0">单环境评估</h4><p class="hint" style="margin:2px 0 0">只看这一个环境打分，不和另一个环境比较；与对比评估分开保存。</p>${singleHtml}` : ''}`;
  $('vside').querySelectorAll('[data-sd]').forEach((d) => (d.ontoggle = () => {
    S.viewer.sd ??= new Set();
    d.open ? S.viewer.sd.add(d.dataset.sd) : S.viewer.sd.delete(d.dataset.sd); // 轮询重绘时保持展开状态
  }));
  $('vside').querySelectorAll('[data-single]').forEach((btn) => (btn.onclick = () =>
    act(() => api('POST', `/api/batches/${bid()}/eval`, { ids: [it.id], envId: Number(btn.dataset.single) }), '已提交单环境评估')));
  $('vPrev').onclick = () => stepViewer(-1);
  $('vNext').onclick = () => stepViewer(1);
  $('vClose').onclick = closeViewer;
  $('vShoot').onclick = () => confirm('重截这段对话的全部轮次？') && act(() => api('POST', `/api/batches/${bid()}/capture`, { ids: [it.id] }), '已加入截图队列');
  $('vEval').onclick = () => act(() => api('POST', `/api/batches/${bid()}/eval`, { ids: [it.id] }), '已提交评估');
  if ($('vCopy')) $('vCopy').onclick = () => copyImage(it.compareImage);
  $('vside').querySelectorAll('[data-gsb]').forEach((b) => (b.onclick = () => setManual('gsb', Number(b.dataset.gsb))));
  $('vside').querySelectorAll('[data-rating]').forEach((b) => (b.onclick = () => setManual('rating', b.dataset.rating)));
  $('vNote').onblur = (e) => {
    if (e.target.value === (it.manual?.note || '')) return;
    it.manual = { ...(it.manual || {}), note: e.target.value };
    api('PATCH', `/api/batches/${bid()}/items/${it.id}`, { manual: { note: e.target.value } }).then((r) => {
      if (r?.manual) it.manual = r.manual;
      toast('备注已保存');
    }, (err) => toast(err.message, true));
  };
}

async function copyImage(url) {
  try {
    const blob = await (await fetch(url)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
    toast('已复制，可直接粘贴到文档或 PPT');
  } catch (e) {
    toast(`复制失败（${e.message}），请用「下载拼图」`, true);
  }
}
// ---------- 导出 ----------
const EXPORT_FIELDS = [
  ['context', '上文（多轮时前几轮问题）'], ['status', '截图状态'], ['img', '各环境截图（嵌入图片）'], ['cmp', '左右拼图（嵌入图片）'],
  ['model', '模型偏好与总分'], ['dims', '各维度分数'], ['eval', '模型评估全文'], ['single', '单环境评估（各环境总分与全文）'], ['manual', '人工偏好 / 评级与备注'],
  ['file', '截图文件路径'], ['summary', '整体分析（单独工作表）'],
];
const DEFAULT_OFF = ['cmp', 'file']; // 拼图与单图重复，默认不嵌，控制文件体积
let exportIds = [];
function openExportDialog(ids) {
  exportIds = ids;
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem('lpExportFields'));
  } catch {
    saved = null;
  }
  const checked = (k) => (Array.isArray(saved) ? saved.includes(k) : !DEFAULT_OFF.includes(k));
  $('expFields').innerHTML = EXPORT_FIELDS.map(([k, label]) => `<label><input type="checkbox" value="${k}" ${checked(k) ? 'checked' : ''}/> ${esc(label)}</label>`).join('');
  $('dlgExport').showModal();
}
const exportQs = () => {
  const qs = new URLSearchParams();
  if (exportIds.length) qs.set('ids', exportIds.join(','));
  return qs;
};
$('expAll').onclick = () => $('expFields').querySelectorAll('input').forEach((c) => (c.checked = true));
$('expNone').onclick = () => $('expFields').querySelectorAll('input').forEach((c) => (c.checked = false));
$('expGo').onclick = () => {
  const sel = [...$('expFields').querySelectorAll('input:checked')].map((c) => c.value);
  localStorage.setItem('lpExportFields', JSON.stringify(sel));
  const qs = exportQs();
  qs.set('fields', sel.join(','));
  qs.set('quality', document.querySelector('input[name=expQ]:checked').value);
  $('dlgExport').close();
  toast('正在生成 Excel，条目多时需要等一会…');
  location.href = `/api/batches/${bid()}/export?${qs}`;
};
$('expJsonl').onclick = () => {
  $('dlgExport').close();
  location.href = `/api/batches/${bid()}/export.jsonl?${exportQs()}`;
};

// ---------- 启动 ----------
(async () => {
  let s = await refreshStatus();
  if (S.role === 'guest' || s?.share?.enabled) ensureName();
  await refresh().catch(() => {});
  const last = localStorage.getItem('lpBatch');
  const first = S.batches.find((b) => b.id === last) || S.batches[0];
  if (first) await openBatch(first.id).catch(() => renderNew());
  else renderNew();
  s = await refreshStatus();
  if (s && S.role === 'owner' && !s.cookie) openCookie();
  loop();
  syncManual();
})();

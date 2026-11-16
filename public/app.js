// 前端：批次管理、条目网格（每轮一张卡，各环境缩略图并排）、对比查看与人工标注、单条/批量模型评估、整体分析、导出
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ST = { pending: '未开始', queued: '排队中', shooting: '截图中', done: '成功', failed: '失败' };
const EV = { queued: '评估排队', running: '评估中', done: '已评估', failed: '评估失败' };
const RT = { good: '好', ok: '中', bad: '差' };
const ENUM = { running: '拉取中', paused: '已暂停拉取', done: '已拉完', failed: '拉取失败' };
const L = ['A', 'B', 'C', 'D'];

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
};

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
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

// ---------- 顶栏状态 ----------
async function refreshStatus() {
  const s = await api('GET', '/api/status').catch(() => null);
  if (!s) return;
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
  $('sKey').value = '';
  $('sKey').placeholder = c.hasKey ? `已保存 ${c.keyMask}（留空则不修改）` : '未设置';
  $('sEval').value = c.judgePrompt;
  $('sEval').placeholder = `留空时：多环境用默认对比 Prompt，单环境用默认打分 Prompt\n\n${c.defaultComparePrompt}`;
  $('sSum').value = c.summaryPrompt;
  $('sSum').placeholder = c.defaultSummaryPrompt;
  $('sCache').checked = c.cacheControl;
  $('sCConc').value = c.captureConcurrency;
  $('sCRetry').value = c.captureRetries;
  $('sConc').value = c.evalConcurrency;
  $('sEvalRetry').value = c.evalRetries;
  $('sMsg').textContent = '';
  $('dlgSettings').showModal();
}
async function saveSettings() {
  S.cfg = await api('POST', '/api/config', {
    baseUrl: $('sBase').value, apiKey: $('sKey').value, model: $('sModel').value,
    judgePrompt: $('sEval').value, summaryPrompt: $('sSum').value, cacheControl: $('sCache').checked,
    captureConcurrency: Number($('sCConc').value), captureRetries: Number($('sCRetry').value),
    evalConcurrency: Number($('sConc').value), evalRetries: Number($('sEvalRetry').value),
  });
}
$('btnSettings').onclick = openSettings;
$('sSave').onclick = async () => {
  try {
    await saveSettings();
    $('dlgSettings').close();
    toast('设置已保存');
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
    else $('sEval').value = k === 'single' ? S.cfg.defaultSinglePrompt : S.cfg.defaultComparePrompt;
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
  const remain = p.total - p.pos + 1;
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
      <legend class="hint">范围（顺着「下一条」往后取）</legend>
      <label><input type="radio" name="nScope" value="1" checked /> 仅这一条</label>
      <label style="margin-left:16px"><input type="radio" name="nScope" value="n" /> 前 <input id="nN" type="number" min="1" value="${Math.min(100, remain)}" style="width:80px" /> 条</label>
      <label style="margin-left:16px"><input type="radio" name="nScope" value="0" /> 剩余全部（${remain} 条，3 并发约 ${Math.ceil((remain * 6) / 60)} 分钟）</label>
    </fieldset>
    <label style="display:block;margin-top:10px"><input id="nTrim" type="checkbox" checked /> 只保留问题与答案正文（裁掉工具栏、推荐问题、评估角标）</label>
    <label class="f" for="nName">批次名称（可选）</label>
    <input id="nName" type="text" placeholder="例如 genui 联调 vs 线上 · 11月第3周" />
    <div class="row" style="margin-top:14px"><button id="nGo" class="pri" type="button" ${on.length ? '' : 'disabled'}>创建并开始截图</button>
      <span class="hint">${on.length > 1 ? `将对比 ${on.map((id, i) => `${L[i]}=${esc(name(id))}`).join('，')}` : on.length ? '单环境：模型评估按单图打分' : '至少选一个环境'}</span></div>`;
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
    const b = await api('POST', '/api/batches', { link: p.link, name: $('nName').value, envIds: on, limit, trim: $('nTrim').checked });
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
      S.cur = await api('GET', `/api/batches/${encodeURIComponent(S.cur.id)}`);
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
  S.cur = await api('GET', `/api/batches/${encodeURIComponent(id)}`);
  localStorage.setItem('lpBatch', id);
  renderList();
  renderBatch(true);
}

// 有进行中的任务时 2 秒轮询，否则 8 秒
async function loop() {
  const s = await refreshStatus();
  const b = S.cur;
  const busy =
    s?.capture.running || s?.login?.status === 'waiting' ||
    (b && (b.enum.status === 'running' || b.counts.queued || b.evalPending || b.items.some((i) => ['running', 'queued'].includes(i.eval?.status)) || b.summary?.status === 'running'));
  if (busy) await refresh().catch(() => {});
  setTimeout(loop, busy ? 2000 : 8000);
}

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
  if (multi()) {
    for (const p of [...L.slice(0, S.cur.envs.length), 'same']) {
      const label = p === 'same' ? '持平' : `${p} 更好`;
      defs[`m:${p}`] = [`模型：${label}`, (i) => modelPref(i) === p];
      defs[`h:${p}`] = [`人工：${label}`, (i) => i.manual?.pref === p];
    }
    defs.conflict = ['人工与模型不一致', (i) => i.manual?.pref && modelPref(i) && i.manual.pref !== modelPref(i)];
  } else {
    for (const [k, t] of Object.entries(RT)) defs[`r:${k}`] = [`人工评${t}`, (i) => i.manual?.rating === k];
  }
  return defs;
}
const visibleItems = () => {
  const pred = (filterDefs()[S.filter] || FILTERS.all)[1];
  const q = S.search.toLowerCase();
  return S.cur.items.filter((i) => pred(i) && (!q || i.query.toLowerCase().includes(q) || String(i.chatId).includes(q)));
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
          <button type="button" id="bRename">重命名</button><button type="button" id="bDel" class="danger">删除批次</button></div>
        <div id="bEnum" class="hint" style="margin-top:6px"></div>
        <div id="bStats" class="stats hint" style="margin-top:4px"></div>
        <div class="toolbar" id="bTools" style="margin-top:10px"></div>
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
  $('bStats').innerHTML = `<span>${c.chats} 段对话 · ${c.total} 轮</span><span class="ok">成功 ${c.done}</span><span class="err">失败 ${c.failed}</span><span>进行中 ${c.queued}</span><span>未开始 ${c.pending}</span><span>模型已评估 ${c.evaluated}</span><span>人工已标注 ${c.rated}</span>${prefStats(b)}${tokenInfo(b.tokens)}`;
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
  const lim = S.cur.source.limit;
  const target = lim || (e.total ? `剩余全部（共 ${e.total}）` : '剩余全部');
  const btn = e.status === 'running' ? '<button type="button" class="sm" id="enStop">停止拉取</button>'
    : e.next && (!lim || e.count < lim) ? '<button type="button" class="sm" id="enGo">继续拉取</button>' : '';
  $('bEnum').innerHTML = `${ENUM[e.status] || e.status}：已取 ${e.count} / ${target} 段对话 ${btn}${e.error ? ` <span class="${e.status === 'failed' ? 'err' : 'warn'}">${esc(e.error)}</span>` : ''}`;
  if ($('enStop')) $('enStop').onclick = () => act(() => api('POST', `/api/batches/${bid()}/enumerate/stop`), '已停止拉取，已取到的会继续截图');
  if ($('enGo')) $('enGo').onclick = () => act(() => api('POST', `/api/batches/${bid()}/enumerate`), '继续拉取');
}

// 胜率条：模型与人工各一行
function prefStats(b) {
  if (b.envs.length < 2) {
    const s = b.items.map((i) => i.eval?.status === 'done' ? i.eval.score : null).filter((x) => typeof x === 'number');
    return s.length ? `<span>平均总分 <b class="score">${(s.reduce((a, x) => a + x, 0) / s.length).toFixed(1)}</b></span>` : '';
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
  return `${line('模型', modelPref)}${line('人工', (i) => i.manual?.pref)}${avg ? `<span>平均总分 ${avg}</span>` : ''}`;
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
  const unevaluated = b.items.filter(FILTERS.unevaluated[1]).length;
  const evalBusy = b.evalPending || b.items.some((i) => ['queued', 'running'].includes(i.eval?.status));
  $('bTools').innerHTML = `
    <div class="grp"><span>截图</span>
      <button type="button" data-a="retryFailed" ${c.failed ? '' : 'disabled'}>重试失败（${c.failed}）</button>
      <button type="button" data-a="shootUnfinished" ${c.failed + c.pending ? '' : 'disabled'}>截取未完成（${c.failed + c.pending}）</button>
      <button type="button" data-a="reshootSel" ${n ? '' : 'disabled'} title="按所在对话整段重截">重截选中（${n}）</button>
      <button type="button" data-a="cancelShoot" ${c.queued ? '' : 'disabled'}>取消排队</button></div>
    <div class="grp"><span>模型评估</span>
      <button type="button" data-a="evalSel" ${n ? '' : 'disabled'}>评估选中（${n}）</button>
      <button type="button" data-a="evalRest" class="pri" ${unevaluated ? '' : 'disabled'}>批量评估待评估（${unevaluated}）</button>
      <button type="button" data-a="cancelEval" ${evalBusy ? '' : 'disabled'}>取消评估</button></div>
    <div class="grp"><span>分析 / 导出</span>
      <button type="button" data-a="summary" ${b.summary?.status === 'running' ? 'disabled' : ''}>整体分析（${n ? `选中 ${n}` : '全部'}）</button>
      <button type="button" data-a="export">导出 Excel / JSONL（${n ? `选中 ${n}` : '全部'}）</button></div>`;
  $('bTools').onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a) runAction(a);
  };
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
    evalSel: () => act(() => api('POST', `${p}/eval`, { ids }), (r) => `已提交评估 ${r.queued} 条（仅截图成功的会评估）`),
    evalRest: () => act(() => api('POST', `${p}/eval`, { ids: S.cur.items.filter(FILTERS.unevaluated[1]).map((i) => i.id) }), (r) => `已提交评估 ${r.queued} 条`),
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

function renderGrid() {
  populateFilter();
  const list = visibleItems();
  const envs = S.cur.envs;
  $('grid').innerHTML = list.length
    ? list
        .map((it) => {
          const sel = S.sel.has(it.id);
          const thumbs = envs.map((e, k) => `<div class="c">${it.images[e.id] ? `<img src="${it.images[e.id]}" alt="" loading="lazy" />` : `<span>${it.status === 'done' ? '无此轮' : ST[it.status]}</span>`}${envs.length > 1 ? `<span class="lb">${L[k]} ${esc(e.name)}</span>` : ''}</div>`).join('');
          const ev = it.eval?.status ? `<span class="badge ${it.eval.status === 'failed' ? 'failed' : it.eval.status === 'done' ? 'done' : ''}">${EV[it.eval.status]}</span>` : '';
          const mp = modelPref(it);
          const scores = envs.map((_, k) => modelScore(it, k)).filter((x) => typeof x === 'number');
          return `<div class="it ${sel ? 'sel' : ''}" data-id="${it.id}">
            <input type="checkbox" class="ck" ${sel ? 'checked' : ''} aria-label="选择 ${esc(it.query)}" />
            <button type="button" class="th" data-open="${it.id}" aria-label="查看 ${esc(it.query)}">${thumbs}</button>
            <div class="bd">
              <div class="q" title="${esc(it.query)}">${it.id}. ${esc(it.query)}</div>
              <div class="hint">chat ${it.chatId}${it.turn > 1 || it.context?.length ? ` · 第 ${it.turn} 轮` : ''}</div>
              <div class="row" style="gap:4px;margin-top:4px">
                <span class="badge ${it.status}">${ST[it.status]}${it.status === 'shooting' ? '…' : ''}</span>${ev}
                ${mp ? `<span class="tag">模型 ${prefLabel(mp)}</span>` : ''}
                ${scores.length ? `<span class="score">${scores.join(' : ')}</span>` : ''}
                ${it.manual?.pref ? `<span class="tag">人工 ${prefLabel(it.manual.pref)}</span>` : ''}
                ${it.manual?.rating ? `<span class="tag">人工：${RT[it.manual.rating]}</span>` : ''}
              </div>
              ${it.error ? `<div class="hint ${it.status === 'failed' ? 'err' : 'warn'}" style="margin-top:4px">${esc(it.error)}</div>` : ''}
              ${it.eval?.status === 'failed' ? `<div class="hint err" style="margin-top:4px">评估失败：${esc(it.eval.error)}</div>` : ''}
            </div></div>`;
        })
        .join('')
    : `<p class="hint">${S.cur.items.length ? '没有符合条件的条目' : S.cur.enum.status === 'running' ? '正在拉取对话列表…' : '还没有条目'}</p>`;
  const n = selIds().length;
  $('selInfo').textContent = n ? `已选 ${n} 条` : '';
  $('selAll').checked = list.length > 0 && list.every((i) => S.sel.has(i.id));
  renderTools();
}

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
    <button type="button" id="sumRun" ${s?.status === 'running' ? 'disabled' : ''}>${s ? '重新分析' : '开始分析'}（${n ? `选中 ${n}` : '全部'}）</button></div>
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
  else if (['1', '2', '3'].includes(e.key)) {
    if (multi()) setManual('pref', { 1: 'A', 2: 'same', 3: 'B' }[e.key]);
    else setManual('rating', { 1: 'good', 2: 'ok', 3: 'bad' }[e.key]);
  } else if (e.key === 'e' || e.key === 'E') $('vEval')?.click();
});

async function setManual(k, v) {
  const it = curItem();
  if (!it) return;
  const val = it.manual?.[k] === v ? null : v;
  it.manual = { ...(it.manual || {}), [k]: val };
  renderViewer(false);
  await api('PATCH', `/api/batches/${bid()}/items/${it.id}`, { manual: { [k]: val } }).catch((e) => toast(e.message, true));
}
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
  if (ev?.status === 'queued' || ev?.status === 'running') evalHtml = `<p>${EV[ev.status]}…${ev.error ? `<br><span class="hint warn">${esc(ev.error)}</span>` : ''}</p>`;
  else if (ev?.status === 'failed') evalHtml = `<p class="err">评估失败：${esc(ev.error)}</p>`;
  if (ev?.text && ev.status !== 'running') {
    const u = ev.usage;
    const usage = u ? ` · 输入 ${u.prompt_tokens || u.input_tokens || 0} tokens，缓存命中 ${ev.cachedTokens || 0}` : '';
    const sc = envs.map((e, k) => [k, modelScore(it, k)]).filter(([, x]) => typeof x === 'number');
    const head = [modelPref(it) ? `偏好 ${prefLabel(modelPref(it))}` : '', sc.length ? `总分 ${sc.map(([k, x]) => `${envs.length > 1 ? `${L[k]} ` : ''}<b class="score">${x}</b>`).join(' / ')}` : ''].filter(Boolean).join(' · ');
    evalHtml += `<p class="hint">${head ? `${head} · ` : ''}${esc(ev.model || '')} · ${ev.at ? new Date(ev.at).toLocaleString('zh-CN') : ''}${usage}</p>${md(ev.text)}`;
  }
  if (!evalHtml) evalHtml = '<p class="hint">尚未进行模型评估。</p>';
  const m = it.manual || {};
  const manual = multi()
    ? [['A', `A 更好`], ['same', '持平'], ['B', `B 更好`]].map(([k, t], i) => `<button type="button" data-pref="${k}" aria-pressed="${m.pref === k}" title="${k === 'same' ? '' : esc(envs[L.indexOf(k)]?.name)}">${t}（${i + 1}）</button>`).join('')
    : Object.entries(RT).map(([k, t], i) => `<button type="button" data-rating="${k}" aria-pressed="${m.rating === k}">${t}（${i + 1}）</button>`).join('');
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
      <button type="button" id="vShoot" title="整段对话重截，会清空该对话各轮的评估与人工标注">重截这段对话</button>
      <button type="button" id="vEval" class="pri" ${it.status === 'done' ? '' : 'disabled'}>${ev?.text ? '重新评估（E）' : '模型评估（E）'}</button></div>

    <h4 style="margin:16px 0 6px">人工${multi() ? '偏好' : '评级'}</h4>
    <div class="row rate" role="group" aria-label="人工标注">${manual}</div>
    <label class="f" for="vNote">备注</label>
    <textarea id="vNote" rows="3" placeholder="记录亮点、问题，失焦自动保存">${esc(m.note || '')}</textarea>

    <h4 style="margin:16px 0 6px">模型评估</h4>${evalHtml}`;
  $('vPrev').onclick = () => stepViewer(-1);
  $('vNext').onclick = () => stepViewer(1);
  $('vClose').onclick = closeViewer;
  $('vShoot').onclick = () => confirm('重截这段对话的全部轮次？') && act(() => api('POST', `/api/batches/${bid()}/capture`, { ids: [it.id] }), '已加入截图队列');
  $('vEval').onclick = () => act(() => api('POST', `/api/batches/${bid()}/eval`, { ids: [it.id] }), '已提交评估');
  if ($('vCopy')) $('vCopy').onclick = () => copyImage(it.compareImage);
  $('vside').querySelectorAll('[data-pref]').forEach((b) => (b.onclick = () => setManual('pref', b.dataset.pref)));
  $('vside').querySelectorAll('[data-rating]').forEach((b) => (b.onclick = () => setManual('rating', b.dataset.rating)));
  $('vNote').onblur = (e) => {
    if (e.target.value === (it.manual?.note || '')) return;
    it.manual = { ...(it.manual || {}), note: e.target.value };
    api('PATCH', `/api/batches/${bid()}/items/${it.id}`, { manual: { note: e.target.value } }).then(() => toast('备注已保存'), (err) => toast(err.message, true));
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
  ['model', '模型偏好与总分'], ['dims', '各维度分数'], ['eval', '模型评估全文'], ['manual', '人工偏好 / 评级与备注'],
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
  await refresh().catch(() => {});
  const last = localStorage.getItem('lpBatch');
  const first = S.batches.find((b) => b.id === last) || S.batches[0];
  if (first) await openBatch(first.id).catch(() => renderNew());
  else renderNew();
  const s = await refreshStatus();
  if (s && !s.cookie) openCookie();
  loop();
})();

// 测试用的假 labelplus：三个取数接口 + 渲染页 + 一个 OpenAI 兼容的假 VLM。不连内网、不调外部接口。
// 结构仿真实页面：对话区在 overflow:hidden 的固定高度容器里，每轮一个 .chat-qa-container，正文后跟工具栏。
import http from 'node:http';

export const COOKIE = 'UUAP_P_TOKEN=fake; session=ok';
const EVAL = 1258076;
// 三段对话按链表相连；第 2 段是两轮
const CHATS = [
  { id: 101, turns: ['北京三日游攻略'] },
  { id: 102, turns: ['iPhone 17 和 16 有什么区别', '那价格呢'] },
  { id: 103, turns: ['今天天气怎么样'] },
];
const ENVS = [{ id: 11, name: '线上' }, { id: 22, name: '策略-genui-联调' }];

function page(env, chat) {
  const turns = chat.turns.map((q, i) => `
    <div class="chat-qa-container" style="padding:12px">
      <div class="q" style="font-weight:600">${q}</div>
      <div class="answer-container"><div class="ai-entry-block" style="height:${300 + env.id * 10 + i * 80}px;background:${env.id === 11 ? '#fde68a' : '#bfdbfe'}">${env.name} 第 ${i + 1} 轮回答</div></div>
      <div class="toolbar" style="height:60px">工具栏 / 推荐问题</div>
    </div>`).join('');
  return `<!doctype html><html><body style="margin:0">
    <div class="wrap" style="height:932px;overflow:hidden"><div class="inner">${turns}</div></div>
    <div style="position:fixed;bottom:0;left:0;right:0;height:60px;background:#000">输入栏</div></body></html>`;
}

// 含一个 Prompt 里自定义的字段（risk_note），验证页面按模型输出原样展示
const COMPARE = {
  intent: '测试', risk_note: '无明显风险',
  dimensions: [{ name: '需求满足', a: 3, b: 5, reason: 'B 更完整' }, { name: '信息质量', a: 4, b: 4, reason: '相当' }],
  a_issues: ['信息少'], b_issues: [], summary: 'B 更好', gsb: 0.5, preference: 'B',
};
const SINGLE = { intent: '测试', summary: '还行', dimensions: [{ name: '需求满足', score: 4, reason: '完整' }, { name: '信息质量', score: 3, reason: '一般' }] };

export function start(port = 0) {
  let vlmCalls = 0;
  const payloads = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const json = (v) => (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(v)));
    if (url.pathname === '/v1/chat/completions') {
      vlmCalls++;
      // 单环境评估时 user 消息里写的是「回答（环境名）」，返回单环境打分结构
      const out = body.includes('回答（') ? SINGLE : COMPARE;
      payloads.push(JSON.parse(body));
      return json({ choices: [{ message: { content: '```json\n' + JSON.stringify(out) + '\n```' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    }
    const authed = (req.headers.cookie || '').includes('session=ok');
    // 前端页面：未登录时模拟 UUAP 登录页，1 秒后「登录成功」写入持久 Cookie（模拟用户在窗口里完成登录）
    if (url.pathname.startsWith('/labelplus/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(authed ? '<html>labelplus 首页</html>'
        : `<html>UUAP 登录<script>setTimeout(()=>{document.cookie='session=ok; path=/; max-age=86400';document.cookie='UUAP_P_TOKEN=fake; path=/; max-age=86400'},1000)</script></html>`);
    }
    if (!authed) {
      // 真实接口未登录时返回 200 + JSON，而不是登录页
      if (url.pathname.startsWith('/labelplusapi/query/')) return json({ status: '401', message: '请登录！', data: 'https://uuap.example/authorize' });
      return res.writeHead(200, { 'Content-Type': 'text/html' }), res.end('<html>UUAP 登录</html>');
    }
    if (url.pathname === '/labelplusapi/query/base_info') {
      const { query_id } = JSON.parse(body);
      const i = CHATS.findIndex((c) => c.id === query_id);
      if (i < 0) return res.writeHead(200, { 'Content-Type': 'text/plain' }), res.end('record not found'); // 真实接口对不存在的 chat 返回纯文本
      return json({ data: { cur_pos: i + 1, total: CHATS.length, next_chat_id: CHATS[i + 1]?.id || 0, pre_chat_id: CHATS[i - 1]?.id || 0, query_info: CHATS[i].turns.map((q, k) => ({ query_id: query_id * 10 + k, query: q })) } });
    }
    if (url.pathname === '/labelplusapi/query/env_info') {
      const { query_id } = JSON.parse(body);
      const chat = Math.floor(query_id / 10);
      return json({ data: ENVS.map((e) => ({ env_info: { env_id: e.id, env_name: e.name }, crawl_info: { crawl_status: 2 }, page_info: { page_key: `${chat}-${e.id}`, page_size: 1000 } })) });
    }
    if (url.pathname === '/labelplusapi/task/pageKey') {
      const [chat, env] = url.searchParams.get('page_key').split('-').map(Number);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page(ENVS.find((e) => e.id === env), CHATS.find((c) => c.id === chat)));
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    server, port: server.address().port, link: `http://x/labelplus/task/chat/query/101/${EVAL}/0/132`, calls: () => vlmCalls, payloads,
  })));
}

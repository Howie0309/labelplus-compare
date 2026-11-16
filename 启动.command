#!/bin/zsh
# 双击启动 labelplus 对比截图与评估：首次自动安装依赖，已在运行就直接打开网页。关闭这个窗口即停止。
cd "${0:A:h}"
PORT=${PORT:-3230}
URL="http://127.0.0.1:$PORT"

if curl -s -m 2 "$URL/api/status" | grep -q '"labelplus":true'; then
  echo "已在运行，直接打开 $URL"
  open "$URL"
  exit 0
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "$NODE_BIN" ]]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do [[ -x "$c" ]] && NODE_BIN="$c" && break; done
fi
if [[ -z "$NODE_BIN" ]]; then
  echo '未找到 Node.js，请先安装 Node.js 20 或更高版本：https://nodejs.org/zh-cn （或 brew install node）'
  read -k1 '?按任意键退出'; exit 1
fi
if (( $("$NODE_BIN" -p 'process.versions.node.split(".")[0]') < 20 )); then
  echo "Node.js 版本过低（$("$NODE_BIN" -v)），请升级到 20 或更高版本"
  read -k1 '?按任意键退出'; exit 1
fi
export PATH="${NODE_BIN:h}:$PATH"

if [[ ! -d "/Applications/Google Chrome.app" ]]; then
  echo '提示：没找到 Google Chrome。截图和自动登录都需要本机 Chrome，请先安装。'
fi

if [[ ! -d node_modules/sharp || ! -d node_modules/playwright-core || ! -d node_modules/exceljs ]]; then
  echo '首次使用，正在安装依赖（约 1 分钟）…'
  npm install --no-audit --no-fund || { echo '依赖安装失败，请检查网络后重试'; read -k1 '?按任意键退出'; exit 1; }
fi

echo "启动中… 浏览器会自动打开 $URL；关闭这个窗口即停止服务"
( for i in {1..30}; do sleep 0.5; curl -s -m 1 "$URL/api/status" >/dev/null && { open "$URL"; break; }; done ) &
PORT=$PORT exec "$NODE_BIN" server.mjs

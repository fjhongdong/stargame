#!/usr/bin/env bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 20 或更新版本：https://nodejs.org/'
  read -r -p '按回车关闭…' _planet_boom_reply
  exit 1
fi
npm ci --no-audit --no-fund
npm run play

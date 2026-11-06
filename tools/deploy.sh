#!/usr/bin/env bash
# 部署 PWA 到 Cloudflare Pages。
#
# 用法：
#   bash tools/deploy.sh
#
# 前置：本机已用 `npx wrangler@4 login` 授权过（OAuth token 存在用户目录下的
#   .wrangler/config/default.toml），不需要 CLOUDFLARE_API_TOKEN。
#   项目名默认 jieshui，可用 PAGES_PROJECT 覆盖。
#
# 之前还发过一份到 surge.sh，因为 surge 不支持 _headers（CSP 只有 meta 版、
# 缺 frame-ancestors / HSTS），站点已全部 teardown，脚本里不再保留 surge 分支。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && { pwd -W 2>/dev/null || pwd; })"
cd "$ROOT"

# 生成 web/_headers（响应头级 CSP / HSTS / X-Frame-Options 等），Cloudflare Pages 会读它
python tools/gen_headers.py

echo "==> Cloudflare Pages"
PROJECT="${PAGES_PROJECT:-jieshui}"
npx --yes wrangler@4 pages deploy web \
  --project-name "$PROJECT" \
  --commit-dirty=true

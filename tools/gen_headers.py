#!/usr/bin/env python3
"""生成 Cloudflare Pages 用的 _headers 文件（放进 web/ 后随站点一起发布）。

为什么需要它：
  index.html 里已经有 meta 版 CSP 作为兜底，但 meta 版有两条天然短板：
    1. 不支持 frame-ancestors（防不住页面被别的站用 iframe 套走做点击劫持）
    2. 对 rel=preload / 早期资源加载的约束弱于响应头
  Cloudflare Pages 支持 _headers，可以把同一套策略提升为响应头，并补上
  X-Frame-Options / HSTS / Permissions-Policy / COOP 这些没法用 meta 表达的头部。

用法：
  python tools/gen_headers.py            # 写 web/_headers
  python tools/gen_headers.py --remove   # 删掉 web/_headers（本地 http.server 调试时用）
"""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "_headers")

CSP = (
    "default-src 'none'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob:; "
    "connect-src 'self' https://userapi.qiekj.com; "
    "font-src 'self' data:; "
    "manifest-src 'self'; "
    "worker-src 'self'; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'none'; "
    "frame-ancestors 'none'; "
    "upgrade-insecure-requests"
)

BODY = f"""# Cloudflare Pages 响应头（由 tools/gen_headers.py 生成，勿手改）
#
# 目的：网页端防 token 被窃取。三条硬约束在 CSP 里：
#   script-src 'self'      —— 任何注入的 <script>/eval 都不执行，XSS 拿不到 localStorage/sessionStorage
#   connect-src 只列官方   —— 即使有代码被执行，也没法把 token POST 到第三方域名
#   frame-ancestors 'none' —— 页面不能被别的站用 iframe 套走（防点击劫持骗你点「开始接水」）
#
# 注意：index.html 里的 meta 版 CSP 是兜底（缺 frame-ancestors）；正式生效的是本文件生成的响应头。

/*
  Content-Security-Policy: {CSP}
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  X-Permitted-Cross-Domain-Policies: none

# 配置文件本身与诊断页不允许被当成脚本加载
/_headers
  Content-Type: text/plain; charset=utf-8

/sw.js
  Cache-Control: no-cache
  Service-Worker-Allowed: /

# HTML 永远不要强缓存：否则服务端更新后用户仍跑旧版本（这也是之前用户看到旧 Token 界面的原因之一）
/*.html
  Cache-Control: no-cache

/
  Cache-Control: no-cache
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--remove", action="store_true", help="删除 web/_headers")
    a = ap.parse_args()
    if a.remove:
        if os.path.exists(OUT):
            os.remove(OUT)
            print("removed", OUT)
        else:
            print("nothing to remove")
        return 0
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(BODY)
    print("wrote", OUT, os.path.getsize(OUT), "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())

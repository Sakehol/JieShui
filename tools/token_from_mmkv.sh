#!/usr/bin/env bash
# 从模拟器/真机里直接读出胖乖生活已登录账号的 token（不需要抓包、不需要装证书、不需要 root）
#
# 前提：原版 App 已经在这台设备上登录过（打开 App → 我的 → 登录）
#
# 用法：
#   bash tools/token_from_mmkv.sh                 # 用默认 adb 设备
#   bash tools/token_from_mmkv.sh 127.0.0.1:5555  # 指定设备（adb devices 里的序列号）
#   bash tools/token_from_mmkv.sh -               # 只打印 token，方便复制
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && { pwd -W 2>/dev/null || pwd; })"
ADB="$ROOT/build/sdk/platform-tools/adb.exe"
PKG="com.qiekj.user"
MMKV="/data/data/$PKG/files/mmkv/mmkv.default"
OUT="$ROOT/build/mmkv.default"

export MSYS2_ARG_CONV_EXCL="*"

if [ "${1:-}" = "-" ]; then ONLY_TOKEN=1; else ONLY_TOKEN=0; fi
DEV="${1:-}"
[ "$DEV" = "-" ] && DEV=""

if [ -n "$DEV" ]; then
  "$ADB" -s "$DEV" pull "$MMKV" "$OUT" >/dev/null 2>&1
else
  "$ADB" pull "$MMKV" "$OUT" >/dev/null 2>&1
fi

if [ ! -s "$OUT" ]; then
  echo "拉取失败。请确认："
  echo "  1) 模拟器/手机已连接（$ADB devices）"
  echo "  2) 原版胖乖生活已经登录过（$PKG 的数据目录里才有 token）"
  exit 1
fi

if [ "$ONLY_TOKEN" = "1" ]; then
  PYTHONIOENCODING=utf-8 python "$ROOT/tools/mmkv_token.py" "$OUT" | sed -n 's/^TOKEN=//p'
else
  PYTHONIOENCODING=utf-8 python "$ROOT/tools/mmkv_token.py" "$OUT"
fi

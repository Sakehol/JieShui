#!/usr/bin/env python3
"""从 MMKV 文件里读出胖乖生活的 token。

用法：
    python tools/mmkv_token.py build/mmkv.default

MMKV 的默认文件是 protobuf 风格的 [varint 长度][key][varint 长度][value] 序列。
本脚本只做一件事：把所有键值对打印出来，并高亮 token。
"""
import sys
import os


def read_varint(b, i):
    shift = 0
    val = 0
    while True:
        if i >= len(b):
            return None, i
        c = b[i]
        i += 1
        val |= (c & 0x7F) << shift
        if not (c & 0x80):
            return val, i
        shift += 7
        if shift > 63:
            return None, i


def parse(b):
    out = {}
    i = 0
    n = len(b)
    while i < n:
        ln, j = read_varint(b, i)
        if ln is None or ln == 0 or j + ln > n:
            i += 1
            continue
        key = b[j:j + ln]
        if not all(32 <= c < 127 for c in key):
            i += 1
            continue
        i = j + ln
        vlen, k = read_varint(b, i)
        if vlen is None or vlen == 0 or k + vlen > n:
            i += 1
            continue
        val = b[k:k + vlen]
        # 字符串值必须整体可打印，数字值（如 int32 变长）也允许
        if all(32 <= c < 127 or c in (9, 10, 13) for c in val):
            out[key.decode('ascii', 'ignore')] = val.decode('utf-8', 'ignore')
        i = k + vlen
    return out


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'build/mmkv.default'
    if not os.path.exists(path):
        sys.exit('找不到文件：%s' % path)
    data = open(path, 'rb').read()
    kv = parse(data)
    tok = kv.get('token', '')
    if tok:
        print('TOKEN=%s' % tok)
    else:
        print('文件存在但没有 token（说明还没在这台设备上登录过）')
    print('--- 全部键 ---')
    for k, v in kv.items():
        show = v if len(v) <= 60 else v[:57] + '...'
        print('%-24s = %s' % (k, show))


if __name__ == '__main__':
    main()

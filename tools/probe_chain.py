#!/usr/bin/env python3
"""用真实 token 跑一遍只读全链路，验证扫码/设备/水卡/免密是否真的能用。

用法：
    python tools/probe_chain.py <token>

只调只读接口，不会开水、不会下单、不会扣钱。
"""
import sys
import time
import json
import hashlib
import urllib.request
import urllib.parse

BASE = 'https://userapi.qiekj.com/'
UA = 'okhttp/3.14.9'
VERSION = '1.145.0'
# 官方 HeadInterceptor 的签名密钥；不带 sign 时 goods/scan/v2 会报「版本过低」
SECRET = 'nFU9pbG8YQoAe1kFh+E7eyrdlSLglwEJeA0wwHB1j5o='


def sign(path, ts, token):
    raw = ('appSecret=%s&channel=android_app&timestamp=%s&token=%s&version=%s&/%s'
           % (SECRET, ts, token or '', VERSION, path))
    return hashlib.sha256(raw.encode()).hexdigest()


def post(path, data, token=None):
    ts = str(int(time.time() * 1000))
    d = dict(data)
    if token:
        d['token'] = token
    body = urllib.parse.urlencode(d).encode()
    req = urllib.request.Request(BASE + path, data=body, method='POST')
    req.add_header('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8')
    req.add_header('User-Agent', UA)
    req.add_header('Version', VERSION)
    req.add_header('channel', 'android_app')
    req.add_header('phoneBrand', 'Redmi')
    req.add_header('timestamp', ts)
    req.add_header('sign', sign(path, ts, token))
    if token:
        req.add_header('Authorization', token)
        req.add_header('token', token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode('utf-8', 'replace')
    except Exception as e:
        return {'_err': '%s: %s' % (type(e).__name__, e)}
    try:
        return json.loads(raw)
    except Exception:
        return {'_raw': raw[:300]}


def show(label, path, data, token):
    r = post(path, data, token)
    bad = r.get('_err') or r.get('_raw')
    if bad:
        print('  %-22s %s  %s' % (label, path, bad))
        return None
    code = r.get('code')
    msg = (r.get('msg') or r.get('message') or '').strip()
    d = r.get('data')
    ok = 'OK ' if code == 0 else 'ERR'
    print('  %s %-20s %-32s code=%-4s %s' % (ok, label, path, code, msg))
    if code == 0 and d is not None:
        s = json.dumps(d, ensure_ascii=False)
        print('       └ %s' % (s[:400] + ('…' if len(s) > 400 else '')))
    return r if code == 0 else None


def main():
    if len(sys.argv) < 2:
        sys.exit('用法：python tools/probe_chain.py <token>')
    token = sys.argv[1].strip()
    print('token = %s…（长度 %d）' % (token[:12], len(token)))

    print('\n[1] 登录态 / 账号')
    show('checkLogin', 'user/checkLogin', {}, token)
    bal = show('balance', 'user/balance', {}, token)
    if bal and isinstance(bal.get('data'), dict):
        d = bal['data']
        tc = d.get('tokenCoin') or 0
        print('       小票余额 ¥%.2f   积分 %s   积分折钱 ¥%s' % (
            float(tc) / 100.0, d.get('integral'), d.get('integralAmount')))

    print('\n[2] 常用设备（不依赖二维码）')
    latest = show('latestUsed', 'goods/latestUsed', {'categoryCode': '04'}, token)
    dev = None
    if latest and isinstance(latest.get('data'), list) and latest['data']:
        dev = latest['data'][0]
        print('       第一台：%s  goodsId=%s' % (dev.get('goodsName'), dev.get('goodsId')))

    if not dev:
        print('\n[4] 设备详情 / 规格 / 水卡')
        print('       没有历史设备，跳过（先扫一次码或在原 App 用过一次饮水机）')
        return

    gid = dev.get('goodsId')
    print('\n[4] 设备详情 / 规格 / 水卡')
    det = show('details', 'goods/normal/details', {'goodsId': gid}, token)
    skus = show('skus', 'goods/normal/skus', {'goodsId': gid}, token)

    shop_id = None
    cat = dev.get('categoryCode') or '04'
    if det and isinstance(det.get('data'), dict):
        d = det['data']
        shop_id = d.get('shopId')
        print('       设备：%s  imei=%s  categoryCode=%s  shopId=%s  蓝牙=%s' % (
            d.get('name'), d.get('imei'), d.get('categoryCode'), shop_id, d.get('isBluetooth')))
    if skus and isinstance(skus.get('data'), list) and skus['data']:
        s0 = skus['data'][0]
        lvl = []
        try:
            lvl = json.loads(s0.get('extAttr') or '{}').get('level') or []
        except Exception:
            pass
        print('       第一个规格：%s  skuId=%s  单价=%s 元/L（官方取自 extAttr.level[0].price）' % (
            s0.get('name'), s0.get('skuId'), (lvl[0] or {}).get('price') if lvl else s0.get('price')))

    print('\n[3] 扫码解析（关键：这一关能不能过）')
    scan_res = None
    probe_val = (det or {}).get('data', {}).get('imei') or 'PROBE00000000'
    for k in ['SN', 'IMEI', 'NQT']:
        r = show('scan/v2 (%s)' % k, 'goods/scan/v2', {k: probe_val}, token)
        if r and scan_res is None:
            scan_res = r.get('data')
    print('       探测值 = %s（这台设备的 imei；常有机型只有按 SN 查才通）' % probe_val)

    # waterQuota/getActive 的 shopId 要传「机构 id」（scan/v2 返回的那个 int，等于 details 的 orgId），
    # 传 details.shopId（长串）会报「参数不正确」——实测确认。
    quota_shop = None
    if isinstance(scan_res, dict):
        quota_shop = scan_res.get('shopId')
    if quota_shop is None and det and isinstance(det.get('data'), dict):
        quota_shop = det['data'].get('orgId')
    show('waterQuota', 'waterQuota/getActive',
         {'shopId': str(quota_shop or ''), 'categoryCode': cat}, token)

    print('\n[5] 支付宝免密签约状态')
    show('alipay/isSign', 'alipay/isSign', {}, token)

    print('\n[6] 风控前置接口（只读）')
    show('isCheckLocation', 'orderRisk/isCheckLocation', {'categoryCode': cat, 'imei': ''}, token)

    print('\n结论：只要 [3] 不是「版本过低」，扫码链路就是通的；'
          '[4] 的水卡额度就是「买过的水卡是否生效」的直接答案。')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 android/ 生成 android_test/（自动注入 mock，避免副本与真源码漂移）。

用法：python tools/make_test.py && bash build_test.sh
"""
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'android')
DST = os.path.join(ROOT, 'android_test')

MOCK_BLOCK = r'''
    // ==== UI 测试用 mock（由 tools/make_test.py 自动注入，勿手改）====
    private static int mockSyncTicks = 0;
    private static String mock(String path) {
        switch (path) {
            case "goods/scan/v2":
                return "{\"code\":0,\"msg\":\"成功\",\"data\":{\"id\":\"10001\",\"categoryCode\":\"04\",\"categoryName\":\"饮水机\",\"shopId\":88,\"jumpToDevicePageFlag\":false,\"jumpToAlipayFlag2\":false}}";
            case "goods/normal/details":
                return "{\"code\":0,\"data\":{\"goodsId\":\"10001\",\"name\":\"3号饮水机\",\"imei\":\"NQT2024001\",\"shopId\":88,\"categoryCode\":\"04\",\"orgName\":\"学生公寓 3 栋\",\"isBluetooth\":0,\"tradeMain\":1}}";
            case "goods/latestUsed":
                return "{\"code\":0,\"data\":[{\"goodsId\":\"10001\",\"goodsName\":\"3号饮水机\",\"orgId\":\"7\",\"orgName\":\"学生公寓 3 栋\",\"categoryCode\":\"04\",\"parentPointId\":0,\"parentPointName\":\"3栋\",\"workStatus\":0},{\"goodsId\":\"10002\",\"goodsName\":\"1号饮水机\",\"orgId\":\"7\",\"orgName\":\"教学楼 A\",\"categoryCode\":\"04\",\"parentPointId\":0,\"parentPointName\":\"A座\",\"workStatus\":0}]}";
            case "goods/normal/skus":
                return "{\"code\":0,\"data\":[{\"skuId\":\"101\",\"name\":\"按量计费\",\"price\":\"0.30\",\"unit\":\"升\",\"feature\":\"0.30 元/升\"},{\"skuId\":\"102\",\"name\":\"包月畅饮\",\"price\":\"19.90\",\"unit\":\"月\",\"feature\":\"30 天内不限量\"}]}";
            case "waterQuota/getActive":
                return "{\"code\":0,\"data\":{\"show\":true,\"text\":\"水卡余额 ¥12.50 · 享 8 折\"}}";
            case "user/checkLogin":
                return "{\"code\":0,\"data\":{}}";
            case "user/balance":
                return "{\"code\":0,\"data\":{\"tokenCoin\":1250,\"integral\":320,\"integralAmount\":\"3.20\"}}";
            case "goods/water/unlock":
                // 每次开阀都把计数清零，模拟“这一台机器刚开始一轮新的接水”。
                // 以前从不清零，第二次进设备页第一轮 sync 就已经是 3，
                // 于是等待期被当场跳过 —— 测出来的不是产品行为，是 mock 的残留。
                mockSyncTicks = 0;
                return "{\"code\":0,\"data\":{\"msgId\":\"m1\",\"orderNo\":\"0620261106004023612291\"}}";
            case "goods/water/sync":
                mockSyncTicks++;
                // 前 2 次模拟"用户还没在机器上按开始"：扫码即开阀之后要等用户按开始，
                // 这段时间 workStatus 不是 2、amount 是 0，不能急着去结算。
                if (mockSyncTicks <= 2) {
                    return "{\"code\":0,\"data\":{\"workStatus\":0,\"identify\":\"\",\"amount\":\"0\",\"status\":0}}";
                }
                if (mockSyncTicks < 6) {
                    return "{\"code\":0,\"data\":{\"workStatus\":2,\"identify\":\"QK202411050001\",\"amount\":\"" + (60 * mockSyncTicks) + "\",\"status\":1}}";
                }
                return "{\"code\":0,\"data\":{\"workStatus\":3,\"identify\":\"QK202411050001\",\"amount\":\"186\",\"status\":2}}";
            case "payChannelRoute/addUserAfterPayChannel":
                return "{\"code\":0,\"data\":null}";
            case "order/afterPay/creating":
                return "{\"code\":0,\"data\":{\"orderId\":\"ord_99001\",\"orderNo\":\"0620261106004023612291\",\"orderStatus\":1,\"payType\":\"15\"}}";
            case "order/sync":
                return "{\"code\":0,\"data\":{\"code\":\"0\",\"messageId\":\"msg_99001\"}}";
            case "order/detail":
                return "{\"code\":0,\"data\":{\"waterUse\":{\"waterUseType\":1,\"waterUseValueDesc\":\"0.2L\"},\"tradeOrderItem\":[{\"originPrice\":\"1.78\",\"realPrice\":\"1.49\"},{\"originPrice\":\"0.08\",\"realPrice\":\"0.00\"}],\"promotionList\":[{\"promotionType\":4,\"discountAmount\":\"0.19\"},{\"promotionType\":8,\"discountAmount\":\"0.18\"}],\"payPrice\":\"1.49\",\"payTypeName\":\"支付宝免密支付\"}}";
            default:
                return "{\"code\":0,\"data\":{}}";
        }
    }

    private static Object mockCall(String path) throws ApiException {
        try { Thread.sleep(180); } catch (InterruptedException ignored) {}
        // 结算相关接口放慢，方便在真机/模拟器上肉眼确认「结算中…」这一态
        if ("order/afterPay/creating".equals(path) || "order/sync".equals(path)
                || "order/detail".equals(path)) {
            try { Thread.sleep(1500); } catch (InterruptedException ignored) {}
        }
        JSONObject mj;
        try { mj = new JSONObject(mock(path)); } catch (Exception e) { throw new ApiException("mock 解析失败", -96); }
        if (mj.optInt("code", 0) != 0) throw new ApiException(mj.optString("msg"), mj.optInt("code"));
        if (!mj.has("data") || mj.isNull("data")) return null;
        Object md;
        try { md = mj.get("data"); } catch (Exception e) { return null; }
        if (md instanceof JSONArray && ((JSONArray) md).length() == 0) return null;
        return md;
    }
'''

MOCK_GUARD = r'''        if (MOCK) return mockCall(path);
'''


def patch_api(path):
    s = open(path, encoding='utf-8').read()
    # MOCK 常量现在写在 api 源码里（默认 false），mock 版只把它翻成 true，
    # 避免"真源码里没有这个字段"导致 android_test 编译不过。
    m0 = re.search(r'public static final boolean MOCK = false;', s)
    if not m0:
        sys.exit('Api.java 结构变了：找不到 MOCK 开关')
    s = s[:m0.start()] + 'public static final boolean MOCK = true;' + s[m0.end():]

    anchor = "    /** 返回 data 字段：可能是 JSONObject / JSONArray / null */"
    if anchor not in s:
        sys.exit('Api.java 结构变了：找不到 call() 前的注释锚点')
    s = s.replace(anchor, MOCK_BLOCK + '\n' + anchor, 1)

    # 在 4 参 call 的方法体开头插入 mock 分支
    m = re.search(r'public static Object call\(String path, Map<String, String> params, String token,\s*\n\s*Map<String, String> extra\) throws ApiException \{\n', s)
    if not m:
        sys.exit('Api.java 结构变了：找不到四参 call(...)')
    s = s[:m.end()] + MOCK_GUARD + s[m.end():]
    open(path, 'w', encoding='utf-8').write(s)


def patch_main(path):
    s = open(path, encoding='utf-8').read()
    old = '        if (Prefs.token(this).isEmpty()) {'
    new = ('        if (Api.MOCK && Prefs.token(this).isEmpty()) {\n'
           '            Prefs.setToken(this, "mocktoken_for_ui_test");\n'
           '            Prefs.setPhone(this, "13800138000");\n'
           '        }\n'
           '        if (Prefs.token(this).isEmpty()) {')
    if old not in s:
        sys.exit('MainActivity.java 结构变了：找不到 token 判空')
    s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)


def main():
    if os.path.isdir(DST):
        shutil.rmtree(DST)
    shutil.copytree(SRC, DST)
    patch_api(os.path.join(DST, 'src/app/jieshui/Api.java'))
    patch_main(os.path.join(DST, 'src/app/jieshui/MainActivity.java'))
    print('android_test 已从 android/ 重新生成')


if __name__ == '__main__':
    main()

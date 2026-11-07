package app.jieshui;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

/**
 * 极简本地存储。
 *
 * 敏感值（token、手机号、设备列表里的 imei）不进明文 XML：
 * 先用 {@link Secure} 通过 Android Keystore 的 AES-GCM 加密再落盘。
 * 老版本升级上来时存的是明文 Base64，读取自动兼容，并在下次写入时转成密文。
 */
public final class Prefs {

    private static final String FILE = "jieshui";

    public static final int C_BG = 0xFF0A0E14;
    public static final int C_CARD = 0xFF151D2A;
    public static final int C_LINE = 0xFF22303F;
    public static final int C_FG = 0xFFE8EEF7;
    public static final int C_FG2 = 0xFF8FA3BA;
    public static final int C_ACCENT = 0xFF2F9CF4;
    public static final int C_OK = 0xFF2ECC8F;
    public static final int C_ERR = 0xFFFF5D5D;
    public static final int C_WARN = 0xFFFFB454;
    public static final int C_INPUT = 0xFF0D141D;

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** 进程内有效的 token：关掉「记住登录」时用，不落盘 */
    private static volatile String memToken = null;

    /**
     * 默认开启 —— 和网页端保持一致，也和以前的行为一致（以前总是记住）。
     * 关掉之后 token 只活在本次进程里，退出 App 就要重新登录。
     */
    public static boolean remember(Context c) {
        return sp(c).getBoolean("remember", true);
    }

    public static void setRemember(Context c, boolean v) {
        sp(c).edit().putBoolean("remember", v).apply();
        if (!v) {
            // 从「记住」切到「不记住」：把已落盘的 token 挪进内存再删盘上那份。
            // 直接删掉会把人当场踢下线 —— 用户想改的是「下次」，不是「现在」。
            String persisted = Secure.decrypt(c, sp(c).getString("token", ""));
            if (!persisted.isEmpty()) memToken = persisted;
            sp(c).edit().remove("token").apply();
        } else {
            // 反过来：开回来时把内存里的 token 落盘，否则下次启动又要重登
            String m = memToken;
            if (m != null && !m.isEmpty()) {
                sp(c).edit().putString("token", Secure.encrypt(c, m)).apply();
                memToken = null;
            }
        }
    }

    public static String token(Context c) {
        // 不记住登录时 token 只在这个进程里，内存优先
        String m = memToken;
        if (m != null) return m;
        return Secure.decrypt(c, sp(c).getString("token", ""));
    }

    public static void setToken(Context c, String v) {
        if (v == null || v.isEmpty()) {
            memToken = null;
            sp(c).edit().remove("token").apply();
            return;
        }
        if (remember(c)) {
            memToken = null;
            sp(c).edit().putString("token", Secure.encrypt(c, v)).apply();
        } else {
            memToken = v;
            sp(c).edit().remove("token").apply();
        }
    }

    public static String phone(Context c) {
        return Secure.decrypt(c, sp(c).getString("phone", ""));
    }

    public static void setPhone(Context c, String v) {
        if (v == null || v.isEmpty()) {
            sp(c).edit().remove("phone").apply();
        } else {
            sp(c).edit().putString("phone", Secure.encrypt(c, v)).apply();
        }
    }

    /* 默认 "15"：PayTypeEnum.ALIPAY_NOT_PASSWORD 的 type 是 15（ordinal 才是 1）。
       传 "1" 会被服务端当成别的渠道，钱扣了但订单停在「待支付」，还会挡住下次接水。 */
    public static String payType(Context c) { return sp(c).getString("payType", "15"); }
    public static void setPayType(Context c, String v) { sp(c).edit().putString("payType", v).apply(); }

    /** 默认关闭：登录后直接弹相机容易打断人，需要时在设置里打开 */
    public static boolean autoStart(Context c) { return sp(c).getBoolean("autoStart", false); }
    public static void setAutoStart(Context c, boolean v) { sp(c).edit().putBoolean("autoStart", v).apply(); }

    /** 定位：官方 /goods/water/unlock 的风控签名包含 lat/lng。取上次已知位置，没有则用 0。 */
    public static String lat(Context c) { return sp(c).getString("lat", "0.0"); }
    public static String lng(Context c) { return sp(c).getString("lng", "0.0"); }
    public static void setLocation(Context c, String lat, String lng) {
        sp(c).edit().putString("lat", lat).putString("lng", lng).apply();
    }

    public static JSONArray devices(Context c) {
        try {
            String raw = sp(c).getString("devices", "");
            if (raw == null || raw.isEmpty()) return new JSONArray();
            // 设备列表里含 imei（设备序列号），同样加密存放
            if (raw.startsWith(Secure.PREFIX) || raw.startsWith("p1:")) {
                raw = Secure.decrypt(c, raw);
            }
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    public static void addDevice(Context c, String goodsId, String name, String imei,
                                 String shopId, String categoryCode, String orgName) {
        try {
            JSONArray old = devices(c);
            JSONArray out = new JSONArray();
            org.json.JSONObject me = new org.json.JSONObject();
            me.put("goodsId", goodsId == null ? "" : goodsId);
            me.put("name", name == null ? "" : name);
            me.put("imei", imei == null ? "" : imei);
            me.put("shopId", shopId == null ? "" : shopId);
            me.put("categoryCode", categoryCode == null ? "" : categoryCode);
            me.put("orgName", orgName == null ? "" : orgName);
            out.put(me);
            for (int i = 0; i < old.length() && out.length() < 10; i++) {
                org.json.JSONObject o = old.optJSONObject(i);
                if (o == null) continue;
                if (goodsId != null && goodsId.equals(o.optString("goodsId"))) continue;
                out.put(o);
            }
            sp(c).edit().putString("devices", Secure.encrypt(c, out.toString())).apply();
        } catch (Exception ignored) {
        }
    }

    /**
     * 一次性迁移：把老版本遗留的明文 token / 手机号 / 设备列表改成密文。
     * 旧版本存的是 Base64(明文) 或裸 JSON，读路径已经兼容，这里只是把它改写成 v2: 格式。
     */
    public static void migrate(Context c) {
        try {
            String rawToken = sp(c).getString("token", "");
            if (!rawToken.isEmpty() && !Secure.isEncrypted(rawToken)) {
                String plain = Secure.decrypt(c, rawToken);
                if (!plain.isEmpty()) sp(c).edit().putString("token", Secure.encrypt(c, plain)).apply();
            }
            String rawPhone = sp(c).getString("phone", "");
            if (!rawPhone.isEmpty() && !Secure.isEncrypted(rawPhone)) {
                String plain = Secure.decrypt(c, rawPhone);
                if (!plain.isEmpty()) sp(c).edit().putString("phone", Secure.encrypt(c, plain)).apply();
            }
            String rawDev = sp(c).getString("devices", "");
            if (!rawDev.isEmpty() && !Secure.isEncrypted(rawDev) && !rawDev.startsWith("p1:")) {
                JSONArray arr = devices(c);
                sp(c).edit().putString("devices", Secure.encrypt(c, arr.toString())).apply();
            }
            // 老版本可能留有应用锁的 PIN 记录；本版已取消应用锁，顺手清掉避免残留
            sp(c).edit().remove("pin").apply();
        } catch (Throwable ignored) {
        }
    }
}

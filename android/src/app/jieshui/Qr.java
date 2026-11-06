package app.jieshui;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/** 二维码内容解析：与官方 HomeScanCodeAct 一致，取 NQT / IMEI / SN / qeykid */
public final class Qr {

    public String nqt, imei, sn, qeykid, raw;

    private static final Pattern BARE = Pattern.compile("^[A-Za-z0-9_\\-]{6,32}$");

    public static Qr parse(String text) {
        Qr q = new Qr();
        q.raw = text == null ? "" : text.trim();
        String raw = q.raw;

        String qs = "";
        int qi = raw.indexOf('?');
        if (qi >= 0) {
            qs = raw.substring(qi + 1);
        } else if (raw.contains("=")) {
            qs = raw;
        }

        if (!qs.isEmpty()) {
            for (String part : qs.split("&")) {
                int eq = part.indexOf('=');
                if (eq < 0) continue;
                String k = part.substring(0, eq).toUpperCase();
                String v = dec(part.substring(eq + 1));
                if ("NQT".equals(k)) q.nqt = v;
                else if ("IMEI".equals(k)) q.imei = v;
                else if ("SN".equals(k)) q.sn = v;
                else if ("QEYKID".equals(k)) q.qeykid = v;
            }
        }

        if (q.nqt == null && q.imei == null && q.sn == null && BARE.matcher(raw).matches()) {
            q.imei = raw;
        }
        return q;
    }

    /** 返回 scanV2 需要的单键参数；无法识别返回 null */
    public Map<String, String> scanParams() {
        Map<String, String> m = new LinkedHashMap<>();
        if (nqt != null && !nqt.isEmpty()) m.put("NQT", nqt);
        else if (imei != null && !imei.isEmpty()) m.put("IMEI", imei);
        else if (sn != null && !sn.isEmpty()) m.put("SN", sn);
        else return null;
        return m;
    }

    public boolean isWaterCard() {
        return qeykid != null && !qeykid.isEmpty() && qeykid.length() >= 8 && qeykid.length() % 2 == 0;
    }

    private static String dec(String s) {
        try {
            return URLDecoder.decode(s, "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException e) {
            return s;
        }
    }
}

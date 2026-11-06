package app.jieshui;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 极简 API 客户端。
 * 接口协议：application/x-www-form-urlencoded POST，token 同时放在 header 与 body。
 */
public final class Api {

    public static final String BASE = "https://userapi.qiekj.com/";
    public static final String VERSION = "1.145.0";
    public static final String UA = "okhttp/3.14.9";

    /** 仅 UI 联调用的 mock 开关；由 tools/make_test.py 生成的 android_test 里会被改 true。 */
    public static final boolean MOCK = false;

    /**
     * 官方 HeadInterceptor 的签名密钥（Base64 解码常量后得到的明文）。
     * sign = SHA256("appSecret=" + SECRET + "&channel=android_app&timestamp=" + ts
     *               + "&token=" + token + "&version=" + VERSION + "&/" + path)
     * 实测：不带 sign 时 goods/scan/v2 会返回「版本过低，请升级APP后再使用」，
     * 带上 sign 立刻正常返回业务数据。所以每个请求都必须签名。
     */
    static final String SECRET = "nFU9pbG8YQoAe1kFh+E7eyrdlSLglwEJeA0wwHB1j5o=";

    /** 官方优惠占位（小票 / 水卡 / 积分），与原客户端一致 */
    public static final String PROMOTIONS =
            "[{\"assetId\":\"0\",\"oldPromotionId\":\"\",\"orgId\":\"0\",\"promotionId\":\"0\",\"promotionType\":\"-6\"}," +
            "{\"assetId\":\"0\",\"oldPromotionId\":\"\",\"orgId\":\"0\",\"promotionId\":\"0\",\"promotionType\":\"-7\"}," +
            "{\"assetId\":\"0\",\"oldPromotionId\":\"0\",\"orgId\":\"0\",\"promotionId\":\"0\",\"promotionType\":\"8\"}]";

    public static final int WORK_RUNNING = 2;

    private Api() {}

    public static class ApiException extends Exception {
        public final int code;
        public ApiException(String message, int code) {
            super(message);
            this.code = code;
        }
    }

    public static Map<String, String> params(String... kv) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            if (kv[i + 1] != null && !kv[i + 1].isEmpty()) m.put(kv[i], kv[i + 1]);
        }
        return m;
    }

    /** 返回 data 字段：可能是 JSONObject / JSONArray / null */
    public static Object call(String path, Map<String, String> params, String token) throws ApiException {
        return call(path, params, token, null);
    }

    /**
     * @param extra 额外请求头。官方客户端调 /goods/water/unlock 与 /trade/create 时
     *              会把 categoryCode / imei / lat / lng 放在 header 里（HeadInterceptor 读 header 算风控签名）。
     */
    public static Object call(String path, Map<String, String> params, String token,
                              Map<String, String> extra) throws ApiException {
        HttpURLConnection conn = null;
        try {
            StringBuilder body = new StringBuilder();
            if (params != null) {
                for (Map.Entry<String, String> e : params.entrySet()) {
                    if (e.getValue() == null || e.getValue().isEmpty()) continue;
                    if (body.length() > 0) body.append('&');
                    body.append(URLEncoder.encode(e.getKey(), "UTF-8"));
                    body.append('=');
                    body.append(URLEncoder.encode(e.getValue(), "UTF-8"));
                }
            }
            if (token != null && !token.isEmpty()) {
                if (body.length() > 0) body.append('&');
                body.append("token=").append(URLEncoder.encode(token, "UTF-8"));
            }
            byte[] payload = body.toString().getBytes("UTF-8");

            URL url = new URL(BASE + path);
            // 只允许 https：BASE 是常量，这里再兜一层，防止以后有人改成 http 造成明文传输
            if (!"https".equalsIgnoreCase(url.getProtocol())) {
                throw new ApiException("拒绝明文连接", -96);
            }
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            // 不跟随重定向：被劫持/被篡改的服务端若返回 302 到 http 或第三方域名，
            // 默认行为会把 token 一起带过去；这里直接拒绝，把跳转当异常。
            conn.setInstanceFollowRedirects(false);

            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
            conn.setRequestProperty("Version", VERSION);
            conn.setRequestProperty("channel", "android_app");
            conn.setRequestProperty("phoneBrand", android.os.Build.BRAND == null ? "Xiaomi" : android.os.Build.BRAND);
            conn.setRequestProperty("User-Agent", UA);
            final String ts = String.valueOf(System.currentTimeMillis());
            conn.setRequestProperty("timestamp", ts);
            conn.setRequestProperty("Accept", "application/json");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", token);
                conn.setRequestProperty("token", token);
            }
            // 官方 HeadInterceptor 的请求签名：不签会被服务端当成旧版本客户端拒掉。
            conn.setRequestProperty("sign", sign(path, ts, token));
            if (extra != null) {
                for (Map.Entry<String, String> e : extra.entrySet()) {
                    if (e.getKey() == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                    conn.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            conn.setRequestProperty("Content-Length", String.valueOf(payload.length));

            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();

            int status = conn.getResponseCode();
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(is);
            if (text == null || text.isEmpty()) {
                throw new ApiException("服务器无响应（" + status + "）", status);
            }

            JSONObject json;
            try {
                json = new JSONObject(text);
            } catch (Exception e) {
                String brief = text.length() > 120 ? text.substring(0, 120) : text;
                throw new ApiException("返回格式异常：" + brief, status);
            }

            int code = json.optInt("code", 0);
            if (code != 0) {
                String msg = json.optString("msg", json.optString("message", "错误码 " + code));
                throw new ApiException(msg, code);
            }
            if (!json.has("data") || json.isNull("data")) return null;
            Object data = json.get("data");
            if (data instanceof JSONArray && ((JSONArray) data).length() == 0) return null;
            return data;

        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            String m = e.getMessage();
            if (m != null && m.contains("timed out")) throw new ApiException("网络超时", -99);
            if (m != null && m.contains("Unable to resolve host")) throw new ApiException("无法连接服务器", -98);
            throw new ApiException("网络错误：" + (m == null ? e.getClass().getSimpleName() : m), -97);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 请求头 sign：SHA-256(appSecret=..&channel=android_app&timestamp=..&token=..&version=..&/<path>) */
    static String sign(String path, String ts, String token) {
        String raw = "appSecret=" + SECRET
                + "&channel=android_app"
                + "&timestamp=" + ts
                + "&token=" + (token == null ? "" : token)
                + "&version=" + VERSION
                + "&/" + path;
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(raw.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                int v = b & 0xFF;
                if (v < 16) sb.append('0');
                sb.append(Integer.toHexString(v));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return null;
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        return new String(bos.toByteArray(), "UTF-8");
    }
}

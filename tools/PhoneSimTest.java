import app.jieshui.ScanCore;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * Simulate what a phone actually hands us: slightly soft, noisy, low contrast,
 * uneven lighting. Then check which rescue passes buy back the far/small codes.
 *
 * The browser gets frames that are already sharpened and stabilised by the ISP;
 * Camera1 preview is not, which is the most likely reason the web client feels
 * better than the app even though both run ZXing over similar pixel counts.
 */
public class PhoneSimTest {

    static final int W = 1920, H = 1080;
    static final String CONTENT = "https://m.qiekj.com/s?SN=NQT2024001&c=04";

    public static void main(String[] a) throws Exception {
        MultiFormatReader reader = newReader();
        int[] codePx = {300, 240, 192, 160, 128, 104};

        System.out.println("realistic phone frame: blur 0.6 + noise 6 + contrast 0.62 + vignette");
        System.out.println("codePx | plain | unsharp | unsharp+inv | invert");
        for (int cp : codePx) {
            BitMatrix m = new QRCodeWriter().encode(CONTENT, BarcodeFormat.QR_CODE, cp, cp);
            byte[] base = grayFrame();
            paste(base, W, H, m, cp);
            byte[] deg = degrade(base, W, H);

            String plain = yn(ScanCore.decodeGray(reader, deg, W, H));
            byte[] sharp = unsharp(deg, W, H, 1.2f);
            String sh = yn(ScanCore.decodeGray(reader, sharp, W, H));
            byte[] sharpInv = invert(sharp);
            String shi = yn(ScanCore.decodeGray(reader, sharpInv, W, H));
            String inv = yn(ScanCore.decodeGray(reader, invert(deg), W, H));

            System.out.println(String.format("%6d | %-5s | %-7s | %-11s | %-6s",
                    cp, plain, sh, shi, inv));
        }
    }

    static String yn(String s) { return s != null ? "OK" : "--"; }

    static byte[] invert(byte[] a) {
        byte[] o = new byte[a.length];
        for (int i = 0; i < a.length; i++) o[i] = (byte) (255 - (a[i] & 0xFF));
        return o;
    }

    static MultiFormatReader newReader() {
        MultiFormatReader r = new MultiFormatReader();
        List<BarcodeFormat> fm = new ArrayList<>();
        fm.add(BarcodeFormat.QR_CODE);
        Map<DecodeHintType, Object> h = new EnumMap<>(DecodeHintType.class);
        h.put(DecodeHintType.POSSIBLE_FORMATS, fm);
        h.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        r.setHints(h);
        return r;
    }

    static byte[] grayFrame() {
        byte[] g = new byte[W * H];
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
                g[y * W + x] = (byte) (170 + ((x / 40 + y / 40) & 1) * 12);
        return g;
    }

    static void paste(byte[] g, int w, int h, BitMatrix m, int cp) {
        int ox = (w - cp) / 2, oy = (h - cp) / 2;
        int n = m.getWidth();
        for (int y = 0; y < cp; y++) {
            int my = y * n / cp;
            for (int x = 0; x < cp; x++) {
                int mx = x * n / cp;
                g[(oy + y) * w + ox + x] = m.get(mx, my) ? (byte) 20 : (byte) 235;
            }
        }
    }

    /** soft + noisy + washed out + vignette, in that order */
    static byte[] degrade(byte[] src, int w, int h) {
        byte[] blur = gauss(src, w, h, 0.6);
        byte[] out = new byte[w * h];
        Random rnd = new Random(12345);
        double cx = w / 2.0, cy = h / 2.0, maxR = Math.sqrt(cx * cx + cy * cy);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int i = y * w + x;
                // vignette: corners lose up to 35% of the light
                double r = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / maxR;
                double v = 1.0 - 0.35 * r * r;
                // contrast 0.62 around mid-grey, plus gaussian-ish noise
                double val = 128 + ((blur[i] & 0xFF) * v - 128) * 0.62;
                val += (rnd.nextGaussian() * 6.0);
                out[i] = (byte) Math.max(0, Math.min(255, (int) Math.round(val)));
            }
        }
        return out;
    }

    static byte[] gauss(byte[] src, int w, int h, double sigma) {
        int r = Math.max(1, (int) Math.round(sigma * 1.5));
        byte[] cur = src.clone();
        for (int pass = 0; pass < 3; pass++) cur = box(cur, w, h, r);
        return cur;
    }

    static byte[] box(byte[] src, int w, int h, int r) {
        byte[] tmp = new byte[w * h];
        byte[] out = new byte[w * h];
        for (int y = 0; y < h; y++) {
            int sum = 0, n = 0;
            for (int x = -r; x < w + r; x++) {
                if (x + r < w) { sum += src[y * w + x + r] & 0xFF; n++; }
                if (x - r - 1 >= 0) { sum -= src[y * w + x - r - 1] & 0xFF; n--; }
                if (x >= 0 && x < w) tmp[y * w + x] = (byte) (n > 0 ? sum / n : 0);
            }
        }
        for (int x = 0; x < w; x++) {
            int sum = 0, n = 0;
            for (int y = -r; y < h + r; y++) {
                if (y + r < h) { sum += tmp[(y + r) * w + x] & 0xFF; n++; }
                if (y - r - 1 >= 0) { sum -= tmp[(y - r - 1) * w + x] & 0xFF; n--; }
                if (y >= 0 && y < h) out[y * w + x] = (byte) (n > 0 ? sum / n : 0);
            }
        }
        return out;
    }

    static byte[] unsharp(byte[] src, int w, int h, float amt) {
        byte[] out = new byte[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int c = src[y * w + x] & 0xFF;
                if (x == 0 || y == 0 || x == w - 1 || y == h - 1) { out[y * w + x] = (byte) c; continue; }
                int sum = (src[(y - 1) * w + x] & 0xFF) + (src[(y + 1) * w + x] & 0xFF)
                        + (src[y * w + x - 1] & 0xFF) + (src[y * w + x + 1] & 0xFF);
                float v = c + amt * (c - sum / 4.0f);
                out[y * w + x] = (byte) Math.max(0, Math.min(255, Math.round(v)));
            }
        }
        return out;
    }
}

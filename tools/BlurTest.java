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

/**
 * Why does the phone struggle where the browser copes?
 *
 * Both run the same algorithm, so the difference has to be in the frames they
 * get. The browser gets a sharp, already-focused, noise-free canvas; Camera1
 * hands us a preview that is often soft, and the autofocus hunts.
 *
 * This measures how much blur ZXing can take before it gives up, at each code
 * size, and whether a light unsharp pass buys anything back. It answers
 * "should the app preprocess the frame, or fix the camera instead?".
 */
public class BlurTest {

    static final int W = 1920, H = 1080;
    static final String CONTENT = "https://m.qiekj.com/s?SN=NQT2024001&c=04";

    public static void main(String[] a) throws Exception {
        MultiFormatReader reader = newReader();
        int[] codePx = {300, 240, 192, 160, 128};
        int[] sigmaX10 = {0, 5, 8, 12, 16};

        System.out.println("blur matrix: rows = code size (px), cols = gaussian sigma x10");
        System.out.print("codePx |");
        for (int s : sigmaX10) System.out.print(String.format(" s=%.1f |", s / 10.0));
        System.out.println("   sharpened?");

        for (int cp : codePx) {
            BitMatrix m = new QRCodeWriter().encode(CONTENT, BarcodeFormat.QR_CODE, cp, cp);
            System.out.print(String.format("%6d |", cp));
            for (int s : sigmaX10) {
                byte[] frame = grayFrame();
                paste(frame, W, H, m, cp);
                byte[] blurred = gauss(frame, W, H, s / 10.0);
                String r = ScanCore.decodeGray(reader, blurred, W, H);
                System.out.print(String.format(" %-5s |", r != null ? "OK" : "--"));
            }
            // same row again, but with an unsharp pass on the worst blur level
            StringBuilder sb = new StringBuilder();
            for (int s : sigmaX10) {
                byte[] frame = grayFrame();
                paste(frame, W, H, m, cp);
                byte[] blurred = gauss(frame, W, H, s / 10.0);
                byte[] sharp = unsharp(blurred, W, H, 1.0f);
                String r = ScanCore.decodeGray(reader, sharp, W, H);
                sb.append(String.format(" %-5s |", r != null ? "OK" : "--"));
            }
            System.out.println("  unsharp:" + sb);
        }
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

    /** Separable box blur, repeated three times ~ gaussian. */
    static byte[] gauss(byte[] src, int w, int h, double sigma) {
        if (sigma <= 0) return src.clone();
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

    /** 3x3 unsharp mask with the usual 5/4 -1/4 kernel scaled by strength. */
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

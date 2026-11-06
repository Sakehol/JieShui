import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeWriter;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 验证 APK 扫码器的三处改动，全部在 JVM 里直跑 zxing-core，不需要手机：
 *
 *   1) 预览尺寸怎么选：现在按「短边最大（上限 1080）」，1440x1080 与 1920x1080 同分，
 *      谁先出现选谁。但 4:3 铺到 20:9 的屏幕上要被放大 1.67 倍，16:9 只放大 1.25 倍 ——
 *      同一个取景框，前者只落到 441 原生像素，后者 587。按「框内原生像素最多」来选才对。
 *
 *   2) 要不要先把整帧转正：不要。QR 码的定位图形本身是旋转无关的，ZXing 自己会算变换。
 *      每帧上百万元素的 rotateYuv 纯属白烧，而且会拖慢帧率。
 *
 *   3) 裁剪 + 复制的成本：只复制框内那块（约 340 KB）而不是整帧（约 2 MB）。
 */
public class ScanFixTest {

    static final MultiFormatReader reader = new MultiFormatReader();
    static final String TEXT = "https://m.qiekj.com/s?SN=NQT2024001&c=04";

    static void initReader() {
        List<BarcodeFormat> formats = new ArrayList<BarcodeFormat>();
        formats.add(BarcodeFormat.QR_CODE);
        Map<DecodeHintType, Object> hints = new EnumMap<DecodeHintType, Object>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        reader.setHints(hints);
    }

    /** 生成二维码灰度图（含 quiet zone），最近邻铺到 px 见方。 */
    static int[] qrGray(int px) {
        try {
            int mod = 25;                       // 版本 2 左右，实际值由 writer 决定
            int target = mod * Math.max(1, px / mod);
            Map<EncodeHintType, Object> h = new HashMap<EncodeHintType, Object>();
            h.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            h.put(EncodeHintType.MARGIN, 2);
            BitMatrix m = new QRCodeWriter().encode(TEXT, BarcodeFormat.QR_CODE, target, target, h);
            int[] g = new int[px * px];
            for (int y = 0; y < px; y++)
                for (int x = 0; x < px; x++) {
                    int sx = (int) ((long) x * target / px);
                    int sy = (int) ((long) y * target / px);
                    g[y * px + x] = m.get(sx, sy) ? 0 : 255;
                }
            return g;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static byte[] frame(int w, int h) {
        byte[] y = new byte[w * h];
        java.util.Random r = new java.util.Random(11);
        for (int i = 0; i < y.length; i++) y[i] = (byte) (120 + r.nextInt(10) - 5);
        return y;
    }

    /** 把二维码画在 (cx,cy) 为中心、边长 qrPx 的正方形里。 */
    static void stamp(byte[] y, int w, int h, int[] qr, int qrPx, int cx, int cy) {
        int x0 = cx - qrPx / 2, y0 = cy - qrPx / 2;
        for (int yy = 0; yy < qrPx; yy++) {
            int ty = y0 + yy;
            if (ty < 0 || ty >= h) continue;
            for (int xx = 0; xx < qrPx; xx++) {
                int tx = x0 + xx;
                if (tx < 0 || tx >= w) continue;
                int sx = (int) ((long) xx * qrPx / qrPx);
                y[ty * w + tx] = (byte) qr[(int) ((long) yy * qr.length / qrPx)];
            }
        }
    }

    /** 整块最近邻缩放后再贴上去，保证模块边界不被插值糊掉。 */
    static void stampScaled(byte[] y, int w, int h, int[] qr, int qrSide, int qrPx, int cx, int cy) {
        int x0 = cx - qrPx / 2, y0 = cy - qrPx / 2;
        for (int yy = 0; yy < qrPx; yy++) {
            int ty = y0 + yy;
            if (ty < 0 || ty >= h) continue;
            int sy = (int) ((long) yy * qrSide / qrPx);
            for (int xx = 0; xx < qrPx; xx++) {
                int tx = x0 + xx;
                if (tx < 0 || tx >= w) continue;
                int sx = (int) ((long) xx * qrSide / qrPx);
                y[ty * w + tx] = (byte) qr[sy * qrSide + sx];
            }
        }
    }

    static byte[] cropCenter(byte[] src, int w, int h, int side) {
        int sx = (w - side) / 2, sy = (h - side) / 2;
        byte[] out = new byte[side * side];
        for (int y = 0; y < side; y++)
            System.arraycopy(src, (sy + y) * w + sx, out, y * side, side);
        return out;
    }

    static String decodeSquare(byte[] buf, int side) {
        try {
            PlanarYUVLuminanceSource s = new PlanarYUVLuminanceSource(buf, side, side, 0, 0, side, side, false);
            Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(s)));
            return r == null ? null : r.getText();
        } catch (Exception e) {
            return null;
        }
    }

    static byte[] rotate90(byte[] d, int w, int h) {
        byte[] o = new byte[d.length];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                o[x * h + (h - y - 1)] = d[y * w + x];
        return o;
    }

    // ---------- 1. 预览尺寸的选择 ----------

    /** 屏幕 1080x2400、取景框占短边 68%，按 cover 铺满后框在预览里对应多少原生像素。 */
    static int roiSideFor(int pw, int ph, int screenW, int screenH, int boxPx) {
        // 旋转 90 度后：显示宽 = ph，显示高 = pw
        float rotW = ph, rotH = pw;
        float scale = Math.max(screenW / rotW, screenH / rotH);
        float vw = rotW * scale, vh = rotH * scale;
        float fx = boxPx / vw, fy = boxPx / vh;
        return Math.round(Math.min(fx * rotW, fy * rotH));
    }

    static void part1() {
        int screenW = 1080, screenH = 2400;
        int box = Math.min(screenW, screenH) * 68 / 100;
        int[][] sizes = {
                {1440, 1080}, {1920, 1080}, {1280, 720}, {1920, 1440},
                {1600, 1200}, {2048, 1536}, {1280, 960}, {960, 720},
        };
        System.out.println("== 1. preview size choice (screen " + screenW + "x" + screenH
                + ", box " + box + "px) ==");
        System.out.println("   size        roiSide(px)   zoom-on-screen");
        int bestOld = -1, bestOldIdx = -1, bestNew = -1, bestNewIdx = -1;
        for (int i = 0; i < sizes.length; i++) {
            int pw = sizes[i][0], ph = sizes[i][1];
            int roi = roiSideFor(pw, ph, screenW, screenH, box);
            float rotW = ph, rotH = pw;
            float scale = Math.max(screenW / rotW, screenH / rotH);
            System.out.printf("   %4dx%-5d  %6d        %.2fx%n", pw, ph, roi, scale);
        }
        // 旧规则：短边最大且 <=1080，取第一个
        for (int i = 0; i < sizes.length; i++) {
            int m = Math.min(sizes[i][0], sizes[i][1]);
            if (m > 1080) continue;
            if (bestOld < 0 || m > bestOld) { bestOld = m; bestOldIdx = i; }
        }
        // 新规则：框内原生像素最多（外加总量上限，避免 4MP 拖慢拷贝）
        for (int i = 0; i < sizes.length; i++) {
            int pw = sizes[i][0], ph = sizes[i][1];
            if ((long) pw * ph > 2600000L) continue;
            int roi = roiSideFor(pw, ph, screenW, screenH, box);
            if (roi > bestNew) { bestNew = roi; bestNewIdx = i; }
        }
        System.out.println("   old rule -> " + sizes[bestOldIdx][0] + "x" + sizes[bestOldIdx][1]
                + " roiSide=" + roiSideFor(sizes[bestOldIdx][0], sizes[bestOldIdx][1], screenW, screenH, box));
        System.out.println("   new rule -> " + sizes[bestNewIdx][0] + "x" + sizes[bestNewIdx][1]
                + " roiSide=" + roiSideFor(sizes[bestNewIdx][0], sizes[bestNewIdx][1], screenW, screenH, box));
        float gain = (float) bestNew / Math.max(1, roiSideFor(sizes[bestOldIdx][0], sizes[bestOldIdx][1], screenW, screenH, box));
        System.out.printf("   linear gain: %.2fx%n%n", gain);
    }

    // ---------- 2. 旋转无关 + 3. 裁剪成本 ----------

    static void part2and3() {
        System.out.println("== 2. rotation invariance (no rotateYuv) ==");
        int pw = 1920, ph = 1080;
        int roi = 587;
        int qrSide = 1300;
        int[] qr = qrGray(qrSide);
        byte[] f = frame(pw, ph);
        stampScaled(f, pw, ph, qr, qrSide, Math.round(roi * 0.55f), pw / 2, ph / 2);

        byte[] cropped = cropCenter(f, pw, ph, roi);
        String upright = decodeSquare(cropped, roi);
        System.out.println("   upright frame            -> " + (upright != null ? "OK" : "MISS"));

        byte[] rot = rotate90(f, pw, ph);
        byte[] croppedRot = cropCenter(rot, ph, pw, roi);
        String rotated = decodeSquare(croppedRot, roi);
        System.out.println("   frame rotated 90 (as-is) -> " + (rotated != null ? "OK" : "MISS"));

        System.out.println();
        System.out.println("== 3. per-frame cost (1920x1080, roi " + roi + ") ==");
        byte[] fb = frame(pw, ph);
        long t0 = System.nanoTime();
        int N = 60;
        for (int i = 0; i < N; i++) rotate90(fb, pw, ph);
        long rotMs = (System.nanoTime() - t0) / 1000000 / N;

        t0 = System.nanoTime();
        for (int i = 0; i < N; i++) cropCenter(fb, pw, ph, roi);
        long cropMs = (System.nanoTime() - t0) / 1000000 / N;

        t0 = System.nanoTime();
        for (int i = 0; i < N; i++) fb.clone();
        long cloneMs = (System.nanoTime() - t0) / 1000000 / N;

        System.out.println("   rotateYuv(full frame)    ~" + rotMs + " ms");
        System.out.println("   clone(full frame)        ~" + cloneMs + " ms");
        System.out.println("   crop ROI only            ~" + cropMs + " ms");
        System.out.println("   saved per frame          ~" + (rotMs + cloneMs - cropMs) + " ms");
        System.out.println();
    }

    // ---------- 4. 距离：框内原生像素越多越远 ----------

    static void part4() {
        System.out.println("== 4. how far: QR as a fraction of the box ==");
        int[] roiList = {441, 587, 760};
        float[] fra = {0.30f, 0.22f, 0.16f, 0.12f, 0.09f, 0.07f};
        StringBuilder head = new StringBuilder("   frac ");
        for (int r : roiList) head.append(String.format("  roi=%d", r));
        System.out.println(head);
        for (float fr : fra) {
            StringBuilder row = new StringBuilder(String.format("   %4.0f%%", fr * 100));
            for (int roi : roiList) {
                int qrPx = Math.round(roi * fr);
                int qrSide = Math.max(400, qrPx * 4);      // 源图给足，避免插值伪影
                int[] qr = qrGray(qrSide);
                byte[] f = frame(roi, roi);
                stampScaled(f, roi, roi, qr, qrSide, qrPx, roi / 2, roi / 2);
                String r = decodeSquare(f, roi);
                row.append(String.format("        %s", r != null ? "OK " : "-- "));
            }
            System.out.println(row);
        }
        System.out.println();
    }

    public static void main(String[] a) {
        initReader();
        part1();
        part2and3();
        part4();
        System.out.println("done");
    }
}

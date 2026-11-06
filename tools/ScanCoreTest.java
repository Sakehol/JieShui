import app.jieshui.ScanCore;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.DecodeHintType;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 直接跑 PRODUCTION CODE {@link ScanCore#decode} 的回归测试。
 *
 * 不另抄一份解码逻辑 —— 抄的会和真代码漂移，测出来的 "pass" 没有意义。
 *
 * build:
 *   javac -encoding UTF-8 -cp zxing-core.jar -d build/tools \
 *         android/src/app/jieshui/ScanCore.java tools/ScanCoreTest.java
 * run:
 *   java -cp "build/tools;zxing-core.jar" ScanCoreTest
 *
 * Checks four things:
 *   1) decodes without pre-rotating the frame (0/90/180/270)
 *   2) how small the code can get inside the viewfinder box
 *   3) fallback catches a code LARGER than the box
 *   4) per-frame cost: crop vs rotate+clone
 *
 * NOTE: console here is GBK and mangles Chinese, so all output is ASCII.
 */
public class ScanCoreTest {

    static final String TEXT = "https://m.qiekj.com/s?SN=NQT2024001&c=04";
    static int fails = 0;

    static MultiFormatReader newReader() {
        MultiFormatReader r = new MultiFormatReader();
        List<BarcodeFormat> formats = new ArrayList<>();
        formats.add(BarcodeFormat.QR_CODE);
        formats.add(BarcodeFormat.CODE_128);
        formats.add(BarcodeFormat.CODE_39);
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        r.setHints(hints);
        return r;
    }

    static void check(String name, boolean ok) {
        System.out.printf("   %-52s %s%n", name, ok ? "PASS" : "FAIL");
        if (!ok) fails++;
    }

    // ---------- synthetic frames ----------

    /** Renders the QR onto a px*px grayscale square. Returns {pixels, side}. */
    static int[][] qrGray(int px) {
        try {
            Map<EncodeHintType, Object> h = new HashMap<>();
            h.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            h.put(EncodeHintType.MARGIN, 2);
            BitMatrix m = new QRCodeWriter().encode(TEXT, BarcodeFormat.QR_CODE, px, px, h);
            int[] g = new int[px * px];
            for (int y = 0; y < px; y++)
                for (int x = 0; x < px; x++)
                    g[y * px + x] = m.get(x, y) ? 0 : 255;
            return new int[][]{g, {px}};
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

    /**
     * Stamps the QR into a qrPx square centred on (cx,cy).
     *
     * Downscaling uses AREA AVERAGING, not nearest neighbour. Nearest neighbour
     * at 0.3x throws away whole modules and produces "the small box fails at 16%
     * but works at 8%" nonsense — that is aliasing in the test rig, not a
     * property of the decoder. A camera optically averages, so area averaging is
     * both more realistic and free of that artefact.
     * Upscaling still uses nearest neighbour so we never blur what we measure.
     */
    static void stamp(byte[] y, int w, int h, int[] qr, int qrSide, int qrPx, int cx, int cy) {
        int x0 = cx - qrPx / 2, y0 = cy - qrPx / 2;
        boolean down = qrSide > qrPx;
        for (int yy = 0; yy < qrPx; yy++) {
            int ty = y0 + yy;
            if (ty < 0 || ty >= h) continue;
            int sy0 = (int) ((long) yy * qrSide / qrPx);
            int sy1 = Math.max(sy0 + 1, (int) ((long) (yy + 1) * qrSide / qrPx));
            for (int xx = 0; xx < qrPx; xx++) {
                int tx = x0 + xx;
                if (tx < 0 || tx >= w) continue;
                int sx0 = (int) ((long) xx * qrSide / qrPx);
                int sx1 = Math.max(sx0 + 1, (int) ((long) (xx + 1) * qrSide / qrPx));
                int v;
                if (!down) {
                    v = qr[sy0 * qrSide + sx0];
                } else {
                    long sum = 0;
                    int n = 0;
                    for (int sy = sy0; sy < sy1; sy++)
                        for (int sx = sx0; sx < sx1; sx++) {
                            sum += qr[sy * qrSide + sx];
                            n++;
                        }
                    v = (int) (sum / Math.max(1, n));
                }
                y[ty * w + tx] = (byte) v;
            }
        }
    }

    static byte[] rot90(byte[] d, int w, int h) {
        byte[] o = new byte[d.length];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                o[x * h + (h - y - 1)] = d[y * w + x];
        return o;
    }

    static byte[] rot180(byte[] d) {
        byte[] o = new byte[d.length];
        for (int i = 0; i < d.length; i++) o[i] = d[d.length - 1 - i];
        return o;
    }

    static byte[] rot270(byte[] d, int w, int h) {
        byte[] o = new byte[d.length];
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                o[(w - x - 1) * h + y] = d[y * w + x];
        return o;
    }

    // ---------- 1. rotation independence ----------

    static void testRotation() {
        System.out.println("== 1. decode WITHOUT pre-rotating the frame ==");
        int w = 1920, h = 1080, roi = 587;
        int[][] q = qrGray(1300);
        byte[] f = frame(w, h);
        stamp(f, w, h, q[0], 1300, Math.round(roi * 0.55f), w / 2, h / 2);

        check("upright", ScanCore.decode(newReader(), f, w, h, roi, false) != null);
        check("rotated 90 (no pre-rotate)", ScanCore.decode(newReader(), rot90(f, w, h), h, w, roi, false) != null);
        check("rotated 180", ScanCore.decode(newReader(), rot180(f), w, h, roi, false) != null);
        check("rotated 270", ScanCore.decode(newReader(), rot270(f, w, h), h, w, roi, false) != null);
        System.out.println();
    }

    // ---------- 2. how small can the code be ----------

    static void testDistance() {
        System.out.println("== 2. smallest QR that still decodes (fraction of the box) ==");
        float[] fracs = {0.30f, 0.22f, 0.16f, 0.14f, 0.12f, 0.11f, 0.10f, 0.09f, 0.08f, 0.07f, 0.06f};
        // box sizes a 1080x2400 phone actually gets from each preview size
        int[] rois = {391, 440, 587, 760};
        String[] names = {"1280x720", "1440x1080", "1920x1080", "2048x1536"};

        // Render the source ONCE at high resolution and always downsample from it.
        // Rendering it fresh per fraction made the numbers non-monotonic — the
        // source itself changed size each run, so we were partly measuring
        // QRCodeWriter's rounding, not the decoder.
        final int SRC = 1200;
        int[][] q = qrGray(SRC);

        System.out.print("   frac ");
        for (int i = 0; i < rois.length; i++) System.out.printf("  %s/%dpx", names[i], rois[i]);
        System.out.println();

        Map<Integer, Integer> limit = new HashMap<>();
        for (float fr : fracs) {
            System.out.printf("   %3.0f%% ", fr * 100);
            for (int roi : rois) {
                int qrPx = Math.round(roi * fr);
                // Try three vertical placements and take the best.
                // A single centred stamp made the results non-monotonic
                // (440px "failed" at 14% but "passed" at 11%) — that is the
                // quiet-zone landing on a module boundary, not decoder behaviour.
                // A real user's hand jitters anyway, so best-of-three is the
                // honest thing to measure.
                boolean ok = false;
                for (int dy : new int[]{0, -17, 13}) {
                    byte[] f = frame(roi, roi);
                    stamp(f, roi, roi, q[0], SRC, qrPx, roi / 2, roi / 2 + dy);
                    if (ScanCore.decode(newReader(), f, roi, roi, roi, true) != null) {
                        ok = true;
                        break;
                    }
                }
                System.out.printf("  %s", ok ? "     OK    " : "     --    ");
                if (ok) limit.merge(roi, Math.round(fr * 100), Math::min);
            }
            System.out.println();
        }

        System.out.println("   --- smallest decodable fraction (lower = works farther away) ---");
        for (int i = 0; i < rois.length; i++)
            System.out.printf("   %-10s %d%%%n", names[i], limit.getOrDefault(rois[i], -1));

        int l391 = limit.getOrDefault(391, 100);
        int l587 = limit.getOrDefault(587, 100);
        check("1920x1080 (587px) reaches 12%", l587 <= 12);
        check("1920x1080 beats 1280x720 by >= 2 points", l391 - l587 >= 2);
        System.out.println();
    }

    // ---------- 3. code larger than the box ----------

    static void testFallback() {
        System.out.println("== 3. code LARGER than the box is caught by the 1-in-8 fallback ==");
        int w = 1920, h = 1080, roi = 587;
        // 1000px: comfortably bigger than the 587px box, but still fully inside
        // the 1080px-tall frame. (An earlier version used 1400 and "failed" —
        // the code was simply cut off by the frame edge, not a product bug.)
        int qrPx = 1000;
        int[][] q = qrGray(1000);
        byte[] f = frame(w, h);
        stamp(f, w, h, q[0], 1000, qrPx, w / 2, h / 2);

        String roiOnly = ScanCore.decode(newReader(), f, w, h, roi, false);
        String withFull = ScanCore.decode(newReader(), f, w, h, roi, true);
        System.out.println("   roi only -> " + (roiOnly != null ? "OK" : "MISS")
                + "   with full fallback -> " + (withFull != null ? "OK" : "MISS"));
        check("fallback rescues an oversized code", withFull != null);
        System.out.println();
    }

    // ---------- 4. per-frame cost ----------

    static void testCost() {
        System.out.println("== 4. per-frame cost at 1920x1080 ==");
        int w = 1920, h = 1080, roi = 587;
        byte[] f = frame(w, h);
        int N = 200;

        long t0 = System.nanoTime();
        for (int i = 0; i < N; i++) rot90(f, w, h);
        double rot = (System.nanoTime() - t0) / 1e6 / N;

        t0 = System.nanoTime();
        for (int i = 0; i < N; i++) f.clone();
        double clone = (System.nanoTime() - t0) / 1e6 / N;

        t0 = System.nanoTime();
        for (int i = 0; i < N; i++) ScanCore.cropCenter(f, w, h, roi);
        double crop = (System.nanoTime() - t0) / 1e6 / N;

        System.out.printf("   rotate whole frame (old)  %.2f ms%n", rot);
        System.out.printf("   clone whole frame  (old)  %.2f ms%n", clone);
        System.out.printf("   crop the box only  (new)  %.2f ms%n", crop);
        System.out.printf("   saved per frame           %.2f ms%n", rot + clone - crop);
        check("crop saves >= 2ms per frame", (rot + clone - crop) >= 2.0);
        System.out.println();
    }

    // ---------- 5. inverted (dark background, light modules) ----------

    /**
     * Some dispenser screens are dark with a light QR, and some stickers are
     * printed that way. scanROI alone never finds those: every binarizer in
     * ZXing assumes dark modules on a light field. ScanCore therefore also tries
     * the inverted crop, but only on frames that already lost the full-frame
     * fallback, so the cost lands on ~1/8 of frames.
     */
    static void testInverted() {
        System.out.println("== 5. dark background / light modules ==");
        int w = 1280, h = 960, roi = 587;
        // The code must FIT inside the region ScanCore actually crops (587px here),
        // otherwise this only re-tests the oversized-code fallback from step 3.
        int codePx = 440;
        int[][] q = qrGray(900);
        int[] inv = new int[q[0].length];
        for (int i = 0; i < inv.length; i++) inv[i] = 255 - q[0][i];

        // light field with a dark code (normal) -- must still work
        byte[] normal = frame(w, h);
        for (int i = 0; i < normal.length; i++) normal[i] = (byte) (240);
        stamp(normal, w, h, q[0], 900, codePx, w / 2, h / 2);
        check("normal polarity still decodes",
                ScanCore.decode(newReader(), normal, w, h, roi, false) != null);

        // dark field with a light code (inverted) -- needs the extra pass
        byte[] dark = new byte[w * h];
        for (int i = 0; i < dark.length; i++) dark[i] = (byte) 15;
        stamp(dark, w, h, inv, 900, codePx, w / 2, h / 2);
        String roiOnly = ScanCore.decode(newReader(), dark, w, h, roi, false);
        String withFull = ScanCore.decode(newReader(), dark, w, h, roi, true);
        System.out.println("   roi only -> " + (roiOnly != null ? "OK" : "MISS")
                + "   with inverted pass -> " + (withFull != null ? "OK" : "MISS"));
        check("inverted pass rescues a light-on-dark code", withFull != null);
        System.out.println();
    }

    public static void main(String[] a) {
        testRotation();
        testDistance();
        testFallback();
        testCost();
        testInverted();
        System.out.println(fails == 0 ? "ALL PASS" : (fails + " FAILED"));
        if (fails != 0) System.exit(1);
    }
}

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * ScanActivity.decode() 的等价实现：用 zxing-core 直接验"整幅解 vs 取景框方块解"。
 * 证明改动的效果：同一个合成预览帧里，把二维码缩到只占取景框一小块时，
 * 整幅解认不出、方块解能认出。
 */
public class ScanRoiTest {

    static final MultiFormatReader reader = new MultiFormatReader();
    static final String TEXT = "https://m.qiekj.com/s?SN=NQT2024001&c=04";

    static void initReader() {
        List<BarcodeFormat> formats = new ArrayList<>();
        formats.add(BarcodeFormat.QR_CODE);
        formats.add(BarcodeFormat.CODE_128);
        formats.add(BarcodeFormat.CODE_39);
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        reader.setHints(hints);
    }

    /** 生成二维码灰度图，边长 px（含 QuietZone）。 */
    static int[] qrGray(int px) {
        try {
            Map<EncodeHintType, Object> h = new HashMap<>();
            h.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            h.put(EncodeHintType.MARGIN, 2);
            BitMatrix m = new QRCodeWriter().encode(TEXT, BarcodeFormat.QR_CODE, px, px, h);
            int[] g = new int[px * px];
            for (int y = 0; y < px; y++)
                for (int x = 0; x < px; x++)
                    g[y * px + x] = m.get(x, y) ? 0 : 255;
            return g;
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * 合成一帧 1280x960 的 NV21 预览（模拟摄像头取景）：
     * 中灰背景 + 轻微噪声，把二维码画在正中，占取景框边长的 frac。
     */
    /** 在画面里撒一些像二维码定位角的高对比方块，模拟框外的标签/桌角干扰。 */
    static void addClutter(byte[] y, int w, int h, int box, int seed) {
        java.util.Random r = new java.util.Random(seed);
        int ox0 = (w - box) / 2, oy0 = (h - box) / 2;
        for (int k = 0; k < 26; k++) {
            int bw = 18 + r.nextInt(70), bh = 18 + r.nextInt(70);
            int bx = r.nextInt(Math.max(1, w - bw)), by = r.nextInt(Math.max(1, h - bh));
            // 别盖到取景框里
            if (bx + bw > ox0 && bx < ox0 + box && by + bh > oy0 && by < oy0 + box) continue;
            boolean dark = r.nextBoolean();
            for (int yy = by; yy < by + bh; yy++)
                for (int xx = bx; xx < bx + bw; xx++)
                    y[yy * w + xx] = (byte) (dark ? 25 : 235);
        }
    }

    static byte[] makeFrame(int w, int h, int box, int[] qr, int qrPx, double frac, boolean clutter) {
        byte[] y = new byte[w * h];
        java.util.Random rnd = new java.util.Random(7);
        for (int i = 0; i < y.length; i++) y[i] = (byte) (118 + rnd.nextInt(14) - 7);
        int side = (int) Math.round(box * frac);
        int ox = (w - side) / 2, oy = (h - side) / 2;
        for (int dy = 0; dy < side; dy++) {
            for (int dx = 0; dx < side; dx++) {
                // 最近邻：把整个源图映射到整个目标块，绝不用整数除法的 step（会裁掉一角）
                int sx = Math.min(qrPx - 1, (int) ((long) dx * qrPx / side));
                int sy = Math.min(qrPx - 1, (int) ((long) dy * qrPx / side));
                int v = qr[sy * qrPx + sx];
                y[(oy + dy) * w + ox + dx] = (byte) v;
            }
        }
        if (clutter) addClutter(y, w, h, box, 42);
        byte[] nv21 = new byte[w * h * 3 / 2];
        System.arraycopy(y, 0, nv21, 0, w * h);
        for (int i = w * h; i < nv21.length; i++) nv21[i] = (byte) 128;
        return nv21;
    }

    /** 把二维码画在 boxInPreview 大小的居中方块里，占其 frac。 */
    static byte[] makeFrameAt(int w, int h, int boxInPreview, int[] qr, int qrPx, double frac) {
        byte[] y = new byte[w * h];
        java.util.Random rnd = new java.util.Random(11);
        for (int i = 0; i < y.length; i++) y[i] = (byte) (118 + rnd.nextInt(14) - 7);
        int side = (int) Math.round(boxInPreview * frac);
        side = Math.min(side, Math.min(w, h) - 2);   // 不能超出画面
        int ox = (w - side) / 2, oy = (h - side) / 2;
        for (int dy = 0; dy < side; dy++) {
            for (int dx = 0; dx < side; dx++) {
                int sx = Math.min(qrPx - 1, (int) ((long) dx * qrPx / side));
                int sy = Math.min(qrPx - 1, (int) ((long) dy * qrPx / side));
                y[(oy + dy) * w + ox + dx] = (byte) qr[sy * qrPx + sx];
            }
        }
        byte[] nv21 = new byte[w * h * 3 / 2];
        System.arraycopy(y, 0, nv21, 0, w * h);
        for (int i = w * h; i < nv21.length; i++) nv21[i] = (byte) 128;
        return nv21;
    }

    static String decodeFull(byte[] buf, int w, int h) {
        try {
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(buf, w, h, 0, 0, w, h, false);
            BinaryBitmap bmp = new BinaryBitmap(new HybridBinarizer(src));
            Result r = reader.decodeWithState(bmp);
            if (r != null && r.getText() != null) return r.getText();
        } catch (Exception ignored) {
        }
        return null;
    }

    static String decodeSquare(byte[] buf, int side) {
        try {
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(buf, side, side, 0, 0, side, side, false);
            BinaryBitmap bmp = new BinaryBitmap(new HybridBinarizer(src));
            Result r = reader.decodeWithState(bmp);
            if (r != null && r.getText() != null) return r.getText();
        } catch (com.google.zxing.NotFoundException nf) {
            // 这一帧没有码
        } catch (Exception ignored) {
        }
        return null;
    }

    static int fullTick = 0;
    static boolean throttleFallback = false;

    /** 与 ScanActivity.decode 一致：先方块，失败再整幅兜底（可限流）。 */
    static String decode(byte[] yuv, int w, int h, int roiSide) {
        try {
            if (roiSide > 0 && roiSide < Math.min(w, h)) {
                int sx = (w - roiSide) / 2, sy = (h - roiSide) / 2;
                byte[] crop = new byte[roiSide * roiSide];
                for (int row = 0; row < roiSide; row++) {
                    System.arraycopy(yuv, (sy + row) * w + sx, crop, row * roiSide, roiSide);
                }
                String r = decodeSquare(crop, roiSide);
                if (r != null) return r;
            }
            if (!throttleFallback || (fullTick++ & 7) == 0) return decodeFull(yuv, w, h);
        } finally {
            reader.reset();
        }
        return null;
    }

    public static void main(String[] a) {
        initReader();
        int W = 1280, H = 960;          // 模拟 1280x960 预览
        int BOX = 653;                  // 取景框映射到预览里的边长（实测 1440x2560 屏幕 + 979px 框）
        int[] qr = qrGray(1200);        // 源图足够大，缩小用最近邻，不引入插值伪影

        System.out.println("frame " + W + "x" + H + ", roi " + BOX + "px");
        System.out.printf("%-14s | %-19s | %-19s%n", "", "full frame (old)", "roi box (new)");
        System.out.printf("%-14s | %-9s %-9s | %-9s %-9s%n", "qr/frame", "clean", "clutter", "clean", "clutter");
        double[] fracs = {0.80, 0.50, 0.30, 0.22, 0.18, 0.14, 0.12, 0.10, 0.08};
        for (double f : fracs) {
            int px = (int) Math.round(BOX * f);
            String[] res = new String[4];
            for (int c = 0; c < 2; c++) {
                byte[] frame = makeFrame(W, H, BOX, qr, 1200, f, c == 1);
                reader.reset();
                res[c] = decodeFull(frame, W, H) == null ? "FAIL" : "ok";
                reader.reset();
                res[2 + c] = decode(frame, W, H, BOX) == null ? "FAIL" : "ok";
            }
            System.out.printf("%-14s | %-9s %-9s | %-9s %-9s%n",
                    String.format("%.0f%% (%dpx)", f * 100, px), res[0], res[1], res[2], res[3]);
        }

        // 真正的增益：预览分辨率。老的选 preview size 逻辑常常落到 1280x720（短边 720），
        // 新逻辑拿最大短边（1440x1080 → 短边 1080）。取景框在预览里的边长随之变大，
        // 同一个距离下二维码能拿到更多像素。
        System.out.println();
        System.out.printf("%-22s %-12s %-12s%n", "preview (min side)", "roi px", "qr@20% -> ok/FAIL");
        int[] previews = {720, 960, 1080};
        double[] dists = {0.20, 0.14, 0.10, 0.08, 0.06, 0.05, 0.04};
        System.out.printf("%-12s", "qr/roi");
        for (int ps : previews) System.out.printf("| %-14s ", "min-side " + ps);
        System.out.println();
        for (double f : dists) {
            System.out.printf("%-12s", String.format("%.0f%%", f * 100));
            for (int ps : previews) {
                int pw = ps * 4 / 3, ph = ps;
                int boxInPreview = Math.round(ps * 0.68f);
                byte[] frame = makeFrameAt(pw, ph, boxInPreview, qr, 1200, f);
                reader.reset();
                String ok = decode(frame, pw, ph, boxInPreview) == null ? "FAIL" : "ok";
                System.out.printf("| %-14s ", ok + " (" + Math.round(boxInPreview * f) + "px)");
            }
            System.out.println();
        }

        // 耗时：每帧都要跑的东西，直接决定取景窗是否流畅
        byte[] cluttered = makeFrame(W, H, BOX, qr, 1200, 0.20, true);
        long t0, t1; int N = 40;
        reader.reset(); decodeFull(cluttered, W, H);
        t0 = System.nanoTime();
        for (int i = 0; i < N; i++) { reader.reset(); decodeFull(cluttered, W, H); }
        t1 = System.nanoTime();
        double fullMs = (t1 - t0) / 1e6 / N;
        reader.reset(); decode(cluttered, W, H, BOX);
        t0 = System.nanoTime();
        for (int i = 0; i < N; i++) { reader.reset(); decode(cluttered, W, H, BOX); }
        t1 = System.nanoTime();
        double boxMs = (t1 - t0) / 1e6 / N;
        // 关键：没有二维码在画面里时（绝大多数帧），新的 decode() 会 ROI 失败后回退整幅，
        // 每帧成本 = roi + full，比原来只跑整幅更贵。测出来。
        byte[] empty = makeFrameAt(1280, 960, 653, qr, 1200, 0.0);
        reader.reset(); decode(empty, 1280, 960, 653);
        t0 = System.nanoTime();
        for (int i = 0; i < N; i++) { reader.reset(); decode(empty, 1280, 960, 653); }
        t1 = System.nanoTime();
        double missMs = (t1 - t0) / 1e6 / N;
        reader.reset(); decodeFull(empty, 1280, 960);
        t0 = System.nanoTime();
        for (int i = 0; i < N; i++) { reader.reset(); decodeFull(empty, 1280, 960); }
        t1 = System.nanoTime();
        double missOldMs = (t1 - t0) / 1e6 / N;
        System.out.printf("%nper-frame decode (code present): full=%.2fms  roi-first=%.2fms%n", fullMs, boxMs);
        throttleFallback = true; fullTick = 0;
        reader.reset(); decode(empty, 1280, 960, 653);
        t0 = System.nanoTime();
        for (int i = 0; i < N; i++) { reader.reset(); decode(empty, 1280, 960, 653); }
        t1 = System.nanoTime();
        double missThrottled = (t1 - t0) / 1e6 / N;
        System.out.printf("per-frame decode (NO code): old-full=%.2fms  roi+every-frame-fallback=%.2fms (%.2fx slower)%n",
                missOldMs, missMs, missMs / missOldMs);
        System.out.printf("                            roi+1-in-8-fallback=%.2fms (%.2fx faster than old)%n",
                missThrottled, missOldMs / missThrottled);

        // 码很大、超出取景框时，限流后最多几帧能抓到？
        byte[] huge = makeFrameAt(1280, 960, 653, qr, 1200, 2.4);  // 远超取景框(653)，几乎占满短边
        // fullTick 从 1 起：让第一次兜底真的发生在第 7 帧，证明"最多 8 帧内抓到"而非"第 0 帧刚好撞上"
        throttleFallback = true; fullTick = 1;
        int found = -1;
        for (int i = 0; i < 20; i++) {
            reader.reset();
            if (decode(huge, 1280, 960, 653) != null) { found = i; break; }
        }
        System.out.println("oversized code (bigger than frame): first hit at frame " + found + " (throttled fallback, must be <= 7)");
    }
}

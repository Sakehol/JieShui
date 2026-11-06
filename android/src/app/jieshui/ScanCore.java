package app.jieshui;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

/**
 * 扫码的解码核心。
 *
 * 单独拆出来是为了让 {@code tools/ScanCoreTest.java} 能在普通 JVM 里
 * 直接跑**这段生产代码**（不需要手机、不需要模拟器），
 * 而不是让测试脚本自己再抄一份解码逻辑 —— 抄的那份会跟真代码漂移，
 * 测出来的"通过"没有意义。
 */
public final class ScanCore {

    private ScanCore() {
    }

    /**
     * 解码一帧 NV21。
     *
     * **不做旋转。** QR 码的三个定位图形是旋转无关的，ZXing 会自己找出三个角并算仿射变换，
     * 所以无论这一帧是正的、倒的、还是躺 90 度，都能直接解。
     * 早期实现每帧先把整幅逐像素旋转一遍，1920x1080 就要 2ms + 2MB 分配，
     * 在相机线程上等于把帧率按在地上。
     *
     * @param roiSide     取景框对应的正方形边长（0 表示不裁，直接整幅解）
     * @param allowFull   是否允许本次做整幅兜底（调用方按帧计数限流）
     * @return 识别到的文本，没有则 null
     */
    public static String decode(MultiFormatReader reader, byte[] yuv, int w, int h,
                                int roiSide, boolean allowFull) {
        if (yuv == null || w <= 0 || h <= 0) return null;
        try {
            if (roiSide > 0 && roiSide < Math.min(w, h)) {
                String r = decodeSquare(reader, cropCenter(yuv, w, h, roiSide), roiSide);
                if (r != null) return r;
            }
            if (allowFull) {
                return decodeFull(reader, yuv, w, h);
            }
        } catch (Exception ignored) {
        } finally {
            reader.reset();
        }
        return null;
    }

    /** 从帧中央裁出边长 side 的正方形。只复制这一块（约 340 KB），不复制整帧（约 2 MB）。 */
    public static byte[] cropCenter(byte[] src, int w, int h, int side) {
        int sx = (w - side) / 2, sy = (h - side) / 2;
        byte[] out = new byte[side * side];
        for (int y = 0; y < side; y++) {
            System.arraycopy(src, (sy + y) * w + sx, out, y * side, side);
        }
        return out;
    }

    private static String decodeSquare(MultiFormatReader reader, byte[] buf, int side) {
        try {
            PlanarYUVLuminanceSource src =
                    new PlanarYUVLuminanceSource(buf, side, side, 0, 0, side, side, false);
            Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(src)));
            if (r != null && r.getText() != null) return r.getText();
        } catch (com.google.zxing.NotFoundException nf) {
            // 这一帧没有码，很正常
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 整幅解（兜底）。注意 PlanarYUVLuminanceSource 必须传真实的宽和高，不能取 min。 */
    private static String decodeFull(MultiFormatReader reader, byte[] buf, int w, int h) {
        try {
            PlanarYUVLuminanceSource src =
                    new PlanarYUVLuminanceSource(buf, w, h, 0, 0, w, h, false);
            Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(src)));
            if (r != null && r.getText() != null) return r.getText();
        } catch (com.google.zxing.NotFoundException nf) {
            // 没有码，正常
        } catch (Exception ignored) {
        }
        return null;
    }
}

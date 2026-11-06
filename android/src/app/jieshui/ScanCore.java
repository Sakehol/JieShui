package app.jieshui;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.InvertedLuminanceSource;
import com.google.zxing.LuminanceSource;
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
     * 解码整幅一帧 NV21（当前手机端的用法）。
     *
     * 为什么解整幅而不是"取景框那一块"：画面现在是**整幅显示**的（contain，不裁不放大），
     * 用户能看见画面四角的码，那就必须也去认那些码。
     * 早先只裁中间一块解，等于把看得见的部分主动丢掉，表现出来就是
     * "明明在画面里却怎么都对不上"。
     *
     * 整幅解比裁块解多花一点时间（1920x1080 约 2.7ms vs 1.2ms），
     * 但这是"用户能看见就一定能认"的代价，值得。
     *
     * @param allowInvert 本次是否额外试一次反色（调用方按帧计数限流，
     *                    因为反色要多解一遍，而深底亮码是少数情况）
     */
    public static String decodeWhole(MultiFormatReader reader, byte[] yuv, int w, int h,
                                     boolean allowInvert) {
        if (yuv == null || w <= 0 || h <= 0) return null;
        try {
            String r = decodeFull(reader, yuv, w, h);
            if (r != null) return r;
            if (allowInvert) {
                // 深底亮码（深色屏幕、反光贴纸）：亮度直方图整个反过来了，
                // ZXing 默认只认深码浅底，必须显式反色再解一遍。
                return decodeFull(reader, invert(yuv, yuv.length), w, h);
            }
        } catch (Exception ignored) {
        } finally {
            reader.reset();
        }
        return null;
    }

    /**
     * 解码一帧 NV21（保留的裁块 + 整幅兜底版本）。
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
            // 整幅兜底的次数本来就被限流到每 8 帧一次，这里再补一次反色尝试，
            // 只在这 1/8 的帧上多花一点点，换取深色底 + 亮码这类贴纸也能认。
            if (allowFull) {
                String r = decodeFull(reader, yuv, w, h);
                if (r != null) return r;
                if (roiSide > 0) {
                    byte[] box = cropCenter(yuv, w, h, roiSide);
                    return decodeSquare(reader, invert(box, box.length), roiSide);
                }
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

    /** 反色。有些饮水机屏幕是深底亮码，或贴了反光膜，亮度直方图整个反过来了。 */
    public static byte[] invert(byte[] gray, int n) {
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) out[i] = (byte) (255 - (gray[i] & 0xFF));
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

    /**
     * 用一维灰度缓冲解一张图（整幅）。
     *
     * 拍照兜底那条路会先把 Bitmap 转成灰度再调这里 —— 转换留在 Activity 里做，
     * 是为了让这个类保持**纯 Java**：它能脱离 Android 在普通 JVM 里跑，
     * tools/ScanCoreTest.java 测的就是这段生产代码本身，不是抄的另一份。
     */
    public static String decodeGray(MultiFormatReader reader, byte[] gray, int w, int h) {
        try {
            LuminanceSource src = new PlanarYUVLuminanceSource(gray, w, h, 0, 0, w, h, false);
            Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(src)));
            if (r != null && r.getText() != null) return r.getText();
        } catch (com.google.zxing.NotFoundException nf) {
            // 没有码，正常
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 整幅解。注意 PlanarYUVLuminanceSource 必须传真实的宽和高，不能取 min。 */
    static String decodeFull(MultiFormatReader reader, byte[] buf, int w, int h) {
        try {
            LuminanceSource src = new PlanarYUVLuminanceSource(buf, w, h, 0, 0, w, h, false);
            Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(src)));
            if (r != null && r.getText() != null) return r.getText();
        } catch (com.google.zxing.NotFoundException nf) {
            // 没有码，正常
        } catch (Exception ignored) {
        }
        return null;
    }
}

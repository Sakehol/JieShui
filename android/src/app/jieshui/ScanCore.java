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
     * 试过但**否决**的做法：把整幅缩小一半再解。tools/DownTest.java 实测
     * 全幅在码占 2.9px/模块时仍能解，缩一半后在 5.1px/模块就开始失败 ——
     * 缩小只会丢信息，对"扫得远"是负收益。
     *
     * @param allowInvert 本次是否额外试一次反色（调用方按帧计数限流，
     *                    因为反色要多解一遍，而深底亮码是少数情况）
     */
    public static String decodeWhole(MultiFormatReader reader, byte[] yuv, int w, int h,
                                     boolean allowInvert) {
        if (yuv == null || w <= 0 || h <= 0) return null;
        try {
            // 第 1 遍：整幅原分辨率。近处的码基本都在这一遍就出来了。
            String r = decodeFull(reader, yuv, w, h);
            if (r != null) return r;

            // 第 2 遍：缩一半再解。
            //
            // 这一遍不是"为了快"，而是为了**拍屏幕**这种场景 —— 这是本 App 的主战场
            // （饮水机就是一块小 LCD）。屏幕有像素栅格和摩尔纹，原分辨率下这些细纹
            // 会混进 ZXing 的 8x8 分块直方图里，把码点边界搅乱，于是一个肉眼非常清楚
            // 的码就是解不出来。2x2 平均把这类高频噪声抹平，码点反而更干净。
            //
            // 网页端一直能扫、App 扫不出来，很大一部分原因就在这里：网页端本来就
            // 把画面缩到 720 宽再解，天然躲过了这一层噪声；App 只在原分辨率上死磕。
            //
            // 代价可忽略：1920x1080 缩一半约 1.3ms，而且只在第 1 遍失败后才跑。
            if (w >= 900 && h >= 600) {
                int w2 = w / 2, h2 = h / 2;
                byte[] small = downsample2(yuv, w, h, w2, h2);
                r = decodeGray(reader, small, w2, h2);
                if (r != null) return r;
                if (allowInvert) {
                    r = decodeGray(reader, invert(small, small.length), w2, h2);
                    if (r != null) return r;
                }
            }

            // 第 3 遍：**点阵码专修** —— 缩到 960 宽后做一次形态学闭运算。
            //
            // 饮水机屏幕上的码不是方块码：每个模块是一个分离的圆点，点与点之间留着
            // 1~2px 的亮缝。人眼看着毫无问题，ZXing 却连三个定位图形都找不到 ——
            // 因为 finder 的 1:1:3:1:1 扫线比例被缝隙切碎了。这不是"糊"，是
            // "图案不连通"，所以锐化/调阈值/换二值化器全部无效（都实测过）。
            //
            // 先缩到 960 把成本压到 13~19ms（全幅做要 100~250ms），再闭运算把亮缝
            // 填上，让模块重新连成实心方块。r=2 和 r=3 覆盖的缝隙宽度不同，两个都试。
            // 实测：缝隙 1px 和 2px 的合成帧都从"解不出"变成"解出"。
            //
            // 这一遍贵，所以跟反色一样按帧限流（调用方每 8 帧传一次 allowInvert）。
            if (allowInvert && w >= 900 && h >= 600) {
                int w4 = 960, h4 = Math.max(1, Math.round((float) h * 960 / w));
                byte[] s4 = scaleTo(yuv, w, h, w4, h4);
                for (int r2 : new int[]{2, 3}) {
                    byte[] closed = close(s4, w4, h4, r2);
                    r = decodeGray(reader, closed, w4, h4);
                    if (r != null) return r;
                    r = decodeGray(reader, invert(closed, closed.length), w4, h4);
                    if (r != null) return r;
                }
            }

            // 第 4 遍：整幅原分辨率 + 反色。
            // 深底亮码（深色屏幕、反光贴纸）：亮度直方图整个反过来了，
            // ZXing 默认只认深码浅底，必须显式反色再解一遍。
            if (allowInvert) {
                return decodeFull(reader, invert(yuv, yuv.length), w, h);
            }
        } catch (Exception ignored) {
        } finally {
            reader.reset();
        }
        return null;
    }

    /**
     * 2x2 平均降采样（只取亮度平面，NV21 的 VU 部分直接丢掉）。
     *
     * 用平均而不是"隔点取一个"：隔点取会把模块边缘的过渡整个跳过，
     * 小码上很容易整块丢模块；平均保留了一点抗锯齿信息，实测在小码上更稳。
     */
    public static byte[] downsample2(byte[] src, int w, int h, int w2, int h2) {
        byte[] out = new byte[w2 * h2];
        for (int y = 0; y < h2; y++) {
            int sy = y * 2;
            int row0 = sy * w, row1 = (sy + 1 < h ? sy + 1 : sy) * w;
            int orow = y * w2;
            for (int x = 0; x < w2; x++) {
                int sx = x * 2;
                int sx1 = sx + 1 < w ? sx + 1 : sx;
                int a = src[row0 + sx] & 0xFF;
                int b = src[row0 + sx1] & 0xFF;
                int c = src[row1 + sx] & 0xFF;
                int d = src[row1 + sx1] & 0xFF;
                out[orow + x] = (byte) ((a + b + c + d) >> 2);
            }
        }
        return out;
    }

    /**
     * 缩放到任意尺寸（面积平均）。
     *
     * 不能拿 {@link #downsample2} 顶替 —— 那个写死了 2x，传别的目标尺寸会读错行。
     * 这里按目标像素反查源矩形再取平均，缩小时每个目标像素都吃到一整块源像素，
     * 相当于一次盒式低通，正适合把 LCD 的像素栅格和摩尔纹抹掉。
     */
    public static byte[] scaleTo(byte[] src, int w, int h, int nw, int nh) {
        byte[] out = new byte[nw * nh];
        for (int y = 0; y < nh; y++) {
            int sy0 = (int) ((long) y * h / nh);
            int sy1 = (int) Math.max(sy0 + 1, (long) (y + 1) * h / nh);
            for (int x = 0; x < nw; x++) {
                int sx0 = (int) ((long) x * w / nw);
                int sx1 = (int) Math.max(sx0 + 1, (long) (x + 1) * w / nw);
                int sum = 0, n = 0;
                for (int yy = sy0; yy < sy1; yy++) {
                    int base = yy * w;
                    for (int xx = sx0; xx < sx1; xx++) {
                        sum += src[base + xx] & 0xFF;
                        n++;
                    }
                }
                out[y * nw + x] = (byte) (n == 0 ? 0 : sum / n);
            }
        }
        return out;
    }

    /**
     * 形态学闭运算（先取最小值膨胀，再取最大值腐蚀），用来把"点阵二维码"的缝隙填上。
     *
     * 为什么需要它：饮水机屏幕上的码不是方块码，每个模块被画成一个**分离的圆点**，
     * 点与点之间留了 1~2px 的亮缝。这种码人眼看着毫无问题，ZXing 却解不出来 ——
     * 因为三个定位图形（finder）的 1:1:3:1:1 扫线比例被缝隙切碎了，连角都找不到，
     * 后面再强的纠错也用不上。这不是"糊"的问题，是"图案不连通"的问题，
     * 所以锐化、调阈值、换二值化器**全部无效**（都实测过）。
     *
     * 闭运算把亮缝填上，让每个模块重新连成实心方块，定位图形恢复正常比例。
     * 经典 O(n·r²) 太慢（1080p 上 100~250ms），这里用可分离写法：先横后竖，
     * 复杂度降到 O(n·r)，960 宽上只要 13~19ms。
     *
     * @param r 半径。1 只填 2px 以内的缝，2~3 能填 4~6px；实测 r=2 和 r=3 覆盖最广。
     */
    public static byte[] close(byte[] src, int w, int h, int r) {
        return maxFilter(minFilter(src, w, h, r), w, h, r);
    }

    /** 可分离的最小值滤波（横一遍、竖一遍），膨胀深色区域。 */
    public static byte[] minFilter(byte[] src, int w, int h, int r) {
        byte[] tmp = new byte[w * h], out = new byte[w * h];
        for (int y = 0; y < h; y++) {
            int base = y * w;
            for (int x = 0; x < w; x++) {
                int lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r), mn = 255;
                for (int xx = lo; xx <= hi; xx++) {
                    int v = src[base + xx] & 0xFF;
                    if (v < mn) mn = v;
                }
                tmp[base + x] = (byte) mn;
            }
        }
        for (int x = 0; x < w; x++) {
            for (int y = 0; y < h; y++) {
                int lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r), mn = 255;
                for (int yy = lo; yy <= hi; yy++) {
                    int v = tmp[yy * w + x] & 0xFF;
                    if (v < mn) mn = v;
                }
                out[y * w + x] = (byte) mn;
            }
        }
        return out;
    }

    /** 可分离的最大值滤波（横一遍、竖一遍），腐蚀深色区域。 */
    public static byte[] maxFilter(byte[] src, int w, int h, int r) {
        byte[] tmp = new byte[w * h], out = new byte[w * h];
        for (int y = 0; y < h; y++) {
            int base = y * w;
            for (int x = 0; x < w; x++) {
                int lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r), mx = 0;
                for (int xx = lo; xx <= hi; xx++) {
                    int v = src[base + xx] & 0xFF;
                    if (v > mx) mx = v;
                }
                tmp[base + x] = (byte) mx;
            }
        }
        for (int x = 0; x < w; x++) {
            for (int y = 0; y < h; y++) {
                int lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r), mx = 0;
                for (int yy = lo; yy <= hi; yy++) {
                    int v = tmp[yy * w + x] & 0xFF;
                    if (v > mx) mx = v;
                }
                out[y * w + x] = (byte) mx;
            }
        }
        return out;
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

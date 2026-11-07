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
 * Does 2x downsampling help or hurt ZXing, at each code size?
 *
 * Renders a real QR, pastes it into a 1920x1080 frame at a controlled size,
 * then decodes (a) the full frame, (b) the half-size frame.
 */
public class DownTest {

    static final int W = 1920, H = 1080;
    static final String CONTENT = "https://m.qiekj.com/s?SN=NQT2024001&c=04";

    public static void main(String[] a) throws Exception {
        MultiFormatReader reader = newReader();
        int[] codePx = {400, 300, 240, 192, 160, 128, 104, 88, 72};
        int[] modPxAsInt = {16, 12, 10, 8, 6, 5, 4, 3, 3};
        int i = 0;
        System.out.println("codePx | modules/px | full | half");
        for (int cp : codePx) {
            BitMatrix m = new QRCodeWriter().encode(CONTENT, BarcodeFormat.QR_CODE, cp, cp);
            byte[] frame = grayFrame();
            paste(frame, W, H, m, cp);
            String f = ScanCore.decodeGray(reader, frame, W, H);
            int w2 = W / 2, h2 = H / 2;
            byte[] half = ScanCore.downsample2(frame, W, H, w2, h2);
            String hf = ScanCore.decodeGray(reader, half, w2, h2);
            System.out.println(String.format("%6d | %4.1f     | %-4s | %-4s", cp, cp / 25.0,
                    f != null ? "OK" : "--", hf != null ? "OK" : "--"));
            i++;
        }
        // and a big code near the camera: downsampling should not break it
        BitMatrix big = new QRCodeWriter().encode(CONTENT, BarcodeFormat.QR_CODE, 800, 800);
        byte[] fr = grayFrame();
        paste(fr, W, H, big, 800);
        System.out.println("big 800px: full=" + (ScanCore.decodeGray(reader, fr, W, H) != null)
                + " half=" + (ScanCore.decodeGray(reader, ScanCore.downsample2(fr, W, H, W / 2, H / 2), W / 2, H / 2) != null));
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
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                g[y * W + x] = (byte) (170 + ((x / 40 + y / 40) & 1) * 12);
            }
        }
        return g;
    }

    /** Paste the module grid scaled to cp pixels, centred, dark modules on light. */
    static void paste(byte[] g, int w, int h, BitMatrix m, int cp) {
        int ox = (w - cp) / 2, oy = (h - cp) / 2;
        int n = m.getWidth();
        for (int y = 0; y < cp; y++) {
            int my = y * n / cp;
            for (int x = 0; x < cp; x++) {
                int mx = x * n / cp;
                byte v = m.get(mx, my) ? (byte) 20 : (byte) 235;
                g[(oy + y) * w + ox + x] = v;
            }
        }
    }
}

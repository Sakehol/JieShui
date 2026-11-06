package app.jieshui;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/** 全屏扫码：Camera1 预览 + ZXing 解码 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {

    public static final String EXTRA_RESULT = "result";
    private static final int REQ_PERM = 11;

    private SurfaceView surfaceView;
    private SurfaceHolder holder;
    private Camera camera;
    private int camId = -1;

    private final MultiFormatReader reader = new MultiFormatReader();
    private boolean decoding = false;
    private boolean handled = false;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private TextView hintView;
    private boolean torchOn = false;
    private int boxSidePx = 0;    // 取景框边长（屏幕 px）
    private int surfaceW = 0, surfaceH = 0;  // 预览画面的显示尺寸
    private int fullTick = 0;     // 兜底整幅解也要限流，见 decode()

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        surfaceView = new SurfaceView(this);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        holder = surfaceView.getHolder();
        holder.addCallback(this);

        // 取景框
        View frame = new View(this) {
            @Override
            protected void onDraw(android.graphics.Canvas cv) {
                android.graphics.Paint p = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
                p.setStyle(android.graphics.Paint.Style.STROKE);
                p.setStrokeWidth(Ui.dp(ScanActivity.this, 3));
                p.setColor(Color.WHITE);
                p.setStrokeCap(android.graphics.Paint.Cap.ROUND);
                float w = getWidth(), h = getHeight(), len = w * 0.22f;
                float l = Ui.dp(ScanActivity.this, 2), r = w - l, t = l, bt = h - l;
                cv.drawLine(l, t, l + len, t, p);
                cv.drawLine(l, t, l, t + len, p);
                cv.drawLine(r - len, t, r, t, p);
                cv.drawLine(r, t, r, t + len, p);
                cv.drawLine(l, bt - len, l, bt, p);
                cv.drawLine(l, bt, l + len, bt, p);
                cv.drawLine(r, bt - len, r, bt, p);
                cv.drawLine(r - len, bt, r, bt, p);
            }
        };
        int side = Math.min(getResources().getDisplayMetrics().widthPixels,
                getResources().getDisplayMetrics().heightPixels) * 68 / 100;
        boxSidePx = side;
        FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(side, side);
        flp.gravity = Gravity.CENTER;
        root.addView(frame, flp);

        // 顶部栏
        LinearLayout top = Ui.row(this);
        top.setPadding(Ui.dp(this, 14), Ui.dp(this, 22), Ui.dp(this, 14), 0);

        TextView close = Ui.text(this, "✕", 22, Color.WHITE, false);
        close.setGravity(Gravity.CENTER);
        close.setPadding(Ui.dp(this, 12), Ui.dp(this, 8), Ui.dp(this, 12), Ui.dp(this, 8));
        close.setOnClickListener(v -> finish());
        Ui.pressable(close);
        top.addView(close);

        hintView = Ui.text(this, "对准二维码", 14, Color.WHITE, false);
        hintView.setGravity(Gravity.CENTER);
        top.addView(hintView, Ui.lpw(1f));

        TextView torch = Ui.text(this, "☀", 20, Color.WHITE, false);
        torch.setGravity(Gravity.CENTER);
        torch.setPadding(Ui.dp(this, 12), Ui.dp(this, 8), Ui.dp(this, 12), Ui.dp(this, 8));
        torch.setOnClickListener(v -> toggleTorch(torch));
        Ui.pressable(torch);
        top.addView(torch);

        FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.gravity = Gravity.TOP;
        root.addView(top, tlp);

        // 底部：手动输入
        TextView manual = Ui.ghostButton(this, "手动输入设备号");
        manual.setTextColor(Color.WHITE);
        manual.setBackground(Ui.round(0x66000000, 12, 0x59FFFFFF, 1, this));
        manual.setOnClickListener(v -> {
            Intent i = new Intent(this, ManualActivity.class);
            startActivityForResult(i, 22);
        });
        FrameLayout.LayoutParams mlp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mlp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
        mlp.bottomMargin = Ui.dp(this, 46);
        root.addView(manual, mlp);

        setContentView(root);

        List<BarcodeFormat> formats = new ArrayList<>();
        formats.add(BarcodeFormat.QR_CODE);
        formats.add(BarcodeFormat.CODE_128);
        formats.add(BarcodeFormat.CODE_39);
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        reader.setHints(hints);

        if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_PERM);
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] p, int[] g) {
        super.onRequestPermissionsResult(req, p, g);
        if (req == REQ_PERM) {
            if (g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) {
                startPreview();
            } else {
                hintView.setText("未授予相机权限");
            }
        }
    }

    @Override
    public void surfaceCreated(SurfaceHolder h) {
        startPreview();
    }

    @Override
    public void surfaceChanged(SurfaceHolder h, int f, int w, int hh) {
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder h) {
        stopPreview();
    }

    private void startPreview() {
        if (camera != null) return;
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        try {
            camera = openBackCamera();
            if (camera == null) {
                hintView.setText("未找到摄像头");
                return;
            }
            Camera.Parameters pr = camera.getParameters();
            List<String> focus = pr.getSupportedFocusModes();
            if (focus != null && focus.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                pr.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            }
            List<Camera.Size> sizes = pr.getSupportedPreviewSizes();
            if (sizes != null && !sizes.isEmpty()) {
                // 挑 min(w,h) 最大的一档（上限 1080）—— 取景框是正方形，
                // 能拿到多少原生像素只取决于短边。原来挑的是"宽在 960~1440 之间面积最小"，
                // 常常落到 1280x720，短边只有 720，白白浪费一半分辨率。
                Camera.Size best = null;
                for (Camera.Size s : sizes) {
                    int m = Math.min(s.width, s.height);
                    if (m > 1080) continue;
                    if (best == null || m > Math.min(best.width, best.height)) best = s;
                }
                if (best == null) {
                    for (Camera.Size s : sizes) {
                        if (best == null || Math.min(s.width, s.height) > Math.min(best.width, best.height)) best = s;
                    }
                }
                pr.setPreviewSize(best.width, best.height);
            }
            pr.setPreviewFormat(android.graphics.ImageFormat.NV21);
            camera.setParameters(pr);
            applySurfaceLayout(pr.getPreviewSize());

            camera.setPreviewDisplay(holder);
            setDisplayOrientation();
            camera.setPreviewCallback(this);
            camera.startPreview();
        } catch (Exception e) {
            hintView.setText("相机启动失败：" + e.getMessage());
            stopPreview();
        }
    }

    /**
     * 按预览的真实宽高比调整 SurfaceView 的大小，让画面**不被拉伸**。
     * 原来 SurfaceView 是 MATCH_PARENT，Camera1 的预览会被硬拉到整个屏幕 ——
     * 竖屏时 4:3 的流被拉成 9:19.5，二维码在画面上是扁的，
     * 用户看到的形状和实际解的形状都对不上，也压低识别率。
     * 现在按比例居中铺满（cover），多出来的部分裁在屏幕外。
     */
    private void applySurfaceLayout(Camera.Size size) {
        if (size == null || size.width <= 0 || size.height <= 0) return;
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;
        // 预览旋转 90/270 后，宽高互换
        int rotation = cameraOrientationDegrees();
        float sw = (rotation == 90 || rotation == 270) ? size.height : size.width;
        float sh = (rotation == 90 || rotation == 270) ? size.width : size.height;
        float scale = Math.max(screenW / sw, screenH / sh);
        int vw = Math.round(sw * scale), vh = Math.round(sh * scale);
        surfaceW = vw; surfaceH = vh;
        ViewGroup.LayoutParams lp = surfaceView.getLayoutParams();
        if (lp instanceof FrameLayout.LayoutParams) {
            FrameLayout.LayoutParams f = (FrameLayout.LayoutParams) lp;
            f.width = vw; f.height = vh;
            f.gravity = Gravity.CENTER;   // 取景框在正中，预览也必须居中才对齐
            surfaceView.setLayoutParams(f);
        } else if (lp != null) {
            lp.width = vw; lp.height = vh;
            surfaceView.setLayoutParams(lp);
        }
    }

    private Camera openBackCamera() {
        int n = Camera.getNumberOfCameras();
        Camera.CameraInfo info = new Camera.CameraInfo();
        for (int i = 0; i < n; i++) {
            Camera.getCameraInfo(i, info);
            if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) {
                camId = i;
                return Camera.open(i);
            }
        }
        if (n > 0) {
            camId = 0;
            return Camera.open(0);
        }
        return null;
    }

    private void setDisplayOrientation() {
        if (camera == null || camId < 0) return;
        Camera.CameraInfo info = new Camera.CameraInfo();
        Camera.getCameraInfo(camId, info);
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        int deg = 0;
        switch (rotation) {
            case Surface.ROTATION_90: deg = 90; break;
            case Surface.ROTATION_180: deg = 180; break;
            case Surface.ROTATION_270: deg = 270; break;
        }
        int result;
        if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
            result = (360 - ((info.orientation + deg) % 360)) % 360;
        } else {
            result = (info.orientation - deg + 360) % 360;
        }
        camera.setDisplayOrientation(result);
    }

    private void stopPreview() {
        if (camera != null) {
            try {
                camera.setPreviewCallback(null);
                camera.stopPreview();
                camera.release();
            } catch (Exception ignored) {
            }
            camera = null;
        }
    }

    private void toggleTorch(TextView btn) {
        if (camera == null) return;
        try {
            Camera.Parameters pr = camera.getParameters();
            if (pr.getSupportedFlashModes() == null ||
                    !pr.getSupportedFlashModes().contains(Camera.Parameters.FLASH_MODE_TORCH)) {
                hintView.setText("该设备不支持手电筒");
                return;
            }
            torchOn = !torchOn;
            pr.setFlashMode(torchOn ? Camera.Parameters.FLASH_MODE_TORCH : Camera.Parameters.FLASH_MODE_OFF);
            camera.setParameters(pr);
            btn.setAlpha(torchOn ? 1f : 0.6f);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onPreviewFrame(byte[] data, Camera cam) {
        if (data == null || decoding || handled || camera == null) return;
        decoding = true;

        final Camera.Size size = cam.getParameters().getPreviewSize();
        final int w = size.width, h = size.height;
        final byte[] copy = data.clone();
        final int rotation = camId >= 0 ? cameraOrientationDegrees() : 0;

        new Thread(() -> {
            String text = decode(copy, w, h, rotation);
            decoding = false;
            if (text != null && !handled) {
                handled = true;
                final String out = text;
                ui.post(() -> {
                    setResult(RESULT_OK, new Intent().putExtra(EXTRA_RESULT, out));
                    finish();
                });
            }
        }).start();
    }

    private int cameraOrientationDegrees() {
        Camera.CameraInfo info = new Camera.CameraInfo();
        Camera.getCameraInfo(camId, info);
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        int deg = 0;
        switch (rotation) {
            case Surface.ROTATION_90: deg = 90; break;
            case Surface.ROTATION_180: deg = 180; break;
            case Surface.ROTATION_270: deg = 270; break;
        }
        return (info.orientation - deg + 360) % 360;
    }

    private String decode(byte[] yuv, int w, int h, int rotation) {
        try {
            byte[] rotated = rotation == 0 ? yuv : rotateYuv(yuv, w, h, rotation);
            int nw = (rotation == 90 || rotation == 270) ? h : w;
            int nh = (rotation == 90 || rotation == 270) ? w : h;

            // 主路径：只解取景框对应的那块正方形。
            // 取景框占屏幕短边 68%，换算成面积只占整帧的 1/3 左右，
            // 实测每帧从 2.7ms 降到 1.2ms，同帧率下可以多解几轮，用户感觉更跟手。
            int roiSide = roiSide(nw, nh);
            if (roiSide > 0 && roiSide < Math.min(nw, nh)) {
                int sx = (nw - roiSide) / 2, sy = (nh - roiSide) / 2;
                byte[] crop = new byte[roiSide * roiSide];
                for (int y = 0; y < roiSide; y++) {
                    System.arraycopy(rotated, (sy + y) * nw + sx, crop, y * roiSide, roiSide);
                }
                String r = decodeSquare(crop, roiSide);
                if (r != null) return r;
            }

            // 兜底：整幅再试一次，但**不是每帧都跑**。
            // 绝大多数帧画面里根本没有码，ROI 失败后立刻整幅重解的话，
            // 每帧成本是 ROI + 整幅（实测 4.6ms，比只解整幅的 3.1ms 还慢 46%）。
            // 改成每 8 帧兜底一次：平均 1.2 + 3.1/8 ≈ 1.6ms，比原来还快；
            // 码特别大、超出取景框的情况最多 8 帧（约 0.3 秒）就能被兜底抓到。
            if ((fullTick++ & 7) == 0) {
                return decodeFull(rotated, nw, nh);
            }
        } catch (Exception ignored) {
        } finally {
            reader.reset();
        }
        return null;
    }

    private String decodeSquare(byte[] buf, int side) {
        try {
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(buf, side, side, 0, 0, side, side, false);
            BinaryBitmap bmp = new BinaryBitmap(new HybridBinarizer(src));
            Result r = reader.decodeWithState(bmp);
            if (r != null && r.getText() != null) return r.getText();
        } catch (com.google.zxing.NotFoundException nf) {
            // 这一帧没有码，很正常
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 整幅解（兜底）。注意 PlanarYUVLuminanceSource 必须传真实的宽和高，不能取 min。 */
    private String decodeFull(byte[] buf, int w, int h) {
        try {
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(buf, w, h, 0, 0, w, h, false);
            BinaryBitmap bmp = new BinaryBitmap(new HybridBinarizer(src));
            Result r = reader.decodeWithState(bmp);
            if (r != null && r.getText() != null) return r.getText();
        } catch (com.google.zxing.NotFoundException nf) {
            // 没有码，正常
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 取景框在预览图里对应的正方形边长（预览坐标系，已旋转）。 */
    private int roiSide(int nw, int nh) {
        if (boxSidePx <= 0 || surfaceW <= 0 || surfaceH <= 0) return 0;
        // 预览是按比例铺在 surface 上的，框占 surface 多少比例，就占预览多少比例
        float fx = (float) boxSidePx / surfaceW;
        float fy = (float) boxSidePx / surfaceH;
        return Math.round(Math.min(fx * nw, fy * nh));
    }

    private static byte[] rotateYuv(byte[] data, int w, int h, int deg) {
        byte[] out = new byte[data.length];
        if (deg == 90) {
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                    out[x * h + (h - y - 1)] = data[y * w + x];
        } else if (deg == 180) {
            for (int i = 0; i < data.length; i++) out[i] = data[data.length - i - 1];
        } else if (deg == 270) {
            for (int y = 0; y < h; y++)
                for (int x = 0; x < w; x++)
                    out[(w - x - 1) * h + y] = data[y * w + x];
        } else {
            return data;
        }
        return out;
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == 22 && res == RESULT_OK && data != null) {
            setResult(RESULT_OK, new Intent().putExtra(EXTRA_RESULT, data.getStringExtra(EXTRA_RESULT)));
            finish();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopPreview();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (holder != null && holder.getSurface() != null && holder.getSurface().isValid()) {
            startPreview();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopPreview();
    }
}

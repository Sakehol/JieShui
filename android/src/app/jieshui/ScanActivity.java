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
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;

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
    private boolean handled = false;
    private final Handler ui = new Handler(Looper.getMainLooper());

    /**
     * 解码全部丢给这一个线程。
     * 原来是每帧 new Thread()：30 fps 就是每秒建 30 个线程，
     * 而且线程还没跑完下一帧又来了，多个解码同时抢 reader，实际上帧率被压得更低。
     */
    private final java.util.concurrent.ExecutorService decoder =
            java.util.concurrent.Executors.newSingleThreadExecutor();
    /** 上一帧还没解完就丢掉这一帧，天然做到「最多只有一帧在路上」。 */
    private final java.util.concurrent.atomic.AtomicBoolean pending =
            new java.util.concurrent.atomic.AtomicBoolean(false);
    /** 复用的拷贝缓冲，避免每帧 clone 出来 2 MB 垃圾。 */
    private byte[] frameBuf;
    private int previewW = 0, previewH = 0;

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
            if (focus != null) {
                // 连续对焦优先。有些机器只给 CONTINUOUS_VIDEO 或只给 AUTO，
                // 不设的话默认是定焦，凑近拍二维码就是糊的 —— 这是"扫不上"的常见原因之一。
                if (focus.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                    pr.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
                } else if (focus.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO)) {
                    pr.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO);
                } else if (focus.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                    pr.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
                }
            }
            List<Camera.Size> sizes = pr.getSupportedPreviewSizes();
            if (sizes != null && !sizes.isEmpty()) {
                // 挑「取景框里能拿到最多原生像素」的那一档，同分时取总面积最小的。
                //
                // 以前按「短边最大」挑，看上去合理，其实不对：
                // 预览是按比例铺满屏幕的，比例越窄，铺上去放大得越狠，
                // 同一个取景框落到的原生像素反而越少。以 1080x2400 的屏幕为例，
                //   1440x1080 要把 4:3 拉到 20:9，放大 1.67 倍 → 框内只有 440 像素
                //   1920x1080 放大 1.25 倍                        → 框内 587 像素
                // 两者短边都是 1080，旧规则会挑前者，白白少 33% 的解析力。
                Camera.Size best = null;
                int bestRoi = 0;
                long bestArea = Long.MAX_VALUE;
                for (Camera.Size s : sizes) {
                    long area = (long) s.width * s.height;
                    // 超过 260 万像素就不考虑了：每帧要拷一份进解码线程，
                    // 8 MB 的帧在低端机上是实打实的带宽开销，而框内像素只多一点点。
                    if (area > 2600000L) continue;
                    int roi = roiSideFor(s.width, s.height);
                    if (roi > bestRoi || (roi == bestRoi && area < bestArea)) {
                        best = s;
                        bestRoi = roi;
                        bestArea = area;
                    }
                }
                if (best == null) {
                    // 全都超了上限，那就退回按短边挑，保证有得用
                    for (Camera.Size s : sizes) {
                        if (best == null || Math.min(s.width, s.height) > Math.min(best.width, best.height)) best = s;
                    }
                }
                if (best != null) pr.setPreviewSize(best.width, best.height);
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
        if (data == null || handled || camera == null) return;
        // 上一帧还在解就直接丢掉这一帧。
        // 注意这里必须用「原子地抢一个令牌」而不是 boolean flag：
        // 原来用 decoding 布尔量，它在子线程里复位，而 onPreviewFrame 在相机线程，
        // 存在读到旧值的窗口，偶尔会放两帧进来同时解 —— 抢 reader 抢到互相拖慢。
        if (!pending.compareAndSet(false, true)) return;

        final Camera.Size size = cam.getParameters().getPreviewSize();
        final int w = size.width, h = size.height;
        if (frameBuf == null || frameBuf.length != data.length || w != previewW || h != previewH) {
            frameBuf = new byte[data.length];
            previewW = w;
            previewH = h;
        }
        final byte[] buf = frameBuf;
        System.arraycopy(data, 0, buf, 0, data.length);

        decoder.execute(() -> {
            String text = null;
            try {
                text = decode(buf, w, h);
            } catch (Throwable ignored) {
            } finally {
                pending.set(false);
            }
            if (text != null && !handled) {
                handled = true;
                final String out = text;
                ui.post(() -> {
                    setResult(RESULT_OK, new Intent().putExtra(EXTRA_RESULT, out));
                    finish();
                });
            }
        });
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

    /**
     * 解码一帧。真正的算法在 {@link ScanCore} 里 —— 拆出去是为了能脱离手机直接测。
     */
    private String decode(byte[] yuv, int w, int h) {
        int roiSide = roiSideFor(w, h);
        // 兜底整幅解不是每帧都跑：绝大多数帧画面里根本没有码，
        // ROI 失败后立刻整幅重解的话每帧成本是 ROI + 整幅（实测 4.6ms，
        // 比只解整幅的 3.1ms 还慢 46%）。改成每 8 帧一次：
        // 平均 1.2 + 3.1/8 ≈ 1.6ms，比原来还快；码特别大、超出取景框的
        // 情况最多 8 帧（约 0.3 秒）也能被兜底抓到。
        boolean allowFull = (fullTick++ & 7) == 0;
        return ScanCore.decode(reader, yuv, w, h, roiSide, allowFull);
    }

    /**
     * 给定预览尺寸，算出取景框里能拿到多少原生像素。
     * 屏幕短边 68% 的方框，按 cover 铺满后落到预览上还剩多长的一条边。
     */
    private int roiSideFor(int pw, int ph) {
        if (boxSidePx <= 0 || pw <= 0 || ph <= 0) return 0;
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;
        // 预览旋转后宽高互换
        int rotation = camId >= 0 ? cameraOrientationDegrees() : 0;
        float rw = (rotation == 90 || rotation == 270) ? ph : pw;
        float rh = (rotation == 90 || rotation == 270) ? pw : ph;
        float scale = Math.max(screenW / rw, screenH / rh);
        float vw = rw * scale, vh = rh * scale;
        float fx = boxSidePx / vw, fy = boxSidePx / vh;
        return Math.round(Math.min(fx * rw, fy * rh));
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
        decoder.shutdownNow();
        frameBuf = null;
    }
}

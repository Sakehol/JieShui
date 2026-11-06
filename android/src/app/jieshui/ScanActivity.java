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
    private int surfaceW = 0, surfaceH = 0;  // 预览画面的显示尺寸
    private int fullTick = 0;     // 兜底整幅解也要限流，见 decode()
    // 预览画面在屏幕上的尺寸 / 取景框边长，都在 applySurfaceLayout() 里算好，
    // 供取景框那层自绘 View 和「点按对焦」使用。
    private int picW = 0, picH = 0;
    private int frameSide = 0;
    private View frameView;
    private long lastPhotoAt = 0;         // 上次拍全分辨率照片的时间
    private boolean photoBusy = false;
    private static final long PHOTO_INTERVAL_MS = 2600;   // 连续预览扫不出来时，多久拍一张

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

        // 取景框：一层**整屏大小**的自绘 View，只画四角准星 + 框外压暗，
        // 不改动画面本身。位置和大小由 applySurfaceLayout() 按"画面在屏幕上的真实矩形"算，
        // 保证框一定完整落在画面里 —— 早先按"屏幕短边的 72%"算，竖屏下
        // 画面只占中间一条 16:9 的带子时，框能比画面还高，上下落在黑边上，
        // 用户照框去对，码其实早就出画面了。这是"扫不上"最隐蔽的一个原因。
        frameView = new View(this) {
            @Override
            protected void onDraw(android.graphics.Canvas cv) {
                int side = frameSide;
                if (side <= 0) return;
                float w = getWidth(), h = getHeight();
                float cx = w / 2f, cy = h / 2f, half = side / 2f;
                float l = cx - half, r = cx + half, t = cy - half, bt = cy + half;

                android.graphics.Paint dim = new android.graphics.Paint();
                dim.setColor(0x9E000000);
                cv.drawRect(0, 0, w, t, dim);
                cv.drawRect(0, bt, w, h, dim);
                cv.drawRect(0, t, l, bt, dim);
                cv.drawRect(r, t, w, bt, dim);

                android.graphics.Paint p = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
                p.setStyle(android.graphics.Paint.Style.STROKE);
                p.setStrokeWidth(Ui.dp(ScanActivity.this, 3));
                p.setColor(Color.WHITE);
                p.setStrokeCap(android.graphics.Paint.Cap.ROUND);
                float len = side * 0.22f;
                float e = Ui.dp(ScanActivity.this, 2);
                cv.drawLine(l + e, t + e, l + e + len, t + e, p);
                cv.drawLine(l + e, t + e, l + e, t + e + len, p);
                cv.drawLine(r - e - len, t + e, r - e, t + e, p);
                cv.drawLine(r - e, t + e, r - e, t + e + len, p);
                cv.drawLine(l + e, bt - e - len, l + e, bt - e, p);
                cv.drawLine(l + e, bt - e, l + e + len, bt - e, p);
                cv.drawLine(r - e, bt - e - len, r - e, bt - e, p);
                cv.drawLine(r - e - len, bt - e, r - e, bt - e, p);
            }
        };
        root.addView(frameView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // 点一下画面 = 立刻拍一张全分辨率照片识别（远处的码靠这个）。
        // 网页端也是点画面触发，两端一致。
        frameView.setOnClickListener(v -> { lastPhotoAt = 0; maybePhotoFallback(); });

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
                // 挑「整幅像素最多」的那一档。
                //
                // 以前按「取景框里能拿到多少原生像素」挑 —— 那是"只解中间一块"时代的规则。
                // 现在解的是整幅，能扫多远直接取决于**整幅的像素数**，规则跟着改：
                //   同一台机器，1920x1080 比 1440x1080 多 78% 的像素，
                //   远处的二维码在后者里可能只有 100px，在前者里有 133px，
                //   换算成每模块的像素数就是 4.0 vs 5.3，一个是勉强、一个是稳的。
                Camera.Size best = null;
                long bestArea = 0;
                for (Camera.Size s : sizes) {
                    long area = (long) s.width * s.height;
                    // 超过 400 万像素就不考虑了：每帧要拷一份进解码线程，
                    // 8 MB 以上的帧在低端机上是实打实的带宽开销，
                    // 而 ZXing 在 400 万像素上单帧就要十几毫秒，帧率会掉。
                    if (area > 4000000L) continue;
                    // 太小的不要：640x480 这种连近处的码都吃力
                    if (Math.min(s.width, s.height) < 720) continue;
                    if (area > bestArea) { best = s; bestArea = area; }
                }
                if (best == null) {
                    // 没有落在区间里的，退回按短边挑，保证有得用
                    for (Camera.Size s : sizes) {
                        if (best == null || Math.min(s.width, s.height) > Math.min(best.width, best.height)) best = s;
                    }
                }
                if (best != null) pr.setPreviewSize(best.width, best.height);
            }
            pr.setPreviewFormat(android.graphics.ImageFormat.NV21);
            // 数码变焦归位。有些机器上一次用完留了个非 1 的变焦，
            // 表现就是"相机自己放大了、退远了反而扫不上"。
            try {
                if (pr.isZoomSupported() && pr.getZoom() != 0) pr.setZoom(0);
            } catch (Exception ignored) {
            }
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
     *
     * 这里改成 **contain**：整幅画面完整可见，多出来的地方留黑边，一像素都不裁。
     * 早先用的是 cover（铺满屏幕、多余裁掉），结果是"看到的画面被放大了"——
     * 用户以为离得太近就往后退，越退码越小，反而更扫不上。
     * 网页端也踩过同一个坑，现在是双端一致的 contain。
     */
    private void applySurfaceLayout(Camera.Size size) {
        if (size == null || size.width <= 0 || size.height <= 0) return;
        int screenW = getResources().getDisplayMetrics().widthPixels;
        int screenH = getResources().getDisplayMetrics().heightPixels;
        // 预览旋转 90/270 后，宽高互换
        int rotation = cameraOrientationDegrees();
        float sw = (rotation == 90 || rotation == 270) ? size.height : size.width;
        float sh = (rotation == 90 || rotation == 270) ? size.width : size.height;
        // contain：取较小的缩放比，整幅装进屏幕
        float scale = Math.min(screenW / sw, screenH / sh);
        int vw = Math.round(sw * scale), vh = Math.round(sh * scale);
        surfaceW = vw; surfaceH = vh;
        picW = vw; picH = vh;
        ViewGroup.LayoutParams lp = surfaceView.getLayoutParams();
        if (lp instanceof FrameLayout.LayoutParams) {
            FrameLayout.LayoutParams f = (FrameLayout.LayoutParams) lp;
            f.width = vw; f.height = vh;
            f.gravity = Gravity.CENTER;   // 取景框在正中，画面也必须居中才对齐
            surfaceView.setLayoutParams(f);
        } else if (lp != null) {
            lp.width = vw; lp.height = vh;
            surfaceView.setLayoutParams(lp);
        }
        // 取景框边长按**画面**短边的 62% 算（不是屏幕短边），再夹在 160~340dp 之间。
        // 这样它一定完整落在画面里，绝不会像上一版那样比画面还高。
        int minSide = Math.min(vw, vh);
        int side = Math.max(Ui.dp(this, 160),
                Math.min(Math.round(minSide * 0.62f), Ui.dp(this, 340)));
        side = Math.min(side, minSide);
        frameSide = side;
        if (frameView != null) frameView.invalidate();
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
        // 连续预览扫了 2.6 秒还没结果，就拍一张全分辨率照片再认 ——
        // 这是"远处 / 小码 / 有点糊"时真正管用的那一招，靠调预览参数救不回来。
        maybePhotoFallback();
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
                ui.post(() -> onScanned(out));
            }
        });
    }

    /** 识别成功：震一下 + 回传结果关页面。两端一致（网页端是 navigator.vibrate(40)）。 */
    private void onScanned(String out) {
        try {
            android.os.Vibrator vb = (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vb != null) {
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    vb.vibrate(android.os.VibrationEffect.createOneShot(
                            40, android.os.VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vb.vibrate(40);
                }
            }
        } catch (Throwable ignored) {
        }
        setResult(RESULT_OK, new Intent().putExtra(EXTRA_RESULT, out));
        finish();
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
     *
     * 现在解的是**整幅**（画面整幅显示，看得见就该认得）。反色那一遍每 8 帧才做一次，
     * 它比普通解多一倍成本，而深底亮码是少数情况。
     */
    private String decode(byte[] yuv, int w, int h) {
        boolean allowInvert = (fullTick++ & 7) == 0;
        return ScanCore.decodeWhole(reader, yuv, w, h, allowInvert);
    }

    /* ---------------- 全分辨率拍照兜底 ----------------

       连续预览识别有两个天花板，靠调参数解决不了：

       1) 预览流的分辨率有限。能扫多远完全由"码在画面里占多少像素"决定，
          码占画面 8% 时，在 1920x1080 的预览里只有 86px，25 个模块摊下来
          3.5px/模块 —— 已经非常勉强。
       2) 预览还要走对焦、压缩、跨进程传输，抖动和糊都会被放大。

       真正可靠的做法和系统相机一样：**拍一张全分辨率静态照片**再识别。
       同一个镜头，照片能到 4000x3000，比预览流多一个数量级的像素，
       识别距离是预览的好几倍，而且不受帧率限制，可以慢慢试多种尺度。

       所以：连续预览只负责"近处快扫"，几秒扫不出来就自动拍一张；
       用户也可以点一下画面手动触发。 */
    private void maybePhotoFallback() {
        if (photoBusy || handled || camera == null) return;
        long now = System.currentTimeMillis();
        if (now - lastPhotoAt < PHOTO_INTERVAL_MS) return;
        lastPhotoAt = now;
        photoBusy = true;
        ui.post(() -> hintView.setText("正在拍照识别…"));
        try {
            camera.takePicture(null, null, (byte[] data, Camera cam) -> {
                photoBusy = false;
                decoder.execute(() -> {
                    String text = decodeJpeg(data);
                    if (text != null && !handled) {
                        handled = true;
                        final String out = text;
                        ui.post(() -> onScanned(out));
                    } else {
                        // 这一张没认出来，隔久一点再拍，别把电和 CPU 都耗在连拍上
                        lastPhotoAt = System.currentTimeMillis() + PHOTO_INTERVAL_MS;
                        ui.post(() -> hintView.setText("没识别到，把二维码再靠近点"));
                        try { if (camera != null) camera.startPreview(); } catch (Throwable ignored) { }
                    }
                });
            });
        } catch (Throwable t) {
            photoBusy = false;
        }
    }

    /** 解码一张全分辨率 JPEG：多尺度 × 两种极性，慢慢试。 */
    private String decodeJpeg(byte[] jpeg) {
        android.graphics.Bitmap bmp = null;
        try {
            // 先拿尺寸，再按长边不超过 2600 解码 —— 4000x3000 直接解成 ARGB
            // 要 48MB，低端机直接 OOM。2600 已经比预览多好几倍像素了。
            android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, o);
            int longSide = Math.max(o.outWidth, o.outHeight);
            int sample = 1;
            while (longSide / sample > 2600) sample *= 2;
            o.inJustDecodeBounds = false;
            o.inSampleSize = sample;
            o.inPreferredConfig = android.graphics.Bitmap.Config.ARGB_8888;
            bmp = android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, o);
            return bmp == null ? null : decodeBitmapDeep(bmp);
        } catch (Throwable t) {
            return null;
        } finally {
            if (bmp != null) bmp.recycle();
        }
    }

    /** 多尺度 + 两种极性解一张位图。这里可以放心地慢。 */
    private String decodeBitmapDeep(android.graphics.Bitmap bmp) {
        int longSide = Math.max(bmp.getWidth(), bmp.getHeight());
        int[] caps = new int[]{1600, 1100, 760};
        for (int cap : caps) {
            float sc = Math.min(1f, (float) cap / longSide);
            int w = Math.max(1, Math.round(bmp.getWidth() * sc));
            int h = Math.max(1, Math.round(bmp.getHeight() * sc));
            android.graphics.Bitmap small = android.graphics.Bitmap.createScaledBitmap(bmp, w, h, true);
            try {
                byte[] gray = toGray(small);
                String r = ScanCore.decodeGray(reader, gray, w, h);
                if (r != null) return r;
                r = ScanCore.decodeGray(reader, ScanCore.invert(gray, gray.length), w, h);
                if (r != null) return r;
            } finally {
                if (small != bmp) small.recycle();
            }
        }
        return null;
    }

    /** Bitmap(ARGB) → 灰度。整数亮度公式，误差对二值化没有影响。 */
    private static byte[] toGray(android.graphics.Bitmap bmp) {
        int w = bmp.getWidth(), h = bmp.getHeight();
        int[] px = new int[w * h];
        bmp.getPixels(px, 0, w, 0, 0, w, h);
        byte[] gray = new byte[w * h];
        for (int i = 0; i < px.length; i++) {
            int p = px[i];
            int r = (p >> 16) & 0xFF, g = (p >> 8) & 0xFF, b = p & 0xFF;
            gray[i] = (byte) ((r * 77 + g * 150 + b * 29) >> 8);
        }
        return gray;
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

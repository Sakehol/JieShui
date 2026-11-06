package app.jieshui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

/** UI 小工具：圆角背景、文本、卡片 */
public final class Ui {

    private Ui() {}

    public static int dp(Context c, float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics());
    }

    public static GradientDrawable round(int color, float radiusDp, Context c) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.RECTANGLE);
        d.setColor(color);
        d.setCornerRadius(dp(c, radiusDp));
        return d;
    }

    public static GradientDrawable round(int color, float radiusDp, int strokeColor, float strokeDp, Context c) {
        GradientDrawable d = round(color, radiusDp, c);
        d.setStroke(dp(c, strokeDp), strokeColor);
        return d;
    }

    public static TextView text(Context c, String s, float sp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s == null ? "" : s);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        t.setLineSpacing(dp(c, 2), 1f);
        return t;
    }

    public static TextView title(Context c, String s, float sp) {
        return text(c, s, sp, Prefs.C_FG, true);
    }

    public static TextView sub(Context c, String s) {
        return text(c, s, 12, Prefs.C_FG2, false);
    }

    public static LinearLayout column(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    public static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    public static LinearLayout.LayoutParams lp(int w, int h) {
        return new LinearLayout.LayoutParams(w, h);
    }

    public static LinearLayout.LayoutParams lpw(float weight) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.weight = weight;
        return p;
    }

    public static View spacer(Context c) {
        return new View(c);
    }

    public static View divider(Context c) {
        View v = new View(c);
        v.setBackgroundColor(Prefs.C_LINE);
        v.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(c, 1))));
        return v;
    }

    /** 卡片容器 */
    public static LinearLayout card(Context c) {
        LinearLayout l = column(c);
        l.setBackground(round(Prefs.C_CARD, 18, Prefs.C_LINE, 1, c));
        int p = dp(c, 16);
        l.setPadding(p, p, p, p);
        return l;
    }

    /** 主按钮 */
    public static TextView primaryButton(Context c, String label) {
        TextView b = text(c, label, 16, Color.WHITE, true);
        b.setGravity(Gravity.CENTER);
        b.setBackground(round(Prefs.C_ACCENT, 13, c));
        b.setPadding(0, dp(c, 15), 0, dp(c, 15));
        b.setClickable(true);
        b.setFocusable(true);
        return b;
    }

    /** 次按钮 */
    public static TextView ghostButton(Context c, String label) {
        TextView b = text(c, label, 14, Prefs.C_FG, false);
        b.setGravity(Gravity.CENTER);
        b.setBackground(round(Prefs.C_INPUT, 12, Prefs.C_LINE, 1, c));
        b.setPadding(dp(c, 16), dp(c, 12), dp(c, 16), dp(c, 12));
        b.setClickable(true);
        b.setFocusable(true);
        return b;
    }

    public static void pressable(View v) {
        v.setOnTouchListener((view, e) -> {
            switch (e.getAction()) {
                case android.view.MotionEvent.ACTION_DOWN:
                    view.setAlpha(0.72f);
                    break;
                case android.view.MotionEvent.ACTION_CANCEL:
                case android.view.MotionEvent.ACTION_UP:
                    view.setAlpha(1f);
                    break;
            }
            return false;
        });
    }

    /** 状态环 */
    public static class RingView extends View {
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF rect = new RectF();
        private float pct = 0f;

        public RingView(Context c) {
            super(c);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(dp(c, 9));
            p.setColor(Prefs.C_ACCENT);
            p.setStrokeCap(Paint.Cap.ROUND);
            bg.setStyle(Paint.Style.STROKE);
            bg.setStrokeWidth(dp(c, 9));
            bg.setColor(0x222F9CF4);
        }

        public void setPct(float v) {
            pct = Math.max(0f, Math.min(1f, v));
            invalidate();
        }

        @Override
        protected void onDraw(Canvas cv) {
            float pad = p.getStrokeWidth() / 2f;
            rect.set(pad, pad, getWidth() - pad, getHeight() - pad);
            cv.drawArc(rect, 0, 360, false, bg);
            if (pct > 0) cv.drawArc(rect, -90, 360 * pct, false, p);
        }
    }

    /** 扫码图标（四个角 + 中间横线） */
    public static class ScanIconView extends View {
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float len, inset, gap;

        public ScanIconView(Context c) {
            super(c);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(dp(c, 2.2f));
            p.setColor(0xFFFFFFFF);
            p.setStrokeCap(Paint.Cap.ROUND);
        }

        @Override
        protected void onDraw(Canvas cv) {
            float w = getWidth(), h = getHeight();
            len = w * 0.26f;
            inset = w * 0.06f;
            gap = w * 0.05f;
            float l = inset, t = inset, r = w - inset, b = h - inset, rr = len;
            // 左上
            cv.drawLine(l, t, l + rr, t, p);
            cv.drawLine(l, t, l, t + rr, p);
            // 右上
            cv.drawLine(r - rr, t, r, t, p);
            cv.drawLine(r, t, r, t + rr, p);
            // 左下
            cv.drawLine(l, b - rr, l, b, p);
            cv.drawLine(l, b, l + rr, b, p);
            // 右下
            cv.drawLine(r, b - rr, r, b, p);
            cv.drawLine(r - rr, b, r, b, p);
            // 中间横线
            cv.drawLine(l + gap, h / 2f, r - gap, h / 2f, p);
        }
    }
}

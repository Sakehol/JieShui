package app.jieshui;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.CheckBox;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    private static final int REQ_SCAN = 100;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService pool = Executors.newCachedThreadPool();

    private FrameLayout root;
    private LinearLayout content;

    // 当前设备
    private String curGoodsId, curName, curImei, curShopId, curCategory, curOrgName;
    private String curSkuId, curSkuName;
    private JSONArray curSkus;

    private boolean running = false;
    private boolean loadingDevice = false;
    private volatile boolean stopRequested = false;
    /** 水是不是真的在流。running 覆盖整个接水会话（含开阀后的等待期），
     *  等待期水还没出，没必要为了 90 秒的等待把返回键锁死。 */
    private volatile boolean watering = false;
    /**
     * 每次接水自增。旧的一轮（例如等待期用户又扫了另一台机器）发现号变了
     * 就必须收手：不能拿 curGoodsId / curSkuId 去轮询和停水 ——
     * 那两个字段那时已经指向新设备了，会把新设备的水停掉。
     */
    private volatile int sessionSeq = 1;
    private TextView actionBtn;
    private TextView topTitle;
    /** 首页右上角的「小票 ¥x.xx」。与网页端顶栏那个徽标同源（user/balance 的 tokenCoin）。 */
    private TextView quotaBadge;
    private TextView stateTitle, stateSub, flowAmount;
    private Ui.RingView ring;
    private LinearLayout flowLine;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(Prefs.C_BG);
        getWindow().setNavigationBarColor(Prefs.C_BG);

        root = new FrameLayout(this);
        root.setBackgroundColor(Prefs.C_BG);
        setContentView(root);

        // 老版本把 token/手机号以明文 Base64 存在 XML 里，升级后一次性改写成 Keystore 密文
        Prefs.migrate(this);

        rememberLocation();

        if (Prefs.token(this).isEmpty()) {
            showGate();
        } else {
            showHome();
            if (Prefs.autoStart(this)) root.postDelayed(this::startScan, 280);
            pool.execute(() -> {
                try {
                    Api.call("user/checkLogin", Api.params("token", Prefs.token(this)), Prefs.token(this));
                } catch (Api.ApiException e) {
                    if (e.code == 2) {
                        Prefs.setToken(this, "");
                        ui.post(() -> showGate("登录已过期，请重新登录"));
                    }
                }
            });
        }
    }

    /* ================= 通用骨架 ================= */

    /**
     * 官方 /goods/water/unlock 的风控签名包含 lat/lng。
     * 这里只读「上次已知位置」，不主动申请权限、不弹窗；拿到就记下来，拿不到就保持 0.0。
     */
    private void rememberLocation() {
        try {
            if (checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
            android.location.LocationManager lm =
                    (android.location.LocationManager) getSystemService(LOCATION_SERVICE);
            if (lm == null) return;
            android.location.Location last = lm.getLastKnownLocation(
                    android.location.LocationManager.NETWORK_PROVIDER);
            if (last == null) {
                last = lm.getLastKnownLocation(android.location.LocationManager.GPS_PROVIDER);
            }
            if (last != null) {
                Prefs.setLocation(this,
                        String.valueOf(last.getLatitude()), String.valueOf(last.getLongitude()));
            }
        } catch (Exception ignored) {
        }
    }

    private void setScreen(View v) {
        // 换页前先收掉所有还开着的弹窗（设置、token 详情等）。
        // 否则从后台回来触发锁屏时，设置弹窗会浮在锁屏页上面，看起来像"没有上锁"。
        dismissDialogs();
        root.removeAllViews();
        root.addView(v, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    /** 记录还活着的弹窗，换页时统一收掉。 */
    private final java.util.List<AlertDialog> liveDialogs = new java.util.ArrayList<>();

    private void trackDialog(AlertDialog d) {
        liveDialogs.add(d);
        d.setOnDismissListener(x -> liveDialogs.remove(d));
    }

    private void dismissDialogs() {
        for (AlertDialog d : new java.util.ArrayList<>(liveDialogs)) {
            try {
                d.dismiss();
            } catch (Throwable ignored) {
            }
        }
        liveDialogs.clear();
    }

    private LinearLayout screenShell() {
        LinearLayout outer = Ui.column(this);
        outer.setBackgroundColor(Prefs.C_BG);

        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.setOverScrollMode(View.OVER_SCROLL_NEVER);

        content = Ui.column(this);
        int ph = Ui.dp(this, 16);
        content.setPadding(ph, Ui.dp(this, 8), ph, Ui.dp(this, 24));

        sv.addView(content, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        outer.addView(sv, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        return outer;
    }

    private LinearLayout topBar(String title, boolean showBack, boolean showSettings) {
        LinearLayout bar = Ui.row(this);
        bar.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 10));

        TextView left = Ui.title(this, title, 17);
        topTitle = left;
        bar.addView(left, Ui.lpw(1f));

        // 首页顶栏右侧的小票徽标。只有首页同时带「设置」齿轮，所以用它当判据 ——
        // 设备页/结算页各有自己的信息，再塞一个余额进去只会把窄顶栏挤爆。
        if (showSettings) {
            quotaBadge = Ui.text(this, "", 12, Prefs.C_OK, true);
            quotaBadge.setGravity(Gravity.CENTER);
            quotaBadge.setBackground(Ui.round(0x1A2ECC8F, 11, 0x382ECC8F, 1, this));
            quotaBadge.setPadding(Ui.dp(this, 10), Ui.dp(this, 5), Ui.dp(this, 10), Ui.dp(this, 5));
            quotaBadge.setVisibility(View.GONE);
            LinearLayout.LayoutParams qlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            qlp.rightMargin = Ui.dp(this, 6);
            bar.addView(quotaBadge, qlp);
        } else {
            // 换页后旧徽标已经不在视图树上了，别让后台回来的余额往上写
            quotaBadge = null;
        }

        if (showBack) {
            TextView back = Ui.text(this, "✕", 20, Prefs.C_FG2, false);
            back.setPadding(Ui.dp(this, 10), Ui.dp(this, 4), Ui.dp(this, 10), Ui.dp(this, 4));
            back.setOnClickListener(v -> {
                if ("device".equals(curScreen) && !canLeaveDevice()) return;
                leaveDevice();
            });
            Ui.pressable(back);
            bar.addView(back);
        }
        if (showSettings) {
            TextView gear = Ui.text(this, "⚙", 20, Prefs.C_FG2, false);
            gear.setPadding(Ui.dp(this, 10), Ui.dp(this, 4), Ui.dp(this, 10), Ui.dp(this, 4));
            gear.setOnClickListener(v -> showSettings());
            Ui.pressable(gear);
            bar.addView(gear);
        }
        return bar;
    }

    /* ================= 登录 ================= */

    private void showGate() {
        showGate(null);
    }

    /**
     * 登录页。msg 非空时在表单上方显示一条红字（例如「登录已过期，请重新登录」），
     * 避免 token 失效后用户只看到「该设备暂无可用计费方式」这种误导性提示。
     */
    private void showGate(String msg) {
        LinearLayout outer = Ui.column(this);
        outer.setBackgroundColor(Prefs.C_BG);
        outer.setGravity(Gravity.CENTER);
        int p = Ui.dp(this, 26);
        outer.setPadding(p, p, p, p);

        TextView logo = Ui.text(this, "💧", 46, Color.WHITE, false);
        logo.setGravity(Gravity.CENTER);
        outer.addView(logo);

        TextView h = Ui.title(this, "接水", 26);
        h.setGravity(Gravity.CENTER);
        outer.addView(h, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView sub = Ui.text(this, "扫码即开 · 无广告 · 支付宝免密", 13, Prefs.C_FG2, false);
        sub.setGravity(Gravity.CENTER);
        outer.addView(sub);
        outer.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 26)));

        if (msg != null && !msg.isEmpty()) {
            TextView banner = Ui.text(this, msg, 13, Prefs.C_ERR, false);
            banner.setGravity(Gravity.CENTER);
            banner.setBackground(Ui.round(0x1FFF5D5D, 11, Prefs.C_ERR, 1, this));
            banner.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            blp.bottomMargin = Ui.dp(this, 14);
            outer.addView(banner, blp);
        }

        // 主入口：手机号验证码登录（Token 入口折叠到下方小字）
        LinearLayout phoneBox = Ui.column(this);
        EditText phone = input("11 位手机号", InputType.TYPE_CLASS_PHONE, 1);
        phoneBox.addView(fieldLabel("手机号"));
        phoneBox.addView(phone);

        LinearLayout codeRow = Ui.row(this);
        EditText code = input("短信验证码", InputType.TYPE_CLASS_NUMBER, 1);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        codeRow.addView(code, clp);
        TextView send = Ui.ghostButton(this, "获取");
        send.setOnClickListener(v -> sendCode(phone.getText().toString().trim(), send));
        Ui.pressable(send);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.leftMargin = Ui.dp(this, 8);
        codeRow.addView(send, slp);
        phoneBox.addView(fieldLabel("验证码"));
        phoneBox.addView(codeRow);
        phoneBox.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 6)));

        TextView login = Ui.primaryButton(this, "登录");
        login.setOnClickListener(v -> {
            doLogin(phone.getText().toString().trim(),
                    code.getText().toString().trim(), login);
            // 验证码一次性，提交后立刻清空输入框，避免留在界面上被截图/记忆
            code.setText("");
        });
        Ui.pressable(login);
        phoneBox.addView(login);

        /* 记住登录：以前只有设置里能改，而多数人根本不知道设置里有这一项 ——
           于是要么被迫每次重新登录，要么在公用设备上莫名一直开着。
           放在登录按钮下面，是「登录」这个动作本身的一部分。 */
        LinearLayout rememberRow = Ui.row(this);
        final boolean[] remember = {Prefs.remember(this)};
        CheckBox rememberBox = new CheckBox(this);
        rememberBox.setChecked(remember[0]);
        rememberBox.setButtonTintList(android.content.res.ColorStateList.valueOf(Prefs.C_ACCENT));
        TextView rememberLabel = Ui.text(this,
                "在这台设备上记住登录（公用设备请勿勾选）", 12, Prefs.C_FG2, false);
        rememberRow.addView(rememberBox, Ui.lp(android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT));
        rememberRow.addView(rememberLabel, Ui.lpw(1f));
        rememberRow.setOnClickListener(v -> {
            boolean nv = !remember[0];
            remember[0] = nv;
            rememberBox.setChecked(nv);
        });
        Ui.pressable(rememberRow);
        LinearLayout.LayoutParams rmlp = new LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT);
        rmlp.topMargin = Ui.dp(this, 10);
        phoneBox.addView(rememberRow, rmlp);

        // 勾选状态在真正写 token 之前落盘，这样 Prefs.setToken 才知道该不该加密保存
        rememberBox.setOnCheckedChangeListener((btn2, checked) -> {
            remember[0] = checked;
            Prefs.setRemember(this, checked);
        });

        LinearLayout tokenBox = Ui.column(this);
        EditText tok = input("从原 App 抓包获取的 token", InputType.TYPE_CLASS_TEXT, 4);
        tokenBox.addView(fieldLabel("Token"));
        tokenBox.addView(tok, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 110)));
        tokenBox.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 6)));
        TextView use = Ui.primaryButton(this, "使用此 Token");
        use.setOnClickListener(v -> {
            String s = tok.getText().toString().trim();
            // 服务端 token 是 32 位十六进制；宽松一点只挡明显不是 token 的输入
            if (s.length() < 16 || !s.matches("[A-Za-z0-9+/=_-]+")) {
                toast(this, "Token 看起来不正确");
                return;
            }
            Prefs.setToken(this, s);
            tok.setText("");
            showHome();
        });
        Ui.pressable(use);
        tokenBox.addView(use);
        tokenBox.setVisibility(View.GONE);

        outer.addView(phoneBox);

        outer.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 18)));

        TextView hint = Ui.text(this, "账号数据仍在胖乖生活服务器，水卡与免密签约直接沿用。",
                12, Prefs.C_FG2, false);
        hint.setGravity(Gravity.CENTER);
        outer.addView(hint);

        TextView adv = Ui.text(this, "已有 Token？改用 Token 登录", 12, Prefs.C_FG2, false);
        adv.setGravity(Gravity.CENTER);
        adv.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 10));
        adv.setOnClickListener(v -> tokenBox.setVisibility(
                tokenBox.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE));
        Ui.pressable(adv);
        outer.addView(adv);
        outer.addView(tokenBox);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Prefs.C_BG);
        sv.setFillViewport(true);
        FrameLayout.LayoutParams flp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        LinearLayout wrap = Ui.column(this);
        wrap.setGravity(Gravity.CENTER);
        wrap.setMinimumHeight(getResources().getDisplayMetrics().heightPixels);
        wrap.addView(outer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        sv.addView(wrap);
        curScreen = "gate";
        setScreen(sv);
    }

    private TextView tabView(String label) {
        TextView t = Ui.text(this, label, 14, Prefs.C_FG2, false);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 10));
        return t;
    }

    private void selectTab(TextView on, TextView off) {
        on.setTextColor(Prefs.C_FG);
        on.setBackground(Ui.round(Prefs.C_CARD, 9, this));
        off.setTextColor(Prefs.C_FG2);
        off.setBackground(null);
    }

    private TextView fieldLabel(String s) {
        TextView t = Ui.text(this, s, 12, Prefs.C_FG2, false);
        t.setPadding(Ui.dp(this, 2), Ui.dp(this, 10), 0, Ui.dp(this, 6));
        return t;
    }

    private EditText input(String hint, int type, int minLines) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(Prefs.C_FG2);
        e.setTextColor(Prefs.C_FG);
        e.setTextSize(15);
        e.setSingleLine(minLines <= 1);
        e.setMinLines(minLines);
        e.setGravity(minLines > 1 ? Gravity.TOP : Gravity.CENTER_VERTICAL);
        e.setInputType(type);
        e.setBackground(Ui.round(Prefs.C_INPUT, 12, Prefs.C_LINE, 1, this));
        int ph = Ui.dp(this, 14), pv = Ui.dp(this, 13);
        e.setPadding(ph, pv, ph, pv);
        return e;
    }

    private void sendCode(String phone, TextView btn) {
        if (!phone.matches("^1\\d{10}$")) {
            toast(this, "请输入正确的手机号");
            return;
        }
        btn.setEnabled(false);
        btn.setText("发送中");
        pool.execute(() -> {
            try {
                Api.call("common/sms/sendCode", Api.params("phone", phone, "template", "reg"), null);
                ui.post(() -> {
                    toast(this, "验证码已发送");
                    countdown(btn);
                });
            } catch (Api.ApiException e) {
                ui.post(() -> {
                    toast(this, e.getMessage());
                    btn.setEnabled(true);
                    btn.setText("获取");
                });
            }
        });
    }

    private void countdown(TextView btn) {
        final int[] left = {60};
        Runnable r = new Runnable() {
            @Override
            public void run() {
                if (left[0] <= 0) {
                    btn.setEnabled(true);
                    btn.setText("获取");
                    return;
                }
                btn.setText(left[0] + "s");
                left[0]--;
                ui.postDelayed(this, 1000);
            }
        };
        ui.post(r);
    }

    private void doLogin(String phone, String code, TextView btn) {
        if (!phone.matches("^1\\d{10}$")) {
            toast(this, "请输入正确的手机号");
            return;
        }
        if (code.length() < 4) {
            toast(this, "请输入验证码");
            return;
        }
        btn.setEnabled(false);
        btn.setText("登录中…");
        pool.execute(() -> {
            try {
                Object data = Api.call("user/reg",
                        Api.params("channel", "android_app", "phone", phone, "verify", code), null);
                JSONObject o = data instanceof JSONObject ? (JSONObject) data : new JSONObject();
                String token = o.optString("token", "");
                boolean forcedBind = o.optBoolean("forcedBind", false);
                if (token.isEmpty()) {
                    // 官方流程：forcedBind=true 时会跳到「绑定微信/支付宝」页，绑完才发 token
                    if (forcedBind) {
                        throw new Api.ApiException(
                                "该手机号需先在官方 App 里绑定微信或支付宝，绑完再用「粘贴 Token」登录", -2);
                    }
                    throw new Api.ApiException("登录失败：服务器未返回 token", -1);
                }
                Prefs.setToken(this, token);
                Prefs.setPhone(this, phone);
                ui.post(this::showHome);
            } catch (Api.ApiException e) {
                ui.post(() -> {
                    toast(this, e.getMessage());
                    btn.setEnabled(true);
                    btn.setText("登录");
                });
            }
        });
    }

    /* ================= 首页 ================= */

    private void showHome() {
        curGoodsId = null;
        LinearLayout outer = screenShell();
        content.addView(topBar("接水", false, true));
        loadBalance();

        // 扫码球
        FrameLayout orbWrap = new FrameLayout(this);
        LinearLayout orb = Ui.column(this);
        orb.setGravity(Gravity.CENTER);
        GradientDrawable od = new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[]{0xFF155F9E, 0xFF2F9CF4});
        od.setShape(GradientDrawable.OVAL);
        orb.setBackground(od);

        Ui.ScanIconView icon = new Ui.ScanIconView(this);
        orb.addView(icon, Ui.lp(Ui.dp(this, 54), Ui.dp(this, 54)));
        TextView label = Ui.text(this, "扫码接水", 15, Color.WHITE, true);
        label.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        llp.topMargin = Ui.dp(this, 10);
        orb.addView(label, llp);

        int orbSize = Ui.dp(this, 190);
        FrameLayout.LayoutParams olp = new FrameLayout.LayoutParams(orbSize, orbSize);
        olp.gravity = Gravity.CENTER_HORIZONTAL;
        olp.topMargin = Ui.dp(this, 18);
        orbWrap.addView(orb, olp);

        orb.setClickable(true);
        orb.setOnClickListener(v -> startScan());
        Ui.pressable(orb);
        content.addView(orbWrap, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView tip = Ui.text(this, "对准饮水机上的二维码，或手动输入设备号", 12, Prefs.C_FG2, false);
        tip.setGravity(Gravity.CENTER);
        content.addView(tip, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 三个亮点
        String[][] tips = {
                {"💳", "支付宝免密", "接完自动结算，无需扫码付款"},
                {"🎟️", "水卡自动生效", "余额与优惠在云端，无需迁移"},
                {"🚫", "无广告无弹窗", "打开即扫，只做接水这一件事"}
        };
        for (String[] t : tips) {
            LinearLayout row = Ui.row(this);
            row.setBackground(Ui.round(Prefs.C_CARD, 14, Prefs.C_LINE, 1, this));
            int p = Ui.dp(this, 13);
            row.setPadding(p, p, p, p);

            TextView ic = Ui.text(this, t[0], 17, Prefs.C_FG, false);
            ic.setGravity(Gravity.CENTER);
            ic.setBackground(Ui.round(0xFF0F1722, 10, this));
            row.addView(ic, Ui.lp(Ui.dp(this, 34), Ui.dp(this, 34)));

            LinearLayout txt = Ui.column(this);
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            tlp.leftMargin = Ui.dp(this, 12);
            txt.addView(Ui.text(this, t[1], 13.5f, Prefs.C_FG, true));
            txt.addView(Ui.text(this, t[2], 12, Prefs.C_FG2, false));
            row.addView(txt, tlp);

            LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rlp.topMargin = Ui.dp(this, 9);
            content.addView(row, rlp);
        }

        // 常用设备
        LinearLayout hRow = Ui.row(this);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.topMargin = Ui.dp(this, 22);
        TextView h = Ui.text(this, "常用设备", 13, Prefs.C_FG2, false);
        hRow.addView(h, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView syncBtn = Ui.text(this, "从账号同步", 12.5f, Prefs.C_ACCENT, false);
        syncBtn.setPadding(Ui.dp(this, 10), Ui.dp(this, 4), Ui.dp(this, 2), Ui.dp(this, 4));
        syncBtn.setClickable(true);
        syncBtn.setOnClickListener(v -> syncDevices((TextView) v));
        hRow.addView(syncBtn);
        content.addView(hRow, hlp);

        JSONArray devs = Prefs.devices(this);
        if (devs.length() == 0) {
            TextView empty = Ui.text(this, "暂无记录，扫码后会出现在这里", 13, Prefs.C_FG2, false);
            empty.setGravity(Gravity.CENTER);
            empty.setBackground(Ui.round(Prefs.C_CARD, 14, Prefs.C_LINE, 1, this));
            empty.setPadding(0, Ui.dp(this, 22), 0, Ui.dp(this, 22));
            LinearLayout.LayoutParams elp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            elp.topMargin = Ui.dp(this, 8);
            content.addView(empty, elp);
        } else {
            for (int i = 0; i < devs.length(); i++) {
                JSONObject o = devs.optJSONObject(i);
                if (o == null) continue;
                final String gid = o.optString("goodsId");
                final String nm = o.optString("name", "饮水机");
                final String im = o.optString("imei");
                final String sid = o.optString("shopId");
                final String cat = o.optString("categoryCode", "04");
                final String org = o.optString("orgName");

                LinearLayout row = Ui.row(this);
                row.setBackground(Ui.round(Prefs.C_CARD, 14, Prefs.C_LINE, 1, this));
                int p = Ui.dp(this, 13);
                row.setPadding(p, p, p, p);

                TextView ic = Ui.text(this, "💧", 16, Prefs.C_FG, false);
                ic.setGravity(Gravity.CENTER);
                ic.setBackground(Ui.round(0x1F2F9CF4, 10, this));
                row.addView(ic, Ui.lp(Ui.dp(this, 34), Ui.dp(this, 34)));

                LinearLayout txt = Ui.column(this);
                LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                tlp.leftMargin = Ui.dp(this, 12);
                txt.addView(Ui.text(this, nm, 14, Prefs.C_FG, true));
                txt.addView(Ui.text(this, org.isEmpty() ? im : org, 12, Prefs.C_FG2, false));
                row.addView(txt, tlp);

                row.setClickable(true);
                row.setOnClickListener(v -> openDevice(gid, nm, im, sid, cat, org));
                Ui.pressable(row);

                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                rlp.topMargin = Ui.dp(this, 8);
                content.addView(row, rlp);
            }
        }

        curScreen = "home";
        setScreen(outer);
    }

    /* ================= 扫码 ================= */

    /** 从账号拉取最近使用过的设备（绕过 scan/v2 门禁的备用入口） */
    private void syncDevices(TextView btn) {
        String tk = Prefs.token(this);
        if (tk.isEmpty()) { toast(this, "请先登录"); return; }
        btn.setText("同步中…");
        pool.execute(() -> {
            try {
                Object data = Api.call("goods/latestUsed", Api.params("categoryCode", "04"), tk);
                if (!(data instanceof JSONArray)) throw new Api.ApiException("账号里还没有饮水机记录", 4003);
                JSONArray arr = (JSONArray) data;
                int n = 0;
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    String gid = o.optString("goodsId", "");
                    if (gid.isEmpty()) continue;
                    Prefs.addDevice(this, gid,
                            o.optString("goodsName", "饮水机"), "",
                            o.optString("orgId", ""),
                            o.optString("categoryCode", "04"),
                            firstNonEmpty(o.optString("orgName", ""), o.optString("parentPointName", "")));
                    n++;
                }
                final int cnt = n;
                ui.post(() -> {
                    btn.setText("从账号同步");
                    if (cnt == 0) toast(this, "账号里还没有饮水机记录");
                    else { toast(this, "已同步 " + cnt + " 台设备"); showHome(); }
                });
            } catch (Api.ApiException e) {
                ui.post(() -> {
                    btn.setText("从账号同步");
                    if (e.code == 2) {
                        Prefs.setToken(this, "");
                        showGate("登录已过期，请重新登录");
                    } else {
                        toast(this, e.getMessage());
                    }
                });
            }
        });
    }

    private static String firstNonEmpty(String a, String b) {
        return a != null && !a.isEmpty() ? a : (b == null ? "" : b);
    }

    /** 秒数 → "1 分 20 秒" / "35 秒" */
    private static String fmtElapsed(double sec) {
        int s = (int) Math.max(0, Math.floor(sec));
        int m = s / 60;
        s = s % 60;
        return m > 0 ? m + " 分 " + s + " 秒" : s + " 秒";
    }

    /** 解析形如 "0.04" 的金额，失败返回 NaN */
    private static double parseAmount(String s) {
        if (s == null || s.isEmpty()) return Double.NaN;
        try {
            return Double.parseDouble(s.trim());
        } catch (Exception e) {
            return Double.NaN;
        }
    }

    private static double parseAmountOr0(String s) {
        double v = parseAmount(s);
        return Double.isNaN(v) ? 0 : v;
    }

    private static String yuan(double v) {
        return String.format(java.util.Locale.US, "¥%.2f", v);
    }

    private void startScan() {
        startActivityForResult(new Intent(this, ScanActivity.class), REQ_SCAN);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_SCAN && res == RESULT_OK && data != null) {
            String text = data.getStringExtra(ScanActivity.EXTRA_RESULT);
            handleScanned(text);
        }
    }

    private void handleScanned(String text) {
        Qr q = Qr.parse(text);
        Map<String, String> p = q.scanParams();
        if (p == null) {
            if (q.isWaterCard()) {
                toast(this, "这是水卡码，本项目暂不支持");
            } else {
                toast(this, "未识别的二维码：" + text.substring(0, Math.min(24, text.length())));
            }
            return;
        }
        final String key = p.keySet().iterator().next();
        final String val = p.get(key);

        showLoading("正在识别设备…");
        pool.execute(() -> {
            try {
                // 二维码里可能写 NQT / IMEI / SN，扫码者手输的通常是机身编号。
                // 服务端认的键因机器而异（实测某机器必须用 SN），因此主键失败就换其余键重试。
                java.util.LinkedHashSet<String> keys = new java.util.LinkedHashSet<>();
                keys.add(key);
                keys.add("SN");
                keys.add("IMEI");
                keys.add("NQT");

                JSONObject o = null;
                String lastMsg = null;
                for (String k : keys) {
                    try {
                        Object data = Api.call("goods/scan/v2", Api.params(k, val), Prefs.token(this));
                        if (data instanceof JSONObject) { o = (JSONObject) data; break; }
                    } catch (Api.ApiException e) {
                        lastMsg = e.getMessage();
                        if (e.code == 2) throw e;          // 未登录直接上抛
                    }
                }
                if (o == null) {
                    throw new Api.ApiException(lastMsg == null ? "该设备未绑定，请联系商家绑定后再使用" : lastMsg, 4000);
                }
                String id = o.optString("id", "");
                String cat = o.optString("categoryCode", "04");
                boolean jump = o.optBoolean("jumpToDevicePageFlag", false);

                if (id.isEmpty()) throw new Api.ApiException("该设备未绑定，请联系商家绑定后再使用", 4000);
                if (jump) throw new Api.ApiException("该设备需在官方 App 内使用", 4001);
                if (!"04".equals(cat)) throw new Api.ApiException("这不是饮水机（类型 " + cat + "）", 4002);

                final String shopId = o.optString("shopId", "");
                final String catName = o.optString("categoryName", "");
                hideLoading();
                // 扫码进来的：进设备页后直接开阀，省掉「再点一次开始接水」
                ui.post(() -> openDevice(id, catName, "", shopId, cat, "", true));
            } catch (Api.ApiException e) {
                hideLoading();
                ui.post(() -> toast(this, e.getMessage()));
            }
        });
    }

    /* ================= 设备页 ================= */

    private void openDevice(String goodsId, String name, String imei, String shopId, String category, String org) {
        openDevice(goodsId, name, imei, shopId, category, org, false);
    }

    private void openDevice(String goodsId, String name, String imei, String shopId, String category,
                            String org, boolean autoStart) {
        curGoodsId = goodsId;
        curName = name;
        curImei = imei;
        curShopId = shopId;
        curCategory = category == null || category.isEmpty() ? "04" : category;
        curOrgName = org;
        curSkus = new JSONArray();
        curSkuId = null;
        // 关键：进入设备页时重置接水状态。否则一次异常退出后 running 永远为 true，
        // 再点按钮会被当成"结束接水"，表现就是点了完全没反应。
        running = false;
        stopRequested = false;
        watering = false;
        loadingDevice = false;
        // 换了设备就把上一轮作废。等待期用户又扫了另一台机器时，上一轮还活着的话
        // 会拿已经指向新设备的 curGoodsId 去停水 —— 把别人那台给停了。
        final int myOpen = ++sessionSeq;

        LinearLayout outer = screenShell();
        content.addView(topBar(name == null || name.isEmpty() ? "饮水机" : name, true, false));

        LinearLayout infoCard = Ui.card(this);
        TextView devName = Ui.title(this, name == null || name.isEmpty() ? "加载中…" : name, 17);
        TextView devMeta = Ui.sub(this, "正在获取设备信息…");
        infoCard.addView(devName);
        infoCard.addView(devMeta);

        TextView quota = Ui.text(this, "", 13, 0xFF6FE0B0, false);
        quota.setBackground(Ui.round(0x1A2ECC8F, 11, 0x382ECC8F, 1, this));
        quota.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
        quota.setVisibility(View.GONE);
        LinearLayout.LayoutParams qlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        qlp.topMargin = Ui.dp(this, 12);
        infoCard.addView(quota, qlp);

        content.addView(infoCard, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 控制卡片
        LinearLayout ctrl = Ui.card(this);
        ctrl.setGravity(Gravity.CENTER_HORIZONTAL);

        ring = new Ui.RingView(this);
        LinearLayout.LayoutParams rglp = new LinearLayout.LayoutParams(Ui.dp(this, 172), Ui.dp(this, 172));
        rglp.topMargin = Ui.dp(this, 6);
        FrameLayout ringWrap = new FrameLayout(this);
        ringWrap.addView(ring, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout ringText = Ui.column(this);
        ringText.setGravity(Gravity.CENTER);
        stateTitle = Ui.title(this, "准备就绪", 17);
        stateTitle.setGravity(Gravity.CENTER);
        stateSub = Ui.text(this, "点击下方按钮开始接水", 12, Prefs.C_FG2, false);
        stateSub.setGravity(Gravity.CENTER);
        ringText.addView(stateTitle);
        ringText.addView(stateSub);
        ringWrap.addView(ringText, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        ctrl.addView(ringWrap, rglp);

        flowLine = Ui.row(this);
        flowLine.setGravity(Gravity.CENTER);
        flowLine.setVisibility(View.GONE);
        TextView fl = Ui.text(this, "已接 ", 13, Prefs.C_FG2, false);
        flowAmount = Ui.text(this, "—", 19, 0xFF7CC4FF, true);
        flowLine.addView(fl);
        flowLine.addView(flowAmount);
        LinearLayout.LayoutParams fllp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        fllp.topMargin = Ui.dp(this, 12);
        ctrl.addView(flowLine, fllp);

        actionBtn = Ui.primaryButton(this, "开始接水");
        actionBtn.setEnabled(false);
        actionBtn.setOnClickListener(v -> {
            if (running) {
                stopRequested = true;
                actionBtn.setText("正在结束…");
                actionBtn.setEnabled(false);
            } else if (curSkuId == null || curSkuId.isEmpty()) {
                // 不静默失败：可能是 SKU 没加载成功，重试一次并给出可见提示
                toast(this, "还没拿到计费方式，正在重新加载…");
                actionBtn.setEnabled(false);
                stateTitle.setText("重新加载");
                stateSub.setText("正在获取计费方式…");
                reloadSkus();
            } else {
                startWater();
            }
        });
        Ui.pressable(actionBtn);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        alp.topMargin = Ui.dp(this, 16);
        ctrl.addView(actionBtn, alp);

        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp.topMargin = Ui.dp(this, 14);
        content.addView(ctrl, clp);

        curScreen = "device";
        setScreen(outer);

        pool.execute(() -> {
            JSONObject detail = null;
            JSONArray skus = null;
            String err = null;
            String skuErr = null;
            int skuCode = 0;
            try {
                Object d = Api.call("goods/normal/details", Api.params("goodsId", goodsId), Prefs.token(this));
                if (d instanceof JSONObject) detail = (JSONObject) d;
            } catch (Api.ApiException e) {
                err = e.getMessage();
            }
            // goods/normal/details 不需要登录，goods/normal/skus 却需要 token。
            // token 过期时 details 照样成功、skus 报「未登录」——必须把 code 单独带出来，
            // 否则会显示成「该设备暂无可用计费方式」，把掉登录误报成设备问题。
            try {
                Object s = Api.call("goods/normal/skus", Api.params("goodsId", goodsId), Prefs.token(this));
                skus = extractSkus(s);
                if (skus == null) skuErr = "计费方式返回结构异常";
            } catch (Api.ApiException e) {
                skuErr = e.getMessage();
                skuCode = e.code;
            }

            final JSONObject fd = detail;
            final JSONArray fs = skus;
            final String fe = err;
            final String fse = skuErr;
            final int fsc = skuCode;
            ui.post(() -> {
                // 这期间又扫了另一台：这一轮的结果已经过期，写下去会把新设备页覆盖掉。
                if (myOpen != sessionSeq) return;
                if (fsc == 2) {
                    Prefs.setToken(this, "");
                    showGate("登录已过期，请重新登录");
                    return;
                }
                if (fd == null) {
                    devMeta.setText("");
                    stateTitle.setText("无法加载");
                    stateSub.setText(fe == null ? "设备信息为空" : fe);
                    actionBtn.setEnabled(false);
                    return;
                }
                curImei = fd.optString("imei", "");
                curShopId = fd.optString("shopId", curShopId);
                curCategory = fd.optString("categoryCode", curCategory);
                curName = fd.optString("name", curName);
                curOrgName = fd.optString("orgName", curOrgName);
                boolean bt = fd.optInt("isBluetooth", 0) == 1;

                devName.setText(curName);
                if (topTitle != null && curName != null && !curName.isEmpty()) topTitle.setText(curName);
                List<String> bits = new ArrayList<>();
                if (!curOrgName.isEmpty()) bits.add(curOrgName);
                if (!curImei.isEmpty()) bits.add("编号 " + curImei);
                if (bt) bits.add("蓝牙");
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < bits.size(); i++) {
                    if (i > 0) sb.append(" · ");
                    sb.append(bits.get(i));
                }
                devMeta.setText(sb.length() == 0 ? "饮水机" : sb.toString());

                Prefs.addDevice(this, curGoodsId, curName, curImei, curShopId, curCategory, curOrgName);

                curSkus = fs == null ? new JSONArray() : fs;
                pickSku();

                if (bt) {
                    stateTitle.setText("蓝牙设备");
                    stateSub.setText("该设备需蓝牙指令，暂不支持");
                    actionBtn.setEnabled(false);
                } else if (curSkuId == null || curSkuId.isEmpty()) {
                    // 不再静默：SKU 拿不到时明确告诉用户原因，并保持按钮可点（点了会重试）
                    stateTitle.setText("无法开始");
                    stateSub.setText(fse == null ? "该设备暂无可用计费方式" : fse);
                    actionBtn.setText("重新加载");
                    actionBtn.setEnabled(true);
                } else if (autoStart) {
                    // 扫码进来的直接开阀：官方 App 扫完码机器立刻认到人，
                    // 用户在机器上按「开始」就有水，中间不需要再点一次手机。
                    stateTitle.setText("正在启动");
                    stateSub.setText("下发开阀指令…");
                    startWater();
                } else {
                    stateTitle.setText("准备就绪");
                    stateSub.setText("点击下方按钮开始接水");
                    actionBtn.setText("开始接水");
                    actionBtn.setEnabled(true);
                }

                loadQuota(quota);
            });
        });
    }

    /**
     * 只挑一个默认档位，不再画计费方式卡片。
     *
     * 饮水机只有一个计费档，官方那行「饮水 · 起步¥1 · 最低10」对用户没有意义，
     * 设备页上多一块卡片只是噪音。skuId 仍然要拿（unlock 必须带），
     * 所以这里只做选择，不做渲染。
     */
    private void pickSku() {
        curSkuId = null;
        curSkuName = null;
        if (curSkus == null) return;
        for (int i = 0; i < curSkus.length(); i++) {
            JSONObject s = curSkus.optJSONObject(i);
            if (s == null) continue;
            String skuId = s.optString("skuId", "");
            if (skuId == null || skuId.isEmpty()) continue;
            curSkuId = skuId;
            curSkuName = s.optString("name", "接水");
            return;
        }
    }

    /** 从接口返回里取 SKU 数组：兼容直接数组 / {list:[...]} / {skus:[...]} / {rows:[...]} */
    private static JSONArray extractSkus(Object data) {
        if (data instanceof JSONArray) return (JSONArray) data;
        if (data instanceof JSONObject) {
            JSONObject o = (JSONObject) data;
            String[] keys = {"list", "skus", "rows", "records", "data"};
            for (String k : keys) {
                JSONArray a = o.optJSONArray(k);
                if (a != null) return a;
            }
        }
        return null;
    }

    /** 只重拉 SKU（按钮兜底用），不重建整页 */
    private void reloadSkus() {
        if (loadingDevice) return;
        loadingDevice = true;
        final String gid = curGoodsId;
        pool.execute(() -> {
            JSONArray skus = null;
            String err = null;
            int code = 0;
            try {
                Object s = Api.call("goods/normal/skus", Api.params("goodsId", gid), Prefs.token(this));
                skus = extractSkus(s);
            } catch (Api.ApiException e) {
                err = e.getMessage();
                code = e.code;
            }
            final JSONArray fs = skus;
            final String fe = err;
            final int fc = code;
            ui.post(() -> {
                loadingDevice = false;
                if (fc == 2) {
                    Prefs.setToken(this, "");
                    showGate("登录已过期，请重新登录");
                    return;
                }
                if (fs == null || fs.length() == 0) {
                    stateTitle.setText("无法开始");
                    stateSub.setText(fe == null ? "该设备暂无可用计费方式" : fe);
                    toast(this, fe == null ? "该设备暂无可用计费方式" : fe);
                    actionBtn.setText("重试");
                    actionBtn.setEnabled(true);
                    return;
                }
                curSkus = fs;
                curSkuId = null;
                pickSku();
                if (curSkuId != null) {
                    stateTitle.setText("准备就绪");
                    stateSub.setText("点击下方按钮开始接水");
                    actionBtn.setText("开始接水");
                    actionBtn.setEnabled(true);
                } else {
                    stateTitle.setText("无法开始");
                    stateSub.setText("计费方式信息不完整");
                    actionBtn.setEnabled(false);
                }
            });
        });
    }

    /**
     * 首页右上角的小票余额 = user/balance 的 tokenCoin（单位：分）。
     * 网页端顶栏那个「小票 ¥x.xx」徽标就是同一个字段，之前只有网页端有，
     * 安卓端要进设备页才看得到 waterQuota 的文案，首页一直是空白。
     */
    private void loadBalance() {
        final TextView badge = quotaBadge;
        if (badge == null) return;
        badge.setText("");
        badge.setVisibility(View.GONE);
        pool.execute(() -> {
            try {
                Object d = Api.call("user/balance", Api.params(), Prefs.token(this));
                double cents = -1;
                if (d instanceof JSONObject) {
                    JSONObject o = (JSONObject) d;
                    if (o.has("tokenCoin")) cents = o.optDouble("tokenCoin", -1);
                }
                final double c = cents;
                ui.post(() -> {
                    // 换页后这个 badge 已经不在屏幕上了，别再往上写
                    if (quotaBadge != badge) return;
                    if (!(c > 0)) return;
                    badge.setText("小票 ¥" + String.format(java.util.Locale.US, "%.2f", c / 100.0));
                    badge.setVisibility(View.VISIBLE);
                });
            } catch (Api.ApiException e) {
                if (e.code == 2) {
                    Prefs.setToken(this, "");
                    ui.post(() -> showGate("登录已过期，请重新登录"));
                }
                // 其余错误静默：余额只是锦上添花，失败了不该打断接水
            }
        });
    }

    private void loadQuota(TextView quota) {
        pool.execute(() -> {
            try {
                Object d = Api.call("waterQuota/getActive",
                        Api.params("shopId", curShopId, "categoryCode", curCategory), Prefs.token(this));
                String txt = null;
                if (d instanceof JSONObject) {
                    txt = ((JSONObject) d).optString("text", "");
                } else if (d instanceof JSONArray && ((JSONArray) d).length() > 0) {
                    txt = ((JSONArray) d).optJSONObject(0) == null ? null
                            : ((JSONArray) d).optJSONObject(0).optString("text", "");
                }
                final String f = (txt == null || txt.isEmpty()) ? null : txt;
                ui.post(() -> {
                    if (f != null) {
                        quota.setText("🎟️ " + f);
                        quota.setVisibility(View.VISIBLE);
                    }
                });
            } catch (Api.ApiException ignored) {
            }
        });
    }

    /* ================= 接水 ================= */

    private void startWater() {
        if (running) return;
        running = true;
        stopRequested = false;
        watering = false;
        final int mySession = ++sessionSeq;
        actionBtn.setEnabled(false);
        actionBtn.setText("结束接水");
        flowLine.setVisibility(View.VISIBLE);
        flowAmount.setText("—");
        stateTitle.setText("正在启动");
        stateSub.setText("下发开阀指令…");
        ring.setPct(0.06f);

        // 设备相关字段在开头固定下来：等待期用户可能又扫了别的机器，
        // 那时 curGoodsId/curSkuId/curCategory 都已被改写。
        final String skuId = curSkuId;
        final String goodsId = curGoodsId;
        final String category = curCategory;
        final String imei = curImei;
        pool.execute(() -> {
            String orderNo = null;
            try {
                Map<String, String> p = Api.params("skuId", skuId, "promotions", Api.PROMOTIONS);
                String payType = Prefs.payType(this);
                if (payType != null && !payType.isEmpty()) p.put("payType", payType);

                // 官方 AfterPayUseAct 在 unlock 之前会先调 payChannelRoute/addUserAfterPayChannel
                // 把账号的后付费（先用后付）渠道登记为 method=15（支付宝免密）。
                // 不登记时服务端可能按「通用小票直扣」处理：钱扣了，但订单停在待支付。
                try {
                    Api.call("payChannelRoute/addUserAfterPayChannel",
                            Api.params("method", payType == null || payType.isEmpty() ? "15" : payType),
                            Prefs.token(this));
                } catch (Api.ApiException ignored) {
                }

                // 官方把 categoryCode/imei/lat/lng 放在 header（HeadInterceptor 读 header 算风控签名）
                Map<String, String> hdr = new HashMap<>();
                hdr.put("categoryCode", category);
                hdr.put("imei", imei);
                hdr.put("lat", Prefs.lat(this));
                hdr.put("lng", Prefs.lng(this));

                Object d = Api.call("goods/water/unlock", p, Prefs.token(this), hdr);
                if (d instanceof JSONObject) orderNo = str((JSONObject) d, "orderNo");

                // 扫码即开阀之后，用户可能还没来得及按机器上的「开始」。
                // 这段时间 workStatus 还不是 RUNNING —— 不能像以前那样一看到非 RUNNING
                // 就当成「已经结算完」去建订单，否则会生成一张 0 元的废单。
                ui.post(() -> {
                    stateTitle.setText("已就绪");
                    stateSub.setText("请在机器上按「开始」");
                    ring.setPct(0.06f);
                    actionBtn.setText("取消");
                    actionBtn.setEnabled(true);
                });

                JSONObject last = null;
                int ticks = 0;
                boolean userStopped = false;
                boolean seenRunning = false;
                boolean machineEnded = false;
                int waitTicks = 0;
                final int START_WAIT_TICKS = 75;   // 约 90 秒等用户按机器上的开始
                while (true) {
                    if (stopRequested) {
                        userStopped = true;
                        break;
                    }
                    try {
                        Thread.sleep(1200);
                    } catch (InterruptedException ignored) {
                    }
                    if (stopRequested) {
                        userStopped = true;
                        break;
                    }
                    // 用户已经去接另一台了。不能直接 return —— 这一轮已经把上一台
                    // 的阀门开开了，就地走人会留它一直挂着。用这一轮冻结的 goodsId 关掉它，
                    // 绝不能读 curGoodsId（那时它已指向新设备，会把新设备的水停了）。
                    if (mySession != sessionSeq) {
                        try {
                            Api.call("goods/endWater", Api.params("goodsId", goodsId), Prefs.token(this));
                        } catch (Api.ApiException ignored) {
                        }
                        return;
                    }
                    ticks++;
                    JSONObject sync = null;
                    try {
                        Object s = Api.call("goods/water/sync", Api.params("skuId", skuId), Prefs.token(this));
                        if (s instanceof JSONObject) sync = (JSONObject) s;
                    } catch (Api.ApiException e) {
                        if (e.code == 2) throw e;
                        // 网络抖动也计入等待时长。以前这里直接 continue，waitTicks 永不增长，
                        // 断网时会一直卡在「已就绪 / 请在机器上按开始」，按钮一直是「取消」。
                        if (++waitTicks > START_WAIT_TICKS) break;
                        if (waitTicks >= 5) {
                            ui.post(() -> {
                                stateTitle.setText("网络不稳");
                                stateSub.setText("连不上服务器，请检查网络后重试");
                            });
                            break;
                        }
                        continue;
                    }
                    if (sync == null) break;
                    last = sync;
                    int ws = sync.optInt("workStatus", 0);
                    boolean isRunning = ws == Api.WORK_RUNNING;
                    if (isRunning) {
                        if (!seenRunning) {
                            seenRunning = true;
                            watering = true;
                            ui.post(() -> {
                                stateTitle.setText("接水中");
                                stateSub.setText("水已开，正在计量");
                                ring.setPct(0.12f);
                                if (actionBtn != null) actionBtn.setText("结束接水");
                            });
                        }
                        final int fticks = ticks;
                        ui.post(() -> {
                            // sync.amount 不是金额（官方只用它判断"有没有消费"），显示已接时长
                            flowAmount.setText(fmtElapsed(fticks * 1.2));
                            ring.setPct(Math.min(0.95f, 0.12f + fticks * 0.03f));
                        });
                    } else if (!seenRunning) {
                        // sync.amount 不是金额，官方正是用它判断"这次有没有消费"。
                        // 用户按了「开始」又很快按「结算」时，两次轮询之间整个 2→3
                        // 可能都过去了，只盯 workStatus 会把这次真实消费当成没接水，
                        // 然后干等 90 秒才放弃 —— 网页端早就补了这个判断，APK 漏了。
                        boolean spent = sync != null && (numOf(sync.optString("amount", "0")) > 0
                                || !str(sync, "identify").isEmpty());
                        if (spent) break;
                        // 扫完码一滴水都没接，直接在机器上点了「结算」：机器会离开空闲态
                        // （workStatus 不再是 0）。以前这里只认 spent，于是这种情况要干等
                        // 90 秒，最后还告诉用户「没有在机器上按开始」—— 但他明明按了结算。
                        // 用「离开了空闲态」而不是死认某个具体值，是怕不同机型终态不一样。
                        if (ws != Api.WORK_IDLE) {
                            machineEnded = true;
                            break;
                        }
                        if (++waitTicks > START_WAIT_TICKS) break;
                    } else {
                        break;
                    }
                    if (ticks > 900) break;
                }

                if (mySession != sessionSeq) {
                    try {
                        Api.call("goods/endWater", Api.params("goodsId", goodsId), Prefs.token(this));
                    } catch (Api.ApiException ignored) {
                    }
                    return;
                }

                // 完全没有消费（一直没按开始）：不要拿空订单去结算，
                // 否则会生成一张 0 元废单，还会以「有未支付订单」挡住下一次接水。
                // tookWater 而不是 seenRunning：按了开始又飞快按结算时，2→3 可能整个
                // 落在两次轮询之间，seenRunning 永远是 false，但确实接了水。
                boolean took = seenRunning || (last != null
                        && (numOf(last.optString("amount", "0")) > 0
                        || !str(last, "identify").isEmpty()));
                if (!took) {
                    try {
                        Api.call("goods/endWater", Api.params("goodsId", goodsId), Prefs.token(this));
                    } catch (Api.ApiException ignored) {
                    }
                    final boolean fStopped = userStopped;
                    final boolean fEnded = machineEnded;
                    if (mySession == sessionSeq) {
                        ui.post(() -> {
                            running = false;
                            stopRequested = false;
                            watering = false;
                            if (fEnded) {
                                // 扫完码没出水就直接在机器上点了「结算」。
                                // 以前这里写「没有在机器上按开始」——用户确实按了结算，
                                // 这句话等于在说他的操作没发生，所以他觉得「描述明显不对」。
                                stateTitle.setText("已结算");
                                stateSub.setText("机器上已结算，本次没有出水，未产生费用");
                            } else {
                                stateTitle.setText("已取消");
                                stateSub.setText(fStopped ? "已取消，本次未接水" : "没有在机器上按开始，本次未接水");
                            }
                            ring.setPct(0f);
                            if (actionBtn != null) {
                                actionBtn.setText("开始接水");
                                actionBtn.setEnabled(true);
                            }
                            if (flowLine != null) flowLine.setVisibility(View.GONE);
                        });
                    }
                    return;
                }

                String finalNo = "";
                // 水一停（机器上点了结算，workStatus 不再是 RUNNING）就立刻把按钮从
                // 「结束接水」切成不可点的「结算中…」。之前这里什么都没做，
                // 于是结算那几秒（afterPay/creating + 最多 4 次 order/sync，约 4 秒）
                // 页面上还挂着一个亮着的「结束接水」——用户看到的正是这个。
                ui.post(() -> {
                    running = false;
                    stopRequested = false;
                    watering = false;
                    if (actionBtn != null) {
                        actionBtn.setText("结算中…");
                        actionBtn.setEnabled(false);
                    }
                });
                if (userStopped) {
                    ui.post(() -> {
                        stateTitle.setText("正在结束");
                        stateSub.setText("已发送停水指令…");
                    });
                    try {
                        Api.call("goods/endWater", Api.params("goodsId", goodsId), Prefs.token(this));
                    } catch (Api.ApiException ignored) {
                    }
                    try {
                        Thread.sleep(800);
                    } catch (InterruptedException ignored) {
                    }
                    try {
                        Object s = Api.call("goods/water/sync", Api.params("skuId", skuId), Prefs.token(this));
                        if (s instanceof JSONObject) last = (JSONObject) s;
                    } catch (Api.ApiException ignored) {
                    }
                }
                if (last != null) finalNo = str(last, "identify");
                if (finalNo.isEmpty() && orderNo != null) finalNo = orderNo;

                ui.post(() -> {
                    stateTitle.setText("已完成");
                    stateSub.setText("正在生成订单…");
                    ring.setPct(1f);
                });

                JSONObject detail = null;
                String payTypeUsed = Prefs.payType(this);
                // 结算状态：ok=已确认支付 / uncreated=订单没建出来 /
                // unpaid=订单建出来了但仍是待支付 / none=这次压根没有消费。
                // 不能一律显示「费用已通过支付宝免密结算」—— 说成已结算而实际挂着
                // 「待支付」，用户下次接水被挡住时会完全不知道原因。
                String settleState = finalNo.isEmpty() ? "none" : "uncreated";
                // 展示用订单号：以 afterPay/creating 返回的 orderNo 为准。
                // goods/water/sync 的 identify 只是「创建后付费订单」的凭据，不是最终订单号
                // （官方单号形如 0620261106004023612291）。拿 identify 去调 order/sync，
                // 服务端查不到这条单，订单就会永远停在「待支付」，还会挡住下一次接水。
                String realNo = finalNo;
                if (!finalNo.isEmpty()) {
                    try {
                        Object c = Api.call("order/afterPay/creating", Api.params("orderNo", finalNo), Prefs.token(this));
                        JSONObject co = c instanceof JSONObject ? (JSONObject) c : null;
                        if (co == null) {
                            settleState = "uncreated";
                        } else {
                            settleState = "unpaid";
                            String oid = str(co, "orderId");
                            String rn = str(co, "orderNo");
                            if (!rn.isEmpty()) realNo = rn;
                            String pt = co.optString("payType", "");
                            if (!pt.isEmpty()) payTypeUsed = pt;
                            boolean paid = "2".equals(co.optString("orderStatus", ""));
                            // 官方 StartStatusAct 拿到 AfterPay 后：orderStatus != 2 就进 PayStateAct(mState=1)，
                            // 由它调 order/sync 完成扣款、把订单从「待支付」推到已支付（code=="0" 才算成功）。
                            // 少了这一步：水票确实扣了、支付宝也推了通知，但胖乖侧订单一直挂着「立即支付」，
                            // 下次接水会被这条未支付订单挡住，必须在官方 App 里手动再点一次。
                            for (int i = 0; i < 4 && !paid; i++) {
                                final int fi = i;
                                ui.post(() -> {
                                    stateTitle.setText("结算中");
                                    stateSub.setText(fi == 0 ? "正在完成支付…" : "正在确认支付结果…");
                                });
                                try {
                                    Object r = Api.call("order/sync",
                                            Api.params("orderNo", realNo, "payType", payTypeUsed),
                                            Prefs.token(this));
                                    if (r instanceof JSONObject && "0".equals(((JSONObject) r).optString("code", ""))) {
                                        paid = true;
                                    }
                                } catch (Api.ApiException ignored) {
                                }
                                if (!paid && i < 3) {
                                    try {
                                        Thread.sleep(900);
                                    } catch (InterruptedException ignored) {
                                    }
                                }
                            }
                            if (paid) settleState = "ok";
                            if (!oid.isEmpty()) {
                                Object dt = Api.call("order/detail", Api.params("orderId", oid), Prefs.token(this));
                                if (dt instanceof JSONObject) detail = (JSONObject) dt;
                            }
                            // 别急着下结论：订单自己的状态才是准的。
                            //
                            // 只信 order/sync 的返回值在「接水一两秒就结算」时必然误判：
                            // 那几次 sync 很可能全部落空，但支付宝异步扣款其实已经成功了。
                            // 用户实测过这种场景 —— APP 写「支付还没确认」，支付宝账单里钱已经扣了，
                            // 于是他被引导去官方 App 点「立即支付」，点开发现根本没有待支付订单。
                            if (!paid) paid = orderLooksPaid(detail);
                            for (int i = 0; i < 2 && !paid && !oid.isEmpty(); i++) {
                                try {
                                    Thread.sleep(1200);
                                } catch (InterruptedException ignored) {
                                }
                                try {
                                    Object d2 = Api.call("order/detail", Api.params("orderId", oid), Prefs.token(this));
                                    if (d2 instanceof JSONObject) {
                                        detail = (JSONObject) d2;
                                        paid = orderLooksPaid(detail);
                                    }
                                } catch (Api.ApiException ignored) {
                                }
                                if (!paid) {
                                    try {
                                        Object r = Api.call("order/sync",
                                                Api.params("orderNo", realNo, "payType", payTypeUsed),
                                                Prefs.token(this));
                                        if (r instanceof JSONObject && "0".equals(((JSONObject) r).optString("code", ""))) {
                                            paid = true;
                                        }
                                    } catch (Api.ApiException ignored) {
                                    }
                                }
                            }
                            if (paid) settleState = "ok";
                        }
                    } catch (Api.ApiException ignored) {
                        settleState = "uncreated";
                    }
                }

                final String fno = realNo;
                final JSONObject fd = detail;
                final JSONObject fsyn = last;
                final String fst = settleState;
                if (mySession == sessionSeq) {
                    ui.post(() -> showResult(fno, fd, fsyn, fst));
                }

            } catch (Api.ApiException e) {
                ui.post(() -> {
                    if (mySession != sessionSeq) return;   // 别把错误画到新设备页上
                    running = false;
                    ring.setPct(0f);
                    if (e.code == 2) {
                        Prefs.setToken(this, "");
                        showGate("登录已过期，请重新登录");
                        return;
                    }
                    stateTitle.setText("启动失败");
                    stateSub.setText(e.getMessage());
                    toast(this, e.getMessage());
                    actionBtn.setText("重试");
                    actionBtn.setEnabled(true);
                });
            } catch (Throwable t) {
                // 非接口异常（解析 NPE 之类）也必须复位 running，
                // 否则按钮会永久失效，表现就是"点了没反应"。
                final String m = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
                ui.post(() -> {
                    if (mySession != sessionSeq) return;
                    running = false;
                    ring.setPct(0f);
                    stateTitle.setText("启动失败");
                    stateSub.setText(m);
                    toast(this, "启动失败：" + m);
                    actionBtn.setText("重试");
                    actionBtn.setEnabled(true);
                });
            }
        });
    }

    private void showResult(String orderNo, JSONObject detail, JSONObject sync) {
        showResult(orderNo, detail, sync, "ok");
    }

    /**
     * @param settleState ok=已确认支付 / uncreated=订单没建出来 / unpaid=仍是待支付
     */
    private void showResult(String orderNo, JSONObject detail, JSONObject sync, String settleState) {
        running = false;
        stopRequested = false;
        watering = false;

        LinearLayout outer = screenShell();
        content.addView(topBar("接水完成", false, false));

        LinearLayout card = Ui.card(this);
        card.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView ok = Ui.text(this, "✓", 30, Prefs.C_OK, true);
        ok.setGravity(Gravity.CENTER);
        ok.setBackground(Ui.round(0x262ECC8F, 31, this));
        card.addView(ok, Ui.lp(Ui.dp(this, 62), Ui.dp(this, 62)));

        TextView h = Ui.title(this, "接水完成", 19);
        h.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.topMargin = Ui.dp(this, 12);
        card.addView(h, hlp);

        TextView sub;
        if ("unpaid".equals(settleState)) {
            sub = Ui.text(this, "水已停，但支付还没确认。若原 App 里有「待支付」订单，点一次「立即支付」，否则会挡住下次接水", 12, Prefs.C_WARN, false);
        } else if ("uncreated".equals(settleState)) {
            sub = Ui.text(this, "水已停，但订单没有生成成功。请到原 App 里确认这笔订单", 12, Prefs.C_WARN, false);
        } else if ("none".equals(settleState)) {
            // 压根没有消费（水没出来 / 时间太短不到最低计量），本来就不该有订单
            sub = Ui.text(this, "本次没有产生费用", 12, Prefs.C_FG2, false);
        } else {
            sub = Ui.text(this, "费用已通过支付宝免密结算", 12, Prefs.C_FG2, false);
        }
        sub.setGravity(Gravity.CENTER);
        card.addView(sub);

        List<String[]> rows = new ArrayList<>();
        if (detail != null) {
            // 用水量/时长：官方 OrderDetailsAct 读 waterUse.waterUseValueDesc
            JSONObject wu = detail.optJSONObject("waterUse");
            if (wu != null) {
                String desc = wu.optString("waterUseValueDesc", "");
                if (!desc.isEmpty()) {
                    rows.add(new String[]{wu.optInt("waterUseType", 0) == 1 ? "用水量" : "用水时长", desc});
                }
            }

            // 原价：tradeOrderItem 求和，缺失时退回 skus
            double origin = 0;
            boolean hasOrigin = false;
            JSONArray items = detail.optJSONArray("tradeOrderItem");
            for (int i = 0; items != null && i < items.length(); i++) {
                JSONObject it = items.optJSONObject(i);
                if (it == null) continue;
                double n = parseAmount(it.optString("originPrice", ""));
                if (!Double.isNaN(n)) {
                    origin += n;
                    hasOrigin = true;
                }
            }
            if (!hasOrigin) {
                JSONArray skus = detail.optJSONArray("skus");
                for (int i = 0; skus != null && i < skus.length(); i++) {
                    JSONObject it = skus.optJSONObject(i);
                    if (it == null) continue;
                    double n = parseAmount(it.optString("originPrice", ""));
                    if (!Double.isNaN(n)) {
                        origin += n;
                        hasOrigin = true;
                    }
                }
            }
            if (hasOrigin) rows.add(new String[]{"原价", yuan(origin)});

            double promoSum = 0;
            JSONArray promos = detail.optJSONArray("promotionList");
            for (int i = 0; promos != null && i < promos.length(); i++) {
                JSONObject p = promos.optJSONObject(i);
                if (p == null) continue;
                double disc = parseAmount(p.optString("discountAmount", ""));
                if (Double.isNaN(disc) || disc <= 0) continue;
                promoSum += disc;
                int type = p.optInt("promotionType", 0);
                String name = p.optString("promotionName", "");
                String label = type == 4 ? "小票抵扣" : type == 8 ? "积分抵扣"
                        : (name.isEmpty() ? "优惠 " + type : name);
                rows.add(new String[]{label, "-" + yuan(disc)});
            }

            String payStr = detail.optString("payPrice", "");
            double pay = parseAmount(payStr);
            if (!payStr.isEmpty() && !Double.isNaN(pay)) {
                rows.add(new String[]{"实付", yuan(pay)});
            } else if (hasOrigin) {
                double real = origin - promoSum - Math.max(0, parseAmountOr0(detail.optString("paymentDiscountPrice", "")));
                rows.add(new String[]{"实付", yuan(Math.max(0, real))});
            }
            String payName = detail.optString("payTypeName", "");
            if (!payName.isEmpty()) rows.add(new String[]{"支付方式", payName});
        }
        if (orderNo != null && !orderNo.isEmpty() && !"null".equals(orderNo)) {
            rows.add(new String[]{"订单号", orderNo});
        }

        for (String[] r : rows) {
            LinearLayout line = Ui.row(this);
            TextView k = Ui.text(this, r[0], 13, Prefs.C_FG2, false);
            TextView v = Ui.text(this, r[1], 13, Prefs.C_FG, true);
            line.addView(k, Ui.lpw(1f));
            line.addView(v);
            LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            llp.topMargin = Ui.dp(this, 9);
            card.addView(line, llp);
        }

        if (rows.size() <= 1) {
            TextView none = Ui.text(this, "本次订单信息暂未返回，可在原 App 订单里查看明细",
                    12, Prefs.C_FG2, false);
            none.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            nlp.topMargin = Ui.dp(this, 12);
            card.addView(none, nlp);
        }

        TextView done = Ui.primaryButton(this, "完成");
        done.setOnClickListener(v -> showHome());
        Ui.pressable(done);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dlp.topMargin = Ui.dp(this, 20);
        card.addView(done, dlp);

        content.addView(card, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        curScreen = "result";
        setScreen(outer);
    }

    /* ================= 设置 ================= */

    private void showSettings() {
        LinearLayout box = Ui.column(this);
        int p = Ui.dp(this, 20);
        box.setPadding(p, p, p, p);

        TextView title = Ui.title(this, "设置", 17);
        box.addView(title);
        box.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 14)));

        String phone = Prefs.phone(this);
        String token = Prefs.token(this);
        box.addView(kvRow("账号", phone.isEmpty() ? "—" : phone));
        box.addView(kvRow("Token", token.isEmpty() ? "—"
                : token.substring(0, Math.min(10, token.length())) + "…"
                + token.substring(Math.max(0, token.length() - 6))));

        // 完整 token：方便在另一台设备（比如手机浏览器/PWA）上直接粘贴登录
        TextView copyTk = Ui.text(this, "查看并复制完整 Token", 14, Prefs.C_FG, true);
        copyTk.setGravity(Gravity.CENTER);
        copyTk.setBackground(Ui.round(Prefs.C_INPUT, 12, Prefs.C_LINE, 1, this));
        copyTk.setPadding(0, Ui.dp(this, 12), 0, Ui.dp(this, 12));
        copyTk.setOnClickListener(v -> showTokenDialog());
        Ui.pressable(copyTk);
        LinearLayout.LayoutParams ct = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ct.topMargin = Ui.dp(this, 4);
        box.addView(copyTk, ct);

        box.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 14)));
        box.addView(Ui.sub(this, "支付方式"));
        TextView pay = Ui.text(this,
                "15".equals(Prefs.payType(this)) ? "支付宝免密（推荐）" : "默认（由服务端决定）",
                15, Prefs.C_FG, false);
        pay.setBackground(Ui.round(Prefs.C_INPUT, 12, Prefs.C_LINE, 1, this));
        pay.setPadding(Ui.dp(this, 14), Ui.dp(this, 13), Ui.dp(this, 14), Ui.dp(this, 13));
        pay.setOnClickListener(v -> {
            String cur = Prefs.payType(this);
            Prefs.setPayType(this, "15".equals(cur) ? "" : "15");
            pay.setText("15".equals(Prefs.payType(this)) ? "支付宝免密（推荐）" : "默认（由服务端决定）");
            toast(this, "已切换支付方式");
        });
        Ui.pressable(pay);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        plp.topMargin = Ui.dp(this, 6);
        box.addView(pay, plp);

        box.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 14)));
        LinearLayout autoRow = Ui.row(this);
        TextView autoLabel = Ui.text(this, "打开即扫码", 15, Prefs.C_FG, false);
        TextView autoVal = Ui.text(this, Prefs.autoStart(this) ? "已开启" : "已关闭", 14,
                Prefs.autoStart(this) ? Prefs.C_ACCENT : Prefs.C_FG2, true);
        autoRow.addView(autoLabel, Ui.lpw(1f));
        autoRow.addView(autoVal);
        autoRow.setBackground(Ui.round(Prefs.C_INPUT, 12, Prefs.C_LINE, 1, this));
        autoRow.setPadding(Ui.dp(this, 14), Ui.dp(this, 13), Ui.dp(this, 14), Ui.dp(this, 13));
        autoRow.setOnClickListener(v -> {
            boolean nv = !Prefs.autoStart(this);
            Prefs.setAutoStart(this, nv);
            autoVal.setText(nv ? "已开启" : "已关闭");
            autoVal.setTextColor(nv ? Prefs.C_ACCENT : Prefs.C_FG2);
        });
        Ui.pressable(autoRow);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        alp.topMargin = Ui.dp(this, 6);
        box.addView(autoRow, alp);

        // 记住登录也应该能在设置里改（登录页那个勾选框决定默认值）
        LinearLayout remRow = Ui.row(this);
        TextView remLabel = Ui.text(this, "记住登录", 15, Prefs.C_FG, false);
        TextView remVal = Ui.text(this, Prefs.remember(this) ? "已开启" : "已关闭", 14,
                Prefs.remember(this) ? Prefs.C_ACCENT : Prefs.C_FG2, true);
        remRow.addView(remLabel, Ui.lpw(1f));
        remRow.addView(remVal);
        remRow.setBackground(Ui.round(Prefs.C_INPUT, 12, Prefs.C_LINE, 1, this));
        remRow.setPadding(Ui.dp(this, 14), Ui.dp(this, 13), Ui.dp(this, 14), Ui.dp(this, 13));
        remRow.setOnClickListener(v -> {
            boolean nv = !Prefs.remember(this);
            Prefs.setRemember(this, nv);
            remVal.setText(nv ? "已开启" : "已关闭");
            remVal.setTextColor(nv ? Prefs.C_ACCENT : Prefs.C_FG2);
            if (nv) {
                // 重新开启时把当前 token 落盘（它此前只活在内存里）
                String tk = Prefs.token(this);
                if (!tk.isEmpty()) Prefs.setToken(this, tk);
            } else {
                toast(this, "已关闭，下次打开需重新登录");
            }
        });
        Ui.pressable(remRow);
        LinearLayout.LayoutParams rlp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rlp2.topMargin = Ui.dp(this, 6);
        box.addView(remRow, rlp2);

        box.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 20)));
        TextView logout = Ui.text(this, "退出登录", 14, Prefs.C_ERR, true);
        logout.setGravity(Gravity.CENTER);
        logout.setBackground(Ui.round(0x1FFF5D5D, 12, this));
        logout.setPadding(0, Ui.dp(this, 13), 0, Ui.dp(this, 13));
        logout.setOnClickListener(v -> {
            AlertDialog cd = new AlertDialog.Builder(this)
                    .setMessage("确定退出登录？")
                    .setNegativeButton("取消", null)
                    .setPositiveButton("退出", (d, w) -> {
                        Prefs.setToken(this, "");
                        Prefs.setPhone(this, "");
                        showGate();
                    })
                    .create();
            darkDialog(cd);
            trackDialog(cd);
            cd.show();
        });
        Ui.pressable(logout);
        box.addView(logout, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView foot = Ui.text(this, "接口：userapi.qiekj.com · 非官方客户端，仅个人使用", 11, Prefs.C_FG2, false);
        foot.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        flp.topMargin = Ui.dp(this, 14);
        box.addView(foot, flp);

        box.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 16)));
        TextView close = Ui.text(this, "关闭", 15, Prefs.C_ACCENT, true);
        close.setGravity(Gravity.CENTER);
        close.setPadding(0, Ui.dp(this, 13), 0, Ui.dp(this, 13));
        Ui.pressable(close);
        box.addView(close, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final AlertDialog dlg = new AlertDialog.Builder(this).setView(box).create();
        close.setOnClickListener(v -> dlg.dismiss());
        darkDialog(dlg);
        trackDialog(dlg);
        dlg.show();
    }

    /**
     * 完整 token 弹窗：只读、可长按选中，并提供一键复制。
     * 用途：把手机 App 上的登录态搬到 PWA / 另一台设备上（那边登录页「已有 Token？」粘贴即可）。
     */
    private void showTokenDialog() {
        String token = Prefs.token(this);
        if (token == null || token.isEmpty()) {
            toast(this, "当前没有登录态");
            return;
        }

        LinearLayout box = Ui.column(this);
        int p = Ui.dp(this, 20);
        box.setPadding(p, p, p, p);

        box.addView(Ui.title(this, "完整 Token", 17));
        TextView tip = Ui.text(this, "整段复制下面这串，粘到网页版登录页底部「已有 Token？」里就能直接登录。", 12, Prefs.C_FG2, false);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tlp.topMargin = Ui.dp(this, 8);
        box.addView(tip, tlp);

        TextView tv = Ui.text(this, token, 13, Prefs.C_FG2, false);
        tv.setTextIsSelectable(true);
        tv.setBackground(Ui.round(Prefs.C_INPUT, 12, Prefs.C_LINE, 1, this));
        tv.setPadding(Ui.dp(this, 12), Ui.dp(this, 12), Ui.dp(this, 12), Ui.dp(this, 12));
        LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        vlp.topMargin = Ui.dp(this, 12);
        box.addView(tv, vlp);

        TextView copy = Ui.text(this, "复制", 15, Prefs.C_ACCENT, true);
        copy.setGravity(Gravity.CENTER);
        copy.setPadding(0, Ui.dp(this, 13), 0, Ui.dp(this, 13));
        Ui.pressable(copy);
        LinearLayout.LayoutParams clp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clp2.topMargin = Ui.dp(this, 14);
        box.addView(copy, clp2);

        TextView close = Ui.text(this, "关闭", 15, Prefs.C_FG2, true);
        close.setGravity(Gravity.CENTER);
        close.setPadding(0, Ui.dp(this, 13), 0, Ui.dp(this, 13));
        Ui.pressable(close);
        box.addView(close, Ui.lp(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final AlertDialog dlg = new AlertDialog.Builder(this).setView(box).create();
        copy.setOnClickListener(v -> {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(ClipData.newPlainText("token", token));
                    toast(this, "已复制");
                }
            } catch (Throwable t) {
                toast(this, "复制失败，请长按上面的文本框手动复制");
            }
        });
        close.setOnClickListener(v -> dlg.dismiss());

        darkDialog(dlg);
        trackDialog(dlg);
        dlg.show();
    }

    private void darkDialog(AlertDialog dlg) {
        if (dlg.getWindow() != null) {
            dlg.getWindow().setBackgroundDrawable(Ui.round(Prefs.C_CARD, 18, Prefs.C_LINE, 1, this));
        }
    }

    private LinearLayout kvRow(String k, String v) {
        LinearLayout row = Ui.row(this);
        row.setPadding(0, Ui.dp(this, 6), 0, Ui.dp(this, 6));
        row.addView(Ui.text(this, k, 13, Prefs.C_FG2, false), Ui.lpw(1f));
        row.addView(Ui.text(this, v, 13, Prefs.C_FG, true));
        return row;
    }

    /* ================= 杂项 ================= */

    private View loading;
    private TextView loadingText;

    private void showLoading(String msg) {
        if (loading == null) {
            FrameLayout fl = new FrameLayout(this);
            fl.setBackgroundColor(0xCC000000);
            TextView t = Ui.text(this, msg, 14, Color.WHITE, false);
            t.setGravity(Gravity.CENTER);
            t.setBackground(Ui.round(0xFF1E2A3A, 12, Prefs.C_LINE, 1, this));
            t.setPadding(Ui.dp(this, 18), Ui.dp(this, 14), Ui.dp(this, 18), Ui.dp(this, 14));
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.gravity = Gravity.CENTER;
            fl.addView(t, lp);
            loading = fl;
            loadingText = t;
            root.addView(fl, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        loadingText.setText(msg);
        loading.setVisibility(View.VISIBLE);
    }

    private void hideLoading() {
        ui.post(() -> {
            if (loading != null) loading.setVisibility(View.GONE);
        });
    }

    static void toast(Activity a, String msg) {
        a.runOnUiThread(() -> Toast.makeText(a, msg, Toast.LENGTH_SHORT).show());
    }

    /** 当前页面：gate / home / device / result。返回键按这个层级回退。 */
    private String curScreen = "gate";

    @Override
    public void onBackPressed() {
        // 不直接 finish：从结算页/设备页退出会丢掉整个 App。
        // 结算页按返回 = 回首页，用户要用时再点扫码。
        if ("result".equals(curScreen) || "device".equals(curScreen)) {
            if ("device".equals(curScreen) && !canLeaveDevice()) return;
            leaveDevice();
            return;
        }
        super.onBackPressed();
    }

    /**
     * 把 sync.amount 这种"字符串数字"安全地转成 double。
     * 这个字段不是金额（官方只用它判断有没有消费），但也可能是空串或 "—"。
     */
    /**
     * 读字符串字段，把「缺字段 / JSON null / 字面量 "null"」统一当成空串。
     *
     * 必须用这个，不能直接用 optString(name, "")：org.json 的 optString 只在
     * **键不存在**时才返回兜底值；键存在而值是 JSON null 时，它会把
     * JSONObject.NULL 转成字符串 "null" 返回。
     *
     * 后果很具体：用户扫完码一滴水没接、直接在机器上点结算，服务端返回的
     * identify 是 JSON null，于是 `!identify.isEmpty()` 恒为真 —— 被当成
     * "这次接过水" 去建订单，最后结算页写着「订单没有生成成功」，
     * 订单号那一栏还明晃晃一个 null。用户实测截图正是这个。
     */
    private static String str(JSONObject o, String key) {
        if (o == null) return "";
        Object v = o.opt(key);
        if (v == null || v == JSONObject.NULL) return "";
        if (v instanceof String) {
            String s = (String) v;
            return ("null".equals(s) || "undefined".equals(s)) ? "" : s;
        }
        return String.valueOf(v);
    }

    private static double numOf(String s) {
        if (s == null || s.isEmpty()) return 0;
        try {
            return Double.parseDouble(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * 判断一份 order/detail 是否已经「付掉了」。
     *
     * 只看 order/sync 的返回值在「接水一两秒就结算」时必然误判：服务端的建单、
     * 扣款、状态回推都还在路上，那几次 sync 很可能全部落空，但支付宝其实已经扣款成功。
     * 用户实测过：APP 写「支付还没确认」，支付宝账单里钱已经扣了，然后他被引导去官方
     * App 点「立即支付」，点开发现根本没有待支付订单。
     *
     * 官方状态表（h5 包里的枚举）：
     *   0 待支付 / 1 已失效 / 2 使用中(或已完成) / 3 已完成 / 4 退款中 / 5 已退款
     * 2 和 3 都算钱已结清 —— 2 是机器还在用、3 是整单结束。
     * 1/4/5 是异常终态，不当作已支付；0 就是真的没付。
     */
    private static boolean orderLooksPaid(JSONObject detail) {
        if (detail == null) return false;
        String st = detail.optString("orderStatus", "");
        if (st.isEmpty()) return false;
        try {
            int n = Integer.parseInt(st.trim());
            return n == 2 || n == 3;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    /**
     * 接水中不允许离开设备页。
     *
     * 之前无论按返回键还是右上角 ✕ 都能直接走人：水泵还在出水，
     * 界面上却已经没有「结束接水」按钮了，只能等它自己流完。
     *
     * 注意判断的是 watering 而不是 running —— running 还包含开阀之后的等待期，
     * 那段时间水一滴都没出，为了 90 秒的等待把返回键锁死纯粹是坑人。
     */
    private boolean canLeaveDevice() {
        if (!watering) return true;
        toast(this, "接水中，请先结束接水");
        return false;
    }

    /**
     * 离开设备页回首页。等待期（已开阀但用户还没按「开始」）允许离开：
     * 让后台那一轮看到 stopRequested，它会自己停水、并且不生成订单。
     */
    private void leaveDevice() {
        if (running && !watering) stopRequested = true;
        showHome();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        pool.shutdownNow();
    }
}

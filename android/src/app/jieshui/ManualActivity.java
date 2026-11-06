package app.jieshui;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** 手动输入二维码内容 */
public class ManualActivity extends Activity {

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().setStatusBarColor(Prefs.C_BG);

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Prefs.C_BG);
        sv.setFillViewport(true);

        LinearLayout root = Ui.column(this);
        int p = Ui.dp(this, 20);
        root.setPadding(p, p + Ui.dp(this, 24), p, p);

        TextView title = Ui.title(this, "输入设备号", 20);
        root.addView(title);
        root.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 16)));

        root.addView(Ui.sub(this, "二维码内容 / 设备编号"));
        root.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 8)));

        EditText input = new EditText(this);
        input.setHint("扫描结果文本，或饮水机上的编号");
        input.setHintTextColor(Prefs.C_FG2);
        input.setTextColor(Prefs.C_FG);
        input.setTextSize(15);
        input.setGravity(Gravity.TOP);
        input.setMinLines(3);
        input.setBackground(Ui.round(Prefs.C_INPUT, 12, Prefs.C_LINE, 1, this));
        input.setPadding(Ui.dp(this, 14), Ui.dp(this, 13), Ui.dp(this, 14), Ui.dp(this, 13));
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        root.addView(input, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Ui.dp(this, 110)));
        root.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 18)));

        TextView ok = Ui.primaryButton(this, "确定");
        ok.setOnClickListener(v -> {
            String s = input.getText().toString().trim();
            if (s.isEmpty()) {
                MainActivity.toast(this, "请输入内容");
                return;
            }
            setResult(RESULT_OK, new Intent().putExtra(ScanActivity.EXTRA_RESULT, s));
            finish();
        });
        Ui.pressable(ok);
        root.addView(ok);
        root.addView(Ui.spacer(this), Ui.lp(1, Ui.dp(this, 10)));

        TextView cancel = Ui.ghostButton(this, "取消");
        cancel.setOnClickListener(v -> finish());
        Ui.pressable(cancel);
        root.addView(cancel);

        sv.addView(root, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(sv);
    }
}

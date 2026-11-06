# 部署说明

## 已上线的地址

**<https://jieshui.pages.dev>** ← 现在就能用（Cloudflare Pages）

- 全部资源已验证可访问（index / app.js / jsQR.js / style.css / sw.js / manifest / icon）
- 响应头级 CSP / HSTS / X-Frame-Options 全部生效（见下）
- 手机浏览器打开后可「添加到主屏幕」，PWA 全屏运行，无地址栏
- 重新部署：`bash tools/deploy.sh`

> **早先放在 surge.sh，已全部下线。** surge 不支持 `_headers`，CSP 只能走 meta 版，
> 而 meta 版不支持 `frame-ancestors`（挡不住 iframe 套页面做点击劫持）。
> 另外实测 surge 取 `/app.js` 约 1.7 s 且抖动大，Cloudflare 稳定 0.64 s。
> `jieshui.surge.sh` / `jieshui-qk.surge.sh` / `hdr-test-qk.surge.sh` 三个域名都已 teardown，现返回 404。

## 一、PWA（网页版，零成本）

`web/` 是纯静态站点，API 侧 CORS 全开，**不需要任何后端或代理**。

### Cloudflare Pages（当前主站）

```bash
# 首次：设备授权（会打印一个 URL + 短代码，浏览器打开点 Allow，5 分钟内有效）
npx wrangler@4.157.0 login --device --browser=false

# 首次：创建项目（项目已存在会报错，可以跳过这步）
npx wrangler@4.157.0 pages project create jieshui --production-branch=main

# 之后每次部署
bash tools/deploy.sh
```

`tools/deploy.sh` 会先跑 `python tools/gen_headers.py` 生成 `web/_headers`，再 `wrangler pages deploy`。

两个必须知道的坑：

1. `wrangler.jsonc` 在 Pages 模式下**不能用 `assets` 字段**（那是 Workers 静态资源写法），只认
   `pages_build_output_dir`，否则报 `Configuration file for Pages projects does not support "assets"`。
2. 首次部署前不建项目会报 `The Pages project "jieshui" does not exist`。

授权凭据存在 `C:\Users\<你>\AppData\Roaming\xdg.config\.wrangler\config\default.toml`，
之后不需要 `CLOUDFLARE_API_TOKEN`。无浏览器环境（CI）才用 API Token：

```bash
export CLOUDFLARE_API_TOKEN=你的token   # 权限选 Cloudflare Pages : Edit
npx wrangler@4.157.0 pages deploy --commit-dirty=true
```

部署完会得到一个 `https://jieshui.pages.dev` 之类的地址，手机浏览器打开 → 菜单「添加到主屏幕」，就会以独立窗口运行（PWA，无地址栏）。

### 其它静态托管

直接把 `web/` 目录整个上传即可（Netlify、Vercel、GitHub Pages、自建 Nginx、局域网 Python `http.server` 都行）。

> **必须是 HTTPS 或 localhost**，否则浏览器不授予摄像头权限（`getUserMedia`），扫码功能不可用。

### 本地预览

```bash
cd web && python -m http.server 8899 --bind 127.0.0.1
# 打开 http://127.0.0.1:8899/
```

## 二、APK（安卓原生）

`apk/jieshui.apk` 已签名，可直接侧载安装。

- 签名证书 SHA-256：`0cfc62f5168f55864cf43f06a4f456ace06b27a71457559da4ea4013680fc7a7`
- 包名 `app.jieshui`，minSdk 24（Android 7.0+），arm64 / x86_64 通用（纯 Java，无 native 库）
- 体积 285 KB

安装：手机文件管理器点开 APK → 允许「安装未知应用」。或者：

```bash
adb install -r apk/jieshui.apk
```

首次打开要授予**相机**权限。如果模拟器没有摄像头，扫码页会是灰屏，用底部的「手动输入设备号」即可。

### 重新构建

```bash
bash build.sh     # 正式版 → apk/jieshui.apk
bash build_test.sh # mock 版 → apk/jieshui-test.apk（不联网，界面演示用）
```

需要 JDK 17 + Android SDK（build-tools 34 / platforms/android-34）+ zxing-core-3.5.3.jar。

## 三、登录

两种都行：

1. **手机号 + 短信验证码** —— 和官方 App 同一个接口（`common/sms/sendCode` + `user/reg`），验证码模板 `reg`。
2. **粘贴 Token** —— 在官方 App 里抓包拿到 `Authorization` 值，或从开源版 App 的「我的 → 查看 Token」复制。

拿到 token 后，水卡、优惠券、积分、免密签约全部**自动沿用**，因为它们挂在账号上，不挂在设备或客户端上。

## 四、常见问题

**Q：接水时提示「该设备需在官方 App 内使用」**
A：`goods/scan/v2` 返回了 `jumpToDevicePageFlag`。这类机器在官方侧也是跳支付宝小程序，本客户端不实现。

**Q：提示「这不是饮水机（类型 XX）」**
A：二维码指向的是洗衣机/烘干机/淋浴，本客户端只做 `categoryCode=04`。

**Q：扫码没反应**
A：先在浏览器确认相机权限；PWA 必须 HTTPS；模拟器无摄像头时用手动输入。

**Q：水卡余额没显示**
A：`waterQuota/getActive` 需要 `shopId`，而 `shopId` 来自 `goods/normal/details`。如果设备详情里 `shopId=0`，这一条会静默跳过——不影响接水扣费（优惠在扣款时由服务端算）。

**Q：会不会影响我在官方 App 里的使用？**
A：不会。这是同一个账号的两个客户端，共用 token 和数据。

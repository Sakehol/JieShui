# 技术文档 · 接水

> 面向开发者的完整实现记录：协议细节、接口链路、安全加固、踩过的坑与实测数据。
> 想先看这个项目是干什么的，请回 [README](../README.md)。


胖乖生活（`com.qiekj.user`）的替代客户端，只保留「扫码 → 接水 → 免密结算」一条线。
无广告、无弹窗、无首页推荐。打开即扫码。

两种形态，共用同一套接口逻辑：

| 形态 | 位置 | 说明 |
| --- | --- | --- |
| **Android APK** | `apk/jieshui.apk`（285 KB，构建产物） | 原生 Java，无第三方 UI 库，相机扫码用 ZXing |
| **PWA 网页** | `web/` · **<https://jieshui.pages.dev>** | 纯静态，已上线 |

---

## 「买过的水卡还生效吗」——这是整个项目的核心

**生效，而且不需要任何迁移动作。**

水卡余额、小票、积分、支付宝免密签约，全部存在胖乖生活的**服务器上**并与**账号**绑定，
客户端只是个遥控器。换一个客户端登录同一个账号，服务端照旧扣它的水卡、走它的免密协议。

代码层面的证据：官方 `StartStatusAct.initData()` 里 `payType` 是硬编码的
`String.valueOf(PayTypeEnum.ALIPAY_NOT_PASSWORD.getType())`（= `"15"`，支付宝免密），
客户端从来没参与过「用哪张卡」的决策 —— 那是服务端按账号算的。

所以本客户端要做的只是：**带上你的 token，把 `skuId` 和 `payType=15` 发给服务端**。

> **`payType` 是枚举的 `type` 字段，不是 ordinal**。
> `PayTypeEnum` 的构造签名是 `(name, ordinal, type, str)`：
> `ALIPAY` = type `13`、`ALIPAY_NOT_PASSWORD` = type `15`、`WALLET` = type `2`。
> 早前误传 `1`（那是 ordinal）的后果是：服务端把渠道认成别的，水票照扣、
> 但订单在胖乖侧一直挂「待支付」，还会挡住下一次接水。

## 怎么拿到 token（三种，从易到难）

### 方式 1（推荐）：从已登录的 App 里直接读

原版 App 把 token 明文存在 MMKV 里：`/data/data/com.qiekj.user/files/mmkv/mmkv.default`。
不需要抓包、不需要装证书、不需要 root（`adb shell run-as` 或模拟器的可读目录即可）。

```bash
# 1. 在手机/模拟器上装原版 App 并登录一次（我的 → 登录）
# 2. 连着 adb，执行：
bash tools/token_from_mmkv.sh

# 只要 token 本身：
bash tools/token_from_mmkv.sh -
```

> 如果 `adb pull` 报 permission denied，先用 `adb root`（模拟器/开发版可用），
> 或者直接把 App 装到 MuMu 之类的模拟器里登录。

### 方式 2：常规手机号登录

在 App/PWA 登录页输入手机号 → 收短信 → 输验证码。**登录成功后 token 会自动保存**，
之后每个请求自动带上，不用你管。

若服务端返回 `forcedBind: true`（常见于老账号），说明这个号必须先绑定第三方账号才会下发
token —— 会提示你先去官方 App 绑定微信/支付宝，绑完再用**方式 1** 或方式 3 取 token。

### 方式 3：浏览器 F12 抓包

1. 手机浏览器打开 <https://h5.qiekj.com>，或电脑上开原版 App 的 H5 页面并登录
2. F12 → Network → 找任意一个 `userapi.qiekj.com` 的 POST
3. 请求头里的 `Authorization`、或表单里的 `token=`，复制那个值

拿到 token 后，在 PWA 登录页点底部小字「已有 Token？改用 Token 登录」，或用 APK 登录页
同一行入口展开输入框粘贴（默认折叠，避免干扰普通用户）。

### 想导出自己的 token（在另一台设备上复用登录态）

- **APK**：首页右上角 ⚙ → 设置 → 「查看并复制完整 Token」→ 弹窗里显示完整明文，
  点「复制」写入剪贴板（也可长按文本框手动选中）。
- **PWA**：右上角 ⚙ → 设置 → 「查看并复制完整 Token」→ 展开只读文本框 + 「复制」按钮。

拿到的那串粘到另一台设备的登录页（PWA 走底部小字、APK 走同一行入口）即可直接进入，
不用再收短信。token 过期后这个入口会显示「当前没有登录态」，属正常。

## 拿到 token 后：一键验证全链路

```bash
python tools/probe_chain.py <token>
```

只调**只读**接口（`user/checkLogin`、`user/balance`、`goods/latestUsed`、`goods/scan/v2`、
`goods/normal/details`、`goods/normal/skus`、`waterQuota/getActive`、`alipay/isSign`），
不会开水、不会下单、不会扣钱。重点看两行：

- `goods/scan/v2` 返回 `code:0` → **扫码链路通了**
- `waterQuota/getActive` 返回的 `text` → **就是买过的水卡/额度文案**

脚本会带齐 `sign` 头与 `timestamp`，与 App 内部完全一致。

### 真实账号验证过的链路（2026-11）

下表是脱敏后的返回**结构**，具体账号数据不进仓库：

| 接口 | 返回结构 |
|---|---|
| `user/balance` | `tokenCoin`（小票余额，单位分）、`integral`（积分） |
| `goods/latestUsed` | 数组，每项含 `goodsId`/`goodsName`/`imei`/`shopId`/`categoryCode` |
| `goods/scan/v2` `SN=<设备编号>` | `code:0`，`data.id` = 设备 `goodsId` |
| `goods/normal/details` | `imei`、`payTypes`、`isBluetooth`、`orgId`、`shopId` |
| `goods/normal/skus` | `skuId`、`extAttr.level[0].price`（元/L）、`extAttr.baseFare`、`extAttr.minCount` |
| `alipay/isSign` | `true` = 免密已签约 |
| `orderRisk/isCheckLocation` | `false` = 该设备不校验定位 |

## 功能

- **打开即扫码**：默认关闭，设置里可开（`autoStart`）——登录后直接弹相机容易打断人
- **扫码即开阀，中间不用再点一次**：扫到饮水机二维码后，客户端直接下发 `goods/water/unlock`，
  机器立刻认到人，用户在机器上按「开始」就出水。官方 App 就是这个节奏——
  手机上多一次「开始接水」纯属多余。设备页这时显示「已就绪 / 请在机器上按「开始」」，
  按钮是「取消」（不想接了直接退出，不会产生订单）
- **不显示计费方式**：饮水机只有一档，官方那行「饮水 · 起步¥1 · 最低10」对用户没意义，
  卡片已删除；`skuId` 仍在后台取到，只是不下发给用户看
- **扫码后一直没按机器上的开始不会产生空单**：等待约 90 秒才会放弃。
  期间 `workStatus` 还不是 `RUNNING`、`amount` 是 0，**不能**当成"已结算"去建订单，
  否则会出现一张 0 元废单，还会以「有未支付订单」挡住下一次接水
- **只认饮水机**：`categoryCode != 04` 的设备直接拒绝，不显示别的业务
- **只走支付宝免密**：`payType=15`（`ALIPAY_NOT_PASSWORD` 的 type 值），与官方 `StartStatusAct` 源码硬编码值一致；接水前会先登记后付费渠道（`payChannelRoute/addUserAfterPayChannel`），否则水票扣了但订单会挂在「待支付」
- **水卡 / 小票 / 积分照常生效**：全部由服务端按账号计算，客户端不参与
- **实时计量**：接水中每秒拉一次 `goods/water/sync`，显示已接时长；金额与水量以 `order/detail` 为准
- **结算明细准确**：水量取 `waterUse.waterUseValueDesc`，金额取 `tradeOrderItem[].originPrice` / `payPrice`
- **手动输入兜底**：相机不可用时可直接粘贴二维码内容或设备号
- **从账号同步**：一键拉取账号最近用过的饮水机（`goods/latestUsed`），不依赖扫码
- **失败必有反馈**：拿不到计费方式 / 接口报错时按钮会变成「重新加载」并显示原因，**不会点了没反应**
- **登录过期会明说**：任一接口返回 `code:2` 时立即回登录页并提示「登录已过期，请重新登录」——
  不会因为 `goods/normal/details` 免登录可用，就把 `goods/normal/skus` 的「未登录」误报成「该设备暂无可用计费方式」
- **token 可导出**：设置里有「查看并复制完整 Token」，方便把手机端的登录态搬到 PWA / 另一台设备
- **扫码取景不做假放大**：取景窗是一块跟屏幕短边成比例的正方形，`video` 用 `cover` 铺满它，
  于是**框里看到的就是解的那块像素**，一点不多一点不少。以前是整屏铺满 + `cover`：
  手机竖屏时横向只剩中间 26%（等效放大 3.85 倍），看起来就像"相机自己放大了"，
  用户只能往后退，而越退二维码在画面里越小、越认不出
- **扫码认得远**：主路径是把取景窗对应的那块**原生像素**切出来解（上限 1080），
  整幅压到 720 只作为兜底、每 3 帧跑一次。直接决定灵敏度的是**摄像头给的分辨率**：
  只给 `width` 时 Chrome 给 1280x720（取景窗只能取到 720px），
  同时给 `width`+`height` 才会给到 4:3 的 1920x1440（能取到 1440px，边长翻倍）。
  实测同一距离下码占取景窗 12% 时，720 的流认不出、1440 的流能认出
- **老机型不会卡**：请求高分辨率后若单帧解码长期超 45ms，会自动把摄像头降回 1280x720 一次

APK 的扫码器（`ScanActivity.java`）是 Camera1 + ZXing，另有三处对应的改动：

- **预览不再被拉伸**：`SurfaceView` 原来是 `MATCH_PARENT`，4:3 的预览流被硬拉到 9:19.5 的屏幕上，
  二维码在画面上是扁的。现在按预览真实宽高比居中铺（cover），多出来的裁到屏幕外
- **只解取景框那块方块**：取景框占屏幕短边 68%，换算成面积约整帧的 1/3，
  实测每帧从 2.7ms 降到 1.2ms。整幅解作为兜底，但**每 8 帧才跑一次**——
  无码帧（绝大多数）如果每帧都兜底，成本是 ROI + 整幅 = 4.5ms，比只解整幅的 3.2ms 还慢 41%；
  限流后降到 1.7ms，比原来快 1.9 倍
- **预览分辨率取短边最大的一档**：原来挑「宽在 960~1440 之间面积最小」，常落到 1280x720（短边 720）。
  取景框是正方形，能拿到多少原生像素只取决于短边，现在取短边最大的一档（上限 1080）。
  实测二维码占取景框 8% 时，720 的流认不出、1080 的流能认出

- **结算期间按钮立刻变成「结算中…」**：机器上点结算、`goods/water/sync` 的 `workStatus` 一变，
  按钮就从「结束接水」切成不可点的「结算中…」。以前这段（`afterPay/creating` + 最多 4 次
  `order/sync`，几秒）页面还挂着亮着的「结束接水」，点它没反应，看起来像"结算很慢"。
  现在结算一结束就自动跳结算页，按返回/完成回首页，要用时再点扫码
- **结算结果如实说**：`order/afterPay/creating` 没建出订单时，结算页写「水已停，但订单没有生成成功」，
  且**不显示订单号**（`goods/water/sync` 的 `identify` 只是建单凭据，不是订单号）；
  `order/sync` 一直没成功时写「支付还没确认」并提醒去原 App 清掉「待支付」单。
  以前这两种情况都写"已结算"，用户下次被"有未支付订单"挡住时完全不知道为什么
- **断网不会永远转圈**：等待期 `goods/water/sync` 连续失败 5 次就退出并显示「网络不稳 / 连不上服务器」。
  以前 `catch` 里的 `continue` 跳过了等待计数，断网时会一直停在「已就绪 / 请在机器上按开始」
- **等待期可以离开**：开阀后水还没出来时按返回/关闭直接回首页，后台那一轮会自己停水且不建单。
  只有真正出水（`workStatus` 到过 `RUNNING`）才拦返回
- **连续扫两台机器不会串**：等待期又扫了另一台，旧的那一轮会被立即作废，并且**只停它自己那台**的水
  （用开头冻结的 `goodsId`），不会把新机器停掉；新机器照常开阀

## 安全加固（网络侧）

目标是「防别人从网络上攻击」：**不改变本机使用体验**，不加锁屏、不防截屏、不影响分享截图和远程协助。
本机数据本身是加密存储的（见下），但那是既有的顺手改造，不构成使用负担。

### APK

| 措施 | 实现 | 挡什么 |
| --- | --- | --- |
| 只走 TLS | `res/xml/network_security_config.xml`：`cleartextTrafficPermitted="false"`（base 与 `qiekj.com` 域级双写）+ `Api.java` 里对 `url.getProtocol()` 兜底抛「拒绝明文连接」(-96) | 降级攻击、公共 WiFi 嗅探、以后有人误改 `BASE` 成 http |
| 只信任系统 CA | `trust-anchors` 只列 `<certificates src="system" />`，**故意不列 `src="user"`、不配 `<debug-overrides>`** | 攻击者在手机上装 mitmproxy / Charles 根证书后中间人解密；release 版没有任何信任用户证书的例外分支 |
| 禁跟随重定向 | `conn.setInstanceFollowRedirects(false)`，302 当异常 | 被劫持的服务端把请求 302 到 http 或第三方域名，`HttpURLConnection` 默认会把 `token` 一起带过去 |
| 本地加密存储 | `Secure.java`：AndroidKeyStore（别名 `jieshui.vault.v1`）+ AES/GCM/NoPadding 256 位，密文格式 `v2:<base64>` | 手机被 root / 取证工具翻 `shared_prefs` 时 token 不是明文 |
| 禁备份 | `allowBackup=false` + `fullBackupContent=false` + `res/xml/data_extraction_rules.xml` 排除 sharedpref/file/database/external | `adb backup` 与厂商云备份把数据连同 Keystore 一起带走 |
| 输入即清 | 验证码提交后 `code.setText("")`；Token 粘贴成功后 `tok.setText("")`；Token 校验要求 ≥16 位且字符集 `[A-Za-z0-9+/=_-]` | 明文凭证长时间留在输入框里被截图/输入法记忆 |
| 不打日志 | 全项目无 `android.util.Log` / `System.out` / `printStackTrace`；toast 不打印任何凭证值 | logcat 被抓后泄露 |

`Secure.java` 的兼容性：`decrypt` 同时认 `v2:`（密文）、`p1:`（Keystore 不可用时的降级明文）、以及**无前缀的老版 Base64 明文**，所以老用户升级不会掉数据。

> 上一版曾加过 `FLAG_SECURE` 防截屏和 PIN 应用锁，已按需求**全部移除**：
> 防截屏会让用户没法截图分享接水订单、也没法远程协助；PIN 每次冷启动都要输，属于本地体验负担，
> 而它挡的只是「拿到已解锁手机的人」，对网络侧攻击没有作用。

### PWA

| 措施 | 实现 | 挡什么 |
| --- | --- | --- |
| **token 默认不落磁盘** | `app.js` 的 `Store.token`：优先内存，其次 `sessionStorage['qk_token_session']`；**只有用户勾了「记住登录」才写 `localStorage['qk_token']`**，取消勾选立刻删 | 关闭标签页后 token 就不在本机磁盘上；共用电脑上下一个人打开浏览器也读不到 |
| CSP（meta 版） | `index.html` 的 `<meta http-equiv="Content-Security-Policy">`：`default-src 'none'`、`script-src 'self'`、`style-src 'self'`（去掉了 `unsafe-inline`）、`connect-src 'self' https://userapi.qiekj.com`、`frame-src 'none'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'` | 注入的 `<script>`/`eval` 不执行（XSS 拿不到 token）；即使有代码被执行，也 POST 不到第三方域名 |
| 禁内联样式 | 已把 `style="..."` 全抽成 class；状态环改用 `--deg` 自定义属性（`el.style.setProperty`，不受 `style-src` 限制） | 减少注入面，同时保证 CSP 收紧后进度环仍能画 |
| Referrer | `<meta name="referrer" content="no-referrer">` | token 出现在链接里时被外部站点拿到 |
| 会话失效清理 | `sessionExpired()` 同时清 `memToken`/`sessionStorage`/`localStorage`、`#setToken` 打码值、`#tokenFull` 明文，并回登录页 | 回登录页后抽屉里还露着旧 token |
| 导出需手动点 | 「查看并复制完整 Token」默认折叠，展开有「不要在公共电脑上开着这个框」提示 | 肩窥 / 误留在屏幕上 |
| 诊断页不发布 | `debug.html` 已移到 `tools/debug.html`，线上 `/debug.html` 返回 404 | 线上留一个能读 token 的调试页 |

### Cloudflare Pages 的 `_headers`（比 meta 更完整）

线上跑在 Cloudflare Pages，`python tools/gen_headers.py` 生成的 `web/_headers` 已生效。
响应头比 meta 多出这些：

- `Content-Security-Policy`（响应头版，含 **`frame-ancestors 'none'`**）——防页面被别的站用 iframe 套走做点击劫持
- `X-Frame-Options: DENY`（给不认 CSP 的老浏览器兜底）
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Permissions-Policy: geolocation=(self), camera=(self), microphone=(), payment=(), usb=()`
- `Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Resource-Policy: same-origin`
- `/sw.js` 与 `*.html` 的 `Cache-Control: no-cache`（避免用户留在旧版本上看不到安全修复）

`tools/deploy.sh` 只发 Cloudflare；`_headers` 必须一起上传，否则线上只剩 meta 版 CSP。

> **为什么是这三道，而不是「加密 token」**：浏览器里没有可信的密钥存放处，前端加密只是把明文换个地方放。
> 真正能降低 token 被偷后损失的是：① 让它尽量不在磁盘上活着；② 让攻击者没机会在页面里执行代码（CSP）；
> ③ 让被执行的代码也没法把 token 发出去（`connect-src`）。三条都做到之后，剩下的唯一入口是服务端的 token 校验本身。

> **为什么主站必须是 Cloudflare 这类能改响应头的托管**：`surge.sh` 不支持 `_headers`（实测自定义响应头不生效），
> CSP 只有 meta 版，而 meta 版**不支持 `frame-ancestors`**。防 iframe 套页面做点击劫持（骗你点「开始接水」真实扣费）
> 必须有响应头，所以原来放在 surge 的站点已全部下线，只保留 Cloudflare Pages。

### 两端共同的取舍

- **不做「设备绑定」**：API 没有设备指纹校验接口，做强绑定会在换机时把用户锁死。
- **不做证书固定（pinning）**：官方证书是 `*.qiekj.com`（Let's Encrypt 系外的 `Xcc Trust OV SSL CA` 签发，2027-04 到期），
  固定 SPKI 会在对方换证书时让全部用户突然连不上，风险大于收益；用「只信任系统 CA」已经能挡住本地中间人。
- **`appSecret` 不是秘密**：它和 `sign` 算法本来就在官方 APK 里，属于「公开的客户端秘密」，
  真正的边界是服务端的 token 校验；我们能做的是**别让它在本机以明文躺着、别在网络上裸奔**。


## 协议要点

服务端：`https://userapi.qiekj.com/`（表单 POST）

```
headers:
  Version: 1.145.0        # = 原 APK 的 versionName（aapt2 dump badging 得到，versionCode=299）
  channel: android_app
  phoneBrand: <Build.BRAND>
  User-Agent: okhttp/3.14.9
  timestamp: <ms>
  Authorization: <token>
  token: <token>
body:
  ...业务参数
  token=<token>          # token 同时在 header 与 body
```

`_sign` / `_appid`（表单签名）实测**非必需**，客户端不实现。但**请求头 `sign` 是必需的**：

```
sign = SHA-256("appSecret=<SECRET>&channel=android_app&timestamp=<ms>&token=<token>"
               + "&version=1.145.0&/" + path)
SECRET = nFU9pbG8YQoAe1kFh+E7eyrdlSLglwEJeA0wwHB1j5o=
```

不带这个头时 `goods/scan/v2` 会返回 `{"code":-1,"msg":"版本过低，请升级APP后再使用"}`
（很容易误判成版本门禁）。带上后立刻正常返回业务数据。**timestamp 必须与 header 的
`timestamp` 完全一致**，token 必须非空，否则同样被拒。

调 `/goods/water/unlock` 时额外带 4 个请求头（官方 `HeadInterceptor` 从 header 取这些值算风控签名
`orderRiskSign`，不发可能被风控拒）：

```
categoryCode: 04
imei: <设备编号>
lat: <纬度>
lng: <经度>
```

客户端实现：Android 用 `LocationManager.getLastKnownLocation`（不主动申请权限，未授权时发 `0.0`），
PWA 用一次 `navigator.geolocation.getCurrentPosition` 并缓存到 localStorage。

## 接口链路

```
goods/scan/v2            SN|IMEI|NQT      → id(goodsId), categoryCode, shopId
goods/latestUsed         categoryCode=04  → goodsId, goodsName, orgName（不需要扫码的备用入口）
goods/normal/details     goodsId          → imei, name, shopId, isBluetooth, orgName
goods/normal/skus        goodsId          → skuId, name, extAttr.level[0].price
waterQuota/getActive     shopId,categoryCode → show, text（水卡/额度文案）
payChannelRoute/addUserAfterPayChannel  method  → 登记后付费渠道（接水前必调，见下）
goods/water/unlock       skuId,promotions,payType=15 → msgId, orderNo
goods/water/sync         skuId            → workStatus(2=运行中), amount, identify
goods/endWater           goodsId          → 停水
order/afterPay/creating  orderNo          → orderId, orderStatus, payType
order/sync               orderNo,payType  → code=="0" 才算支付完成（关键，见下）
order/detail             orderId          → waterUse.waterUseValueDesc, tradeOrderItem[].originPrice, payPrice, promotionList[]
```

> **接水前必须调 `payChannelRoute/addUserAfterPayChannel`（`method=15`）**。
> 官方 `AfterPayVm.setAfterPayChannel()` 在 `AfterPayUseAct.useBtnClick()` 里先登记渠道再解锁：
> `mapOf("method" to String.valueOf(PayTypeEnum.ALIPAY_NOT_PASSWORD.getType()))` →
> `ApiService.addAfterPayChannel` → `POST payChannelRoute/addUserAfterPayChannel`。
> 不登记直接用 `payType=15` unlock 的后果：支付宝侧仍会按「通用小票」结算，而不是账号已签约的
> 「企鹅共享小额免密支付」，订单状态也不会推进。

> **`order/sync` 是必须的一步，漏了订单会一直挂在「待支付」**。
> 官方 `StartStatusAct.createObserver$lambda$14` 拿到 `AfterPay` 后判断：
> `orderStatus == 2`（已完成）→ 直接进订单详情；**否则 `PayStateAct.startAction(..., mState=1)`**，
> 而 `PayStateAct.initData()` 在 `mState == 1` 且品类是饮水/淋浴时调的就是
> `orderSync(orderNo, payType)`（`PayStateVm$orderSync$1` → `ApiService.orderSync` → `POST order/sync`）。
> 返回实体的 `code` 字段为 `"0"` 时才 `showState(3)`（「后付费支付成功页」）。
>
> 少了这一步的现象：水票确实扣了、支付宝也推了扣款通知，但胖乖侧订单状态没推进，
> 官方 App「待支付」里留着一条「需付款 ¥0.00」的单子，**下次接水会被它挡住**，
> 必须在官方 App 里手动点一次「立即支付」才能继续。
> 本项目在 `order/afterPay/creating` 之后、`order/detail` 之前补了 `order/sync`（最多重试 3 次）。

> **`goods/water/sync` 的 `amount` 不是金额**，不要除以 100 当钱显示（实测接 0.2L 时它返回 `76`，
> 而真实原价是 ¥0.04）。官方 `DeviceStartupAct.createObserver$lambda$38` 只用它做判断：
> `amount` 非空且 `>0` 且有 `identify` 时才调 `afterPay(identify)`，从不展示给用户。
>
> 正确的结算字段来自 `order/detail`：水量用 `waterUse.waterUseValueDesc`（已带单位，按
> `waterUseType==1` 显示「用水量」否则「用水时长」），金额用 `tradeOrderItem[].originPrice`
> 求和 + `promotionList[].discountAmount` 抵扣 + `payPrice`（实付）。本项目按此实现。

> `goods/scan/v2` 的键名因机器而异：**实测某些设备只有 `SN` 能查到**，同一台设备的 imei
> 用它查返回 `4000 设备未绑定`，用 `SN` 查才返回 `code:0`。客户端因此会依次尝试
> `SN` / `IMEI` / `NQT`，任一成功即止。

> **单价不要读 `Sku.price` / `Sku.unit`**：`unit` 实际是出水量之类（实测值 `"2.3"`），
> `price` 是 `"1.00"`。官方 `WaterSkuAdapter.convert()` 的算法是取
> `extAttr.level[0].price` + `"元/L"`（按流量计）或 `"元/秒"`，并显示 `extAttr.baseFare`
> 起步价与 `minCount` 最低量。本项目按此实现。

`promotions` 固定三段（与官方一致）：

```json
[{"assetId":"0","oldPromotionId":"","orgId":"0","promotionId":"0","promotionType":"-6"},
 {"assetId":"0","oldPromotionId":"","orgId":"0","promotionId":"0","promotionType":"-7"},
 {"assetId":"0","oldPromotionId":"0","orgId":"0","promotionId":"0","promotionType":"8"}]
```

## 构建 APK

不需要 Gradle。`build.sh` 直接用 aapt2 + javac + d8 + apksigner：

```bash
# 依赖：JDK17、Android SDK build-tools 34、platforms/android-34、zxing-core-3.5.3.jar
bash build.sh          # → apk/jieshui.apk

# mock 版（仅 UI 验证，不联网）
python tools/make_test.py && bash build_test.sh   # → apk/jieshui-test.apk
```

`tools/make_test.py` 会自动把 `android/` 复制成 `android_test/` 并注入 mock，**不要手改 `android_test/`**，
否则它会与真源码漂移（踩过坑：加了新接口后 mock 版少了对应桩，点按钮直接崩）。

脚本里 `JDK` / `SDK` / `ZXING` 三个路径按本机实际情况改。

> **bash 坑**：不要把 `D:/...` 这类 Windows 盘符直接拼进 `$PATH`，`D:` 会被当成路径分隔符导致 `javac: command not found`。用 `/d/...` 或绝对路径调用。

## 部署 PWA

**已上线： <https://jieshui.pages.dev>**（Cloudflare Pages，响应头级 CSP 全部生效）

```bash
bash tools/deploy.sh            # 生成 _headers 并发到 Cloudflare Pages
```

### Cloudflare Pages

项目名 `jieshui`（想部署自己的副本就换成你自己的，或用 `PAGES_PROJECT=xxx bash tools/deploy.sh`）。
凭据来自 `npx wrangler login`，存在 wrangler 自己的配置目录里，**不需要 `CLOUDFLARE_API_TOKEN`**。

`wrangler.jsonc` 必须是 Pages 形态：

```jsonc
{
  "name": "jieshui",
  "compatibility_date": "2025-01-01",
  "pages_build_output_dir": "./web"
}
```

> 踩过的坑：Pages 模式**不支持 `assets` 字段**（那是 Workers 静态资源写法），写了会报
> `Configuration file for Pages projects does not support "assets"`；只有 `pages_build_output_dir` 才对。
> 另外首次部署前得先 `npx wrangler pages project create jieshui --production-branch=main`，
> 否则报 `The Pages project "jieshui" does not exist`。

线上实测的响应头（`curl -sI https://jieshui.pages.dev/`）：

```
content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; …; frame-ancestors 'none'
strict-transport-security: max-age=31536000; includeSubDomains
x-frame-options: DENY
referrer-policy: no-referrer
permissions-policy: geolocation=(self), camera=(self), microphone=(), payment=(), usb=()
cross-origin-opener-policy: same-origin
cross-origin-resource-policy: same-origin
cache-control: no-cache            ← 首页与 sw.js，避免用户卡在旧版本
```

404 由 `web/404.html`（标题「页面不存在」）接管，`/debug.html` 之类不会回落到主页。

> **早先用过 surge.sh，已全部下线。** 它不支持 `_headers`（CSP 只有 meta 版、缺 `frame-ancestors`），
> 且实测比 Cloudflare 慢约 2.5 倍、抖动大。三个域名（`jieshui.surge.sh`、`jieshui-qk.surge.sh`、
> `hdr-test-qk.surge.sh`）都已 `surge teardown`，现在访问返回 404。

**Service Worker 缓存策略**：`web/sw.js` 对 `html/js/css/webmanifest` 走 **network-first**，
图片字体走 cache-first。之前是全局 cache-first，导致部署新版后手机上还是旧界面
（用户反馈"Token 界面还在"就是这个原因）。改版时记得同步升 `CACHE` 版本号（当前 `qk-v8`）。

> 用了 network-first 之后，新版本在**普通刷新**（甚至只是重新打开）时就会生效，不需要清缓存。
> 若用户仍看到旧界面，多半是 PWA 被"添加到主屏幕"后从独立窗口启动、且该实例的 SW 尚未接管——
> 关掉再开一次即可。

换其它托管也随时可以，`web/` 里全是静态文件，API 侧 CORS 全开（已实测 `https://jieshui.pages.dev` 这个 Origin 的
preflight 会回显 `Access-Control-Allow-Origin` 与全部自定义头），无需后端代理：

```bash
npx wrangler pages deploy --commit-dirty=true   # 读 wrangler.jsonc 的 pages_build_output_dir
```

> **必须是 HTTPS 或 localhost**，否则浏览器不授予摄像头权限，扫码功能不可用。

## 目录

```
android/          原生 APK 源码（Java，9 个文件，含 Secure.java）
android_test/     自动生成的 mock 副本（勿手改，源在 tools/make_test.py）
web/              PWA（index.html / app.js / style.css / jsQR.js / sw.js）
apk/              构建产物（jieshui.apk 真实版 / jieshui-test.apk mock 版）
build.sh          APK 构建脚本
build_test.sh     mock 版构建脚本
tools/            开发辅助
  ├ probe_chain.py      用真实 token 跑只读全链路验证
  ├ token_from_mmkv.sh  从设备里读 token
  ├ mmkv_token.py       MMKV 解析
  ├ deploy.sh           部署 PWA 到 Cloudflare Pages（先跑 gen_headers.py）
  ├ gen_headers.py      生成 Cloudflare Pages 的 web/_headers（响应头版 CSP/HSTS 等）
  ├ make_test.py        生成 mock 副本
  ├ debug.html          诊断页（不发布，只在本机 python -m http.server 打开）
  ├ flow_repeat.js      连续接水回归：水停后按钮必须立刻变「结算中…」，结算完按返回回首页
  ├ flow_auto.js        扫码即开阀：没点任何按钮就下发 unlock，等待期不结算，按开始后才计量
  ├ flow_auto_cancel.js 等待期点「取消」：要能真的退出，且不产生空订单
  ├ flow_edge.js        边界回归：结算后返回/等待期返回/unlock 失败重试/等待期掉登录/取消后重扫
  ├ flow_edge2.js       恶性 bug 回归：建单失败、始终扣款失败、断网、等待期换机器（含停水对象）
  ├ flow_scan.js        扫码解码回归：同一张二维码在画面里变小，各档缩放下能否认出
  ├ flow_scan_e2e.js    扫码端到端：合成画面喂给真实 tickScan，要走完到设备页
  ├ flow_camera.js      取景几何：横/竖两种摄像头流下 object-fit 各裁掉多少
  ├ flow_frame2.js      取景几何：四种流下取景框与 video 元素必须完全重合
  ├ flow_roi3.js        竖屏流端到端：码只占取景窗 14% 时能否扫出来
  ├ flow_caps.js        摄像头能力探测：不同 constraints 实际拿到什么分辨率
  ├ ScanRoiTest.java    APK 解码回归（JVM 直跑 zxing）：整幅 vs 取景框方块，含耗时与限流兜底
  ├ flow_perf.js        解码开销：各尺寸下 jsQR 每帧耗时，用来定降频阈值
  └ cdp.js / flow_*.js  无头浏览器截图与流程验证
ref/              参考实现（wzs0512/qiekj-android 的关键文件，仅作比对）
shots/            界面截图（不入仓库，宣传图在 docs/img/）
```

## 说明

个人自用项目，仅复用自己账号已有的水卡与免密签约，不涉及任何账号共享、代刷或余额篡改。
所有金额、优惠、订单均由服务端计算，客户端只负责把用户的操作翻译成既有接口调用。
若官方接口或风控策略变更，本项目可能需要同步调整。

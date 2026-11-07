/* =========================================================
   接水 · 精简客户端
   接口：https://userapi.qiekj.com/
   ========================================================= */
'use strict';

const BASE = 'https://userapi.qiekj.com/';
const APP_VERSION = '1.145.0';
const UA = 'okhttp/3.14.9';
const PROMOTIONS = '[{"assetId":"0","oldPromotionId":"","orgId":"0","promotionId":"0","promotionType":"-6"},{"assetId":"0","oldPromotionId":"","orgId":"0","promotionId":"0","promotionType":"-7"},{"assetId":"0","oldPromotionId":"0","orgId":"0","promotionId":"0","promotionType":"8"}]';
// goods/water/sync 的 workStatus：0 = 阀已开但用户还没按机器上的「开始」，2 = 正在出水。
const WORK_IDLE = 0;
const WORK_RUNNING = 2;

/* ---------------- 存储 ----------------
 * token 默认只放内存（sessionStorage 也不放）：
 *   - localStorage 里的东西任何一个 XSS、恶意浏览器插件、共享设备上的下一个用户都能直接读走；
 *   - 相比之下「关掉标签页就要重新登录」的代价很小 —— 登录态本来就只值几分钟一次操作。
 * 需要跨标签页/重开还在的话，用户在设置里勾「记住登录」才落到 localStorage。
 * 两处都加了同源校验：token 只在当前 origin 有效，被复制到别处也用不了（服务端还会校验 sign）。
 */
const LS_TOKEN = 'qk_token';
const SS_TOKEN = 'qk_token_session';
const LS_REMEMBER = 'qk_remember';

let memToken = '';

const Store = {
  /* 默认「记住」：以前默认不记住，结果每次重开都要重新登录，而设置里那个开关
     几乎没人发现。现在登录页第一屏就能看到并改掉它（公用设备请取消勾选）。
     一旦用户显式选过，就以存下来的值为准。 */
  get remember() {
    const v = localStorage.getItem(LS_REMEMBER);
    return v === null ? true : v === '1';
  },
  set remember(v) {
    // 必须写 '0' 而不是删掉这个键 —— 删掉会退回「默认记住」，
    // 用户明明取消勾选了，下次打开却又被记住了。
    localStorage.setItem(LS_REMEMBER, v ? '1' : '0');
    // 关掉「记住登录」时，把已经落盘的 token 立刻清掉（内存里那份留着，别当场踢下线）
    if (!v) localStorage.removeItem(LS_TOKEN);
  },
  get token() {
    if (memToken) return memToken;
    try {
      memToken = sessionStorage.getItem(SS_TOKEN) || localStorage.getItem(LS_TOKEN) || '';
    } catch (_) { memToken = ''; }
    return memToken;
  },
  set token(v) {
    memToken = v || '';
    try {
      if (!memToken) {
        sessionStorage.removeItem(SS_TOKEN);
        localStorage.removeItem(LS_TOKEN);
        return;
      }
      // 勾了「记住登录」才写 localStorage，否则只写 sessionStorage（关标签页即失效）
      sessionStorage.setItem(SS_TOKEN, memToken);
      if (Store.remember) localStorage.setItem(LS_TOKEN, memToken);
      else localStorage.removeItem(LS_TOKEN);
    } catch (_) { /* 隐私模式下 storage 可能不可用，退化为纯内存 */ }
  },
  get phone() { return localStorage.getItem('qk_phone') || ''; },
  set phone(v) { v ? localStorage.setItem('qk_phone', v) : localStorage.removeItem('qk_phone'); },
  get devices() { try { return JSON.parse(localStorage.getItem('qk_devices') || '[]'); } catch { return []; } },
  set devices(v) { localStorage.setItem('qk_devices', JSON.stringify(v.slice(0, 12))); },
  /* PayTypeEnum 里 ALIPAY_NOT_PASSWORD 的 type 是 15（不是 ordinal 1）。
     传错值会让服务端把它当「支付宝直扣/通用小票」，而不是已签约的
     「企鹅共享小额免密支付」，结果是：水票被扣了、但订单在胖乖侧仍是待支付。 */
  get payType() { const v = localStorage.getItem('qk_paytype'); return v === null ? '15' : v; },
  set payType(v) { localStorage.setItem('qk_paytype', v); },
  /* 默认关闭：登录后直接弹相机容易打断人，用户可在设置里打开 */
  get autoStart() { return localStorage.getItem('qk_auto') === '1'; },
  set autoStart(v) { localStorage.setItem('qk_auto', v ? '1' : '0'); },
  /* 官方 /goods/water/unlock 的风控签名含 lat/lng，缓存上次拿到的位置 */
  get geo() {
    try { return JSON.parse(localStorage.getItem('qk_geo') || 'null') || { lat: 0, lng: 0 }; }
    catch { return { lat: 0, lng: 0 }; }
  },
  set geo(v) { if (v && v.lat != null) localStorage.setItem('qk_geo', JSON.stringify(v)); },
  addDevice(d) {
    const list = Store.devices.filter(x => (x.goodsId || x.imei) !== (d.goodsId || d.imei));
    list.unshift(d);
    Store.devices = list;
  }
};

/* ---------------- 网络 ---------------- */
class ApiError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

/* 官方 HeadInterceptor 的签名密钥（Base64 常量解码后的明文） */
const APP_SECRET = 'nFU9pbG8YQoAe1kFh+E7eyrdlSLglwEJeA0wwHB1j5o=';

/* 纯 JS SHA-256（http:// 局域网访问时没有 crypto.subtle，用它兜底） */
const SHA256 = (() => {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  return function (msg) {
    const bytes = new TextEncoder().encode(msg);
    const bitLen = bytes.length * 8;
    const withPad = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    withPad.set(bytes);
    withPad[bytes.length] = 0x80;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 4, bitLen >>> 0);
    dv.setUint32(withPad.length - 8, Math.floor(bitLen / 4294967296));
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    for (let off = 0; off < withPad.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [(H[0] + a) >>> 0, (H[1] + b) >>> 0, (H[2] + c) >>> 0, (H[3] + d) >>> 0,
           (H[4] + e) >>> 0, (H[5] + f) >>> 0, (H[6] + g) >>> 0, (H[7] + h) >>> 0];
    }
    return H.map(x => x.toString(16).padStart(8, '0')).join('');
  };
})();

/** 请求头 sign：SHA-256(appSecret=..&channel=android_app&timestamp=..&token=..&version=..&/<path>) */
function sign(path, ts, token) {
  return SHA256('appSecret=' + APP_SECRET
    + '&channel=android_app'
    + '&timestamp=' + ts
    + '&token=' + (token || '')
    + '&version=' + APP_VERSION
    + '&/' + path);
}

async function api(path, params = {}, { auth = true, timeout = 20000, extraHeaders = null } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    body.append(k, String(v));
  }
  if (auth && Store.token) body.append('token', Store.token);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const ts = String(Date.now());
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'Version': APP_VERSION,
    'channel': 'android_app',
    'phoneBrand': 'Redmi',
    'User-Agent': UA,
    'timestamp': ts,
    // 官方 HeadInterceptor 的请求签名；不签会被服务端当成旧版本客户端拒掉。
    'sign': sign(path, ts, auth ? Store.token : ''),
    'Accept': 'application/json, text/plain, */*'
  };
  if (auth && Store.token) {
    headers['Authorization'] = Store.token;
    headers['token'] = Store.token;
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v !== undefined && v !== null && v !== '') headers[k] = String(v);
    }
  }

  let res;
  try {
    res = await fetch(BASE + path, { method: 'POST', headers, body: body.toString(), signal: ctrl.signal, mode: 'cors' });
  } catch (e) {
    clearTimeout(timer);
    throw new ApiError(e.name === 'AbortError' ? '网络超时' : '网络连接失败', -99);
  }
  clearTimeout(timer);

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new ApiError('服务器返回异常（' + res.status + '）', res.status); }

  if (json.code !== undefined && json.code !== 0) {
    if (json.code === 2) { sessionExpired(); }
    throw new ApiError(json.msg || json.message || ('错误码 ' + json.code), json.code);
  }
  return json.data;
}

/**
 * 登录态失效：token 被服务端判为未登录。
 * 之前这里只清空 token，界面继续停在设备页并显示「该设备暂无可用计费方式」，
 * 用户完全不知道是自己掉登录了。现在直接回登录页并说明原因。
 */
let sessionExpiredAt = 0;
function sessionExpired() {
  Store.token = '';
  const now = Date.now();
  if (now - sessionExpiredAt < 1500) return;   // 并发请求只提示一次
  sessionExpiredAt = now;
  $('#app').classList.add('hidden');
  $('#settings').classList.add('hidden');
  $('#scanner').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  /* 设置里残留的 token / 账号也要一起清掉，否则回到登录页后抽屉里还显示旧信息 */
  const st = $('#setToken'); if (st) st.textContent = '—';
  const tf = $('#tokenFull'); if (tf) tf.value = '';
  const tfb = $('#tokenFullBox'); if (tfb) tfb.classList.add('hidden');
  const box = $('#gateMsg');
  if (box) {
    box.textContent = '登录已过期，请重新登录';
    box.classList.remove('hidden');
  }
  toast('登录已过期，请重新登录', true);
}

/* ---------------- UI 基础 ---------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let toastTimer;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// 屏内导航会往 history 里压一条记录，浏览器/手机返回键才有的可退。
// navGuard 用来避免 popstate 处理里再压一条把用户困在页面里。
let navGuard = false;

function show(screenId) {
  ['home', 'device', 'result'].forEach(id => {
    const el = $('#' + id);
    if (el) el.classList.toggle('hidden', id !== screenId);
  });
  if (navGuard) return;
  const cur = (history.state && history.state.qk) || null;
  if (cur === screenId) return;
  // 首次进页面用 replace，别让用户按一次返回才退得出去
  if (!history.state) history.replaceState({ qk: screenId }, '');
  else history.pushState({ qk: screenId }, '');
}

/**
 * 离开设备页回到首页。
 *
 * 等待期（已开阀、但用户还没在机器上按「开始」）是允许离开的：
 * 这时候一滴水都没出，把用户困在页面上等 90 秒没有任何意义。
 * 后台那一轮会看到 stopRequested，自己停水、并且不生成订单。
 */
function leaveDevice() {
  if (busy && !watering) stopRequested = true;
  show('home');
  current = null;
}

// 浏览器/手机返回键：往回收一层，最终回到首页（需要再接水就在首页点扫码）。
// 不把「回设备页」当默认动作 —— 结算完用户想的是结束这次接水，不是接着开第二次。
window.addEventListener('popstate', () => {
  // 水正在流时不允许离开设备页：界面没了就没法停水，纯属坑人。
  // 注意判断的是 watering 而不是 busy —— busy 还包含开阀后的等待期，
  // 那段时间水一滴都没出，把用户锁在页面上 90 秒毫无道理。
  if (watering && !$('#device').classList.contains('hidden')) {
    history.pushState({ qk: 'device' }, '');
    toast('接水中，请先结束接水', true);
    return;
  }
  const st = (history.state && history.state.qk) || 'home';
  navGuard = true;
  try {
    if (st === 'result') {
      show('result');
    } else {
      leaveDevice();
    }
  } finally {
    navGuard = false;
  }
});

/* ---------------- 登录 ---------------- */
let countdown = 0, cdTimer;

async function sendCode() {
  const phone = $('#phone').value.trim();
  if (!/^1\d{10}$/.test(phone)) return toast('请输入正确的手机号', true);
  const btn = $('#sendCode');
  btn.disabled = true;
  try {
    await api('common/sms/sendCode', { phone, template: 'reg' }, { auth: false });
    toast('验证码已发送');
    countdown = 60;
    tick();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

function tick() {
  const btn = $('#sendCode');
  clearInterval(cdTimer);
  const run = () => {
    if (countdown <= 0) { btn.disabled = false; btn.textContent = '获取'; clearInterval(cdTimer); return; }
    btn.textContent = countdown + 's';
    countdown--;
  };
  run();
  cdTimer = setInterval(run, 1000);
}

async function doLogin() {
  const phone = $('#phone').value.trim();
  const code = $('#code').value.trim();
  if (!/^1\d{10}$/.test(phone)) return toast('请输入正确的手机号', true);
  if (code.length < 4) return toast('请输入验证码', true);
  const btn = $('#doLogin');
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const data = await api('user/reg', { channel: 'android_app', phone, verify: code }, { auth: false });
    const token = data && data.token;
    if (!token) {
      if (data && data.forcedBind) {
        throw new ApiError('该手机号需先在官方 App 里绑定微信或支付宝，绑完再用「粘贴 Token」登录');
      }
      throw new ApiError('登录失败：服务器未返回 token');
    }
    // 必须先落「记住登录」的选择，再写 token —— Store.token 的 setter 靠它
    // 决定写 localStorage 还是只写 sessionStorage。
    applyRememberChoice();
    Store.token = token;
    Store.phone = phone;
    enterApp();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = '登录';
  }
}

/** 把登录页那个「记住登录」勾选框的结果落盘，并同步设置页里的同名开关。 */
function applyRememberChoice() {
  const g = $('#rememberGate');
  if (!g) return;
  Store.remember = !!g.checked;
  const rb = $('#remember');
  if (rb) rb.checked = !!g.checked;
}

function useToken() {
  const t = $('#tokenInput').value.trim();
  if (t.length < 10) return toast('Token 看起来不正确', true);
  applyRememberChoice();
  Store.token = t;
  enterApp();
}

function enterApp() {
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const gm = $('#gateMsg');
  if (gm) gm.classList.add('hidden');
  $('#setPhone').textContent = Store.phone || '—';
  $('#setToken').textContent = Store.token ? Store.token.slice(0, 10) + '…' + Store.token.slice(-6) : '—';
  const tf = $('#tokenFull');
  if (tf) tf.value = Store.token || '';
  const tfb = $('#tokenFullBox');
  if (tfb) tfb.classList.add('hidden');
  $('#payTypeSel').value = Store.payType;
  $('#autoStart').checked = Store.autoStart;
  const rb = $('#remember');
  if (rb) rb.checked = Store.remember;
  const rg = $('#rememberGate');
  if (rg) rg.checked = Store.remember;
  renderDevices();
  refreshQuotaBadge();
  cacheGeo();
  if (Store.autoStart) setTimeout(() => { if (!scanning) openScanner().catch(() => { }); }, 260);
}

/**
 * 官方 /goods/water/unlock 的风控签名包含 lat/lng。
 * 浏览器里只能靠 geolocation；用户拒绝或超时就保持上次缓存值（初始 0/0），不阻塞任何流程。
 */
function cacheGeo() {
  if (!navigator.geolocation) return;
  try {
    navigator.geolocation.getCurrentPosition(
      (p) => { Store.geo = { lat: p.coords.latitude, lng: p.coords.longitude }; },
      () => { },
      { timeout: 6000, maximumAge: 600000, enableHighAccuracy: false }
    );
  } catch (_) { }
}

function logout() {
  Store.token = '';
  Store.phone = '';
  $('#app').classList.add('hidden');
  $('#settings').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  const gm = $('#gateMsg');
  if (gm) gm.classList.add('hidden');
}

/* ---------------- 设备列表 ---------------- */
function renderDevices() {
  const list = Store.devices;
  const box = $('#deviceList');
  if (!list.length) { box.innerHTML = '<div class="empty">暂无记录，扫码后会出现在这里</div>'; return; }
  box.innerHTML = '';
  list.forEach(d => {
    const b = document.createElement('button');
    b.className = 'device';
    b.innerHTML = `<div class="d-ico">💧</div>
      <div class="d-main">
        <div class="d-name">${escapeHtml(d.name || '饮水机')}</div>
        <div class="d-sub">${escapeHtml(d.shopName || d.imei || d.goodsId || '')}</div>
      </div>`;
    b.onclick = () => openDevice({ goodsId: d.goodsId, name: d.name, shopId: d.shopId, imei: d.imei, categoryCode: d.categoryCode });
    box.appendChild(b);
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 从账号拉取最近使用过的饮水机（scan/v2 被风控拦时的备用入口） */
async function syncDevices() {
  const btn = $('#btnRefreshDevices');
  const old = btn.textContent;
  btn.textContent = '同步中…';
  btn.disabled = true;
  try {
    const arr = await api('goods/latestUsed', { categoryCode: '04' });
    if (!Array.isArray(arr) || !arr.length) { toast('账号里还没有饮水机记录'); return; }
    let n = 0;
    arr.forEach(o => {
      if (!o || !o.goodsId) return;
      Store.addDevice({
        goodsId: String(o.goodsId),
        name: o.goodsName || '饮水机',
        shopId: o.orgId || '',
        imei: '',
        categoryCode: o.categoryCode || '04',
        shopName: o.orgName || o.parentPointName || ''
      });
      n++;
    });
    renderDevices();
    toast('已同步 ' + n + ' 台设备');
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

/* ---------------- 水卡 / 额度 ---------------- */
async function refreshQuotaBadge() {
  const badge = $('#quotaBadge');
  // 先清空文字再隐藏：只 add('hidden') 的话，重新登录前若样式被改回来会残留旧金额。
  badge.textContent = '';
  badge.classList.add('hidden');
  try {
    const b = await api('user/balance', {});
    if (b && b.tokenCoin !== undefined && b.tokenCoin !== null) {
      const yuan = (Number(b.tokenCoin) / 100);
      if (!isNaN(yuan) && yuan > 0) {
        badge.textContent = '小票 ¥' + yuan.toFixed(2);
        badge.classList.remove('hidden');
      }
    }
  } catch (_) { /* code===2 已由 api() 里的 sessionExpired() 处理 */ }
}

/* ---------------- 扫码 ---------------- */
let stream = null, rafId = 0, scanning = false;

async function openScanner() {
  const box = $('#scanner');
  box.classList.remove('hidden');
  scanning = true;
  let s = null;
  // 逐步降级：先用最理想的条件，失败/不支持就退到更宽松的一组。
  // 有些安卓机（OPPO/vivo 的不少机型）对 facingMode 做精确匹配会直接报错，
  // 所以这里从"精确"一路退到"随便给我个摄像头"。
  //
  // 分辨率尽量要高，而且要**同时给 width 和 height**：
  // 实测（tools/flow_caps.js）只给 width 时，Chrome 会给一路 1280x720 的 16:9，
  // 正方形取景窗只能从里面取到 720px；写成 1920x1440 则给到 4:3 的 1920x1440，
  // 取景窗能取到 1440px 原生像素 —— 边长的像素翻倍。
  // 而"能扫多远"直接取决于码在取景窗里占多少像素（tools/flow_caps.js：
  // 同样是码占 12%，720 的流失败、1440 的流成功），所以这一句对灵敏度影响最大。
  // 用 ideal 而不是 exact，设备不支持就自动退到它能给的最佳档，不会报错。
  const tries = [
    { video: { facingMode: { exact: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false },
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false },
    { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    { video: { facingMode: 'environment' }, audio: false },
    { video: true, audio: false }
  ];
  for (const c of tries) {
    try { s = await navigator.mediaDevices.getUserMedia(c); break; } catch (_) { }
  }
  if (!s) {
    closeScanner();
    toast('无法打开摄像头，请允许权限或手动输入', true);
    return;
  }
  stream = s;

  // 连续对焦 + 重置数码变焦。
  // 很多安卓机在网页里的摄像头默认不是连续对焦，凑近反而糊；
  // 也有机型会带一个非 1 的默认变焦（看起来就是"自己放大了"）。
  const track = s.getVideoTracks()[0];
  if (track) {
    // 有些机型（尤其是选了高分辨率之后）首帧是 640x480 之类的低档，
    // 拿到流之后再抬一次分辨率，比一次到位更可靠（tools/flow_caps.js：
    // video:true 拿到 640x480，applyConstraints 之后变成 1920x1440）。
    try {
      await track.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1440 } });
    } catch (_) { }
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (_) { }
    // 数码变焦归位 —— 但"1"在不同机型上不是一个意思：
    // 有的机型 zoom 是个比例（1 = 不放大），有的机型是一段区间（例如 100~400），
    // 直接写 zoom:1 会被夹到区间下限，某些机器上那正好是 2 倍起跳；
    // 反过来，写死 1 在这些机器上又完全不起作用。
    // 所以先读 capabilities 的真实区间，取"最小倍率"—— 那永远是这颗镜头的光学基准。
    // 用户反馈里"我和同学的手机变焦倍数明显不一样"，根因就是这里没做归一化。
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : null;
      const z = caps && caps.zoom;
      if (z && typeof z.min === 'number') {
        await track.applyConstraints({ advanced: [{ zoom: z.min }] });
      } else {
        await track.applyConstraints({ advanced: [{ zoom: 1 }] });
      }
    } catch (_) { }
  }

  const video = $('#video');
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  await video.play().catch(() => {});
  // 垫底的模糊背景用同一路流，只是铺满屏幕当氛围，不参与识别
  const bg = $('#bgvideo');
  if (bg) { bg.srcObject = stream; bg.play().catch(() => {}); }

  // 点画面立即拍一张识别（远处小码时最管用）
  video.onclick = () => { photoTick = 0; photoDelayMs = 1600; grabPhoto(); };
  scanStartAt = performance.now();

  // 等第一帧出来才知道视频的真实宽高，布局要依赖它
  await new Promise(res => {
    if (video.videoWidth) return res();
    const on = () => { video.removeEventListener('loadedmetadata', on); res(); };
    video.addEventListener('loadedmetadata', on);
    setTimeout(res, 1500);
  });
  layoutScanFrame();
  window.addEventListener('resize', layoutScanFrame);
  window.addEventListener('orientationchange', layoutScanFrame);

  tickScan();
}

/* 取景框的位置和大小按**视频画面在屏幕上的真实矩形**算，而且解码范围就是整幅画面。

   这里踩过的三个坑，都是"看到的不等于认的"造成的：
   1) 全屏 cover + 解整幅压到 480：cover 把画面放大 3.85 倍，用户以为离得太近往后退，
      越退码越小；而解码那边又把整幅缩到 480，远处的小码只剩十几个像素。
   2) video 缩成小正方形只显示框内：不裁了，但框外全黑，看着像相机坏了。
   3) contain + 固定尺寸方框：画面只占中间一条细带，方框比它还高，
      框的上下落在黑边上 —— 用户照框去对，码其实出画面了。

   现在的原则只有一条：**屏幕上能看见的，就是能被识别的**。
   画面按原始比例整幅显示（不裁不放大），解码也取整幅，取景框只是画在画面中央的准星，
   尺寸严格按画面矩形的短边算，不可能超出画面。 */
function layoutScanFrame() {
  const video = $('#video');
  if (!video) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) { scanROI = null; return; }

  // object-fit:contain 之后，画面在屏幕上的实际矩形（可能上下或左右留黑边）
  const boxW = video.clientWidth || innerWidth;
  const boxH = video.clientHeight || innerHeight;
  const scale = Math.min(boxW / vw, boxH / vh);
  const dw = vw * scale, dh = vh * scale;
  const left = (boxW - dw) / 2, top = (boxH - dh) / 2;   // 相对 video 元素

  // 准星：画面短边的 62%，再夹在 160~340 之间。
  // 只做视觉引导，不参与裁剪，所以不需要和任何解码区域对齐。
  const side = Math.max(160, Math.min(Math.round(Math.min(dw, dh) * 0.62), 340));
  const fr = $('.scan-frame');
  if (fr) {
    const vr = video.getBoundingClientRect();
    fr.style.width = side + 'px';
    fr.style.height = side + 'px';
    fr.style.left = (vr.left + left + (dw - side) / 2) + 'px';
    fr.style.top = (vr.top + top + (dh - side) / 2) + 'px';
    fr.style.transform = 'none';
  }

  // 解码范围 = 整幅原生帧。既然画面是整幅显示的，就没有任何理由只解中间一块：
  // 只解中间等于把画面四角能看见的码主动丢掉。
  scanROI = { x: 0, y: 0, w: vw, h: vh };
  window.__scanROI = scanROI;   // 仅供 tools/flow_frame2.js 断言

  // 记下画面矩形，兜底拍照时要用它把码的位置映射回原生像素
  window.__scanRect = { left: left, top: top, w: dw, h: dh, vw: vw, vh: vh };
}
let scanROI = null;

function closeScanner() {
  scanning = false;
  cancelAnimationFrame(rafId);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  window.removeEventListener('resize', layoutScanFrame);
  window.removeEventListener('orientationchange', layoutScanFrame);
  scanROI = null;
  // 每次重开都要重新评估性能，别把上一次的降频状态带过来
  scanCost = 0; scanTickCost = 0; scanDowngraded = false;
  $('#scanner').classList.add('hidden');
}

let scanTick = 0;
let frameNo = 0;           // 每一帧都加一（含被跳过的帧）
let scanCost = 0;          // 单次解码的滑动平均耗时（ms），用来决定是否降频
let scanTickCost = 0;      // 累计解码次数（用来判断"跑了一会儿了"）
let scanDowngraded = false; // 已经为低端机降过分辨率

/* 原生条码识别（Barcode Detection API）。
   Android 版 Chrome 从 83 起自带这个接口，底层是系统级的识别器 ——
   比 jsQR 快一个数量级，而且对模糊/倾斜/低对比的容忍度高得多。
   iOS Safari 目前不支持，桌面 Chrome 多数也不支持，所以只当增强：
   能用就用，不能用照旧走 jsQR，不影响任何现有行为。 */
let detector = null, detectorTried = false;
function getDetector() {
  if (detectorTried) return detector;
  detectorTried = true;
  try {
    if ('BarcodeDetector' in window) {
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch (_) { detector = null; }
  return detector;
}

async function tickScan() {
  if (!scanning) return;
  const video = $('#video');
  frameNo++;
  // 慢机自动降频：单次解码超过这个预算就每两帧才跑一次，
  // 免得把 rAF 拖死、预览卡成幻灯片（低端安卓上实测会到 50ms+）。
  const every = scanCost > 35 ? 2 : 1;
  if (every > 1 && frameNo % every !== 0) {
    rafId = requestAnimationFrame(tickScan);
    return;
  }
  if (video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR) {
    scanTick++;
    const t0 = performance.now();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh) {
      // 有些机型会在预览过程中切换分辨率（对焦完成、切广角），
      // 这时取景框的屏幕坐标就失效了，跟着重算一次。
      if (vw !== tickScan._vw || vh !== tickScan._vh) {
        tickScan._vw = vw; tickScan._vh = vh;
        layoutScanFrame();
      }
      const text = await decodeFrom(video, vw, vh, false);
      if (maybeHit(text)) return;

      // 连续预览扫了几秒还没结果 → 拍一张全分辨率照片再认。
      // 这是"远处 / 小码 / 有点糊"时真正管用的那一招，靠调预览参数是救不回来的。
      if (scanning && performance.now() - scanStartAt > photoDelayMs) {
        scanStartAt = performance.now();
        grabPhoto();
      }
    }
    const dt = performance.now() - t0;
    scanCost = scanCost ? scanCost * 0.8 + dt * 0.2 : dt;

    // 低端机保护：请求 1920x1440 之后，如果解码长期跟不上（老机型预览会卡），
    // 主动把摄像头降到 1280x720 —— 宁可少认一点点，也不能让预览卡成幻灯片。
    // 只降一次，降完不再回弹，避免反复抖动。
    scanTickCost++;
    if (!scanDowngraded && scanTickCost > 60 && scanCost > 60) {
      scanDowngraded = true;
      const tr = stream && stream.getVideoTracks()[0];
      if (tr) {
        try { await tr.applyConstraints({ width: { ideal: 1280 }, height: { ideal: 720 } }); } catch (_) { }
        photoDelayMs = 3000;   // 降了分辨率就更依赖拍照兜底，早点触发
      }
    }
  }
  rafId = requestAnimationFrame(tickScan);
}

/* 从一个可绘制源（video 或 ImageBitmap）解一帧。
   分两档尺度：先 720（快，绝大多数情况够），再 1280（远处小码靠这档，隔帧跑）。

   为什么不只解"取景框那一块"：因为画面现在整幅显示（不裁不放大），
   框只是画在中间的准星。只解中间等于把画面四角能看见的码主动丢掉 ——
   而用户看到那里有码，就会觉得"明明在画面里却扫不出来"。 */
async function decodeFrom(src, srcW, srcH, deep) {
  // 第 0 遍：原生 BarcodeDetector（安卓 Chrome 有）。
  // 它直接解原始画面、不用画 canvas，通常 1~3ms 出结果，
  // 而且对运动模糊、倾斜、低对比的容忍度远好于纯 JS 的 jsQR。
  const det = getDetector();
  if (det && det.detect) {
    try {
      const hits = await det.detect(src);
      if (!scanning) return null;
      if (hits && hits.length && hits[0].rawValue) return hits[0].rawValue;
    } catch (_) { /* 某些机型 detect 会抛，忽略，退回 jsQR */ }
  }

  const cv = tickScan._cv || (tickScan._cv = document.createElement('canvas'));
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  // 反色（深底亮码）很贵，只在少数帧上试。invertFirst 而不是 onlyInvert：
  // jsQR 的 inverted 矩阵只在 shouldInvert（attemptBoth / invertFirst）为真时
  // 才由 binarize 产出，用 onlyInvert 拿到的是 undefined，直接抛
  // "Cannot read properties of undefined (reading 'height')"。
  const inv = deep || frameNo % 4 === 0 ? 'invertFirst' : 'dontInvert';

  const passes = deep ? [1600, 1100, 720] : [720, 1280];
  for (let i = 0; i < passes.length; i++) {
    if (!deep && i === 1 && frameNo % 2 !== 0) break;   // 大档隔帧
    const cap = passes[i];
    const sc = Math.min(1, cap / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * sc)), h = Math.max(1, Math.round(srcH * sc));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    ctx.drawImage(src, 0, 0, w, h);
    const code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: inv });
    if (code && code.data) return code.data;
  }

  // 兜底：点阵二维码（码点分离、中间有亮缝）靠上面几遍一定认不出，
  // 必须先把缝隙用闭运算填上。这条和安卓端 ScanCore 里那条是同一套逻辑。
  // 贵（960 宽约 5~9ms），所以只在小档、隔帧跑，不影响正常扫码的手感。
  if ((deep || frameNo % 3 === 0) && srcW >= 600) {
    const tw = Math.min(960, Math.max(srcW, srcH));
    const sc2 = tw / Math.max(srcW, srcH);
    const w2 = Math.max(1, Math.round(srcW * sc2)), h2 = Math.max(1, Math.round(srcH * sc2));
    if (cv.width !== w2 || cv.height !== h2) { cv.width = w2; cv.height = h2; }
    ctx.drawImage(src, 0, 0, w2, h2);
    for (const r of [2, 3]) {
      const img = closedImageData(ctx, w2, h2, r);
      const hit = window.jsQR(img.data, w2, h2, { inversionAttempts: 'invertFirst' });
      if (hit && hit.data) return hit.data;
    }
  }
  return null;
}

function maybeHit(text) {
  if (!text) return false;
  closeScanner();
  if (navigator.vibrate) navigator.vibrate(40);
  handleScanned(text);
  return true;
}

/* 点阵二维码专修：形态学闭运算。
   饮水机屏幕上那种码，每个模块是一个分离的圆点，点与点之间留 1~2px 亮缝。
   人眼看着毫无问题，jsQR / ZXing 却连三个定位图形都找不到 —— 因为 finder 的
   1:1:3:1:1 扫线比例被缝隙切碎了。这不是"糊"，是"图案不连通"，所以调锐化、
   换阈值、多试几档缩放全部无效（都实测过）。闭运算把亮缝填上，模块重新连成
   实心方块，定位图形恢复正常比例。

   可分离写法（先横后竖），960 宽上 5~9ms；全尺寸做要 100~250ms，不值得。 */
function minFilter(src, w, h, r) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
      let mn = 255;
      for (let xx = lo; xx <= hi; xx++) { const v = src[base + xx]; if (v < mn) mn = v; }
      tmp[base + x] = mn;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
      let mn = 255;
      for (let yy = lo; yy <= hi; yy++) { const v = tmp[yy * w + x]; if (v < mn) mn = v; }
      out[y * w + x] = mn;
    }
  }
  return out;
}

function maxFilter(src, w, h, r) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r), hi = Math.min(w - 1, x + r);
      let mx = 0;
      for (let xx = lo; xx <= hi; xx++) { const v = src[base + xx]; if (v > mx) mx = v; }
      tmp[base + x] = mx;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r), hi = Math.min(h - 1, y + r);
      let mx = 0;
      for (let yy = lo; yy <= hi; yy++) { const v = tmp[yy * w + x]; if (v > mx) mx = v; }
      out[y * w + x] = mx;
    }
  }
  return out;
}

/** 取一块 canvas 画面的灰度，做闭运算，再写回成一份可喂给 jsQR 的 ImageData。 */
function closedImageData(ctx, w, h, r) {
  const img = ctx.getImageData(0, 0, w, h);
  const src = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < src.length; i++, p += 4) {
    src[i] = (img.data[p] * 77 + img.data[p + 1] * 150 + img.data[p + 2] * 29) >> 8;
  }
  const closed = maxFilter(minFilter(src, w, h, r), w, h, r);
  for (let i = 0, p = 0; i < closed.length; i++, p += 4) {
    const v = closed[i];
    img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v; img.data[p + 3] = 255;
  }
  return img;
}

function setScanHint(t) {
  const el = $('#scanHint');
  if (el && el.textContent !== t) el.textContent = t;
}

/* ---------------- 全分辨率拍照兜底 ----------------

   连续预览识别有两个天花板，靠调参数解决不了：

   1) 摄像头流的分辨率有限（多数安卓网页给到 1920x1440 就到顶），
      而"能扫多远"完全由码在画面里占多少像素决定。码占 8% 时，
      在 1440 的流里只有 115px，25 个模块摊下来 4.6px/模块 —— 非常勉强。
   2) 预览还要走对焦、压缩、跨进程传输，抖动和糊都会被放大。

   真正可靠的做法和系统相机一样：**拍一张全分辨率静态照片**再识别。
   同一个镜头，照片能到 4000x3000，比预览流多一个数量级的像素，
   识别距离是预览的好几倍，而且不受帧率限制，可以慢慢试多种尺度。

   所以：连续预览只负责"近处快扫"，几秒没结果就自动拍一张；
   用户也可以随时点画面手动触发。 */
let photoBusy = false, photoTick = 0, photoDelayMs = 2200;
let scanStartAt = 0;

async function grabPhoto() {
  if (!stream || photoBusy || !scanning) return;
  photoBusy = true;
  try {
    let bmp = null;
    const track = stream.getVideoTracks()[0];

    // 首选 ImageCapture：拿的是传感器全分辨率静态图，比预览帧大一个数量级。
    if (typeof window.ImageCapture === 'function' && track) {
      try {
        const ic = new window.ImageCapture(track);
        const blob = await ic.takePhoto();
        if (blob) bmp = await createImageBitmap(blob);
      } catch (_) { bmp = null; }
    }

    // 退路：把 video 的原生像素整幅画到 canvas（不缩放）
    if (!bmp) {
      const v = $('#video');
      if (v && v.videoWidth) bmp = await createImageBitmap(v).catch(() => null);
    }
    if (!bmp) return;

    const text = await decodeBitmapDeep(bmp);
    if (bmp.close) bmp.close();
    if (text) { maybeHit(text); return; }

    photoTick++;
    photoDelayMs = Math.min(1600 + photoTick * 700, 5000);
    if (scanning) setScanHint('没认出来，把二维码再靠近点，或点一下画面');
  } catch (_) {
    /* 拍照失败不影响预览继续扫 */
  } finally {
    photoBusy = false;
  }
}

/* 深度解码一张静态图：多尺度 × 两种极性。
   这里可以放心地慢 —— 一秒解一张照片，比一秒解 30 帧预览有用得多。 */
async function decodeBitmapDeep(bmp) {
  const det = getDetector();
  if (det && det.detect) {
    try {
      const hits = await det.detect(bmp);
      if (hits && hits.length && hits[0].rawValue) return hits[0].rawValue;
    } catch (_) { }
  }
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const long = Math.max(bmp.width, bmp.height);
  const scales = [];
  for (const cap of [2400, 1500, 1000, 700]) {
    const sc = Math.min(1, cap / long);
    if (!scales.some(s => Math.abs(s - sc) < 0.02)) scales.push(sc);
  }
  for (const sc of scales) {
    const w = Math.max(1, Math.round(bmp.width * sc));
    const h = Math.max(1, Math.round(bmp.height * sc));
    cv.width = w; cv.height = h;
    ctx.drawImage(bmp, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (const inv of ['dontInvert', 'invertFirst']) {
      const code = window.jsQR(data, w, h, { inversionAttempts: inv });
      if (code && code.data) return code.data;
    }
  }

  // 点阵码兜底：闭运算填缝再解。照片可以慢慢来，这里半径从 1 到 4 全试一遍。
  const tw = Math.min(1200, long);
  const sc2 = tw / long;
  const w2 = Math.max(1, Math.round(bmp.width * sc2));
  const h2 = Math.max(1, Math.round(bmp.height * sc2));
  cv.width = w2; cv.height = h2;
  ctx.drawImage(bmp, 0, 0, w2, h2);
  for (const r of [1, 2, 3, 4]) {
    const img = closedImageData(ctx, w2, h2, r);
    for (const inv of ['dontInvert', 'invertFirst']) {
      const code = window.jsQR(img.data, w2, h2, { inversionAttempts: inv });
      if (code && code.data) return code.data;
    }
  }
  return null;
}

async function toggleTorch() {
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const on = !toggleTorch._on;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    toggleTorch._on = on;
  } catch { toast('该设备不支持手电筒'); }
}

/* ---------------- 二维码解析 ---------------- */
function parseQr(text) {
  const raw = String(text || '').trim();
  const out = {};
  let qs = '';
  const qi = raw.indexOf('?');
  if (qi >= 0) qs = raw.slice(qi + 1);
  else if (raw.includes('=')) qs = raw;

  if (qs) {
    for (const part of qs.split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq).toUpperCase();
      const v = decodeURIComponent(part.slice(eq + 1));
      if (k === 'NQT') out.NQT = v;
      else if (k === 'IMEI') out.IMEI = v;
      else if (k === 'SN') out.SN = v;
      else if (k === 'QEYKID') out.qeykid = v;
    }
  }
  if (!out.NQT && !out.IMEI && !out.SN) {
    // 裸编号兜底：8~24 位字母数字，按 IMEI 处理
    if (/^[A-Za-z0-9_\-]{6,32}$/.test(raw)) out.IMEI = raw;
  }
  return out;
}

async function handleScanned(text) {
  const qr = parseQr(text);
  const key = qr.NQT ? 'NQT' : qr.IMEI ? 'IMEI' : qr.SN ? 'SN' : null;
  if (!key) return toast('未识别的二维码：' + text.slice(0, 30), true);

  if (qr.qeykid && !key) { /* 水卡码，本项目不处理 */ }

  showScreenLoading('正在识别设备…');
  try {
    // 服务端认的键因机器而异（实测某机器必须用 SN），主键失败就换其余键重试
    const keys = [...new Set([key, 'SN', 'IMEI', 'NQT'])];
    let res = null, lastMsg = '';
    for (const k of keys) {
      try {
        const r = await api('goods/scan/v2', { [k]: qr[key] });
        if (r && r.id) { res = r; break; }
      } catch (e) {
        lastMsg = e.message;
        if (e.code === 2) throw e;
      }
    }
    if (!res) throw new ApiError(lastMsg || '该设备未绑定，请联系商家绑定后再使用');

    if (res.jumpToDevicePageFlag) {
      toast('该设备需在官方 App 内使用');
      hideScreenLoading();
      return;
    }
    const cat = res.categoryCode || '04';
    if (cat !== '04') {
      hideScreenLoading();
      toast('这不是饮水机（类型 ' + cat + '）', true);
      return;
    }
    hideScreenLoading();
    await openDevice({ goodsId: res.id, categoryCode: cat, shopId: res.shopId, name: res.categoryName });
  } catch (e) {
    hideScreenLoading();
    toast(e.message, true);
  }
}

let screenLoading;
function showScreenLoading(msg) {
  if (!screenLoading) {
    screenLoading = document.createElement('div');
    screenLoading.className = 'toast';
    screenLoading.style.zIndex = 90;
    document.body.appendChild(screenLoading);
  }
  screenLoading.textContent = msg;
  screenLoading.classList.remove('hidden');
}
function hideScreenLoading() { if (screenLoading) screenLoading.classList.add('hidden'); }

/* ---------------- 设备详情 ---------------- */
let current = null;

async function openDevice(dev) {
  // 换设备立刻作废上一轮会话。
  // 不这么做的话，等待期扫第二台机器时旧的这一轮还占着 busy，
  // 新一轮的 startWater() 会被「正在处理，请稍候」挡回去 ——
  // 表现就是「扫了第二台没反应」，而且界面上还挂着上一台的「取消」。
  // 旧那轮看到 sessionSeq 变了会自己停掉它那台机器的水（见 abandonSession）。
  if (busy) {
    sessionSeq++;
    busy = false;
  }
  stopRequested = false;
  watering = false;
  const me = { ...dev, detail: null, skus: [], sku: null };
  current = me;
  show('device');
  $('#devName').textContent = dev.name || '饮水机';
  $('#devMeta').textContent = '加载中…';
  $('#quotaLine').classList.add('hidden');
  setState('正在连接', '正在获取设备信息…');

  try {
    // 注意：skus 的错误**不能吞掉**。/goods/normal/details 不需要登录，但
    // /goods/normal/skus 需要 token——token 过期时 details 照样成功、skus 报「未登录」，
    // 若把错误吞掉就会显示成「该设备暂无可用计费方式」，把掉登录误报成设备问题。
    const [detail, skus] = await Promise.all([
      api('goods/normal/details', { goodsId: dev.goodsId }),      api('goods/normal/skus', { goodsId: dev.goodsId })
    ]);
    // 这期间用户又扫了另一台：这一轮的结果已经过期，写下去会把新设备页覆盖掉。
    if (current !== me) return;
    current.detail = detail || {};
    current.imei = current.detail.imei || dev.imei || '';
    current.shopId = current.detail.shopId || dev.shopId || '';
    current.categoryCode = current.detail.categoryCode || dev.categoryCode || '04';
    current.name = current.detail.name || dev.name || '饮水机';

    $('#devName').textContent = current.name;
    const metaBits = [];
    if (current.detail.orgName) metaBits.push(current.detail.orgName);
    if (current.imei) metaBits.push('编号 ' + current.imei);
    if (current.detail.isBluetooth === 1) metaBits.push('蓝牙');
    $('#devMeta').textContent = metaBits.join(' · ') || '饮水机';

    Store.addDevice({
      goodsId: dev.goodsId, name: current.name, imei: current.imei,
      shopId: current.shopId, categoryCode: current.categoryCode,
      shopName: current.detail.orgName || ''
    });
    renderDevices();

    current.skus = skuList(skus);
    // 计费方式不再展示给用户（这台饮水机只有一档，官方那行「饮水 · 起步¥1 · 最低10」
    // 对用户没有意义）。但仍要先拿到 skuId 才能下发开阀指令。
    current.sku = pickSku(current.skus);

    if (current.detail.isBluetooth === 1) {
      setState('蓝牙设备', '该设备需蓝牙指令，暂不支持');
      $('#actionBtn').disabled = true;
    } else if (!current.sku || !current.sku.skuId) {
      setState('无法开始', '该设备暂无可用计费方式');
      $('#actionBtn').disabled = true;
    } else {
      // 历史设备入口和扫码入口一样：直接开阀解锁。设备页不再提供「开始接水」这种
      // 点了也不会出水的按钮 —— 服务端根本没有开阀接口（12 个 dex 穷举过）。
      startWater();
    }

    loadQuota();
  } catch (e) {
    // code===2 时 api() 已经跳回登录页了，这里不要再把「未登录」写成设备加载失败
    if (e && e.code === 2) return;
    if (current !== me) return;         // 已经换到别的设备了，别写错页面
    $('#devMeta').textContent = '';
    setState('无法加载', e.message);
    $('#actionBtn').disabled = true;
  }
}

function skuList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['list', 'skus', 'rows', 'records', 'data']) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}

/* 计费方式不再渲染成卡片列表。用户要的是「扫完就接水」，机器上按「开始」就出水，
   手机上没有选档位的必要（这台机器也只有一档）。这里只挑出 skuId 供开阀使用。
   保留 skuList 是因为容错分支还要判断"这台设备到底有没有可用的计费方式"。 */
function pickSku(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const ok = list.find(s => s && s.skuId);
  return ok || null;
}

async function loadQuota() {
  if (!current) return;
  const line = $('#quotaLine');
  line.classList.add('hidden');
  try {
    const q = await api('waterQuota/getActive', {
      shopId: current.shopId, categoryCode: current.categoryCode
    });
    const t = q && (q.text || (Array.isArray(q) && q[0] && q[0].text));
    if (t) {
      line.textContent = '🎟️ ' + t;
      line.classList.remove('hidden');
    }
  } catch (_) { }
}

/* ---------------- 状态环 ---------------- */
let ringPct = 0, ringTimer;

function setState(title, sub) {
  $('#stateTitle').textContent = title;
  $('#stateSub').textContent = sub || '';
}

function setRing(pct) {
  ringPct = Math.max(0, Math.min(100, pct));
  const deg = ringPct * 3.6;
  // 用自定义属性而不是 style.background：CSP style-src 'self' 会拦掉后者。
  const el = $('#stateRing');
  if (el) el.style.setProperty('--deg', deg.toFixed(1) + 'deg');
}

/* ---------------- 接水主流程 ---------------- */
let busy = false;
let stopRequested = false;
/* 每次接水给一个自增号。旧的一轮（例如等待期用户又扫了另一台）发现
   号码变了就必须立刻收手：不能再锁 skuId/goodsId 去轮询或停水，
   否则会把「另一台」的水给停掉。 */
let sessionSeq = 0;
/* 水是不是真的在流。busy 覆盖的是整个接水会话（含开阀后的等待期），
   等待期水还没出，这时候没必要把用户锁在设备页上 —— 90 秒的等待里
   连返回键都按不动，纯属困住用户。只有 watering 为真才拦。 */
let watering = false;

async function startWater() {
  // 不能静默 return —— 用户点了没反应会以为坏了，这里一律给出可见反馈
  if (busy) { toast('正在处理，请稍候', true); return; }
  if (!current) { toast('请先选择设备', true); return; }
  if (!current.sku || !current.sku.skuId) {
    toast('还没拿到计费方式，正在重新加载…', true);
    $('#actionBtn').disabled = true;
    setState('重新加载', '正在获取计费方式…');
    let reloadErr = null;
    try {
      const skus = await api('goods/normal/skus', { goodsId: current.goodsId });
      current.skus = skuList(skus);
      current.sku = pickSku(current.skus);
    } catch (e) {
      reloadErr = e;
    }
    if (!current.sku || !current.sku.skuId) {
      // token 过期时 api() 已经跳回登录页，这里不要再覆盖成"设备问题"
      if (reloadErr && reloadErr.code === 2) return;
      const why = reloadErr ? reloadErr.message : '该设备暂无可用计费方式';
      setState('无法开始', why);
      toast(why, true);
      $('#actionBtn').textContent = '重新加载';
      $('#actionBtn').disabled = false;
      return;
    }
    setState('正在连接', '正在获取设备信息…');
    $('#actionBtn').textContent = '正在连接…';
    $('#actionBtn').disabled = true;
    startWater();
    return;
  }
  busy = true;
  stopRequested = false;
  const mySession = ++sessionSeq;
  // 这一轮用的设备与计费方式，开头就固定下来。
  // 等待期用户又扫了另一台机器时 current 会被换掉，轮询/停水不能再跟着变。
  const dev = current;
  const sku = current.sku;
  const btn = $('#actionBtn');
  btn.disabled = true;
  $('#flowLine').classList.remove('hidden');
  $('#flowAmount').textContent = '—';
  // 被新扫码顶掉的一轮必须「安静地」退出：不改界面、不建订单、不停水
  const superseded = () => mySession !== sessionSeq;

  /**
   * 被顶掉的那一轮收尾。
   *
   * 不能直接 return —— 上一轮的阀门已经开了，就地走人会让那台机器的水路
   * 一直挂在「已开阀」状态，得等它自己超时。停水指令要用这一轮开头冻结的
   * dev.goodsId，绝不能读 current（那时它已经指向新设备了，会把新设备的水停掉）。
   */
  const abandonSession = async (d) => {
    try { await api('goods/endWater', { goodsId: d.goodsId }); } catch (_) { }
  };

  try {
    setState('正在启动', '下发开阀指令…');
    setRing(6);

    const params = { skuId: sku.skuId, promotions: PROMOTIONS };
    if (Store.payType) params.payType = Store.payType;
    // 官方 AfterPayUseAct 在 unlock 之前会先调 payChannelRoute/addUserAfterPayChannel
    // 把这个账号的后付费（先用后付）渠道登记为 method=15（支付宝免密）。
    // 不登记时服务端可能按「通用小票直扣」处理：钱扣了，但订单停在待支付。
    try {
      await api('payChannelRoute/addUserAfterPayChannel', { method: Store.payType || '15' });
    } catch (_) { }

    const unlock = await api('goods/water/unlock', params, {
      extraHeaders: {
        categoryCode: dev.categoryCode || '04',
        imei: dev.imei || '',
        lat: String((Store.geo && Store.geo.lat) || 0),
        lng: String((Store.geo && Store.geo.lng) || 0)
      }
    });
    const msgId = unlock && unlock.msgId;
    const orderNo0 = unlock && unlock.orderNo;

    // 扫码即开阀之后，用户可能还没来得及按机器上的【开始】。
    // 这段时间 workStatus 已经是 2 了，但一滴水都没出 —— 不能一看到它就当成
    // 「正在出水」，否则「已就绪」只会维持一次轮询（约 1.2 秒）。
    // 这里不放任何"开始/暂停/结算"按钮：服务端没有开阀和暂停接口（已把官方 APK 的
    // 12 个 dex 穷举确认过，goods/* 下只有 unlock / sync / endWater），
    // 按钮点了也驱不动机器，只会让用户以为坏了。状态一律跟着机器面板走。
    setState('已就绪', '请在机器上按【开始】');
    setRing(6);
    btn.textContent = '取消';
    btn.disabled = false;

    let last = null, ticks = 0, userStopped = false;
    let seenRunning = false, waitTicks = 0, netFailed = false;
    // 机器被解锁后 workStatus 就已经是 2 了，但那时用户还没按【开始】，一滴水都没出。
    // 所以还得单独记一个「解锁过」的标记，用来区分「解锁后一直没出水就结束」。
    let sawActive = false;
    let waterTicks = 0;      // 只有真出水才计数，用来显示「已接 N 秒」
    // 解锁那一刻 sync.amount 的基线值。之后只有比它大才算"出水了"。
    let baseAmount = null;
    // 出水之后 amount 连续几轮没再增长。用来识别机器上按了【暂停】。
    let stillTicks = 0;
    let pausedShown = false;
    // 约 90 秒等用户按机器上的开始。测试里可以用 window.__startWaitTicks 缩短。
    const START_WAIT_TICKS = window.__startWaitTicks || 75;
    while (true) {
      if (stopRequested) { userStopped = true; break; }
      await sleep(1200);
      if (stopRequested) { userStopped = true; break; }
      if (superseded()) return await abandonSession(dev);   // 用户已经去接另一台了
      ticks++;
      let sync;
      try {
        sync = await api('goods/water/sync', { skuId: sku.skuId });
      } catch (e) {
        if (e.code === 2) throw e;
        // 网络抖动也计入等待时长。以前这里是 continue，waitTicks 永不增长，
        // 断网时会一直卡在「已就绪 / 请在机器上按开始」，按钮也一直是「取消」——
        // 看上去像加载中，其实永远不会自己结束。连续失败 5 次就当这轮放弃。
        // 注意 userStopped 必须跟着置上：用户点了「取消」才断的网，不能被写成
        // 「没有在机器上按开始」，那样提示是错的。
        userStopped = stopRequested;
        netFailed = true;
        if (++waitTicks > START_WAIT_TICKS) break;
        if (waitTicks >= 5) break;
        continue;
      }
      last = sync || {};
      const ws = last.workStatus;
      const active = ws === WORK_RUNNING;
      // ── 怎么判断"水真的出来了"────────────────────────────────────────
      // 走过两次弯路，别再退回去：
      //  ① workStatus === 2 不行 —— 机器屏幕上写的是「设备已解锁 (6)秒 / 轻触【开始】
      //     键出水」，这个状态下它就是 2，用户不按开始也是 2。
      //  ② identify 有值也不行 —— 它是解锁后服务端就给出的"建单凭据"，扫码瞬间就有，
      //     拿它当出水信号会让「已就绪」只维持一次轮询（约 1.2 秒）就跳成「接水中」。
      // 唯一可靠的是 sync.amount（不是金额，但官方正是用它判断"这单有没有消费"）
      // 相对**解锁那一刻的基线**是否增长：待命时它是个定值，出水后才会变大。
      const amt = Number(last.amount) || 0;
      if (baseAmount === null) baseAmount = amt;
      const grew = amt > baseAmount;
      if (amt > baseAmount) baseAmount = amt;   // 基线只进不退

      if (grew && !seenRunning) {
        // 第一次看到有消费 = 用户按了机器上的【开始】，水真的出来了
        seenRunning = true;
        watering = true;
        stillTicks = 0;
        setState('接水中', '正在计量');
        setRing(12);
        btn.textContent = '结束接水';
        btn.disabled = false;
      }

      if (seenRunning) {
        if (grew) {
          stillTicks = 0;
          if (pausedShown) {
            // 用户又按了机器上的【开始】，接着出水
            pausedShown = false;
            setState('接水中', '正在计量');
          }
          waterTicks++;
          $('#flowAmount').textContent = fmtElapsed(waterTicks * 1.2);
          setRing(Math.min(95, 12 + waterTicks * 3));
        } else {
          stillTicks++;
          // 连着 3 轮（约 3.6 秒）amount 一动不动，而机器仍在这一单里 ——
          // 这就是用户在机器上按了【暂停】。暂停时 workStatus 仍然是 2，
          // 光看它区分不出「在出水」和「停着没动」，只能看 amount 还长不长。
          if (!pausedShown && active && stillTicks >= 3) {
            pausedShown = true;
            setState('接水暂停中', '机器已暂停');
            setRing(Math.min(95, 12 + waterTicks * 3));
          }
        }
        // 出过水之后 workStatus 一离开 2 = 机器上按了【结算】，去出账
        if (!active) break;
      } else {
        // 还没出水，这一轮仍在等用户按【开始】
        if (active) {
          sawActive = true;
        } else if (sawActive || ws !== WORK_IDLE) {
          // 解锁过但一直没按【开始】，然后机器自己收口了（在机器上点了结算）
          break;
        }
        if (++waitTicks > START_WAIT_TICKS) break;
      }
      if (ticks > 600) break;
    }
    if (superseded()) return await abandonSession(dev);

    // 完全没有消费（一直没按开始）：不要拿空订单去结算，
    // 否则会生成一张 0 元废单，还会以「有未支付订单」挡住下一次接水。
    // 判据只能是 seenRunning（循环里靠 amount 增长置位）；identify 不能用来判断，
    // 它解锁后就有值 —— 早期版本就是因为它，没出水也去建单，最后弹出一张订单号 null 的结算页。
    const tookWater = seenRunning;
    if (!tookWater) {
      // 停水指令必须发给这一轮的设备，不能读 current（可能已经换成另一台了）
      try { await api('goods/endWater', { goodsId: dev.goodsId }); } catch (_) { }
      // 断网退出要说"网络不稳"，别用「已取消」把它盖掉 —— 用户看到「没有在机器上按开始」
      // 会以为是自己的操作问题，其实是根本没连上服务器。
      if (netFailed) {
        setState('网络不稳', '请检查网络后重试');
      } else {
        // 「扫码后一滴水没接」的走法都归到这里：在机器上按了结算、在机器上什么都不按、
        // 或者在手机/网页上点了【取消】。对用户来说结果一样 —— 没接水、没花钱。
        setState('接水已取消', '未接水，未产生费用');
      }
      setRing(0);
      btn.textContent = '取消';
      btn.disabled = true;
      const fl = $('#flowLine');
      if (fl) fl.classList.add('hidden');
      busy = false;
      stopRequested = false;
      return;
    }

    // 水一停（机器上点了结算，workStatus 不再是 RUNNING）就立刻把按钮从「结束接水」
    // 切成不可点的「结算中…」。之前这里什么都没动，于是结算那几秒
    // （afterPay/creating + 最多 4 次 order/sync）页面上还挂着一个亮着的「结束接水」，
    // 用户点了没反应 —— 他看到的"反应太慢"就是这个。
    stopRequested = false;
    watering = false;
    btn.textContent = '结算中…';
    btn.disabled = true;

    if (userStopped) {
      setState('正在结束', '已发送停水指令…');
      try { await api('goods/endWater', { goodsId: dev.goodsId }); } catch (_) { }
      await sleep(800);
      try {
        const s = await api('goods/water/sync', { skuId: sku.skuId });
        if (s) last = s;
      } catch (_) { }
    }

    setState('已完成', '正在生成订单…');
    setRing(100);

    let finalOrderNo = (last && last.identify) || orderNo0 || '';
    if (finalOrderNo === 'null' || finalOrderNo === 'undefined') finalOrderNo = '';
    let orderId = null, detail = null;
    // 结算结果要如实告诉用户，不能一律说"已结算"：
    // 订单没建出来、或 order/sync 一直没成功时，订单其实是「待支付」，
    // 说成已结算会让用户下次接水被"有未支付订单"挡住时完全不知道为什么。
    //
    // 但反过来也不能把"已经付掉了"说成"待支付"（用户实测踩到过）：
    // 接水一两秒就结算时，服务端建单和扣款都还在路上，
    // order/sync 那几秒钟很可能还没把订单推到已完成，
    // 而支付宝那边其实已经扣款成功了。判据必须是**订单自己的状态**（order/detail），
    // 不是某一次调用的返回值。
    //   ok       = 已确认支付
    //   unpaid   = 订单建出来了，但服务端仍显示待支付
    //   uncreated= 订单根本没建出来
    //   none     = 本次没有产生消费（水量太少 / 没出水），不该有订单
    let settleState = 'ok';
    if (!finalOrderNo) settleState = 'none';
    if (finalOrderNo) {
      try {
        const created = await api('order/afterPay/creating', { orderNo: finalOrderNo });
        if (!created) {
          settleState = 'uncreated';
        } else {
          orderId = created.orderId;
          // 订单号以 afterPay/creating 返回的为准：它返回的就是官方 AfterPay 实体
          // {orderId, orderNo, orderStatus, payType}。goods/water/sync 的 identify 只是
          // 用来「创建」后付费订单的凭据，不是最终订单号（官方单号形如 0620261106004023612291）。
          // 之前拿 identify 去调 order/sync，服务端查不到这条单，于是订单永远停在「待支付」，
          // 还会以「有未支付订单需要完成」挡住下一次接水。
          const realNo = created.orderNo || finalOrderNo;
          if (created.orderNo) finalOrderNo = created.orderNo;
          // 官方 StartStatusAct 拿到 AfterPay 后：orderStatus != 2 就进 PayStateAct(mState=1)，
          // 由它调 order/sync 完成扣款、把订单从「待支付」推到已支付（code=="0" 才显示成功页）。
          const pt = created.payType || Store.payType || '15';
          let paid = String(created.orderStatus) === '2';
          for (let i = 0; i < 4 && !paid; i++) {
            setState('结算中', i === 0 ? '正在完成支付…' : '正在确认支付结果…');
            let r = null;
            try {
              r = await api('order/sync', { orderNo: realNo, payType: pt });
            } catch (_) { }
            if (r && String(r.code) === '0') paid = true;
            else if (i < 3) await sleep(900);
          }
          // 别急着下结论：订单状态才是准的。
          // 短时接水（一两秒就结算）时，order/sync 往往还没把订单推进到完成，
          // 但支付宝已经扣款成功；这时去看 order/detail 的订单状态就能看到真相。
          if (orderId) {
            try { detail = await api('order/detail', { orderId }); } catch (_) { }
          }
          if (!paid) paid = orderLooksPaid(detail);
          if (!paid) {
            // 再给服务端几秒（只多问一次，不拖长）。支付宝的异步通知本来就比
            // 我们的请求晚到，这一步能把"其实已支付"的绝大多数情况捞回来。
            for (let i = 0; i < 2 && !paid && orderId; i++) {
              await sleep(1200);
              try {
                const d2 = await api('order/detail', { orderId });
                if (d2) detail = d2;
                paid = orderLooksPaid(d2);
              } catch (_) { }
              if (!paid) {
                let r = null;
                try { r = await api('order/sync', { orderNo: realNo, payType: pt }); } catch (_) { }
                if (r && String(r.code) === '0') paid = true;
              }
            }
          }
          if (!paid) settleState = 'unpaid';
        }
      } catch (_) {
        settleState = 'uncreated';
      }
    } else {
      settleState = 'uncreated';
    }
    if (superseded()) return;   // 订单已经算清楚了，界面归新一轮，别再画

    showResult(finalOrderNo, orderId, detail, last, settleState);
  } catch (e) {
    if (superseded()) return;          // 别把错误画到新设备页上
    setRing(0);
    setState('启动失败', e.message);
    toast(e.message, true);
    btn.textContent = '重试';
    btn.disabled = false;
  } finally {
    // 只有「当前这一轮」才有权清这些标志。被新扫码顶掉的旧轮次
    // 一清，就会把新那轮刚设好的 busy/stopRequested 抹掉。
    if (!superseded()) {
      busy = false;
      stopRequested = false;
      watering = false;
    }
  }
}

async function stopWater() {
  if (!current) return;
  stopRequested = true;
  const btn = $('#actionBtn');
  btn.disabled = true;
  btn.textContent = '正在结束…';
}

/**
 * 把设备页恢复成「可以再开一次水」的状态。
 *
 * 之前 showResult() 只切到结算页，设备页的按钮文案还停在「结束接水」、
 * 状态环停在 100%、#flowLine 也还显示着上一轮的用量。用户用浏览器返回键
 * 回到设备页时看到的就是「一个已经结束、却写着结束接水」的死界面，只能刷新整页。
 */
function resetDevicePanel() {
  const btn = $('#actionBtn');
  if (btn) {
    // 设备页只剩「取消 / 结束接水」，没有「开始接水」——
    // 服务端没有开阀接口，做出来也是点了不出水的假按钮。
    btn.textContent = '正在连接…';
    btn.disabled = true;
  }
  setRing(0);
  setState('正在连接', '正在获取设备信息…');
  const fl = $('#flowLine');
  if (fl) fl.classList.add('hidden');
  const fa = $('#flowAmount');
  if (fa) fa.textContent = '—';
}

/**
 * 判断一份 order/detail 是否已经是「付掉了」。
 *
 * 为什么不能只看 order/sync 的返回值：接水一两秒就点结算时，服务端的建单、
 * 扣款、回推状态都还在路上，我们那几次 order/sync 很可能全部落空，
 * 但支付宝其实已经扣款成功（用户实测：APP 提示"支付还没确认"，
 * 支付宝账单里已经扣了）。这时候去看订单自己的状态才是准的。
 *
 * 官方状态表（h5 包里的枚举）：
 *   0 待支付 / 1 已失效 / 2 使用中(或已完成) / 3 已完成 / 4 退款中 / 5 已退款
 * 2 和 3 都算"钱已经结清"—— 2 是机器还在用、3 是整单结束。
 * 1/4/5 属于异常终态，不当作已支付。0 就是真的没付。
 */
function orderLooksPaid(detail) {
  if (!detail) return false;
  const st = detail.orderStatus;
  if (st == null || st === '') return false;
  const n = Number(st);
  if (isNaN(n)) return false;
  return n === 2 || n === 3;
}

function showResult(orderNo, orderId, detail, sync, settleState) {
  busy = false;
  stopRequested = false;
  // 结算页一出现就把设备页复位：用户按返回键/浏览器后退回来时可以立刻再扫一台，
  // 不用刷新页面（刷新会丢掉当前设备与列表状态）。
  resetDevicePanel();
  show('result');
  const rows = [];
  if (detail) {
    const wu = detail.waterUse;
    if (wu && wu.waterUseValueDesc) {
      rows.push([wu.waterUseType === 1 ? '用水量' : '用水时长', wu.waterUseValueDesc]);
    }
    // 原价：优先取订单条目 originPrice，其次 SkuItem 求和
    let origin = 0, hasOrigin = false;
    (detail.tradeOrderItem || []).forEach(it => {
      const n = Number(it && it.originPrice);
      if (!isNaN(n)) { origin += n; hasOrigin = true; }
    });
    if (!hasOrigin) {
      (detail.skus || []).forEach(it => {
        const n = Number(it && it.originPrice);
        if (!isNaN(n)) { origin += n; hasOrigin = true; }
      });
    }
    if (hasOrigin) rows.push(['原价', '¥' + origin.toFixed(2)]);

    const promos = detail.promotionList || [];
    let promoSum = 0;
    promos.forEach(p => {
      const n = Number(p && p.discountAmount);
      if (!isNaN(n) && n > 0) {
        promoSum += n;
        const name = p.promotionType === 4 ? '小票抵扣'
          : p.promotionType === 8 ? '积分抵扣' : ('优惠' + (p.promotionName || p.promotionType));
        rows.push([name, '-¥' + n.toFixed(2)]);
      }
    });
    // 实付：payPrice；退而求其次 origin - 优惠
    const pay = Number(detail.payPrice);
    if (!isNaN(pay) && detail.payPrice != null && detail.payPrice !== '') {
      rows.push(['实付', '¥' + pay.toFixed(2)]);
    } else if (hasOrigin) {
      const real = Math.max(0, origin - promoSum - (Number(detail.paymentDiscountPrice) || 0));
      rows.push(['实付', '¥' + real.toFixed(2)]);
    }
    if (detail.payTypeName) rows.push(['支付方式', detail.payTypeName]);
  }
  // 订单没建出来时，手里的 orderNo 其实是 goods/water/sync 的 identify（服务端查不到），
  // 当成订单号展示会误导用户去原 App 里搜一个不存在的单号。
  // 另外必须挡住字符串 "null"：服务端在「没出水」时返还的是 JSON null，
  // 一路走到这里会变成货真价实的 "null"，直接显示在订单号那一栏。
  if (orderNo && orderNo !== 'null' && orderNo !== 'undefined' && settleState !== 'uncreated') {
    rows.push(['订单号', orderNo]);
  }

  const kv = $('#resultRows');
  kv.innerHTML = rows.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('');
  // 结算状态必须如实反映，不能一律说「已结算」：
  // - uncreated：订单根本没建出来，此时给的 orderNo 只是 identify，不是真单号，别当成订单号展示
  // - unpaid：订单建出来了但 order/sync 没成功，胖乖侧仍是「待支付」，会挡住下一次接水
  const msg = $('#resultMsg');
  if (settleState === 'uncreated') {
    msg.textContent = '水已停，但订单没有生成成功。请到原 App 里确认这笔订单。';
    msg.classList.add('warn');
  } else if (settleState === 'unpaid') {
    msg.textContent = '水已停，但支付还没确认。到原 App 里若有「待支付」订单，请点一次「立即支付」，否则会挡住下次接水。';
    msg.classList.add('warn');
  } else if (settleState === 'none') {
    // 压根没有消费（水没出来 / 时间太短不到最低计量），本来就不该有订单
    msg.textContent = '本次没有产生费用';
    msg.classList.remove('warn');
  } else if (settleState === 'ok') {
    msg.textContent = '费用已通过支付宝免密结算';
    msg.classList.remove('warn');
  } else {
    // 兼容老调用点
    msg.textContent = detail ? '费用已通过支付宝免密结算' : '已完成，明细以原 App 订单为准';
  }
  refreshQuotaBadge();
}

/* ---------------- 工具 ---------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function fmtElapsed(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $('#sendCode').onclick = sendCode;
  $('#doLogin').onclick = doLogin;
  $('#advToken').onclick = (e) => {
    e.preventDefault();
    const box = $('#tokenBox');
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) $('#tokenInput').focus();
  };
  $('#useToken').onclick = useToken;
  $('#phone').addEventListener('keydown', e => { if (e.key === 'Enter') $('#code').focus(); });
  $('#code').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

  $('#scanBtn').onclick = openScanner;
  $('#btnScannerClose').onclick = closeScanner;
  $('#btnTorch').onclick = toggleTorch;
  $('#btnManual').onclick = () => { closeScanner(); $('#manual').classList.remove('hidden'); $('#manualInput').focus(); };
  $('#btnManualOk').onclick = () => {
    const v = $('#manualInput').value.trim();
    if (!v) return toast('请输入内容', true);
    $('#manual').classList.add('hidden');
    handleScanned(v);
  };
  $('#btnManualCancel').onclick = () => $('#manual').classList.add('hidden');

  $('#btnRefreshDevices').onclick = syncDevices;
  $('#btnCloseDevice').onclick = () => {
    // 水真的在流时关掉设备页 = 水一直流但界面上没有停止按钮
    if (watering) return toast('接水中，请先结束接水', true);
    leaveDevice();
  };
  $('#actionBtn').onclick = () => {
    const label = $('#actionBtn').textContent;
    // 已就绪时这是「取消」，接水中/暂停时是「结束接水」，结算中是禁用态。
    // 两者都是"从这一端结束这一单"：取消 = 没接过水，直接停阀不建单；
    // 结束接水 = 已接过水，停阀后走结算。真正的区分在 stopWater/会话里做。
    if (label === '取消' || label === '结束接水') return stopWater();
    if (busy) return toast('正在处理，请稍候', true);
    startWater();
  };
  // 结算页的出口：完成 → 首页；浏览器返回键 → 首页（见 popstate）。
  // 需要再接水时在首页点扫码，不在这里堆快捷方式。
  $('#btnDone').onclick = () => { leaveDevice(); refreshQuotaBadge(); };

  $('#btnSettings').onclick = () => $('#settings').classList.remove('hidden');
  $('#btnCloseSettings').onclick = () => $('#settings').classList.add('hidden');
  $('#btnLogout').onclick = logout;
  $('#payTypeSel').onchange = (e) => { Store.payType = e.target.value; toast('已切换支付方式'); };
  $('#autoStart').onchange = (e) => { Store.autoStart = e.target.checked; };
  const rb = $('#remember');
  if (rb) rb.onchange = (e) => {
    Store.remember = e.target.checked;
    // 勾上时把当前内存里的 token 落盘；取消勾选时 setter 已清掉 localStorage
    if (e.target.checked && Store.token) {
      try { localStorage.setItem(LS_TOKEN, Store.token); } catch (_) { }
    }
    // 两个开关是同一个状态，别让登录页那个还显示旧值
    const rg = $('#rememberGate');
    if (rg) rg.checked = e.target.checked;
    toast(e.target.checked ? '已记住登录（仅本机）' : '已取消记住，关闭标签页后需重新登录');
  };
  const rgGate = $('#rememberGate');
  if (rgGate) rgGate.onchange = (e) => {
    // 登录页还没写 token，只是先把选择记下来；真正落盘在 doLogin / useToken 里
    Store.remember = e.target.checked;
    if (rb) rb.checked = e.target.checked;
  };

  /* 查看 / 复制完整 token：模拟器或另一台设备上直接粘贴登录 */
  const showToken = () => {
    const box = $('#tokenFullBox');
    if (!Store.token) return toast('当前没有登录态', true);
    $('#tokenFull').value = Store.token;
    box.classList.remove('hidden');
    $('#tokenFull').scrollIntoView({ block: 'nearest' });
  };
  $('#btnShowToken').onclick = showToken;
  $('#btnHideToken').onclick = () => $('#tokenFullBox').classList.add('hidden');
  $('#btnCopyToken').onclick = async () => {
    const v = Store.token || '';
    if (!v) return toast('当前没有登录态', true);
    try {
      await navigator.clipboard.writeText(v);
      toast('已复制');
    } catch (_) {
      /* http 局域网或旧浏览器没有 clipboard API，退回手动选中 */
      const ta = $('#tokenFull');
      ta.value = v;
      $('#tokenFullBox').classList.remove('hidden');
      ta.focus(); ta.select();
      try { document.execCommand('copy'); toast('已复制'); }
      catch (e) { toast('请长按下面的文本框手动复制', true); }
    }
  };

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#scanner').classList.contains('hidden')) closeScanner();
      else if (!$('#settings').classList.contains('hidden')) $('#settings').classList.add('hidden');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && scanning) closeScanner();
  });
}

/* ---------------- 启动 ---------------- */
function boot() {
  bind();
  setRing(0);

  // 登录页那个「记住登录」默认值要与已保存的选择一致（新用户默认勾上）
  const rg = $('#rememberGate');
  if (rg) rg.checked = Store.remember;
  const rb0 = $('#remember');
  if (rb0) rb0.checked = Store.remember;

  if (Store.token) {
    enterApp();
    // 校验 token 是否有效（静默）
    api('user/checkLogin', { token: Store.token }).catch(() => { });
  } else {
    $('#gate').classList.remove('hidden');
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }
}

document.addEventListener('DOMContentLoaded', boot);

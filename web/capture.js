/* =========================================================
   接水 · 真机取证页

   目的：把 goods/water/sync 在真机上返回的原始数据原样记下来，
   并标出哪一次、哪个字段变了。

   这里**不做任何界面判断**，不显示「接水中/已就绪」，只解锁 + 记录。
   前几版出问题全都是「判据猜错了」，而猜错的原因是从来没见过真机上的
   原始值 —— 一直在拿自己写的 mock 验证自己写的判据。

   用法：
     1. 打开 capture（token 和主站共用，主站登录过就不用再登）
     2. 选设备 → 点「① 开阀解锁」
     3. 点「② 开始记录」，手先别动，等它记 2 行
     4. 到机器前：按【开始】等 4 秒 →【暂停】等 4 秒 →【继续】等 4 秒 →【结算】
     5. 点「复制全部」，把内容发回来

   变了的字段会标 *，所以一眼就能看出哪个字段跟着面板在动。
   ========================================================= */
'use strict';

(function () {
  /* 这些常量与 app.js 保持一致（sign 算法是服务端强制的，不能改） */
  const BASE = 'https://userapi.qiekj.com/';
  const APP_VERSION = '1.145.0';
  const UA = 'okhttp/3.14.9';
  const APP_SECRET = 'nFU9pbG8YQoAe1kFh+E7eyrdlSLglwEJeA0wwHB1j5o=';
  const PROMOTIONS = '[{"assetId":"0","oldPromotionId":"","orgId":"0","promotionId":"0","promotionType":"-6"},{"assetId":"0","oldPromotionId":"","orgId":"0","promotionId":"0","promotionType":"-7"},{"assetId":"0","oldPromotionId":"0","orgId":"0","promotionId":"0","promotionType":"8"}]';

  const $ = (s) => document.querySelector(s);
  const logEl = $('#log');
  const devSel = $('#devSel');
  const btnUnlock = $('#btnUnlock');
  const btnStart = $('#btnStart');
  const btnStop = $('#btnStop');
  const btnMark = $('#btnMark');
  const btnCopy = $('#btnCopy');
  const btnClear = $('#btnClear');

  let timer = null;
  let seq = 0;
  let lines = [];
  let dev = null;
  let detail = null;
  let curSku = null;
  let prevFlat = null;

  function out(text, cls) {
    lines.push(text);
    const span = document.createElement('span');
    span.className = 'line' + (cls ? ' ' + cls : '');
    span.textContent = text + '\n';
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ---------------- 纯 JS SHA-256 ---------------- */
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

  function sign(path, ts, token) {
    return SHA256('appSecret=' + APP_SECRET
      + '&channel=android_app'
      + '&timestamp=' + ts
      + '&token=' + (token || '')
      + '&version=' + APP_VERSION
      + '&/' + path);
  }

  function getToken() {
    try {
      return sessionStorage.getItem('qk_token_session') ||
             localStorage.getItem('qk_token') || '';
    } catch (_) { return ''; }
  }

  async function call(path, params, extraHeaders) {
    const token = getToken();
    if (!token) throw new Error('没有 token，请先回主站登录');
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      body.append(k, String(v));
    }
    body.append('token', token);
    const ts = String(Date.now());
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Version': APP_VERSION,
      'channel': 'android_app',
      'phoneBrand': 'Redmi',
      'User-Agent': UA,
      'timestamp': ts,
      'sign': sign(path, ts, token),
      'Accept': 'application/json, text/plain, */*',
      'Authorization': token,
      'token': token
    };
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (v !== undefined && v !== null && v !== '') headers[k] = String(v);
      }
    }
    const res = await fetch(BASE + path, { method: 'POST', headers, body: body.toString(), mode: 'cors' });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch (_) { throw new Error('HTTP ' + res.status + ' 非 JSON：' + text.slice(0, 200)); }
    return json;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function stamp() {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  /* 把 sync 的 data 摊平成一行：字段名一个不落。
     与上一行不同的字段后面标 * —— 这是整个页面最重要的一列信息。 */
  function flat(data) {
    if (data === null || data === undefined) return '(null)';
    if (typeof data !== 'object') return String(data);
    const cur = {};
    for (const k of Object.keys(data).sort()) {
      let v = data[k];
      if (v === null) v = 'null';
      else if (v === undefined) v = 'undefined';
      else if (typeof v === 'string') v = JSON.stringify(v);
      else if (typeof v === 'object') v = JSON.stringify(v);
      cur[k] = String(v);
    }
    const parts = [];
    for (const k of Object.keys(cur)) {
      const changed = prevFlat !== null && prevFlat[k] !== cur[k];
      const same = prevFlat !== null && prevFlat[k] === cur[k];
      // 只有「上一行有这个字段、这一行变了」才标星；第一行不标
      parts.push(k + '=' + cur[k] + (changed ? '*' : ''));
    }
    prevFlat = cur;
    return parts.join('  ');
  }

  async function tick() {
    if (!curSku) return;
    seq++;
    const t = stamp();
    let res;
    try {
      res = await call('goods/water/sync', { skuId: curSku.skuId });
    } catch (e) {
      out('#' + seq + ' ' + t + '  请求失败：' + (e && e.message), 'err');
      return;
    }
    if (res.code !== 0) {
      out('#' + seq + ' ' + t + '  code=' + res.code + ' msg=' + (res.msg || res.message || ''), 'err');
      return;
    }
    const line = '#' + seq + ' ' + t + '  ' + flat(res.data || {});
    // 有字段变了就把整行标绿，方便肉眼定位
    out(line, line.indexOf('*') >= 0 ? 'mark' : null);
  }

  /* ① 开阀解锁 —— 与主站 startWater() 走同一串请求 */
  async function unlock() {
    if (!dev) { out('先选设备', 'err'); return; }
    if (!curSku) { out('这台设备还没取到计费方式', 'err'); return; }
    btnUnlock.disabled = true;
    out('─── 开始解锁 ' + (dev.name || dev.goodsId) + ' ───', 'mark');
    try {
      // 后付费渠道登记：不登记的话钱扣了订单会挂「待支付」
      await call('payChannelRoute/addUserAfterPayChannel', { method: '15' }).catch(() => { });

      const params = { skuId: curSku.skuId, promotions: PROMOTIONS, payType: '15' };
      const io = (await call('orderRisk/isCheckLocation', {
        categoryCode: (detail && detail.categoryCode) || '04',
        imei: (detail && detail.imei) || ''
      }).catch(() => null));
      out('位置校验：' + JSON.stringify(io && io.data), null);

      const res = await call('goods/water/unlock', params, {
        categoryCode: (detail && detail.categoryCode) || '04',
        imei: (detail && detail.imei) || '',
        lat: '0',
        lng: '0'
      });
      if (res.code !== 0) {
        out('解锁失败：code=' + res.code + ' ' + (res.msg || ''), 'err');
        btnUnlock.disabled = false;
        return;
      }
      out('解锁成功 msgId=' + (res.data && res.data.msgId) + ' orderNo=' + (res.data && res.data.orderNo), 'mark');
      btnStart.disabled = false;
      btnStart.focus();
      out('→ 现在点「② 开始记录」，然后去机器上按【开始】', 'warn');
    } catch (e) {
      out('解锁失败：' + (e && e.message), 'err');
      btnUnlock.disabled = false;
    }
  }

  /* ② 开始记录 */
  function start() {
    if (timer) return;
    if (!curSku) { out('这台设备还没取到计费方式', 'err'); return; }
    out('─── 开始记录 ───', 'mark');
    btnStart.disabled = true;
    btnStop.disabled = false;
    btnMark.disabled = false;
    devSel.disabled = true;
    btnUnlock.disabled = true;
    tick();
    timer = setInterval(tick, 1200);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    btnStart.disabled = !!curSku === false;
    btnStop.disabled = true;
    btnMark.disabled = true;
    devSel.disabled = false;
    out('─── 停止记录 ───', 'mark');
  }

  btnUnlock.onclick = unlock;
  btnStart.onclick = start;
  btnStop.onclick = stop;
  btnMark.onclick = () => out('─── 标记 @' + stamp() + ' ───', 'warn');
  btnClear.onclick = () => { lines = []; logEl.textContent = ''; prevFlat = null; seq = 0; };

  btnCopy.onclick = async () => {
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      btnCopy.textContent = '已复制';
      setTimeout(() => { btnCopy.textContent = '复制全部'; }, 1500);
    } catch (_) {
      const r = document.createRange();
      r.selectNodeContents(logEl);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      btnCopy.textContent = '已选中，长按复制';
      setTimeout(() => { btnCopy.textContent = '复制全部'; }, 2500);
    }
  };

  function readDevices() {
    try { return JSON.parse(localStorage.getItem('qk_devices') || '[]'); } catch (_) { return []; }
  }

  function loadDevices() {
    const list = readDevices();
    if (!list.length) {
      devSel.innerHTML = '<option value="">没有设备，请先回主站扫一次码</option>';
      return;
    }
    devSel.innerHTML = list.map((d, i) =>
      '<option value="' + i + '">' + (d.name || d.goodsId || ('设备' + i)) + '</option>'
    ).join('');
    devSel.onchange = () => pick(Number(devSel.value));
    pick(0);
  }

  async function pick(idx) {
    const list = readDevices();
    dev = list[idx];
    curSku = null;
    detail = null;
    prevFlat = null;
    if (!dev) return;
    btnStart.disabled = true;
    btnUnlock.disabled = true;
    out('─── 选中设备：' + (dev.name || dev.goodsId) + '  goodsId=' + dev.goodsId + ' ───', 'mark');
    try {
      const d = await call('goods/normal/details', { goodsId: dev.goodsId });
      if (d.code === 0 && d.data) {
        detail = d.data;
        out('设备：' + (detail.name || '') + '  orgName=' + (detail.orgName || '') +
          '  imei=' + (detail.imei || '') + '  categoryCode=' + (detail.categoryCode || '') +
          '  isBluetooth=' + detail.isBluetooth, null);
      }
      const res = await call('goods/normal/skus', { goodsId: dev.goodsId });
      if (res.code !== 0) {
        out('取计费方式失败：code=' + res.code + ' ' + (res.msg || ''), 'err');
        return;
      }
      let data = res.data;
      let arr = [];
      if (Array.isArray(data)) arr = data;
      else if (data && Array.isArray(data.list)) arr = data.list;
      else if (data && Array.isArray(data.skus)) arr = data.skus;
      if (!arr.length) { out('这台设备没有计费方式', 'err'); return; }
      curSku = arr[0];
      out('计费方式 skuId=' + (curSku.skuId || '?') + '  原始：' + JSON.stringify(curSku).slice(0, 300), 'mark');
      btnUnlock.disabled = false;
    } catch (e) {
      out('取设备信息失败：' + (e && e.message), 'err');
    }
  }

  loadDevices();
  if (!getToken()) out('没有 token —— 请先回主站登录，再回来打开本页', 'err');
})();

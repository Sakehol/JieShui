/* =========================================================
   接水 · 真机取证页（v2：一个按钮）

   v1 的错：把「解锁」和「记录」拆成两个按钮，用户点「开始记录」
   时根本没开阀，机器当然没反应。

   v2：点一次「开始」= 登记后付费渠道 + 开阀解锁 + 立刻开始轮询
   goods/water/sync。不做任何判断、不改机器状态，只记录原始数据。

   用法：
     1. 打开 /capture（token 和主站共用）
     2. 选设备 → 点「开始（开阀 + 记录）」
     3. 等页面显示「已开阀」
     4. 到机器前：按【开始】4 秒 →【暂停】4 秒 →【继续】4 秒 →【结算】
     5. 点「复制全部」发回来
   ========================================================= */
'use strict';

(function () {
  /* 这些常量与 app.js 保持一致（sign 算法是服务端强制的，不能改） */
  const BASE = 'https://userapi.qiekj.com/';
  const APP_VERSION = '1.145.0';
  const UA = 'okhttp/3.14.9';
  const APP_SECRET = 'nFU9pbG8YQoAe1kFh+E7eyrdlSLglwEJeA0wwHB1j5o=';
  const PROMOTIONS = '[{"assetId":"0","oldPromotionId":"","orgId":"0","promotionId":"0","promotionType":"-6"},{"assetId":"0","oldPromotionId":"","orgId":"0","promotionId":"0","promotionType":"-7"},{"assetId":"0","oldPromotionId":"0","orgId":"0","promotionId":"0","promotionType":8}]';

  const $ = (s) => document.querySelector(s);
  const logEl = $('#log');
  const liveEl = $('#live');
  const liveHintEl = $('#liveHint');
  const devSel = $('#devSel');
  const btnGo = $('#btnGo');
  const btnStop = $('#btnStop');
  const btnMark = $('#btnMark');
  const btnCopy = $('#btnCopy');

  let timer = null;
  let seq = 0;
  let lines = [];
  let dev = null;
  let detail = null;
  let curSku = null;
  let prevFlat = null;
  let running = false;
  let lastMsgId = '';
  let lastOrderNo = '';
  let probeCtx = null;
  let lastProbeStatus = null;
  let probing = false;

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

  function fmtVal(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  /* 摊平成一行；与上一行不同的字段标 * */
  function flat(data) {
    if (data === null || data === undefined) return '(null)';
    if (typeof data !== 'object') return String(data);
    const cur = {};
    for (const k of Object.keys(data).sort()) cur[k] = fmtVal(data[k]);
    const parts = [];
    for (const k of Object.keys(cur)) {
      const changed = prevFlat !== null && prevFlat[k] !== cur[k];
      parts.push(k + '=' + cur[k] + (changed ? '*' : ''));
    }
    prevFlat = cur;
    return parts.join('  ');
  }

  /* 把 status 翻成人话，方便你对着机器面板核对 */
  const STATUS_TEXT = {
    '1': '闸已开，等你按【开始】',
    '2': '正在出水',
    '4': '已暂停',
    '3': '已结算',
    '5': '已结算',
    '6': '机器空闲（没这一单）'
  };

  function renderLive(d) {
    if (!d) { liveEl.textContent = '—'; liveHintEl.textContent = ''; return; }
    const st = d.status;
    liveEl.textContent = 'status=' + fmtVal(st) + '   workStatus=' + fmtVal(d.workStatus)
      + '   amount=' + fmtVal(d.amount);
    const text = STATUS_TEXT[String(st)];
    liveHintEl.textContent = text ? ('→ ' + text) : '→ （这个 status 值以前没见过，记下来）';
    liveEl.className = 'live' + (text ? '' : ' unknown');
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
    const data = res.data || {};
    renderLive(data);
    const line = '#' + seq + ' ' + t + '  ' + flat(data);
    out(line, line.indexOf('*') >= 0 ? 'mark' : null);

    /* status 一变就把那一批只读探针全部打一遍。
       只看服务端有没有一个接口能反应「机器上按了【开始】」。
       加个开关，免得一晚上打几千个请求。 */
    if (probeCtx && data.status !== lastProbeStatus) {
      const first = lastProbeStatus === null;
      lastProbeStatus = data.status;
      if (!first && !probing) {
        probing = true;
        out('  ★ status 变了（' + fmtVal(lastProbeStatus) + '），打一轮探针', 'sep');
        probeAll(probeCtx).finally(() => { probing = false; });
      }
    }
  }

  /* ---------------- 探针：开阀后试探几个只读接口 ----------------
     目的只有一个：找出「机器上按了【开始】」这件事服务端到底有没有地方能查到。
     goods/water/sync 只回 4 个字段，如果它还带别的参数、或者另一个只读接口
     能查到，那就有救；全都查不到，就说明数据根本不存在。
     全部只读，不会开阀也不会扣费。 */
  function probeName(call_) { return call_.name; }

  async function probeAll(ctx) {
    const { skuId, goodsId, msgId, orderNo, imei, categoryCode } = ctx;
    const list = [
      // 同名接口多带几个参数，看会不会吐出更多字段
      ['goods/water/sync +msgId', 'goods/water/sync', { skuId, msgId }, null],
      ['goods/water/sync +orderNo', 'goods/water/sync', { skuId, orderNo }, null],
      ['goods/water/sync +goodsId', 'goods/water/sync', { skuId, goodsId, msgId, orderNo }, null],
      // h5 那边用的另一个 sync（参数是 machineFunctionId）。我们没有 id，
      // 但试试 msgId / imei 会不会被接受 —— 万一通，它返回的就是机器实时态
      ['machine/water/sync msgId', 'machine/water/sync', { machineFunctionId: msgId }, null],
      ['machine/water/sync imei', 'machine/water/sync', { machineFunctionId: imei }, null],
      // h5 打开设备时用来查功能列表与状态的
      ['machine/function/listState', 'machine/function/listState', { machineId: imei, msgId }, null],
      ['machine/sync msgId', 'machine/sync', { msgId }, null],
      ['machine/detail', 'machine/detail', { machineId: imei, goodsId }, null],
      ['machine/function/list', 'machine/function/list', { machineId: imei }, null],
      ['machine/water/stateCmd', 'machine/water/stateCmd', { type: 1, machineId: imei }, null],
      ['machine/msg/sync', 'machine/msg/sync', { msgId, machineId: imei }, null],
      // 订单侧：有时订单里会带机器的实时状态
      ['order/detail', 'order/detail', { orderNo }, null],
      ['goods/latestUsed', 'goods/latestUsed', { categoryCode }, null]
    ];
    for (const [name, path, params] of list) {
      let res;
      try {
        res = await call(path, params);
      } catch (e) {
        out('  探针 ' + name + ' → 连接失败 ' + (e && e.message), 'warn');
        continue;
      }
      const code = res && res.code;
      const data = res && res.data;
      const brief = data === undefined ? '(无 data)' : JSON.stringify(data).slice(0, 300);
      const line = '  探针 ' + name + ' → code=' + code + ' data=' + brief;
      out(line, code === 0 ? 'mark' : 'warn');
    }

    /* 链式探针：h5 那条链路要 machineFunctionId，它来自 machine/function/list 的 items[].id。
       如果同一台机器在两套系统里都登记过，这条路就能拿到真正的实时状态。 */
    for (const mid of [imei, goodsId]) {
      if (!mid) continue;
      let fl;
      try { fl = await call('machine/function/list', { machineId: mid }); } catch (_) { continue; }
      const items = (fl && fl.data && fl.data.items) || (fl && fl.items) || null;
      out('  链式 machine/function/list machineId=' + mid + ' → code=' + (fl && fl.code) +
        ' items=' + (items ? JSON.stringify(items).slice(0, 300) : '(无)'), items ? 'mark' : 'warn');
      if (!items || !items.length) continue;
      for (const it of items.slice(0, 3)) {
        const fid = it && (it.id || it.functionId);
        if (!fid) continue;
        const s2 = await call('machine/water/sync', { machineFunctionId: fid }).catch(() => null);
        out('  链式 machine/water/sync machineFunctionId=' + fid + ' (' + (it.functionName || '') + ')' +
          ' → ' + JSON.stringify(s2).slice(0, 300), s2 && s2.status ? 'sep' : 'warn');
      }
    }
  }

  async function go() {
    if (running) return;
    if (!dev) { out('先选设备', 'err'); return; }
    if (!curSku) { out('这台设备还没取到计费方式', 'err'); return; }

    running = true;
    btnGo.disabled = true;
    devSel.disabled = true;
    btnStop.disabled = false;
    lines = []; logEl.textContent = ''; prevFlat = null; seq = 0;
    liveEl.textContent = '—'; liveHintEl.textContent = '';

    out('─── ' + stamp() + ' 开始：' + (dev.name || dev.goodsId) + ' ───', 'mark');

    try {
      // 后付费渠道登记：不登记的话钱扣了订单会挂「待支付」
      await call('payChannelRoute/addUserAfterPayChannel', { method: '15' }).catch(() => { });

      const cat = (detail && detail.categoryCode) || dev.categoryCode || '04';
      const imei = (detail && detail.imei) || dev.imei || '';

      const io = await call('orderRisk/isCheckLocation', { categoryCode: cat, imei }).catch(() => null);
      out('位置校验：' + JSON.stringify(io && io.data), null);

      const res = await call('goods/water/unlock',
        { skuId: curSku.skuId, promotions: PROMOTIONS, payType: '15' },
        { categoryCode: cat, imei, lat: '0', lng: '0' });

      if (res.code !== 0) {
        out('开阀失败：code=' + res.code + ' ' + (res.msg || ''), 'err');
        out('（如果提示订单待支付，先去官方 App 把那条单付掉再回来）', 'warn');
        finish();
        return;
      }
      out('已开阀  msgId=' + (res.data && res.data.msgId) + '  orderNo=' + (res.data && res.data.orderNo), 'mark');
      out('→ 走到机器前按【开始】，然后【暂停】【继续】【结算】', 'warn');

      lastMsgId = String((res.data && res.data.msgId) || '');
      lastOrderNo = String((res.data && res.data.orderNo) || '');
      probeCtx = { skuId: curSku.skuId, goodsId: dev.goodsId, msgId: lastMsgId, orderNo: lastOrderNo, imei, categoryCode: cat };
      lastProbeStatus = null;
      out('（按下机器面板的键时，会顺带打一轮只读探针，看服务端有没有别的接口能反应「开始」）', 'warn');

      // 开阀后立刻开始轮询（不等用户点第二次）
      tick();
      timer = setInterval(tick, 1200);
    } catch (e) {
      out('失败：' + (e && e.message), 'err');
      finish();
    }
  }

  function finish() {
    if (timer) { clearInterval(timer); timer = null; }
    running = false;
    btnGo.disabled = false;
    btnStop.disabled = true;
    devSel.disabled = false;
  }

  function stop() {
    out('─── ' + stamp() + ' 结束记录 ───', 'mark');
    finish();
  }

  btnGo.onclick = go;
  btnStop.onclick = stop;

  function mark(what) {
    const t = '─── ' + what + '  ' + stamp() + ' ───';
    out(t, 'sep');
    liveHintEl.textContent = '已记下：' + what;
  }

  btnMark.onclick = () => mark('手动标记');
  ['mkStart', 'mkPause', 'mkResume', 'mkEnd'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const label = el.textContent.replace(/^我按了/, '').trim();
    el.onclick = () => mark('我按了' + label);
  });

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

  /* 设备名来自 localStorage（可能被别的页面/旧版本写脏），放进 innerHTML 前必须转义。
     option 的 value 只放下标，不放设备名。 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function loadDevices() {
    const list = readDevices();
    if (!list.length) {
      devSel.innerHTML = '<option value="">没有设备，请先回主站扫一次码</option>';
      btnGo.disabled = true;
      return;
    }
    devSel.innerHTML = list.map((d, i) =>
      '<option value="' + i + '">' + esc(d.name || d.goodsId || ('设备' + i)) + '</option>'
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
    btnGo.disabled = true;
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
      out('计费方式 skuId=' + (curSku.skuId || '?'), 'mark');
      btnGo.disabled = false;
    } catch (e) {
      out('取设备信息失败：' + (e && e.message), 'err');
    }
  }

  loadDevices();
  if (!getToken()) out('没有 token —— 请先回主站登录，再回来打开本页', 'err');
})();

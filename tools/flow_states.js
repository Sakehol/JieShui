const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

// 设备页回归（v1.1.7 口径）。
//
// 背景（用户 m19389 + 2026-11-08 02:39 真机抓包）：
//   goods/water/sync 在「开阀 → 结算」之间只回 status=1 / workStatus=2 / amount=null，
//   人在机器上按了【开始】【暂停】【继续】服务端一个字都不回，只有结算那一刻
//   三个字段才一起变。所以「接水中 / 接水暂停中」这两屏做不出来，已经删掉。
//
// 现在设备页只有一个状态和一枚按钮：
//   1) 扫码后 = 「已就绪」，按钮写「结算」，且**不能**自己跳走。
//   2) 点【结算】时没接过水（amount 仍是 null/0）= 「接水已取消 / 未接水，未产生费用」，
//      按钮变「返回首页」（点了必须真的回首页），且**不建订单**。
//   3) 点【结算】时接过水（amount > 0）= 跳结算页，六行明细齐全。
//   4) 机器上自己按【结算】（status 变 5、workStatus 回 1）也走同一条判断。
//
// mock 的取值全部照抄 2026-11-08 02:39 那份真机抓包，不是猜的：
//   等待期  status=1  workStatus=2  amount=null
//   结算后  status=5  workStatus=1  amount=59（没接水的单仍是 null）
const MOCK = `
(function(){
  let syncN = 0;
  window.__calls = [];
  window.__pressAt = 0;    // 机器上按【开始】的时刻；0 = 还没按（决定 amount 回不回填）
  window.__endedAt = 0;    // 收到 goods/endWater 的时刻。真实机器随后自己结算、amount 才回填
  const D = {
    'goods/scan/v2': {id:'10001', categoryCode:'04', categoryName:'3号饮水机', shopId:88,
      jumpToDevicePageFlag:false, jumpToAlipayFlag2:false},
    'goods/normal/details': {goodsId:'10001', name:'3号饮水机', imei:'NQT2024001', shopId:'88',
      categoryCode:'04', orgName:'学生公寓 3 栋', isBluetooth:0, tradeMain:1},
    'goods/normal/skus': [{skuId:'101', name:'按量计费', price:'0.30', unit:'升', feature:'0.30 元/升'}],
    'waterQuota/getActive': {show:true, text:'水卡余额 ¥12.50 · 享 8 折'},
    'user/balance': {tokenCoin:1250},
    'user/checkLogin': {token:'mocktoken_0123456789abcdef'},
    'goods/endWater': {},
    'payChannelRoute/addUserAfterPayChannel': {},
    'order/sync': {code:'0', messageId:'msg_99001'},
    'order/detail': {
      waterUse:{waterUseType:1, waterUseValueDesc:'0.5L'},
      tradeOrderItem:[{originPrice:'1.50', realPrice:'1.20'}],
      promotionList:[{promotionType:4, discountAmount:'0.30'}],
      payPrice:'1.20', payTypeName:'支付宝免密支付'
    }
  };
  const J = (data) => new Response(JSON.stringify({code:0,msg:'成功',data}),
    {status:200,headers:{'Content-Type':'application/json'}});
  window.fetch = async function(url){
    const p = String(url).replace('https://userapi.qiekj.com/','');
    window.__calls.push(p);
    if (p === 'goods/water/unlock') {
      await new Promise(r=>setTimeout(r,120));
      return J({msgId:'m_1', orderNo:'QK202411060001'});
    }
    if (p === 'goods/endWater') {
      // 收到停水指令后，真实机器约 1 秒自己结算，amount 才回填。
      // mock 必须照这个来，否则页面永远等不到 amount，只能超时。
      if (!window.__endedAt) window.__endedAt = Date.now();
      return J({});
    }
    if (p === 'goods/water/sync') {
      syncN++;
      let data;
      // 停水后约 1 秒机器结算完成
      const settled = window.__endedAt && (Date.now() - window.__endedAt) > 900;
      if (settled) {
        // 结算之后。关键：**没按过【开始】的单 amount 必须还是 null** ——
        // 真机上没出水就没有计量。这里要是也给正数，等于帮代码把所有单都当成
        // "接过水"，「没接水 → 接水已取消」这条就永远测不出来（以前踩过）。
        data = {workStatus:1, identify:'IDENTIFY_A',
                amount: window.__pressAt ? '59' : null, status:5};
      } else {
        // 开阀之后、结算之前：真机上这三个字段一动不动，无论用户按没按开始。
        data = {workStatus:2, identify:'IDENTIFY_A', amount:null, status:1};
      }
      await new Promise(r=>setTimeout(r,80));
      return J(data);
    }
    if (p === 'order/afterPay/creating') {
      await new Promise(r=>setTimeout(r,300));
      return J({orderId:'ord_states_1', orderNo:'0620261106007777777777', orderStatus:1, payType:'15'});
    }
    if (p in D) { await new Promise(r=>setTimeout(r,60)); return J(D[p]); }
    return new Response(JSON.stringify({code:1,msg:'mock 未定义: '+p}),
      {status:200,headers:{'Content-Type':'application/json'}});
  };
})();
`;

const SNAP = `({
  screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
  btn:document.querySelector('#actionBtn').textContent,
  btnDisabled:document.querySelector('#actionBtn').disabled,
  state:document.querySelector('#stateTitle').textContent,
  sub:document.querySelector('#stateSub').textContent,
  amount:document.querySelector('#flowAmount').textContent,
  flowHidden:document.querySelector('#flowLine').classList.contains('hidden')
})`;

// 轮询等某个条件成立再快照，避免拍到中间态（本地跑得比线上快，固定 sleep 会飘）
const snapWhen = async (page, sleep, cond, maxMs) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < (maxMs || 12000)) {
    last = await page.evaluate(SNAP);
    if (last && cond(last)) return last;
    await sleep(150);
  }
  return last;
};

module.exports = async (page, { sleep, url }) => {
  const out = {};
  const base = url || 'http://127.0.0.1:8899/index.html';
  const calls = () => page.evaluate(`(window.__calls||[]).filter(c=>c!=='user/balance')`);

  try {
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
    // 先导航再写 localStorage：首次导航是 about:blank，跨源写会被拒
    await page.S('Page.navigate', { url: base });
    await sleep(1200);
    await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef');
      localStorage.setItem('qk_phone','13800138000');
      localStorage.setItem('qk_auto','0');
      localStorage.setItem('qk_devices','[]'); 'ok'`);
    await page.S('Page.reload', { ignoreCache: true });
    await sleep(1200);

    // ── 场景 A：扫码后什么都不按，直接点手机上的【结算】──────────────
    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=NQT2024001&c=04'); 'ok'`);
    out.ready = await snapWhen(page, sleep, s => s.state === '已就绪', 8000);
    // 再等 4 秒，确认它不会自己跳走（没按开始，服务端什么都不回）
    await sleep(4000);
    out.readyAfter4s = await page.evaluate(SNAP);

    await page.click('#actionBtn');     // 点【结算】
    out.cancelled = await snapWhen(page, sleep, s => s.state === '接水已取消', 25000);
    out.cancelSettleCalls = await page.evaluate(
      `(window.__calls||[]).filter(c=>c==='order/afterPay/creating').length`);
    out.cancelStateIsDevice = (out.cancelled.screen || []).indexOf('device') >= 0;
    await page.shot(shot('states-1-cancelled.png'));

    // 用户 m16749 问题 1：取消态的按钮必须能点、且点了真的回首页
    out.cancelBtnEnabled = out.cancelled.btnDisabled === false;
    out.cancelBtnLabel = out.cancelled.btn;
    await page.click('#actionBtn');
    await sleep(600);
    out.afterCancelClick = await page.evaluate(`({
      screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id)
    })`);
    out.cancelBtnGoesHome = (out.afterCancelClick.screen || []).indexOf('home') >= 0;

    // ── 场景 B：重新扫码 → 机器上按了【开始】→ 点【结算】→ 结算页 ──────
    await page.evaluate(`window.__pressAt = 0; window.__endedAt = 0; 'ok'`);
    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=NQT2024001&c=04'); 'ok'`);
    await snapWhen(page, sleep, s => s.state === '已就绪', 8000);
    // 人在机器上按了【开始】，出水 5 秒（服务端不告诉我们，只能等结算回填）
    await page.evaluate(`window.__pressAt = Date.now(); 'ok'`);
    await sleep(5000);
    out.flowingStillReady = await page.evaluate(SNAP);   // 接线中本来就不该跳，确认仍是已就绪
    await page.click('#actionBtn');
    out.done = await snapWhen(page, sleep,
      s => (s.screen || []).indexOf('result') >= 0, 25000);
    out.rows = await page.evaluate(`document.querySelector('#resultRows').textContent`);
    out.msg = await page.evaluate(`document.querySelector('#resultMsg').textContent`);
    out.unlocks = (await calls()).filter(c => c === 'goods/water/unlock').length;
    await page.shot(shot('states-2-result.png'));

    // 断言汇总
    out.ok =
      out.ready.state === '已就绪' &&
      out.ready.btn === '结算' &&
      out.ready.flowHidden === true &&
      out.readyAfter4s.state === '已就绪' &&
      out.cancelled.state === '接水已取消' &&
      out.cancelled.sub === '未接水，未产生费用' &&
      out.cancelSettleCalls === 0 &&
      out.cancelStateIsDevice === true &&
      out.cancelBtnEnabled === true &&
      out.cancelBtnLabel === '返回首页' &&
      out.cancelBtnGoesHome === true &&
      out.flowingStillReady.state === '已就绪' &&
      (out.done.screen || []).indexOf('result') >= 0 &&
      out.msg.indexOf('支付宝免密') >= 0 &&
      out.rows.indexOf('用水量') >= 0 &&
      out.unlocks >= 2;
    return out;
  } catch (e) {
    out.ERR = String(e && e.stack || e);
    return out;
  }
};

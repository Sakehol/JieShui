const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

// 设备页四态回归（用户 m15839 定的口径，取代 v1.1.0 的三按钮方案）：
//
//  1) 扫码后 = 「已就绪」，主按钮写「取消」。此时**不能**自己跳「接水中」。
//  2) 没在机器上按【开始】就直接在机器上按【结算】= 「接水已取消 / 未接水，未产生费用」，
//     并且**不建订单**（不能出现 null 订单号）。
//  3) 在机器上按【开始】出水 = 「接水中」，主按钮变「结束接水」。
//  4) 机器上按【暂停】= 「接水暂停中」（amount 连着几轮不涨，workStatus 仍是 2）。
//  5) 机器上按【结算】= 跳结算页，六行明细齐全。
//
// 这里最容易回退的是 1)：出水判据必须只看 sync.amount 相对解锁基线的增长。
// identify 解锁就有值、workStatus 解锁就是 2，这两样当信号都会让「已就绪」一秒就跳。
const MOCK = `
(function(){
  let syncN = 0;
  window.__calls = [];
  window.__pressAt = 0;    // 机器上按【开始】的时刻；0 = 还没按
  window.__pauseAt = 0;    // 机器上按【暂停】的时刻
  window.__finishAt = 0;   // 机器上按【结算】的时刻
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
    if (p === 'goods/water/sync') {
      syncN++;
      let data;
      if (window.__finishAt) {
        // 机器上按了【结算】。关键：**没接过水的单 amount 必须仍是 0** ——
        // 真机上没出水就不会有计量，这里要是也写 300，等于帮代码把所有单都当成"接过水"，
        // 「扫码后没接水直接结算 → 接水已取消」这条就永远测不出来（第一版 mock 就是这么错的）。
        data = {workStatus:3, identify:'IDENTIFY_A',
                amount: window.__pressAt ? '300' : '0', status:2};
      } else if (!window.__pressAt) {
        // 真机解锁态：workStatus 已经是 2、identify 已有值，但 amount 一滴水没出时是 0。
        data = {workStatus:2, identify:'IDENTIFY_A', amount:'0', status:0};
      } else if (window.__pauseAt) {
        // 暂停：workStatus 仍然是 2（机器没退出这一单），但 amount 冻住不涨。
        data = {workStatus:2, identify:'IDENTIFY_A', amount:String(60*(window.__pauseAt ? 2 : syncN)), status:1};
      } else {
        data = {workStatus:2, identify:'IDENTIFY_A', amount:String(60*syncN), status:1};
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
  amount:document.querySelector('#flowAmount').textContent
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

    // ── 场景 A：扫码后什么都不按，直接在机器上点【结算】 ────────────────
    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=NQT2024001&c=04'); 'ok'`);
    out.ready = await snapWhen(page, sleep, s => s.state === '已就绪', 8000);
    // 再等 4 秒，确认它没自己跳到「接水中」（旧代码在这里就掉了）
    await sleep(4000);
    out.readyAfter4s = await page.evaluate(SNAP);

    await page.evaluate(`window.__finishAt = Date.now(); 'ok'`);
    out.cancelled = await snapWhen(page, sleep, s => s.state === '接水已取消', 10000);
    out.cancelSettleCalls = await page.evaluate(
      `(window.__calls||[]).filter(c=>c==='order/afterPay/creating').length`);
    out.cancelStateIsDevice = (out.cancelled.screen || []).indexOf('device') >= 0;
    await page.shot(shot('states-1-cancelled.png'));

    // ── 场景 B：重新扫码 → 机器上按【开始】→ 接水中 ──────────────────────
    await page.evaluate(`window.__pressAt = 0; window.__pauseAt = 0; window.__finishAt = 0; 'ok'`);
    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=NQT2024001&c=04'); 'ok'`);
    await snapWhen(page, sleep, s => s.state === '已就绪', 8000);
    await page.evaluate(`window.__pressAt = Date.now(); 'ok'`);
    out.flowing = await snapWhen(page, sleep, s => s.state === '接水中', 10000);
    await page.shot(shot('states-2-flowing.png'));

    // ── 场景 C：机器上按【暂停】→ 接水暂停中 ────────────────────────────
    await page.evaluate(`window.__pauseAt = Date.now(); 'ok'`);
    out.paused = await snapWhen(page, sleep, s => s.state === '接水暂停中', 12000);
    const amtA = out.paused.amount;
    await sleep(3000);
    out.pausedHeld = await page.evaluate(`({state:document.querySelector('#stateTitle').textContent,
      amount:document.querySelector('#flowAmount').textContent})`);
    out.amountFrozen = amtA === out.pausedHeld.amount;
    await page.shot(shot('states-3-paused.png'));

    // ── 场景 D：机器上按【结算】→ 结算页 ────────────────────────────────
    await page.evaluate(`window.__finishAt = Date.now(); 'ok'`);
    out.done = await snapWhen(page, sleep,
      s => (s.screen || []).indexOf('result') >= 0, 20000);
    out.rows = await page.evaluate(`document.querySelector('#resultRows').textContent`);
    out.msg = await page.evaluate(`document.querySelector('#resultMsg').textContent`);
    out.unlocks = (await calls()).filter(c => c === 'goods/water/unlock').length;
    await page.shot(shot('states-4-result.png'));

    // 断言汇总
    out.ok =
      out.ready.state === '已就绪' &&
      out.ready.btn === '取消' &&
      out.readyAfter4s.state === '已就绪' &&
      out.cancelled.state === '接水已取消' &&
      out.cancelled.sub === '未接水，未产生费用' &&
      out.cancelSettleCalls === 0 &&
      out.cancelStateIsDevice === true &&
      out.flowing.state === '接水中' &&
      out.flowing.btn === '结束接水' &&
      out.paused.state === '接水暂停中' &&
      out.amountFrozen === true &&
      (out.done.screen || []).indexOf('result') >= 0 &&
      out.msg.indexOf('支付宝免密') >= 0 &&
      out.rows.indexOf('用水量') >= 0;
    return out;
  } catch (e) {
    out.ERR = String(e && e.stack || e);
    return out;
  }
};

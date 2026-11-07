const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

// 扫码即接水回归：
// 用户要的是「扫完码机器直接认到人，在机器上按开始就有水」，手机上不要再点一次。
// 1) 扫码 → 设备页 → 自动下发 unlock，unlock 的调用发生在进设备页后（不需要点按钮）
// 2) 用户还没按机器上的「开始」时（workStatus 一直不是 2），不能急着结算/建单
// 3) 用户按了「开始」并接水后，机器上点结算 → 正常进结算页
const MOCK = `
(function(){
  // 模拟机器：前 N 次 sync 表示"用户还没按开始"（workStatus=0, amount=0），
  // 之后变成运行中（2），再之后用户点结算（3）
  let syncN = 0;
  window.__calls = [];
  window.__pressAt = 0;      // 用 __press() 让机器进入出水状态
  window.__finishAt = 0;     // 用 __finish() 让机器结算
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
    const path = String(url).replace('https://userapi.qiekj.com/','');
    window.__calls.push(path);
    if (path === 'goods/water/unlock') {
      await new Promise(r=>setTimeout(r,120));
      return J({msgId:'m_1', orderNo:'QK202411060001'});
    }
    if (path === 'goods/water/sync') {
      syncN++;
      let data;
      if (!window.__pressAt) {
        // 真机解锁后 workStatus 就已经是 2 了（屏幕显示「设备已解锁 (6)秒 / 轻触【开始】键出水」），
        // 但用户没按开始，所以 amount 还是 0、identify 还是空。以前 mock 写的是 0，
        // 于是「把 2 当成正在出水」这个 bug 在测试里根本照不出来。
        data = {workStatus:2, identify:'', amount:'0', status:0};     // 已解锁，等用户按开始
      } else if (!window.__finishAt) {
        data = {workStatus:2, identify:'IDENTIFY_A', amount:String(60*syncN), status:1};
      } else {
        data = {workStatus:3, identify:'IDENTIFY_A', amount:'300', status:2};
        if (!window.__settleAt) window.__settleAt = Date.now();
      }
      await new Promise(r=>setTimeout(r,80));
      return J(data);
    }
    if (path === 'order/afterPay/creating') {
      await new Promise(r=>setTimeout(r,300));
      return J({orderId:'ord_auto_1', orderNo:'0620261106009999999999', orderStatus:1, payType:'15'});
    }
    if (path in D) {
      await new Promise(r=>setTimeout(r,60));
      return J(D[path]);
    }
    return new Response(JSON.stringify({code:1,msg:'mock 未定义: '+path}),
      {status:200,headers:{'Content-Type':'application/json'}});
  };
})();
`;

module.exports = async (page, { sleep, url }) => {
  const out = {};
  const base = url || 'http://127.0.0.1:8899/index.html';
  const snap = `({
    screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
    btn:document.querySelector('#actionBtn').textContent,
    btnDisabled:document.querySelector('#actionBtn').disabled,
    state:document.querySelector('#stateTitle').textContent,
    sub:document.querySelector('#stateSub').textContent
  })`;
  try {
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
    await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef');
      localStorage.setItem('qk_phone','13800138000');
      localStorage.setItem('qk_auto','0');
      localStorage.setItem('qk_devices','[]'); 'ok'`);
    await page.S('Page.navigate', { url: base });
    await sleep(1200);

    // 直接走 handleScanned（绕过摄像头，几何与解码已由 flow_scan_e2e 覆盖）
    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=NQT2024001&c=04'); 'ok'`);
    await sleep(2500);

    // 关键断言 1：没点任何按钮，unlock 已经发了
    out.afterScan = await page.evaluate(`({
      calls:(window.__calls||[]).filter(c=>c!=='user/balance'),
      unlocked:(window.__calls||[]).includes('goods/water/unlock'),
      screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
      state:document.querySelector('#stateTitle').textContent,
      sub:document.querySelector('#stateSub').textContent
    })`);

    // 关键断言 2：用户还没按开始，等一会儿不能跑到结算页
    await sleep(4000);
    out.waiting = await page.evaluate(snap);
    out.settleCallsWhileWaiting = await page.evaluate(
      `(window.__calls||[]).filter(c=>c==='order/afterPay/creating').length`);

    // 用户在机器上按「开始」，出水；再接 3 秒后点「结算」
    await page.evaluate(`window.__pressAt = Date.now(); 'ok'`);
    await sleep(3600);
    out.flowing = await page.evaluate(snap);
    await page.evaluate(`window.__finishAt = Date.now(); 'ok'`);
    await sleep(3000);
    out.done = await page.evaluate(snap);
    out.rows = await page.evaluate(`document.querySelector('#resultRows').textContent`);
    out.endWaterCalls = await page.evaluate(
      `(window.__calls||[]).filter(c=>c==='goods/endWater').length`);
    await page.shot(shot('auto-scan.png'));
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

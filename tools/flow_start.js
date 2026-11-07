const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

// 设备页三按钮回归：
// 用户要的是「扫码后设备页是【已就绪】，按钮写【开始接水】；点它切到【接水中】；
// 接水中还要有对应机器【暂停】【结算】的按钮」。
//
// 三条容易回退的点，这个脚本各守一条：
//  1) 已就绪必须能停留（不能一秒后自己跳接水中）—— 靠 sync.amount 相对解锁基线的增长判断，
//     identify 解锁即有值、workStatus 也早就是 2，这两样都不能当出水信号。
//  2) 点【开始接水】必须立刻切到「接水中」，不能等下一轮同步（1.2 秒后才变，用户会以为没反应）。
//  3) 出水后 *暂停* 要能停住「已接 N 秒」的计时。
const MOCK = `
(function(){
  let syncN = 0;
  window.__calls = [];
  window.__pressAt = 0;
  window.__finishAt = 0;
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
      if (!window.__pressAt) {
        // 与真机一致：解锁后 workStatus 就已经是 2、identify 也已经有值，
        // 但 amount 还是 0（一滴水没出）。用户说的「已就绪一秒就跳接水中」就是
        // 因为旧代码拿 identify / workStatus 当出水信号。
        data = {workStatus:2, identify:'IDENTIFY_A', amount:'0', status:0};
      } else if (!window.__finishAt) {
        data = {workStatus:2, identify:'IDENTIFY_A', amount:String(60*syncN), status:1};
      } else {
        data = {workStatus:3, identify:'IDENTIFY_A', amount:'300', status:2};
      }
      await new Promise(r=>setTimeout(r,80));
      return J(data);
    }
    if (p === 'order/afterPay/creating') {
      await new Promise(r=>setTimeout(r,300));
      return J({orderId:'ord_start_1', orderNo:'0620261106008888888888', orderStatus:1, payType:'15'});
    }
    if (p in D) { await new Promise(r=>setTimeout(r,60)); return J(D[p]); }
    return new Response(JSON.stringify({code:1,msg:'mock 未定义: '+p}),
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
    sub:document.querySelector('#stateSub').textContent,
    actionsVisible:!document.querySelector('#flowActions').classList.contains('hidden'),
    pauseLabel:document.querySelector('#btnPause').textContent,
    amount:document.querySelector('#flowAmount').textContent
  })`;
  try {
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
    await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef');
      localStorage.setItem('qk_phone','13800138000');
      localStorage.setItem('qk_auto','0');
      localStorage.setItem('qk_devices','[]'); 'ok'`);
    await page.S('Page.navigate', { url: base });
    await sleep(1200);

    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=NQT2024001&c=04'); 'ok'`);
    await sleep(2500);

    // 断言 1：已就绪必须站得住，按钮写「开始接水」。
    // 等待期只要「取消」—— 那时没水可暂停、也没单可结算，摆一个「结算」很怪。
    // 注意要等界面真的落到「已就绪」再快照：unlock 之前的那一瞬间三键条还没画出来，
    // 本地比线上慢一点，直接快照会拍到"条子整个隐藏"的中间态（曾误判过一次）。
    const snapWhenReady = `(async () => {
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('#stateTitle').textContent === '已就绪') break;
        await new Promise(r => setTimeout(r, 100));
      }
      return ${snap};
    })()`;
    out.ready = await page.evaluate(snapWhenReady);
    out.ready.waitOnlyCancel = await page.evaluate(
      `document.querySelector('#btnPause').classList.contains('hidden')
       && document.querySelector('#btnSettle').classList.contains('hidden')
       && !document.querySelector('#btnCancel').classList.contains('hidden')`);

    // 多等 4 秒 —— 旧代码这里已经跳成「接水中」了
    await sleep(4000);
    out.readyAfter5s = await page.evaluate(snap);

    // 断言 2：点 App 上的「开始接水」，界面要立刻切过去（不能等下一轮同步）
    await page.evaluate(`document.querySelector('#actionBtn').click(); 'ok'`);
    await sleep(300);
    out.afterStartClick = await page.evaluate(snap);
    await page.S('Page.captureScreenshot', { format: 'png' }).then(r =>
      require('fs').writeFileSync(shot('start-1-ready.png'), Buffer.from(r.data, 'base64'))).catch(() => { });

    // 断言 3：机器上按开始出水 → 接水中，且有「暂停/结算」按钮
    await page.evaluate(`window.__pressAt = Date.now(); 'ok'`);
    await sleep(3000);
    out.flowing = await page.evaluate(snap);
    await page.S('Page.captureScreenshot', { format: 'png' }).then(r =>
      require('fs').writeFileSync(shot('start-2-flowing.png'), Buffer.from(r.data, 'base64'))).catch(() => { });

    // 断言 4：点「暂停」，计时停住（amount 文本不再变）
    await page.evaluate(`document.querySelector('#btnPause').click(); 'ok'`);
    await sleep(200);
    const pausedA = await page.evaluate(snap);
    await sleep(2600);
    const pausedB = await page.evaluate(snap);
    out.pause = {
      state: pausedA.state, sub: pausedA.sub, label: pausedA.pauseLabel,
      amountFrozen: pausedA.amount === pausedB.amount,
      amountA: pausedA.amount, amountB: pausedB.amount
    };

    // 断言 5：点「结算」，走正常结算流程 → 结算页
    await page.evaluate(`window.__finishAt = Date.now();
      document.querySelector('#actionBtn').click(); 'ok'`);
    await sleep(4500);
    out.done = await page.evaluate(`({
      screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
      msg:document.querySelector('#resultMsg').textContent,
      rows:document.querySelector('#resultRows').textContent
    })`);
    out.calls = await page.evaluate(`(window.__calls||[]).filter(c=>c!=='user/balance')`);
    await page.S('Page.captureScreenshot', { format: 'png' }).then(r =>
      require('fs').writeFileSync(shot('start-3-result.png'), Buffer.from(r.data, 'base64'))).catch(() => { });
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

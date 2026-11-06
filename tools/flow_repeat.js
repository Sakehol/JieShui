const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

// 连续接水回归：
// 1) 结算那几秒页面不能还挂着可点的「结束接水」（用户报的"反应太慢"就是这个）
// 2) 结算完成后按返回 = 回首页，从首页能立刻再开一次
const MOCK = `
(function(){
  let syncTicks = 0, unlockCount = 0;
  const D = {
    'goods/normal/details': {goodsId:'10001', name:'3号饮水机', imei:'NQT2024001', shopId:'88',
      categoryCode:'04', orgName:'学生公寓 3 栋', isBluetooth:0, tradeMain:1, userShowUseWaterDetail:true,
      extAttr:'{"flowmeter":1}', serviceTelephone:'4006689966'},
    'goods/normal/skus': [
      {skuId:'101', name:'按量计费', price:'0.30', unit:'升', feature:'0.30 元/升', amount:'1'}
    ],
    'waterQuota/getActive': {show:true, text:'水卡余额 ¥12.50 · 享 8 折'},
    'user/balance': {tokenCoin:1250, integral:320, integralAmount:'3.20'},
    'goods/endWater': {},
    'payChannelRoute/addUserAfterPayChannel': {},
    'order/sync': {code:'0', messageId:'msg_99001'},
    'order/detail': {
      waterUse:{waterUseType:1, waterUseValueDesc:'0.2L'},
      tradeOrderItem:[{originPrice:'1.86', realPrice:'1.49'}],
      promotionList:[{promotionType:4, discountAmount:'0.19'},{promotionType:8, discountAmount:'0.18'}],
      payPrice:'1.49', payTypeName:'支付宝免密支付'
    },
    'user/checkLogin': {token:'mocktoken_0123456789abcdef'}
  };
  window.__calls = [];
  window.__btnLog = [];
  const J = (data) => new Response(JSON.stringify({code:0,msg:'成功',data}), {status:200,headers:{'Content-Type':'application/json'}});
  const realFetch = window.fetch;
  window.fetch = async function(url, opts){
    const path = String(url).replace('https://userapi.qiekj.com/','');
    if (path === 'goods/water/unlock') {
      unlockCount++; window.__calls.push(path);
      await new Promise(r=>setTimeout(r,50));
      return J({msgId:'m_'+unlockCount, orderNo:'QK'+unlockCount});
    }
    if (path === 'goods/water/sync') {
      window.__calls.push(path);
      syncTicks++;
      const done = !(syncTicks < 3);
      const data = done ? {workStatus:3, identify:'IDENTIFY_'+unlockCount, amount:'186', status:2}
                        : {workStatus:2, identify:'IDENTIFY_'+unlockCount, amount:String(60*syncTicks), status:1};
      // 水真正停下的时刻：从这一刻起按钮就不能再是「结束接水」
      if (done && !window.__settleAt) window.__settleAt = Date.now();
      await new Promise(r=>setTimeout(r,80));
      return J(data);
    }
    if (path === 'order/afterPay/creating') {
      window.__calls.push(path);
      // 故意放慢：模拟真实结算耗时，好在这段时间里采样按钮状态
      await new Promise(r=>setTimeout(r,900));
      return J({orderId:'ord_99001', orderNo:'0620261106004023612291', orderStatus:1, payType:'15'});
    }
    if (path in D) {
      window.__calls.push(path);
      await new Promise(r=>setTimeout(r,50));
      return J(D[path]);
    }
    return new Response(JSON.stringify({code:1,msg:'mock 未定义: '+path}), {status:200,headers:{'Content-Type':'application/json'}});
  };
  // 每秒采样一次按钮，记录结算期间它到底长什么样
  setInterval(() => {
    const b = document.querySelector('#actionBtn');
    if (b) window.__btnLog.push({t:Date.now(), text:b.textContent, disabled:b.disabled});
  }, 120);
})();
`;

module.exports = async (page, { sleep, url }) => {
  const out = {};
  const base = url || 'http://127.0.0.1:8899/index.html';
  const snap = `({
    screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
    btn:document.querySelector('#actionBtn').textContent,
    btnDisabled:document.querySelector('#actionBtn').disabled,
    state:document.querySelector('#stateTitle').textContent
  })`;
  try {
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
    await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef'); localStorage.setItem('qk_phone','13800138000'); localStorage.setItem('qk_auto','0'); localStorage.setItem('qk_devices', JSON.stringify([
      {goodsId:'10001', name:'3号饮水机', imei:'NQT2024001', shopId:'88', categoryCode:'04', shopName:'学生公寓 3 栋'}
    ])); 'ok'`);
    await page.S('Page.navigate', { url: base });
    await sleep(1200);

    // ---- 第一轮 ----
    await page.click('.device');
    await sleep(900);
    await page.click('#actionBtn');
    await sleep(6000);

    out.round1 = await page.evaluate(snap);
    // 只看「水已经停了」之后的采样：这段时间按钮必须是「结算中…/off」
    out.afterSettle = await page.evaluate(`(() => {
      const at = window.__settleAt || 0;
      const logs = (window.__btnLog||[]).filter(x => x.t >= at);
      const firstSettling = logs.find(x => x.text !== '结束接水');
      return {
        samples: logs.length,
        texts: [...new Set(logs.map(x => x.text + (x.disabled ? '/off' : '/ON')))],
        staleStopBtn: logs.filter(x => x.text === '结束接水').length,
        // 水停 → 按钮变成「结算中…」的延迟（含 mock 的 80ms 网络延时）
        switchDelayMs: firstSettling ? firstSettling.t - at : null
      };
    })()`);

    // ---- 结算页按返回 = 回首页 ----
    await page.evaluate(`history.back(); 'ok'`);
    await sleep(700);
    out.afterBack = await page.evaluate(snap);

    // ---- 从首页立刻再开一次 ----
    await page.evaluate(`window.__calls.length = 0; 'ok'`);
    await page.click('.device');
    await sleep(900);
    await page.click('#actionBtn');
    await sleep(6000);
    out.round2 = await page.evaluate(
      `({screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
         rows:document.querySelector('#resultRows').textContent,
         unlocks:(window.__calls||[]).filter(c=>c==='goods/water/unlock').length})`
    );
    await page.shot(shot('repeat-round2.png'));
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

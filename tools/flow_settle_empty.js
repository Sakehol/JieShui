const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

// 扫完码一滴水没接，直接在机器上点「结算」。
//
// 用户实测（截图）：结算页写着「水已停，但订单没有生成成功」，
// 订单号那一栏明晃晃一个 null。实际上他压根没出水，本来就不该有订单。
//
// 两个叠加的 bug：
// 1) goods/water/sync 在「没出水」时返回 identify: null（JSON null），
//    旧代码用「identify 非空」判断有没有接过水，null 被当成有值 →
//    判定为"接过水" → 去建订单 → 建不出来 → 显示「订单没有生成成功」。
//    APK 侧更狠：org.json 的 optString 会把 JSON null 转成字符串 "null"，
//    于是连 "null".isEmpty() 都是 false，还把这个 "null" 当订单号显示。
// 2) 机器上按了结算（workStatus 离开 2）但没出水时，旧代码不认这个信号，
//    要干等约 90 秒，最后说「没有在机器上按开始」——用户明明按了结算。
//
// 这个用例要求：立刻结束等待、文案说清「机器上已结算，本次没有出水」、
// 不建订单、不清单里不出现 null。
const MOCK = `
(function(){
  window.__calls = [];
  window.__settleAt = 0;
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
    'payChannelRoute/addUserAfterPayChannel': {}
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
      await new Promise(r=>setTimeout(r,80));
      // 关键：identify 是真正的 JSON null，不是空串 —— 服务端没出水时就是这样。
      // 机器在用户按下「结算」后从 0 变成 3。
      // 真机解锁后 workStatus 就已经是 2（屏幕写「设备已解锁 / 轻触【开始】键出水」），
      // 但没出水时 amount 仍是 0、identify 仍是 JSON null。这才是"扫码后没接水"的真实帧。
      if (!window.__settleAt) return J({workStatus:2, identify:'IDENTIFY_A', amount:'0', status:1});
      return J({workStatus:3, identify:null, amount:'0', status:3});
    }
    if (p in D) {
      await new Promise(r=>setTimeout(r,60));
      return J(D[p]);
    }
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

    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=NQT2024001&c=04'); 'ok'`);
    await sleep(2500);
    out.waiting = await page.evaluate(snap);

    // 用户在机器上直接点「结算」——一滴水都没放
    const endedAt = Date.now();
    await page.evaluate(`window.__settleAt = Date.now(); 'ok'`);
    // 只等 4 秒：旧代码会在这里干等 90 秒，所以能等出结果本身就是断言
    await sleep(4000);
    out.afterSettle = await page.evaluate(snap);
    out.settleLatencyMs = Date.now() - endedAt;

    out.settleCalls = await page.evaluate(
      `(window.__calls||[]).filter(c=>c==='order/afterPay/creating').length`);
    out.syncCalls = await page.evaluate(
      `(window.__calls||[]).filter(c=>c==='goods/water/sync').length`);
    // 结算页里的所有文字，用来断言没有 null 漏出来
    out.resultText = await page.evaluate(
      `(document.querySelector('#resultMsg')||{}).textContent + ' | ' +
       (document.querySelector('#resultRows')||{}).textContent`);
    out.hasNull = /(^|[^a-zA-Z])null([^a-zA-Z]|$)/.test(out.resultText || '');
    out.state = out.afterSettle.state;
    out.sub = out.afterSettle.sub;
    await page.shot(shot('settle-empty.png'));
  } catch (e) {
    out.ERR = String((e && e.stack) || e);
  }
  return out;
};

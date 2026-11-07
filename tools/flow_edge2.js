const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

// 恶性 bug 排查 2：网络失败与会话冲突
//
// 覆盖真实会撞到的三种"看起来正常、其实是错的"：
//   A) 结算阶段网络失败（afterPay/creating 500）—— 页面是否仍谎称"已结算"
//   B) 结算阶段 order/sync 一直返回非 0 —— 订单其实还挂着待支付
//   C) 等待期 sync 持续网络失败 —— 会不会永远停在「已就绪」
//   D) 会话进行中再次扫码 —— 当前设备是否被换掉，第二次 unlock 会不会发出去
const MOCK = `
(function(){
  const opts = () => { try { return JSON.parse(localStorage.getItem('__opts') || '{}'); } catch (_) { return {}; } };
  window.__opts = opts();
  window.__calls = [];
  window.__pressAt = 0;
  window.__settleAt = 0;
  const J = (data) => new Response(JSON.stringify({code:0,msg:'成功',data}),
    {status:200,headers:{'Content-Type':'application/json'}});
  const E = (code,msg) => new Response(JSON.stringify({code,msg}),
    {status:200,headers:{'Content-Type':'application/json'}});
  window.fetch = async function(url, init){
    const path = String(url).replace('https://userapi.qiekj.com/','');
    const o = opts();
    window.__calls.push(path);
    if (path === 'goods/water/unlock') {
      await new Promise(r=>setTimeout(r,60));
      return J({msgId:'m_1', orderNo:'0620261106000000000001'});
    }
    if (path === 'goods/water/sync') {
      if (o.syncNetFail) throw new TypeError('Failed to fetch');
      await new Promise(r=>setTimeout(r,50));
      // 解锁后 workStatus 就是 2 了，只是 amount 还是 0（用户没按开始、没出水）
      if (!window.__pressAt) return J({workStatus:0, identify:'IDENTIFY_A', amount:'0', status:1});
      if (!window.__settleAt) return J({workStatus:2, identify:'IDENTIFY_A', amount:'120', status:2});
      return J({workStatus:3, identify:'IDENTIFY_A', amount:'186', status:3});
    }
    if (path === 'order/afterPay/creating') {
      if (o.createFail) return E(5000, '服务开小差了，请稍后再试');
      await new Promise(r=>setTimeout(r,120));
      return J({orderId:'ord_99001', orderNo:'0620261106009999999999', orderStatus:1, payType:'15'});
    }
    if (path === 'order/sync') {
      if (o.syncNeverPaid) return J({code:'3', messageId:'msg_x'});
      return J({code:'0', messageId:'msg_99001'});
    }
    if (path === 'goods/scan/v2') {
      const b = String((init && init.body) || '');
      // 第二个二维码是另一台机器
      if (b.indexOf('NQT2024999') >= 0) return J({id:'10002', categoryCode:'04', categoryName:'4号饮水机', shopId:89, jumpToDevicePageFlag:false});
      return J({id:'10001', categoryCode:'04', categoryName:'3号饮水机', shopId:88, jumpToDevicePageFlag:false});
    }
    if (path === 'goods/normal/details') {
      const b = String((init && init.body) || '');
      const other = b.indexOf('10002') >= 0;
      return J({goodsId: other?'10002':'10001', name: other?'4号饮水机':'3号饮水机',
        imei: other?'NQT2024999':'NQT2024001', shopId: other?'89':'88',
        categoryCode:'04', orgName:'学生公寓 3 栋', isBluetooth:0, tradeMain:1});
    }
    if (path === 'goods/normal/skus') {
      const b = String((init && init.body) || '');
      return J([{skuId: b.indexOf('10002')>=0 ? '202' : '101', name:'按量计费', price:'0.30', unit:'升'}]);
    }
    if (path === 'waterQuota/getActive') return J({show:false});
    if (path === 'user/balance') return J({tokenCoin:1250});
    if (path === 'user/checkLogin') return J({token:'mocktoken_0123456789abcdef'});
    if (path === 'order/detail') return J({
      waterUse:{waterUseType:1, waterUseValueDesc:'0.5L'},
      tradeOrderItem:[{originPrice:'1.50', realPrice:'1.20'}],
      promotionList:[{promotionType:4, discountAmount:'0.30'}],
      payPrice:'1.20', payTypeName:'支付宝免密支付',
      // 默认不带 orderStatus：让 B 组能维持"订单还挂着"的状态。
      // E 组打开 detailPaid，模拟"order/sync 全落空但订单其实已经完成"。
      orderStatus: o.detailPaid ? 3 : 0
    });
    if (path === 'goods/endWater') {
      // 记下停的是哪台 —— 会话被顶掉时最容易停错机器
      window.__endWaters = window.__endWaters || [];
      window.__endWaters.push(String((init && init.body) || ''));
      return J({});
    }
    if (path === 'payChannelRoute/addUserAfterPayChannel') return J({});
    return J({});
  };
})();
`;

module.exports = async (page, { sleep, url }) => {
  const out = {};
  // 必须跟随命令行传进来的地址，不能写死 127.0.0.1。
  // 以前写死过一次，对着线上跑时 Page.navigate 会跳到本地地址，
  // 于是 localStorage 里的 __opts 根本没被读到，mock 静默失效 ——
  // 用例照样"通过"，但测的根本不是线上那份代码。
  const base = url || 'http://127.0.0.1:8899/index.html';

  const setup = async (opts) => {
    // 先确保当前文档是同源的，否则 localStorage 会抛 SecurityError
    // （about:blank 上读 localStorage 在部分 Chrome 版本是被拒的）。
    const stored = `localStorage.setItem('__opts', ${JSON.stringify(JSON.stringify(opts || {}))});
      localStorage.setItem('qk_token','mocktoken_0123456789abcdef');
      localStorage.setItem('qk_phone','13800138000');
      localStorage.setItem('qk_auto','0');
      localStorage.setItem('qk_devices','[]'); 'ok'`;
    for (let i = 0; i < 3; i++) {
      try { await page.evaluate(stored); return await finishSetup(); } catch (_) { }
      await page.S('Page.navigate', { url: base });
      await sleep(900);
    }
    await page.evaluate(stored);
    await finishSetup();
  };

  const finishSetup = async () => {
    await page.S('Page.navigate', { url: base });
    await sleep(1300);
    await page.evaluate(`window.__startWaitTicks = 4; 'ok'`);
  };

  const scan = async (sn) => {
    // 线上首屏比本地慢（要走 sw + 网络），等 app.js 真正执行完再调。
    for (let i = 0; i < 40; i++) {
      const ok = await page.evaluate(`typeof handleScanned === 'function'`);
      if (ok) break;
      await sleep(250);
    }
    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=${sn}&c=04'); 'ok'`);
    await sleep(1500);
  };

  const resultText = `({
    screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
    msg:(document.querySelector('#resultMsg')||{}).textContent,
    rows:(document.querySelector('#resultRows')||{}).textContent,
    state:(document.querySelector('#stateTitle')||{}).textContent,
    sub:(document.querySelector('#stateSub')||{}).textContent
  })`;

  try {
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });

    // ---------- A：afterPay/creating 失败 ----------
    await setup({ createFail: true });
    await scan('NQT2024001');
    await page.evaluate(`window.__pressAt = Date.now() + 100; 'ok'`);
    await sleep(2200);
    await page.evaluate(`window.__settleAt = Date.now(); 'ok'`);
    await sleep(3000);
    out.A_createFail = await page.evaluate(resultText);

    // ---------- B：order/sync 一直不成功 ----------
    await setup({ syncNeverPaid: true });
    await scan('NQT2024001');
    await page.evaluate(`window.__pressAt = Date.now() + 100; 'ok'`);
    await sleep(2200);
    await page.evaluate(`window.__settleAt = Date.now(); 'ok'`);
    await sleep(6000);
    out.B_neverPaid = await page.evaluate(resultText);

    // ---------- C：等待期 sync 一直网络失败 ----------
    await setup({ syncNetFail: true });
    await scan('NQT2024001');
    await sleep(9000);   // __startWaitTicks=4 → 约 5 秒就该放弃
    out.C_syncNetFail = await page.evaluate(`({
      state:(document.querySelector('#stateTitle')||{}).textContent,
      sub:(document.querySelector('#stateSub')||{}).textContent,
      btn:(document.querySelector('#actionBtn')||{}).textContent,
      syncCalls:(window.__calls||[]).filter(c=>c==='goods/water/sync').length
    })`);

    // ---------- D：等待期再扫另一台机器 ----------
    await setup({});
    await scan('NQT2024001');
    const before = await page.evaluate(`({
      devName:(document.querySelector('#devName')||{}).textContent,
      state:(document.querySelector('#stateTitle')||{}).textContent,
      unlockCount:(window.__calls||[]).filter(c=>c==='goods/water/unlock').length
    })`);
    await scan('NQT2024999');
    await sleep(1500);
    const endWaters = await page.evaluate(`JSON.stringify(window.__endWaters || [])`);
    out.D_rescanWhileWaiting = {
      before,
      after: await page.evaluate(`({
        devName:(document.querySelector('#devName')||{}).textContent,
        state:(document.querySelector('#stateTitle')||{}).textContent,
        btn:(document.querySelector('#actionBtn')||{}).textContent,
        unlockCount:(window.__calls||[]).filter(c=>c==='goods/water/unlock').length
      })`),
      // 关键断言：被顶掉的那一轮只能停自己那台（10001），绝不能停到新机器（10002）
      endWaters,
      stoppedOwnDeviceOnly: !/10002/.test(endWaters),
      stoppedOldDevice: /10001/.test(endWaters)
    };

    // ---------- E：order/sync 全落空，但订单在服务端其实已经完成 ----------
    // 这就是用户截图里的场景：接水一两秒就结算，支付宝已经扣款成功，
    // App 却写「支付还没确认」，还让人去官方 App 点"立即支付"——
    // 点开发现根本没有待支付订单。判据必须看订单状态，不能只看 sync 返回。
    await setup({ syncNeverPaid: true, detailPaid: true });
    await scan('NQT2024001');
    await page.evaluate(`window.__pressAt = Date.now() + 100; 'ok'`);
    await sleep(2200);
    await page.evaluate(`window.__settleAt = Date.now(); 'ok'`);
    await sleep(6000);
    out.E_paidViaDetail = await page.evaluate(resultText);

    await page.shot(shot('edge2.png'));
  } catch (e) {
    out.ERR = String((e && e.stack) || e);
  }
  return out;
};

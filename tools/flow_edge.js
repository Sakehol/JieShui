const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

// 边界/恶性 bug 排查：真实使用里会撞到、但常规流程测不到的分支
//
// 注意：mock 必须用 Page.addScriptToEvaluateOnNewDocument 注入，
// 不能先 page.evaluate 再 reload —— 那样 reload 会把覆盖掉的 fetch 清掉，
// 结果页面走真实网络、全程静默失败，看起来像"页面坏了"。
//
// 覆盖：
//   1) 结算页点「完成」回首页后，再按返回键 —— 会不会又被弹回结算页
//   2) 扫码自动开阀后、用户还没按开始（等待期）按返回键 —— 能不能退出
//   3) 自动开阀失败（unlock 报错）—— 停在什么状态，按钮能不能重试
//   4) 等待期掉登录（sync 返回 code 2）—— 会不会卡死在设备页
//   5) 取消后立刻重扫 —— 状态是否干净
//   6) 等待期内关闭页面（beforeunload）不需要测，改为测「反复点取消」幂等
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
      if (o.unlockFail) return E(5001, '设备离线，请稍后再试');
      await new Promise(r=>setTimeout(r,80));
      return J({msgId:'m_1', orderNo:'0620261106009999999999'});
    }
    if (path === 'goods/water/sync') {
      if (o.syncExpire) return E(2, '未登录');
      await new Promise(r=>setTimeout(r,60));
      // 解锁后 workStatus 就是 2 了，只是 amount 还是 0（用户没按开始、没出水）
      if (!window.__pressAt) return J({workStatus:2, identify:'IDENTIFY_A', amount:'0', status:1});
      if (!window.__settleAt) return J({workStatus:2, identify:'IDENTIFY_A', amount:'120', status:2});
      return J({workStatus:3, identify:'IDENTIFY_A', amount:'186', status:3});
    }
    if (path === 'order/afterPay/creating') {
      await new Promise(r=>setTimeout(r,180));
      return J({orderId:'ord_99001', orderNo:'0620261106009999999999', orderStatus:1, payType:'15'});
    }
    if (path === 'goods/scan/v2') return J({id:'10001', categoryCode:'04', categoryName:'3号饮水机', shopId:88, jumpToDevicePageFlag:false});
    if (path === 'goods/normal/details') return J({goodsId:'10001', name:'3号饮水机', imei:'NQT2024001', shopId:'88', categoryCode:'04', orgName:'学生公寓 3 栋', isBluetooth:0, tradeMain:1});
    if (path === 'goods/normal/skus') return J([{skuId:'101', name:'按量计费', price:'0.30', unit:'升'}]);
    if (path === 'waterQuota/getActive') return J({show:false});
    if (path === 'user/balance') return J({tokenCoin:1250});
    if (path === 'user/checkLogin') return J({token:'mocktoken_0123456789abcdef'});
    if (path === 'order/sync') return J({code:'0', messageId:'msg_99001'});
    if (path === 'order/detail') return J({
      waterUse:{waterUseType:1, waterUseValueDesc:'0.5L'},
      tradeOrderItem:[{originPrice:'1.50', realPrice:'1.20'}],
      promotionList:[{promotionType:4, discountAmount:'0.30'}],
      payPrice:'1.20', payTypeName:'支付宝免密支付'
    });
    if (path === 'goods/endWater') return J({});
    if (path === 'payChannelRoute/addUserAfterPayChannel') return J({});
    return J({});
  };
})();
`;

module.exports = async (page, { sleep, url }) => {
  const out = {};
  const base = url || 'http://127.0.0.1:8899/index.html';
  const snap = `({
    screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
    btn:(document.querySelector('#actionBtn')||{}).textContent,
    btnDisabled:(document.querySelector('#actionBtn')||{}).disabled,
    state:(document.querySelector('#stateTitle')||{}).textContent,
    sub:(document.querySelector('#stateSub')||{}).textContent,
    rows:(document.querySelector('#resultRows')||{}).textContent,
    hist:(history.state&&history.state.qk)||null
  })`;

  const setup = async (opts) => {
    await page.evaluate(`localStorage.setItem('__opts', ${JSON.stringify(JSON.stringify(opts || {}))});
      localStorage.setItem('qk_token','mocktoken_0123456789abcdef');
      localStorage.setItem('qk_phone','13800138000');
      localStorage.setItem('qk_auto','0');
      localStorage.setItem('qk_devices','[]'); 'ok'`);
    await page.S('Page.navigate', { url: base });
    await sleep(1300);
    await page.evaluate(`window.__startWaitTicks = 6; 'ok'`);
  };

  const scan = async () => {
    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=NQT2024001&c=04'); 'ok'`);
    await sleep(1600);
  };

  try {
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });

    // ---------- 用例 1：走完 → 点完成 → 返回键 ----------
    await setup({});
    await scan();
    await page.evaluate(`window.__pressAt = Date.now() + 100; 'ok'`);
    await sleep(2400);
    await page.evaluate(`window.__settleAt = Date.now(); 'ok'`);
    await sleep(3200);
    out.case1_result = await page.evaluate(snap);

    await page.click('#btnDone');
    await sleep(500);
    out.case1_home = await page.evaluate(snap);

    // ---------- 用例 2：等待期按返回键 ----------
    await setup({});
    await scan();
    out.case2_waiting = await page.evaluate(snap);
    const beforeLen = await page.evaluate(`history.length`);
    await page.evaluate(`history.back(); 'ok'`);
    await sleep(900);
    out.case2_afterBack = await page.evaluate(snap);
    out.case2_busyBlocks = { beforeLen, same: out.case2_waiting.screen.join() === out.case2_afterBack.screen.join() };

    // ---------- 用例 3：unlock 失败 ----------
    await setup({ unlockFail: true });
    await scan();
    await sleep(1400);
    out.case3_unlockFail = await page.evaluate(snap);
    const n0 = await page.evaluate(`(window.__calls||[]).filter(c=>c==='goods/water/unlock').length`);
    await page.click('#actionBtn');
    await sleep(1400);
    out.case3_retry = {
      unlockBefore: n0,
      unlockAfter: await page.evaluate(`(window.__calls||[]).filter(c=>c==='goods/water/unlock').length`),
      snap: await page.evaluate(snap)
    };

    // ---------- 用例 4：等待期掉登录 ----------
    await setup({ syncExpire: true });
    await scan();
    await sleep(3000);
    out.case4_sessionExpired = await page.evaluate(`({
      gateShown: !document.getElementById('gate').classList.contains('hidden'),
      appShown: !document.getElementById('app').classList.contains('hidden'),
      token: (localStorage.getItem('qk_token')||'').length
    })`);

    // ---------- 用例 5：取消后立刻重扫 ----------
    await setup({});
    await scan();
    out.case5_waiting = await page.evaluate(snap);
    await page.click('#actionBtn');                 // 取消
    await sleep(1400);
    out.case5_afterCancel = await page.evaluate(snap);
    await page.evaluate(`handleScanned('https://m.qiekj.com/s?SN=NQT2024001&c=04'); 'ok'`);
    await sleep(600);
    out.case5_rescan = await page.evaluate(`({
      screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
      state:(document.querySelector('#stateTitle')||{}).textContent,
      btn:(document.querySelector('#actionBtn')||{}).textContent,
      unlocks:(window.__calls||[]).filter(c=>c==='goods/water/unlock').length
    })`);

    await page.shot(shot('edge.png'));
  } catch (e) {
    out.ERR = String((e && e.stack) || e);
  }
  return out;
};

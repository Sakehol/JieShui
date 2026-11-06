const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

const MOCK = `
(function(){
  const D = {
    'goods/normal/details': {goodsId:'10001', name:'3号饮水机', imei:'NQT2024001', shopId:'88',
      categoryCode:'04', orgName:'学生公寓 3 栋', isBluetooth:0, tradeMain:1, userShowUseWaterDetail:true,
      extAttr:'{"flowmeter":1}', serviceTelephone:'4006689966'},
    'goods/normal/skus': [
      {skuId:'101', name:'按量计费', price:'0.30', unit:'升', feature:'0.30 元/升', amount:'1'},
      {skuId:'102', name:'包月畅饮', price:'19.90', unit:'月', feature:'30 天内不限量', amount:'30'}
    ],
    'waterQuota/getActive': {show:true, text:'水卡余额 ¥12.50 · 享 8 折'},
    'user/balance': {tokenCoin:1250, integral:320, integralAmount:'3.20'},
    'goods/water/unlock': {msgId:'m_7788', orderNo:'QK202411050001'},
    'goods/water/sync': {workStatus:2, identify:'IDENTIFY_ABC', amount:'186', status:1},
    'goods/endWater': {},
    'payChannelRoute/addUserAfterPayChannel': {},
    'order/afterPay/creating': {orderId:'ord_99001', orderNo:'0620261106004023612291', orderStatus:1, payType:'15'},
    // 官方 PayStateAct(mState=1) 调的就是它；code=="0" 才算支付成功
    'order/sync': {code:'0', messageId:'msg_99001'},
    // 真实结构：水量在 waterUse，金额在 tradeOrderItem[].originPrice / payPrice
    'order/detail': {
      waterUse:{waterUseType:1, waterUseValueDesc:'0.2L'},
      tradeOrderItem:[
        {originPrice:'1.78', realPrice:'1.49'},
        {originPrice:'0.08', realPrice:'0.00'}
      ],
      promotionList:[{promotionType:4, discountAmount:'0.19'},{promotionType:8, discountAmount:'0.18'}],
      payPrice:'1.49', payTypeName:'支付宝免密支付'
    },
    'user/checkLogin': {token:'mocktoken_0123456789abcdef'}
  };
  let syncTicks = 0;
  window.__calls = [];
  window.__bodies = {};
  const realFetch = window.fetch;
  window.fetch = async function(url, opts){
    const path = String(url).replace('https://userapi.qiekj.com/','');
    if (path in D) {
      window.__calls.push(path);
      try { window.__bodies[path] = decodeURIComponent(String((opts && opts.body) || '')); } catch(_) {}
      let data = D[path];
      if (path === 'goods/water/sync') {
        syncTicks++;
        data = syncTicks < 4 ? {workStatus:2, identify:'IDENTIFY_ABC', amount:String(60*syncTicks), status:1}
                             : {workStatus:3, identify:'IDENTIFY_ABC', amount:'186', status:2};
      }
      await new Promise(r=>setTimeout(r,120));
      return new Response(JSON.stringify({code:0,msg:'成功',data}), {status:200,headers:{'Content-Type':'application/json'}});
    }
    return new Response(JSON.stringify({code:1,msg:'mock 未定义: '+path}), {status:200,headers:{'Content-Type':'application/json'}});
  };
})();
`;

module.exports = async (page, { sleep }) => {
  await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
  await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef'); localStorage.setItem('qk_phone','13800138000'); localStorage.setItem('qk_auto','0'); localStorage.setItem('qk_devices', JSON.stringify([
    {goodsId:'10001', name:'3号饮水机', imei:'NQT2024001', shopId:'88', categoryCode:'04', shopName:'学生公寓 3 栋'}
  ])); 'ok'`);

  await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
  await sleep(1200);
  await page.shot(shot('home2.png'));

  // 点第一台设备
  await page.click('.device');
  await sleep(900);
  await page.shot(shot('device.png'));

  const state = await page.evaluate(`({title:document.querySelector('#stateTitle').textContent, meta:document.querySelector('#devMeta').textContent, skuCards:document.querySelectorAll('.sku').length, hasSkuList:!!document.querySelector('#skuList'), quota:document.querySelector('#quotaLine').textContent})`);

  // 开始接水
  await page.click('#actionBtn');
  await sleep(2600);
  await page.shot(shot('flowing.png'));

  await sleep(4200);
  await page.shot(shot('result.png'));
  const result = await page.evaluate(`({screen:[...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id), rows:document.querySelector('#resultRows').textContent})`);
  // 关键断言：结算链路必须调过 order/sync，否则订单会停在「待支付」
  const calls = await page.evaluate(`(window.__calls||[])`);
  // 全量返回：payChannelRoute 在 unlock 之前，只取尾部会把它切掉
  const bodies = await page.evaluate(`(window.__bodies||{})`);
  return { state, result, calls, synced: calls.includes('order/sync'),
           channelReg: calls.includes('payChannelRoute/addUserAfterPayChannel'),
           unlockBody: bodies['goods/water/unlock'] || '',
           syncBody: bodies['order/sync'] || '',
           chanBody: bodies['payChannelRoute/addUserAfterPayChannel'] || '' };
};

const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

/* 回归：登录后不应自动弹出扫码层。
   注意：token 现在必须被 mock 成"有效"，否则 user/balance 返回 code:2 会触发
   sessionExpired() 跳回登录页（那是另一个正确行为，别在这条用例里混测）。*/
const MOCK = `
(function(){
  const D = {
    'user/balance': {code:0, msg:'成功', data:{tokenCoin:1006, integral:30, integralAmount:'0.07'}},
    'user/checkLogin': {code:0, msg:'成功', data:null},
    'goods/latestUsed': {code:0, msg:'成功', data:[
      {goodsId:10001, goodsName:'3号饮水机', orgId:900001, orgName:'测试校区', categoryCode:'04'}
    ]}
  };
  window.fetch = async function(url){
    const p = String(url).replace('https://userapi.qiekj.com/','');
    await new Promise(r=>setTimeout(r,80));
    const body = D[p] || {code:0, msg:'成功', data:null};
    return new Response(JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}});
  };
})();
`;

module.exports = async (page, { sleep }) => {
  const out = {};
  try {
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });

    // 1) 预置登录态 + 断言「默认不自动扫码」
    await page.evaluate(`
      localStorage.clear();
      localStorage.setItem('qk_token', 'mocktoken_for_ui_test');
      localStorage.setItem('qk_phone', '13800138000');
      'ok'
    `);
    await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
    await sleep(1600);

    out.gateHidden = await page.evaluate(`document.querySelector('#gate').classList.contains('hidden')`);
    out.appShown = await page.evaluate(`!document.querySelector('#app').classList.contains('hidden')`);
    // 关键回归：登录后不应该自动弹出扫码层
    out.autoScanOff = await page.evaluate(`document.querySelector('#scanner').classList.contains('hidden')`);
    out.autoStartChecked = await page.evaluate(`document.querySelector('#autoStart').checked`);
    await page.shot(shot('pwa-noscan.png'));

    // 2) service worker 是否注册
    out.swCache = await page.evaluate(`(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return r ? 'registered' : 'none';
    })()`);
  } catch (e) {
    out.ERR = String((e && e.message) || e);
  }
  return out;
};

const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

/* 首页外观 + token 有效时的进入状态（mock 掉 user/balance / checkLogin，
   否则真实接口会返回 code:2，触发"登录已过期"跳回登录页） */
const MOCK = `
(function(){
  const D = {
    'user/balance': {tokenCoin:1006, integral:30, integralAmount:'0.07'},
    'user/checkLogin': {token:'mocktoken_0123456789abcdef'},
    'goods/latestUsed': []
  };
  window.fetch = async function(url){
    const path = String(url).replace('https://userapi.qiekj.com/','');
    const data = (path in D) ? D[path] : null;
    await new Promise(r=>setTimeout(r,60));
    return new Response(JSON.stringify({code:0,msg:'成功',data}), {status:200,headers:{'Content-Type':'application/json'}});
  };
})();
`;

module.exports = async (page, { sleep }) => {
  await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
  await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef');
    localStorage.setItem('qk_phone','13800138000');
    localStorage.setItem('qk_auto','0');
    localStorage.setItem('qk_pin','');
    localStorage.setItem('qk_devices', JSON.stringify([
    {goodsId:'10001', name:'3号饮水机（1F 东侧）', imei:'NQT2024001', shopId:'88', categoryCode:'04', shopName:'学生公寓 3 栋'},
    {goodsId:'10002', name:'5号饮水机（2F 茶水间）', imei:'NQT2024002', shopId:'88', categoryCode:'04', shopName:'学生公寓 3 栋'}
  ])); 'ok'`);
  await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
  await sleep(1500);

  const shots = [];
  await page.shot(shot('home.png'));
  shots.push('home');

  return {
    shots,
    hasApp: await page.evaluate(`!document.querySelector('#app').classList.contains('hidden')`),
    devices: await page.evaluate(`document.querySelectorAll('.device').length`),
    quota: await page.evaluate(`document.querySelector('#quotaBadge').textContent`)
  };
};

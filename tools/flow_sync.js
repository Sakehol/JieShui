const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

const MOCK = `
(function(){
  const D = {
    'goods/latestUsed': [
      {goodsId:'10001',goodsName:'3号饮水机',orgId:'7',orgName:'学生公寓 3 栋',categoryCode:'04',parentPointName:'3栋',workStatus:0},
      {goodsId:'10002',goodsName:'1号饮水机',orgId:'7',orgName:'教学楼 A',categoryCode:'04',parentPointName:'A座',workStatus:0}
    ],
    'user/balance': {tokenCoin:1250, integral:320, integralAmount:'3.20'}
  };
  window.__syncCalls = [];
  const realFetch = window.fetch;
  window.fetch = async function(url, opts){
    const path = String(url).replace('https://userapi.qiekj.com/','');
    if (path in D) {
      window.__syncCalls.push(path);
      await new Promise(r=>setTimeout(r,120));
      return new Response(JSON.stringify({code:0,msg:'成功',data:D[path]}), {status:200,headers:{'Content-Type':'application/json'}});
    }
    return new Response(JSON.stringify({code:1,msg:'mock 未定义: '+path}), {status:200,headers:{'Content-Type':'application/json'}});
  };
})();
`;

module.exports = async (page, { sleep }) => {
  await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
  await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef'); localStorage.setItem('qk_phone','13800138000'); localStorage.setItem('qk_auto','0'); localStorage.removeItem('qk_devices'); 'ok'`);
  await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
  await sleep(1200);
  await page.shot(shot('pwa-sync-1.png'));

  await page.click('#btnRefreshDevices');
  await sleep(900);
  await page.shot(shot('pwa-sync-2.png'));

  const devs = await page.evaluate(`JSON.parse(localStorage.getItem('qk_devices')||'[]').map(d=>d.name+'@'+(d.shopName||''))`);
  const calls = await page.evaluate(`window.__syncCalls.slice()`);

  // 再点第一台设备，确认同步出来的条目能进详情页
  await page.click('.device');
  await sleep(900);
  await page.shot(shot('pwa-sync-3.png'));

  return { devs, calls };
};

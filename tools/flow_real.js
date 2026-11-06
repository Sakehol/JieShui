/* 真机链路回归：需要自己的 token（不会提交进仓库）
   用法：QK_TOKEN=<你的token> QK_PHONE=<手机号> node tools/cdp.js flow ... tools/flow_real.js */
const TOKEN = process.env.QK_TOKEN || '';
const PHONE = process.env.QK_PHONE || '';
if (!TOKEN) { console.error('缺少 QK_TOKEN 环境变量，跳过真实链路回归'); }
const SHOT = process.env.SHOTS_DIR || (__dirname + '/../shots/');

module.exports = async (page, { sleep }) => {
  await page.evaluate(`localStorage.setItem('qk_token','${TOKEN}'); localStorage.setItem('qk_phone','${PHONE}'); localStorage.setItem('qk_auto','0'); localStorage.removeItem('qk_devices'); 'ok'`);
  await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
  await sleep(1600);

  await page.click('#btnRefreshDevices');
  await sleep(2600);
  await page.shot(SHOT + 'pwa-real-sync.png');

  const devs = await page.evaluate(`JSON.parse(localStorage.getItem('qk_devices')||'[]').map(d=>d.name+'@'+(d.shopName||''))`);

  await page.click('.device');
  await sleep(3200);
  await page.shot(SHOT + 'pwa-real-device.png');

  const state = await page.evaluate(`({
    title: (document.querySelector('#devName')||{}).innerText||'',
    meta: (document.querySelector('#devMeta')||{}).innerText||'',
    quota: (document.querySelector('#quota')||{}).innerText||'',
    skus: document.querySelectorAll('#skuList > *').length,
    st: (document.querySelector('#stateTitle')||{}).innerText||''
  })`);

  return { devs, state };
};

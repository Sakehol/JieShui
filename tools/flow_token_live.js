/* 线上 token 持久化回归：需要自己的 token
   用法：QK_TOKEN=<你的token> QK_PHONE=<手机号> node tools/cdp.js flow ... tools/flow_token_live.js */
module.exports = async (page, { sleep }) => {
  const P = process.env.SHOTS_DIR || (__dirname + '/../shots/');
  const TOKEN = process.env.QK_TOKEN || '';
  const PHONE = process.env.QK_PHONE || '';
  if (!TOKEN) return { skipped: 'missing QK_TOKEN' };
  const out = {};
  await page.evaluate(`localStorage.setItem('qk_token','${TOKEN}');localStorage.setItem('qk_phone','${PHONE}');localStorage.setItem('qk_auto','0');'ok'`);
  await page.S('Page.navigate', { url: 'https://jieshui.pages.dev/index.html' });
  await sleep(2500);
  out.appShown = await page.evaluate(`!document.querySelector('#app').classList.contains('hidden')`);
  await page.evaluate(`document.querySelector('#btnSettings').click();'ok'`);
  await sleep(500);
  out.hasBtn = await page.evaluate(`!!document.querySelector('#btnShowToken')`);
  await page.evaluate(`document.querySelector('#btnShowToken').click();'ok'`);
  await sleep(400);
  out.full = await page.evaluate(`document.querySelector('#tokenFull').value`);
  await page.shot(P + 'live-token-copy.png');
  return out;
};

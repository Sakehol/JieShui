const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

module.exports = async (page, { sleep }) => {
  // 清空历史 mock 状态，回到首次打开的登录页
  await page.evaluate(`localStorage.clear(); 'ok'`);
  await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
  await sleep(1200);
  await page.shot(shot('pwa-login.png'));

  const out = {
    gateVisible: await page.evaluate(`!document.querySelector('#gate').classList.contains('hidden')`),
    appHidden: await page.evaluate(`document.querySelector('#app').classList.contains('hidden')`),
    tokenBoxHiddenInitially: await page.evaluate(`document.querySelector('#tokenBox').classList.contains('hidden')`),
    hasTabs: await page.evaluate(`document.querySelectorAll('.tab').length`)
  };

  // 展开「已有 Token？改用 Token 登录」
  await page.evaluate(`document.querySelector('#advToken').click(); 'ok'`);
  await sleep(400);
  await page.shot(shot('pwa-token.png'));
  out.tokenBoxShownAfterClick = await page.evaluate(`!document.querySelector('#tokenBox').classList.contains('hidden')`);

  return out;
};

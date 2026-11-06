const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

module.exports = async (page, { sleep }) => {
  const out = {};
  await page.evaluate(`
    localStorage.clear();
    localStorage.setItem('qk_token', 'mocktoken_for_ui_test');
    localStorage.setItem('qk_phone', '13800138000');
    'ok'
  `);
  await page.S('Page.navigate', { url: 'https://jieshui.pages.dev/' });
  await sleep(2000);

  out.title = await page.evaluate(`document.title`);
  out.gateHidden = await page.evaluate(`document.querySelector('#gate').classList.contains('hidden')`);
  out.appShown = await page.evaluate(`!document.querySelector('#app').classList.contains('hidden')`);
  out.autoScanOff = await page.evaluate(`document.querySelector('#scanner').classList.contains('hidden')`);
  out.hasTabs = await page.evaluate(`document.querySelectorAll('.tab').length`);
  out.tokenBoxFolded = await page.evaluate(`document.querySelector('#tokenBox').classList.contains('hidden')`);
  out.advText = await page.evaluate(`(document.querySelector('#advToken')||{}).textContent || ''`);
  await page.shot(shot('live-v3.png'));
  return out;
};

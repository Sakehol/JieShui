/* 取证页冒烟：页面能开、脚本能跑、设备列表能读出来、按钮状态对 */
module.exports = async (page, { sleep, url }) => {
  const out = {};
  const target = (url || 'http://127.0.0.1:8899').replace(/\/index\.html$/, '') + '/capture.html';
  try {
    await page.S('Page.navigate', { url: target });
    await sleep(1500);

    out.title = await page.evaluate(`document.querySelector('h1') && document.querySelector('h1').textContent`);
    out.hasSelect = await page.evaluate(`!!document.querySelector('#devSel')`);
    out.hasLog = await page.evaluate(`!!document.querySelector('#log')`);
    out.noTokenHint = await page.evaluate(`document.querySelector('#log').textContent.indexOf('没有 token') >= 0`);

    // 六个按钮必须都在
    out.btns = await page.evaluate(`['#btnUnlock','#btnStart','#btnMark','#btnStop','#btnCopy','#btnClear'].map(s => !!document.querySelector(s))`);

    // 注入假设备和假 token，确认设备下拉能读出来
    await page.evaluate(`
      localStorage.setItem('qk_devices', JSON.stringify([{goodsId:'1101521735', name:'测试机', imei:'1', shopId:'1', categoryCode:'04'}]));
      sessionStorage.setItem('qk_token_session', 'fake-token-for-smoke');
      location.reload();
    `);
    await sleep(1800);

    out.devOptions = await page.evaluate(`document.querySelectorAll('#devSel option').length`);
    out.devLabel = await page.evaluate(`document.querySelector('#devSel option').textContent`);

    // 取 skus 会失败（假 token），此时「解锁」必须仍禁用，不能让人点了没反应
    out.unlockDisabled = await page.evaluate(`document.querySelector('#btnUnlock').disabled`);
    out.startDisabled = await page.evaluate(`document.querySelector('#btnStart').disabled`);

    // 点「开始记录」应被拒绝并给提示
    await page.click('#btnStart');
    await sleep(600);
    out.logTail = await page.evaluate(`document.querySelector('#log').textContent.slice(-200)`);

    // 复制按钮在没有内容时不应崩
    await page.click('#btnCopy');
    await sleep(400);
    out.copyStillThere = await page.evaluate(`document.querySelector('#btnCopy').textContent`);
    out.clearedOk = await page.evaluate(`(function(){document.querySelector('#btnClear').click();return document.querySelector('#log').textContent.length;})()`);

    out.ok = !!out.hasSelect && !!out.hasLog && out.noTokenHint === true
      && out.btns.every(Boolean) && out.devOptions >= 1;
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

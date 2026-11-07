/* 取证页冒烟：页面能开、脚本能跑、设备列表能读出来、按钮状态对
   v2：只剩一个「开始」按钮（开阀 + 记录合一），另加实时状态卡 #live */
module.exports = async (page, { sleep, url }) => {
  const out = {};
  const target = (url || 'http://127.0.0.1:8899').replace(/\/index\.html$/, '') + '/capture.html';
  try {
    await page.S('Page.navigate', { url: target });
    await sleep(1500);

    out.title = await page.evaluate(`document.querySelector('h1') && document.querySelector('h1').textContent`);
    out.hasSelect = await page.evaluate(`!!document.querySelector('#devSel')`);
    out.hasLog = await page.evaluate(`!!document.querySelector('#log')`);
    out.hasLive = await page.evaluate(`!!document.querySelector('#live')`);
    out.noTokenHint = await page.evaluate(`document.querySelector('#log').textContent.indexOf('没有 token') >= 0`);

    // 四个按钮必须都在（v2 去掉了「解锁」和「清空」）
    out.btns = await page.evaluate(`['#btnGo','#btnMark','#btnStop','#btnCopy'].map(s => !!document.querySelector(s))`);
    out.oldBtnsGone = await page.evaluate(`!document.querySelector('#btnUnlock') && !document.querySelector('#btnStart')`);

    // 注入假设备和假 token，确认设备下拉能读出来
    await page.evaluate(`
      localStorage.setItem('qk_devices', JSON.stringify([{goodsId:'1101521735', name:'测试机', imei:'1', shopId:'1', categoryCode:'04'}]));
      sessionStorage.setItem('qk_token_session', 'fake-token-for-smoke');
      location.reload();
    `);
    await sleep(1800);

    out.devOptions = await page.evaluate(`document.querySelectorAll('#devSel option').length`);
    out.devLabel = await page.evaluate(`document.querySelector('#devSel option').textContent`);

    // 取 skus 会失败（假 token），此时「开始」必须仍禁用，不能让人点了没反应
    out.goDisabled = await page.evaluate(`document.querySelector('#btnGo').disabled`);
    out.stopDisabled = await page.evaluate(`document.querySelector('#btnStop').disabled`);

    // 点「开始」应被拒绝并给提示（没有 curSku）
    await page.click('#btnGo');
    await sleep(600);
    out.logTail = await page.evaluate(`document.querySelector('#log').textContent.slice(-200)`);
    out.rejectedWithoutSku = out.logTail.indexOf('计费方式') >= 0;

    // 复制按钮在没有内容时不应崩
    await page.click('#btnCopy');
    await sleep(400);
    out.copyStillThere = await page.evaluate(`document.querySelector('#btnCopy').textContent`);

    // 标记按钮要能打出一行分隔（v3：四个按键标记 + 一个手动标记）
    await page.click('#btnMark');
    await sleep(300);
    out.markLine = await page.evaluate(`document.querySelector('#log').textContent.indexOf('手动标记') >= 0`);
    out.mkBtns = await page.evaluate(`['#mkStart','#mkPause','#mkResume','#mkEnd'].map(s => !!document.querySelector(s))`);
    await page.click('#mkStart');
    await sleep(300);
    out.mkLine = await page.evaluate(`document.querySelector('#log').textContent.indexOf('我按了【开始】') >= 0`);

    out.ok = !!out.hasSelect && !!out.hasLog && !!out.hasLive && out.noTokenHint === true
      && out.btns.every(Boolean) && out.oldBtnsGone === true
      && out.devOptions >= 1 && out.goDisabled === true
      && out.rejectedWithoutSku === true && out.markLine === true
      && out.mkBtns.every(Boolean) && out.mkLine === true;
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

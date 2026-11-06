const MOCK = `
(function(){
  const ok = d => new Response(JSON.stringify({code:0,msg:'成功',data:d}),{status:200,headers:{'Content-Type':'application/json'}});
  window.fetch = async function(url){
    const p = String(url).replace('https://userapi.qiekj.com/','');
    if (p === 'user/checkLogin') return ok({token:'TEST_TOKEN_000000000000000000000000000'});
    if (p === 'user/balance') return ok({tokenCoin:1006,integral:30,integralAmount:'0.07'});
    return ok(null);
  };
})();
`;

module.exports = async (page, { sleep }) => {
  const P = process.env.SHOTS_DIR || (__dirname + '/../shots/');
  const out = {};
  await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
  await page.evaluate(`localStorage.setItem('qk_token','TEST_TOKEN_000000000000000000000000000');localStorage.setItem('qk_phone','13800138000');localStorage.setItem('qk_auto','0');'ok'`);
  await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
  await sleep(1500);

  out.appShown = await page.evaluate(`!document.querySelector('#app').classList.contains('hidden')`);
  await page.evaluate(`document.querySelector('#btnSettings').click();'ok'`);
  await sleep(400);
  out.masked = await page.evaluate(`document.querySelector('#setToken').textContent`);
  out.boxHiddenBefore = await page.evaluate(`document.querySelector('#tokenFullBox').classList.contains('hidden')`);

  await page.evaluate(`document.querySelector('#btnShowToken').click();'ok'`);
  await sleep(350);
  out.boxShownAfter = await page.evaluate(`!document.querySelector('#tokenFullBox').classList.contains('hidden')`);
  out.full = await page.evaluate(`document.querySelector('#tokenFull').value`);
  out.readonly = await page.evaluate(`document.querySelector('#tokenFull').readOnly`);
  await page.shot(P + 'pwa-token-copy.png');

  await page.evaluate(`document.querySelector('#btnCopyToken').click();'ok'`);
  await sleep(450);
  out.toast = await page.evaluate(`(()=>{const t=document.querySelector('#toast');return t.classList.contains('hidden')?null:t.textContent;})()`);
  out.clipboard = await page.evaluate(`navigator.clipboard.readText().then(t=>t).catch(e=>'ERR:'+e.message)`);
  await page.shot(P + 'pwa-token-copied.png');

  await page.evaluate(`document.querySelector('#btnHideToken').click();'ok'`);
  await sleep(250);
  out.boxHiddenAfterHide = await page.evaluate(`document.querySelector('#tokenFullBox').classList.contains('hidden')`);
  return out;
};

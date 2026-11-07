// 登录页「记住登录」：必须在第一屏可见、默认勾选、且选择要真的决定 token 落盘位置。
// 以前的坑：默认不记住 → 每次重开都要重登；开关只在设置里 → 没人发现。
// 注意：mock 必须在最后那次 reload 之后注入，reload 会把 window.fetch 覆盖清掉。
module.exports = async function (page) {
  const out = {};
  const MOCK = `
    window.__calls = [];
    window.fetch = async (u, o) => {
      window.__calls.push(String(u));
      const body = String((o && o.body) || '');
      const isReg = String(u).indexOf('/user/reg') >= 0;
      const payload = { code: 0, data: isReg ? { token: 'TESTTOKEN0123456789' } : {} };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };
  `;
  async function fresh() {
    await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
    await new Promise(r => setTimeout(r, 700));
    await page.evaluate('localStorage.clear(); sessionStorage.clear();');
    await page.S('Page.reload', { ignoreCache: true });
    await new Promise(r => setTimeout(r, 800));
    await page.evaluate(MOCK);
  }
  try {
    await fresh();
    out.gateVisible = await page.evaluate(`!document.querySelector('#gate').classList.contains('hidden')`);
    out.boxInGate = await page.evaluate(`!!document.querySelector('#gate #rememberGate')`);
    out.checkedByDefault = await page.evaluate(`document.querySelector('#rememberGate').checked`);

    // ① 取消勾选 → token 只进 sessionStorage
    await page.evaluate(`const g=document.querySelector('#rememberGate');
      g.checked=false; g.dispatchEvent(new Event('change'));`);
    await page.evaluate(`document.querySelector('#phone').value='13800138000';
      document.querySelector('#code').value='1234';
      document.querySelector('#doLogin').click();`);
    await new Promise(r => setTimeout(r, 600));
    out.calls1 = await page.evaluate(`JSON.stringify(window.__calls || [])`);
    out.toast1 = await page.evaluate(`document.querySelector('#toast').textContent`);
    out.noRemember = await page.evaluate(`JSON.stringify({
      ls: localStorage.getItem('qk_token'),
      ss: !!sessionStorage.getItem('qk_token_session'),
      flag: localStorage.getItem('qk_remember'),
      app: !document.querySelector('#app').classList.contains('hidden')
    })`);

    // ② 默认（勾选）→ token 落 localStorage
    await fresh();
    out.defaultCheckedAgain = await page.evaluate(`document.querySelector('#rememberGate').checked`);
    await page.evaluate(`document.querySelector('#phone').value='13800138000';
      document.querySelector('#code').value='1234';
      document.querySelector('#doLogin').click();`);
    await new Promise(r => setTimeout(r, 600));
    out.withRemember = await page.evaluate(`JSON.stringify({
      ls: localStorage.getItem('qk_token'),
      ss: !!sessionStorage.getItem('qk_token_session'),
      flag: localStorage.getItem('qk_remember'),
      app: !document.querySelector('#app').classList.contains('hidden')
    })`);
    out.syncedWithSettings = await page.evaluate(`document.querySelector('#remember').checked`);
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

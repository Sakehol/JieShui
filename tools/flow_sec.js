const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

// 验证网页端 token 防盗：
//   1) 默认不把 token 写进 localStorage（只落 sessionStorage）
//   2) 勾上「记住登录」后才落 localStorage，取消后立刻清掉
//   3) CSP 收紧后页面仍正常（无 console 报错，状态环靠 CSS 变量渲染）
const out = {};

const MOCK = `
window.__calls = [];
window.fetch = async (url) => {
  const path = String(url).replace('https://userapi.qiekj.com/', '');
  window.__calls.push(path);
  const ok = (data) => new Response(JSON.stringify({ code: 0, msg: 'ok', data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path === 'common/sms/sendCode') return ok(null);
  if (path === 'user/reg') return ok({ token: 'TEST_TOKEN_000000000000000000000000000', newRegister: false, forcedBind: false });
  if (path === 'user/checkLogin') return ok({ token: 'TEST_TOKEN_000000000000000000000000000' });
  if (path === 'user/balance') return ok({ tokenCoin: 1006, integral: 30, integralAmount: '0.07' });
  if (path === 'goods/latestUsed') return ok([]);
  if (path === 'goods/normal/details') return ok({ name: '测试饮水机', imei: 'NQT2024001', shopId: '900000000000001', orgId: 900001, categoryCode: '04', isBluetooth: 0 });
  if (path === 'goods/normal/skus') return ok([{ skuId: 1057235858, name: '饮水', price: '1.00', unit: '2.3', extAttr: '{"baseFare":"1","level":[{"amount":"0","price":"0.2"}],"minCount":10}' }]);
  if (path === 'waterQuota/getActive') return ok({ show: true, text: '水卡余额 12.50' });
  return ok(null);
};
`;

module.exports = async function (page) {
  try {
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });

    // 先清干净再重新加载，确保从「未登录」开始
    out.beforeClear = await page.evaluate('localStorage.getItem("qk_remember")');
    await page.evaluate('try{localStorage.clear();sessionStorage.clear();}catch(e){}');
    await page.S('Page.reload', { ignoreCache: true });
    await page.waitFor(1200);
    await page.waitFor('#gate', 8000);
    await page.waitFor(600);

    // 通过「粘贴 Token」登录，避开短信
    await page.evaluate(`(() => {
      const adv = document.getElementById('advToken'); if (adv) adv.click();
      const box = document.getElementById('tokenBox'); if (box) box.classList.remove('hidden');
      const ti = document.getElementById('tokenInput'); if (ti) ti.value = 'TEST_TOKEN_000000000000000000000000000';
      const bt = document.getElementById('useToken'); if (bt) bt.click();
    })()`);
    await page.waitFor("#app:not(.hidden)", 8000);
    await page.waitFor(900);

    out.lsTokenAfterLogin = await page.evaluate("localStorage.getItem('qk_token')");
    out.ssTokenAfterLogin = await page.evaluate("sessionStorage.getItem('qk_token_session') ? 'present' : null");
    out.appShown = await page.evaluate("!document.getElementById('app').classList.contains('hidden')");
    out.rememberChecked = await page.evaluate("document.getElementById('remember').checked");

    // 打开设置抽屉，确认 CSP 收紧后 UI 仍正常
    await page.evaluate("document.getElementById('btnSettings').click()");
    await page.waitFor(500);
    out.settingsShown = await page.evaluate("!document.getElementById('settings').classList.contains('hidden')");
    await page.shot(shot('sec-web-1-settings.png'));

    // 勾上「记住登录」
    await page.evaluate(`(() => {
      const r = document.getElementById('remember');
      r.checked = true;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.waitFor(500);
    out.lsTokenAfterRemember = await page.evaluate("localStorage.getItem('qk_token') ? 'present' : null");
    out.rememberFlag = await page.evaluate("localStorage.getItem('qk_remember')");

    // 取消勾选 → 立刻清掉 localStorage 里的 token
    await page.evaluate(`(() => {
      const r = document.getElementById('remember');
      r.checked = false;
      r.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.waitFor(500);
    out.lsTokenAfterUnremember = await page.evaluate("localStorage.getItem('qk_token')");
    out.ssTokenStillThere = await page.evaluate("sessionStorage.getItem('qk_token_session') ? 'present' : null");

    // 状态环：确认 CSS 变量这条路能生效（CSP 去掉 unsafe-inline 后的关键回归点）
    out.ringDeg = await page.evaluate(`(() => {
      const el = document.getElementById('stateRing');
      if (!el) return 'no-el';
      el.style.setProperty('--deg', '123deg');
      return getComputedStyle(el).getPropertyValue('--deg').trim();
    })()`);

    out.consoleErrors = (page.logs || []).filter(x => x.startsWith('[error]') || x.startsWith('[log:error]')).slice(0, 8);
  } catch (e) {
    out.ERR = e && e.message;
  }
  return out;
};

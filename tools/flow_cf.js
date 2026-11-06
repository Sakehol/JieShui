// Cloudflare Pages 上验证：响应头级 CSP 生效、token 不落盘、状态环正常、404 页正确
const out = {};
module.exports = async function (page) {
  try {
    await page.evaluate('try{localStorage.clear();sessionStorage.clear();}catch(e){}');
    await page.S('Page.reload', { ignoreCache: true });
    await page.waitFor(1600);
    out.title = await page.evaluate('document.title');
    out.gate = await page.evaluate("!document.getElementById('gate').classList.contains('hidden')");
    out.hasRemember = await page.evaluate("!!document.getElementById('remember')");
    out.lsToken = await page.evaluate("localStorage.getItem('qk_token')");
    out.inlineStyleTags = await page.evaluate("document.querySelectorAll('style').length");
    out.ringVar = await page.evaluate(`(()=>{const e=document.getElementById('stateRing');if(!e)return 'no-el';e.style.setProperty('--deg','91deg');return getComputedStyle(e).getPropertyValue('--deg').trim();})()`);
    out.swVersion = await page.evaluate("(async()=>{const r=await fetch('sw.js',{cache:'no-store'});const t=await r.text();const m=t.match(/qk-v\\d+/);return m?m[0]:'none';})()");
    out.errs = (page.logs || []).filter(x => x.startsWith('[error]') || x.startsWith('[log:error]')).slice(0, 6);
  } catch (e) { out.ERR = e.message; }
  return out;
};

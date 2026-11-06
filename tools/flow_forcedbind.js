const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

const MOCK = `
(function(){
  const realFetch = window.fetch;
  window.fetch = async function(url, opts){
    const path = String(url).replace('https://userapi.qiekj.com/','');
    if (path === 'user/reg') {
      return new Response(JSON.stringify({code:0,msg:'成功',data:{token:null,newRegister:false,forcedBind:true}}),
        {status:200,headers:{'Content-Type':'application/json'}});
    }
    return new Response(JSON.stringify({code:1,msg:'mock 未定义: '+path}), {status:200,headers:{'Content-Type':'application/json'}});
  };
})();
`;
module.exports = async (page, { sleep }) => {
  await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
  await page.evaluate(`localStorage.clear(); 'ok'`);
  await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
  await sleep(1100);
  await page.evaluate(`document.querySelector('#phone').value='13800138000';
    document.querySelector('#code').value='123456'; 'ok'`);
  await page.click('#doLogin');
  await sleep(800);
  await page.shot(shot('pwa-forcedbind.png'));
  const t = await page.evaluate(`(document.querySelector('.toast')||{}).textContent || ''`);
  return { toast: t };
};

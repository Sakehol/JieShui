// 竖屏原生流（720x1280）+ 二维码只占取景窗的 14%：
// 这是真机上最真实的情况 —— 手机竖着拿、安卓给的却是各种方向的流。
// 检验"正方形取景窗 + 原生像素 ROI"能不能认出来。
const QR_B64 = require('fs').readFileSync('build/qr_b64.txt', 'utf8').trim();

const MOCK = `
(function(){
  const D = {
    'goods/scan/v2': {id:'10001', categoryCode:'04', categoryName:'饮水机', shopId:88, jumpToDevicePageFlag:false, jumpToAlipayFlag2:false},
    'goods/normal/details': {goodsId:'10001', name:'3号饮水机', imei:'NQT2024001', shopId:'88',
      categoryCode:'04', orgName:'学生公寓 3 栋', isBluetooth:0, tradeMain:1},
    'goods/normal/skus': [{skuId:'101', name:'按量计费', price:'0.30', unit:'升', feature:'0.30 元/升'}],
    'waterQuota/getActive': {show:true, text:'水卡余额 ¥12.50 · 享 8 折'},
    'user/balance': {tokenCoin:1250}
  };
  window.fetch = async function(url){
    const path = String(url).replace('https://userapi.qiekj.com/','');
    const data = (path in D) ? D[path] : {};
    return new Response(JSON.stringify({code:0,msg:'成功',data}),
      {status:200,headers:{'Content-Type':'application/json'}});
  };
})();`;

module.exports = async (page, { sleep }) => {
  const out = {};
  try {
    await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
    await sleep(1000);
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
    await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef');
      localStorage.setItem('qk_phone','13800138000'); 'ok'`);
    await page.S('Page.reload', { ignoreCache: true });
    await sleep(1400);

    await page.evaluate(`document.querySelector('#scanBtn').click(); 'ok'`);
    await sleep(2400);

    // 换成竖屏合成流，码占取景窗 14%
    out.inject = await page.evaluate(`(async () => {
      const b64 = ${JSON.stringify(QR_B64)};
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
      const W = 720, H = 1280;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const roiSide = Math.min(W, H);          // 取景窗显示的就是中心这块
      const side = Math.round(roiSide * 0.14);
      (function draw() {
        ctx.fillStyle = '#6b6b6b'; ctx.fillRect(0, 0, W, H);
        // 画在整幅的中心（也就是取景窗中心）
        ctx.drawImage(img, W / 2 - side / 2, H / 2 - side / 2, side, side);
        requestAnimationFrame(draw);
      })();
      const v = document.querySelector('#video');
      if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
      v.srcObject = cv.captureStream(20);
      await v.play().catch(() => {});
      await new Promise(r => setTimeout(r, 300));
      return { qrPx: side, videoW: v.videoWidth, videoH: v.videoHeight };
    })()`);

    await sleep(4500);

    out.after = await page.evaluate(`({
      scannerClosed: document.querySelector('#scanner').classList.contains('hidden'),
      screen: [...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
      devName: (document.querySelector('#devName')||{}).textContent || ''
    })`);
  } catch (e) { out.ERR = String(e && e.stack || e); }
  return out;
};

// 扫码端到端：把合成好的摄像头画面（真二维码 + 灰背景）接进 video.srcObject，
// 让真实的 tickScan() 去解，验证从"看到二维码"到"进设备页"整条链路。
//
// 二维码只占画面高度 12% —— 按老参数（整幅压到 480）这是认不出的，
// 用来证明新加的中间裁切那一遍确实起作用。
const QR_B64 = require('fs').readFileSync('build/qr_b64.txt', 'utf8').trim();

const MOCK = `
(function(){
  const D = {
    'goods/scan/v2': {id:'10001', categoryCode:'04', categoryName:'饮水机', shopId:88, jumpToDevicePageFlag:false, jumpToAlipayFlag2:false},
    'goods/normal/details': {goodsId:'10001', name:'3号饮水机', imei:'NQT2024001', shopId:'88',
      categoryCode:'04', orgName:'学生公寓 3 栋', isBluetooth:0, tradeMain:1},
    'goods/normal/skus': [{skuId:'101', name:'按量计费', price:'0.30', unit:'升', feature:'0.30 元/升'}],
    'waterQuota/getActive': {show:true, text:'水卡余额 ¥12.50 · 享 8 折'},
    'user/balance': {tokenCoin:1250},
    'user/checkLogin': {}
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
    await sleep(1200);
    await page.S('Page.addScriptToEvaluateOnNewDocument', { source: MOCK });
    await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef');
      localStorage.setItem('qk_phone','13800138000'); 'ok'`);
    await page.S('Page.reload', { ignoreCache: true });
    await sleep(1400);

    // 打开扫码页（拿它正常的初始化和 tickScan 启动）
    await page.evaluate(`document.querySelector('#scanBtn').click(); 'ok'`);
    await sleep(2500);

    out.before = await page.evaluate(`({
      scannerOpen: !document.querySelector('#scanner').classList.contains('hidden'),
      hasStream: !!document.querySelector('#video').srcObject
    })`);

    // 把视频源换成我们合成的画面：25 模块的真二维码，只占画面高度 12%
    out.inject = await page.evaluate(`(async () => {
      const b64 = ${JSON.stringify(QR_B64)};
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
      const W = 1280, H = 720;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const side = Math.round(H * 0.12);
      (function draw() {
        ctx.fillStyle = '#6b6b6b'; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(img, W / 2 - side / 2, H / 2 - side / 2, side, side);
        requestAnimationFrame(draw);
      })();
      const st = cv.captureStream(30);
      const v = document.querySelector('#video');
      if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
      v.srcObject = st;
      await v.play().catch(() => {});
      return { qrPx: side, videoW: v.videoWidth, videoH: v.videoHeight };
    })()`);

    // 给 tickScan 几秒去解
    await sleep(4000);

    out.after = await page.evaluate(`({
      scannerClosed: document.querySelector('#scanner').classList.contains('hidden'),
      screen: [...document.querySelectorAll('.screen')].filter(e=>!e.classList.contains('hidden')).map(e=>e.id),
      devName: (document.querySelector('#devName')||{}).textContent || ''
    })`);
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

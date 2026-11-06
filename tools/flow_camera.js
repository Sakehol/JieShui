// 摄像头取景几何：竖屏手机上 object-fit 到底放大了多少倍。
//
// 背景：同学（OPPO）报"扫码时画面被自动放大，二维码拍不清"。
// 关键区别在于摄像头流本身是横的还是竖的 —— 手机竖屏拍摄时浏览器通常给竖流，
// 那 cover 只轻微裁边；但 Chromium 的假摄像头固定给 1280x720 横流，
// 照它算会得出夸大的倍数。所以这里横竖两种都量。
module.exports = async (page, { sleep }) => {
  const out = {};
  try {
    await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
    await sleep(1200);
    await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef');
      localStorage.setItem('qk_phone','13800138000'); 'ok'`);
    await page.S('Page.reload', { ignoreCache: true });
    await sleep(1400);
    await page.evaluate(`document.querySelector('#scanBtn').click(); 'ok'`);
    await sleep(2500);

    out.measure = await page.evaluate(`(async () => {
      const v = document.querySelector('#video');
      const box = v.getBoundingClientRect();
      const boxW = box.width, boxH = box.height;

      function calc(vw, vh, fit) {
        const sx = boxW / vw, sy = boxH / vh;
        const scale = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
        // 画面在容器里实际占的宽高
        const dispW = vw * scale, dispH = vh * scale;
        // 可见比例（被裁掉多少）
        const visW = Math.min(1, boxW / dispW), visH = Math.min(1, boxH / dispH);
        return {
          visibleW: +visW.toFixed(2),
          visibleH: +visH.toFixed(2),
          visibleArea: +(visW * visH).toFixed(2),
          // cover 相对 contain 的等效放大倍数
          magnify: +(Math.max(sx, sy) / Math.min(sx, sy)).toFixed(2)
        };
      }

      // 真正用 canvas 把流重设成指定尺寸，让 videoWidth/videoHeight 变成真值
      async function withSize(vw, vh) {
        const cv = document.createElement('canvas');
        cv.width = vw; cv.height = vh;
        const ctx = cv.getContext('2d');
        (function draw(){
          ctx.fillStyle = '#555'; ctx.fillRect(0, 0, vw, vh);
          requestAnimationFrame(draw);
        })();
        const st = cv.captureStream(20);
        if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
        v.srcObject = st;
        await v.play().catch(() => {});
        await new Promise(r => setTimeout(r, 400));
        return v.videoWidth + 'x' + v.videoHeight;
      }

      const res = { viewport: boxW.toFixed(0) + 'x' + boxH.toFixed(0), current: getComputedStyle(v).objectFit };
      const land = await withSize(1280, 720);
      res.landscapeStream = { video: land, cover: calc(1280, 720, 'cover'), contain: calc(1280, 720, 'contain') };
      const port = await withSize(720, 1280);
      res.portraitStream = { video: port, cover: calc(720, 1280, 'cover'), contain: calc(720, 1280, 'contain') };
      return res;
    })()`);
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

// 取景框和真实画面到底对不对得上？
//
// 用户被引导"把二维码放进方框"，但方框是 70vw 的固定尺寸，
// 而 contain 之后视频实际只占屏幕中间一条。方框比画面还大时，
// 用户把二维码对到方框边缘，二维码其实已经在画面外了。
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

    out.geom = await page.evaluate(`(async () => {
      const v = document.querySelector('#video');
      const frame = document.querySelector('.scan-frame');
      const vp = { w: innerWidth, h: innerHeight };

      function rects(vw, vh) {
        const cv = document.createElement('canvas');
        cv.width = vw; cv.height = vh;
        const ctx = cv.getContext('2d');
        (function d(){ ctx.fillStyle='#444'; ctx.fillRect(0,0,vw,vh); requestAnimationFrame(d); })();
        const st = cv.captureStream(20);
        if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
        v.srcObject = st;
        return new Promise(r => setTimeout(() => {
          const sc = Math.min(vp.w / vw, vp.h / vh);   // contain
          const dispW = vw * sc, dispH = vh * sc;
          const ox = (vp.w - dispW) / 2, oy = (vp.h - dispH) / 2;
          const f = frame.getBoundingClientRect();
          r({
            stream: vw + 'x' + vh,
            videoVisible: { x: +ox.toFixed(0), y: +oy.toFixed(0), w: +dispW.toFixed(0), h: +dispH.toFixed(0) },
            guideFrame: { x: +f.left.toFixed(0), y: +f.top.toFixed(0), w: +f.width.toFixed(0), h: +f.height.toFixed(0) },
            // 方框有多少比例落在真实画面之外
            frameOutsideVideo: +((
              Math.max(0, ox - f.left) + Math.max(0, (f.left + f.width) - (ox + dispW))
            ) / f.width).toFixed(2),
            frameTallerThanVideo: f.height > dispH
          });
        }, 500));
      }

      const res = {};
      res.landscape = await rects(1280, 720);
      res.portrait = await rects(720, 1280);
      return res;
    })()`);
  } catch (e) { out.ERR = String(e && e.stack || e); }
  return out;
};

// 几何自洽性：取景框和 video 元素必须完全重合，
// 且 scanROI 必须等于 video 原生帧的中心正方形（= 屏幕上显示的那块）。
const QR_B64 = require('fs').readFileSync('build/qr_b64.txt', 'utf8').trim();

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
    await sleep(2200);

    out.check = await page.evaluate(`(async () => {
      const v = document.querySelector('#video');
      const frame = document.querySelector('.scan-frame');
      const results = {};

      async function test(vw, vh, label) {
        const cv = document.createElement('canvas');
        cv.width = vw; cv.height = vh;
        const ctx = cv.getContext('2d');
        let raf = 0;
        (function d(){ ctx.fillStyle='#444'; ctx.fillRect(0,0,vw,vh); raf = requestAnimationFrame(d); })();
        const st = cv.captureStream(20);
        if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
        v.srcObject = st;
        await v.play().catch(() => {});
        return new Promise(r => setTimeout(() => {
            cancelAnimationFrame(raf);
            layoutScanFrame();
            const vr = v.getBoundingClientRect();
            const fr = frame.getBoundingClientRect();
            // 框与 video 元素是否重合（容差 2px）
            const coincide = Math.abs(vr.left - fr.left) < 2 && Math.abs(vr.top - fr.top) < 2
                          && Math.abs(vr.width - fr.width) < 2 && Math.abs(vr.height - fr.height) < 2;
            // 显示区域 = 原生帧中心正方形
            const roiSide = Math.min(vw, vh);
            const roi = window.scanROI;
            const roiOK = roi && Math.abs(roi.w - roiSide) < 1 && Math.abs(roi.h - roiSide) < 1;
            // 这个正方形在屏幕上的等效放大倍数：显示边长 / 原生边长
            const scale = +(vr.width / roiSide).toFixed(2);
            r({ label, stream: vw + 'x' + vh, roi: roi && { w: Math.round(roi.w), x: Math.round(roi.x), y: Math.round(roi.y) },
                screenSide: Math.round(vr.width), scale, coincide, roiOK, realVW: v.videoWidth });
          }, 600));
      }

      results.landscape = await test(1280, 720, 'landscape');
      results.portrait = await test(720, 1280, 'portrait');
      results.square = await test(720, 720, 'square');
      results.vga = await test(640, 480, 'vga');
      return results;
    })()`);

  } catch (e) { out.ERR = String(e && e.stack || e); }
  return out;
};

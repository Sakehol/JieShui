// 几何自洽性（全屏预览 + 暗罩取景框版）：
//   1) video 必须铺满整个视口（不是缩成一个小方块 —— 那样框外全黑，用户以为相机坏了）
//   2) 取景框必须是居中的正方形，边长 = min(视口宽,高) * 0.72（上限 300）
//   3) scanROI 必须是"屏幕上完整可见的最大正方形"换算回原生像素，
//      且**必须包住取景框**——这是安全方向：只会多认，不会少认
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
            const roi = window.__scanROI || window.scanROI;

            // 1) 预览铺满视口（CSS 用 inset:0 + 100%/100%，读取时也应等于视口）
            const fillsScreen = Math.abs(vr.width - innerWidth) < 2
                             && Math.abs(vr.height - innerHeight) < 2;

            // 2) 框是居中正方形，边长符合 72% / 300 上限
            const expectSide = Math.min(Math.round(Math.min(innerWidth, innerHeight) * 0.72), 300);
            const square = Math.abs(fr.width - fr.height) < 1;
            const rightSize = Math.abs(fr.width - expectSide) <= 1;
            const centred = Math.abs((fr.left + fr.width / 2) - innerWidth / 2) < 1
                         && Math.abs((fr.top + fr.height / 2) - innerHeight / 2) < 1;

            // 3) 框在原生帧里占多大，必须落在 scanROI 之内
            const scale = Math.max(innerWidth / vw, innerHeight / vh);
            const frameInNative = fr.width / scale;
            const covers = roi && roi.w + 0.5 >= frameInNative;

            // scanROI 应为"屏幕上完整可见的最大正方形"换算回原生像素
            const expectRoi = Math.min(Math.round(Math.min(innerWidth, innerHeight) / scale), Math.min(vw, vh));

            r({ label, stream: vw + 'x' + vh,
                fillsScreen, square, rightSize, centred,
                frameSide: Math.round(fr.width),
                frameInNative: Math.round(frameInNative),
                roi: roi && Math.round(roi.w),
                expectRoi,
                roiOK: roi && Math.abs(roi.w - expectRoi) <= 2,
                covers,
                zoom: +(fr.width / frameInNative).toFixed(2) });
          }, 600));
      }

      results.landscape = await test(1280, 720, 'landscape');
      results.portrait = await test(720, 1280, 'portrait');
      results.square = await test(720, 720, 'square');
      results.vga = await test(640, 480, 'vga');
      results.hd = await test(1920, 1440, 'hd');
      return results;
    })()`);

  } catch (e) { out.ERR = String(e && e.stack || e); }
  return out;
};

// 几何自洽性（整幅显示 + 中央准星版）：
//   1) video 元素铺满整个视口（contain 由 CSS 负责，元素本身是满屏的）
//   2) 视频画面在屏幕上的矩形必须**完整落在视口内**（contain ⇒ 不裁切）
//   3) 取景框必须是**居中正方形 + 完全落在画面矩形内**（这是上一版最大的坑：
//      框比画面还高，上下落在黑边上，用户照框去对，码其实已经出画面）
//   4) scanROI 必须是整幅原生帧（画面整幅显示 ⇒ 解码也整幅，看了的都能认）
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
            const rect = window.__scanRect || {};

            // 1) video 元素铺满视口
            const fillsScreen = Math.abs(vr.width - innerWidth) < 2
                             && Math.abs(vr.height - innerHeight) < 2;

            // 2) contain：画面矩形不超出视口（留黑边是正常的，超出就是裁切了）
            const contained = rect.w <= innerWidth + 1 && rect.h <= innerHeight + 1;

            // 3) 框是居中的正方形
            const square = Math.abs(fr.width - fr.height) < 1;
            const centred = Math.abs((fr.left + fr.width / 2) - innerWidth / 2) < 1.5
                         && Math.abs((fr.top + fr.height / 2) - innerHeight / 2) < 1.5;

            // 4) **框必须完全落在画面里**——上一版就是这里出的事
            const picL = vr.left + (rect.left || 0), picT = vr.top + (rect.top || 0);
            const picR = picL + (rect.w || 0), picB = picT + (rect.h || 0);
            const insideFrame = fr.left >= picL - 1 && fr.top >= picT - 1
                             && fr.right <= picR + 1 && fr.bottom <= picB + 1;

            // 边长应为画面短边的 62%，夹在 160~340
            const expectSide = Math.max(160, Math.min(Math.round(Math.min(rect.w || 0, rect.h || 0) * 0.62), 340));
            const rightSize = Math.abs(fr.width - expectSide) <= 2;

            // 5) scanROI 必须是整幅原生帧
            const roiFull = roi && roi.x === 0 && roi.y === 0 && roi.w === vw && roi.h === vh;

            r({ label, stream: vw + 'x' + vh,
                fillsScreen, contained, insideFrame, square, centred, rightSize, roiFull,
                frameSide: Math.round(fr.width),
                pic: Math.round(rect.w || 0) + 'x' + Math.round(rect.h || 0),
                margin: Math.round(Math.min(
                  (fr.left - picL), (fr.top - picT),
                  (picR - fr.right), (picB - fr.bottom))) });
          }, 600));
      }

      results.landscape = await test(1280, 720, 'landscape');
      results.portrait = await test(720, 1280, 'portrait');
      results.square = await test(720, 720, 'square');
      results.vga = await test(640, 480, 'vga');
      results.hd = await test(1920, 1440, 'hd');
      results.wide = await test(1920, 1080, 'wide');
      return results;
    })()`);

  } catch (e) { out.ERR = String(e && e.stack || e); }
  return out;
};

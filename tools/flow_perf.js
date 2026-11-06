// 解码开销：jsQR 在不同尺寸下每帧要花多少毫秒。
// 低端安卓（同学的 OPPO）上如果每帧都跑 720/960 的整幅+裁切，
// rAF 会被拖住，界面就"反应慢"。用实测数字决定要不要隔帧。
const QR_B64 = require('fs').readFileSync('build/qr_b64.txt', 'utf8').trim();

module.exports = async (page, { sleep }) => {
  const out = {};
  try {
    await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
    await sleep(1500);
    out.perf = await page.evaluate(`(async () => {
      const b64 = ${JSON.stringify(QR_B64)};
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });

      const W = 1280, H = 720;
      const src = document.createElement('canvas');
      src.width = W; src.height = H;
      const sctx = src.getContext('2d');
      sctx.fillStyle = '#6b6b6b'; sctx.fillRect(0, 0, W, H);
      const side = Math.round(H * 0.10);   // 小二维码：最坏情况（认不出，要扫满整幅）
      sctx.drawImage(img, W / 2 - side / 2, H / 2 - side / 2, side, side);

      function bench(w, h, invert) {
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(src, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h);
        const N = 12;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) {
          window.jsQR(data.data, w, h, { inversionAttempts: invert });
        }
        return +((performance.now() - t0) / N).toFixed(2);
      }

      return {
        full480_dontInvert: bench(480, 270, 'dontInvert'),
        full720_dontInvert: bench(720, 405, 'dontInvert'),
        full720_attemptBoth: bench(720, 405, 'attemptBoth'),
        crop960_attemptBoth: bench(960, 960, 'attemptBoth'),
        crop800_attemptBoth: bench(800, 800, 'attemptBoth')
      };
    })()`);
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

// 扫码健壮性回归：把二维码合成进一个假的"摄像头画面"，直接喂给 jsQR 解码，
// 验证 1) 大画面里二维码很小的时候还能认出 2) 中间裁切那一路确实在起作用。
//
// 关键点：jsQR 的输入是 ImageData，所以这里直接在 canvas 上画，不走摄像头。
const QR_B64 = require('fs').readFileSync('build/qr_b64.txt', 'utf8').trim();

module.exports = async (page, { sleep }) => {
  const out = {};
  try {
    await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
    await sleep(1200);

    out.decode = await page.evaluate(`(async () => {
      const b64 = ${JSON.stringify(QR_B64)};
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });

      // 模拟手机取景：1280x720 的横画面，二维码只占画面高度的 18%，
      // 位置略微偏离中心 —— 这正是"手机举得比较远"的真实情况。
      function frame(vw, vh, qrFrac, dx, dy) {
        const cv = document.createElement('canvas');
        cv.width = vw; cv.height = vh;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#6b6b6b'; ctx.fillRect(0, 0, vw, vh);       // 灰底，模拟机器背景
        const side = Math.round(vh * qrFrac);
        ctx.drawImage(img, vw / 2 - side / 2 + dx, vh / 2 - side / 2 + dy, side, side);
        return cv;
      }

      function tryDecode(cv, longEdge, invert) {
        const vw = cv.width, vh = cv.height;
        const sc = Math.min(1, longEdge / Math.max(vw, vh));
        const w = Math.round(vw * sc), h = Math.round(vh * sc);
        const c2 = document.createElement('canvas');
        c2.width = w; c2.height = h;
        const ctx = c2.getContext('2d');
        ctx.drawImage(cv, 0, 0, w, h);
        return !!window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h,
          { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' });
      }

      function tryCenterCrop(cv, maxSide) {
        const vw = cv.width, vh = cv.height;
        const side = Math.min(vw, vh);
        const sx = (vw - side) / 2, sy = (vh - side) / 2;
        const sc = Math.min(1, maxSide / side);
        const w = Math.round(side * sc);
        const c2 = document.createElement('canvas');
        c2.width = w; c2.height = w;
        const ctx = c2.getContext('2d');
        ctx.drawImage(cv, sx, sy, side, side, 0, 0, w, w);
        return !!window.jsQR(ctx.getImageData(0, 0, w, w).data, w, w,
          { inversionAttempts: 'attemptBoth' });
      }

      const res = {};
      // 场景 A：二维码占 18% 高度，偏 60px 左、40px 下
      const A = frame(1280, 720, 0.18, -60, 40);
      res.full_480 = tryDecode(A, 480, false);   // 老参数
      res.full_720 = tryDecode(A, 720, false);   // 新参数
      // 场景 B：二维码几乎没有偏移、占 22%（裁切那一路的舒适区）
      const B = frame(1280, 720, 0.22, 0, 0);
      res.crop_960 = tryCenterCrop(B, 960);

      // 临界点扫描：二维码在画面里从大到小，看两档缩放各自能撑到多小
      res.sweep = {};
      [0.16, 0.14, 0.12, 0.10, 0.08].forEach(f => {
        const cv = frame(1280, 720, f, 0, 0);
        res.sweep['frac_' + f] = {
          full_480: tryDecode(cv, 480, false),
          full_720: tryDecode(cv, 720, false),
          crop_960: tryCenterCrop(cv, 960)
        };
      });
      return res;
    })()`);
  } catch (e) {
    out.ERR = String(e && e.stack || e);
  }
  return out;
};

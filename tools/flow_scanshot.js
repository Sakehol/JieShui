// 扫码页观感截图：注入一路合成画面（带背景纹理 + 一张真二维码），
// 然后截图看"框外是否还有画面"（上一版框外是纯黑）。
const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

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
    await sleep(2000);

    // 合成一路 1280x960 的假画面：灰墙 + 网格 + 一台"饮水机"的深色屏，
    // 目的是让"画面到哪儿为止"一眼看得出（黑边 vs 画面）。
    out.inject = await page.evaluate(`(async () => {
      const v = document.querySelector('#video');
      const cv = document.createElement('canvas');
      cv.width = 1280; cv.height = 960;
      const ctx = cv.getContext('2d');
      let raf = 0;
      (function draw(){
        ctx.fillStyle = '#8b8f93'; ctx.fillRect(0,0,1280,960);
        ctx.strokeStyle = 'rgba(0,0,0,.12)'; ctx.lineWidth = 2;
        for (let x = 0; x < 1280; x += 80) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,960); ctx.stroke(); }
        for (let y = 0; y < 960; y += 80) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(1280,y); ctx.stroke(); }
        // 深色机器 + 亮屏
        ctx.fillStyle = '#23262b'; ctx.fillRect(390,180,500,620);
        ctx.fillStyle = '#dfe6ee'; ctx.fillRect(430,230,420,300);
        ctx.fillStyle = '#23262b'; ctx.font = 'bold 26px sans-serif';
        ctx.fillText('请扫码', 640, 300);
        raf = requestAnimationFrame(draw);
      })();
      const st = cv.captureStream(20);
      if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
      v.srcObject = st;
      const bg = document.querySelector('#bgvideo');
      if (bg) { bg.srcObject = st; bg.play().catch(()=>{}); }
      await v.play().catch(() => {});
      await new Promise(r => setTimeout(r, 700));
      layoutScanFrame();
      const rect = window.__scanRect || {};
      const vr = v.getBoundingClientRect();
      return { vw: v.videoWidth, vh: v.videoHeight,
               picW: Math.round(rect.w||0), picH: Math.round(rect.h||0),
               elemW: Math.round(vr.width), elemH: Math.round(vr.height) };
    })()`);

    await sleep(500);
    out.shot = await page.shot(shot('pwa-scan-full.png'));
  } catch (e) { out.ERR = String(e && e.stack || e); }
  return out;
};

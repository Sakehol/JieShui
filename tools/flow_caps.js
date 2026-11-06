// 修正版：constraints 必须包在 video 里。
// 重点验证"先取流、再 applyConstraints 抬分辨率"这条路是否比一次到位更可靠。
module.exports = async (page, { sleep }) => {
  const out = {};
  try {
    await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
    await sleep(1200);

    out.probe = await page.evaluate(`(async () => {
      const sets = [
        { name: 'A width ideal 1280', v: { width: { ideal: 1280 }, facingMode: { ideal: 'environment' } } },
        { name: 'B 1920x1440 ideal', v: { width: { ideal: 1920 }, height: { ideal: 1440 }, facingMode: { ideal: 'environment' } } },
        { name: 'C 1920x1080 ideal', v: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: { ideal: 'environment' } } },
        { name: 'D video true', v: true },
        { name: 'E min 1280x720', v: { width: { min: 1280 }, height: { min: 720 }, facingMode: { ideal: 'environment' } } }
      ];
      const res = [];
      for (const s of sets) {
        try {
          const st = await navigator.mediaDevices.getUserMedia({ video: s.v, audio: false });
          const t = st.getVideoTracks()[0];
          const g1 = t.getSettings();
          let caps = null;
          try { caps = t.getCapabilities ? t.getCapabilities() : null; } catch (_) {}
          let after = null;
          try {
            await t.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1440 } });
            const g2 = t.getSettings();
            after = g2.width + 'x' + g2.height;
          } catch (e) { after = 'apply-failed:' + (e && e.name); }
          res.push({ set: s.name, got: g1.width + 'x' + g1.height, afterApply: after,
            capMax: caps && caps.width ? caps.width.max + 'x' + caps.height.max : null,
            focus: caps && caps.focusMode ? caps.focusMode.join('/') : null,
            zoom: caps && caps.zoom ? caps.zoom.min + '~' + caps.zoom.max : null });
          st.getTracks().forEach(x => x.stop());
        } catch (e) { res.push({ set: s.name, err: String(e && e.name || e) + ':' + String(e && e.message || '') }); }
      }
      return res;
    })()`);
  } catch (e) { out.ERR = String(e && e.stack || e); }
  return out;
};

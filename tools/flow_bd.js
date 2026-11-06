module.exports = async (page, { sleep }) => {
  const out = {};
  try {
    await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
    await sleep(1200);
    out.info = await page.evaluate(`(async () => {
      const r = { hasBD: 'BarcodeDetector' in window };
      if (r.hasBD) {
        try { r.formats = await window.BarcodeDetector.getSupportedFormats(); } catch (e) { r.formats = 'ERR:' + e.message; }
      }
      r.ua = navigator.userAgent;
      return r;
    })()`);
  } catch (e) { out.ERR = String(e && e.stack || e); }
  return out;
};

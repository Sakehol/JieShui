const path = require('path');
const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'shots');
const shot = (name) => path.join(SHOTS, name);

module.exports = async (page, { sleep }) => {
  await page.evaluate(`localStorage.setItem('qk_token','mocktoken_0123456789abcdef'); localStorage.setItem('qk_phone','13800138000'); localStorage.setItem('qk_auto','0'); localStorage.setItem('qk_devices','[]'); 'ok'`);
  await page.S('Page.navigate', { url: 'http://127.0.0.1:8899/index.html' });
  await sleep(1000);

  // 扫码覆盖层：直接显示（无摄像头时用黑底看 UI）
  await page.evaluate(`document.querySelector('#scanner').classList.remove('hidden')`);
  await sleep(300);
  await page.shot(shot('scanner.png'));
  await page.evaluate(`document.querySelector('#scanner').classList.add('hidden')`);

  // 设置
  await page.click('#btnSettings');
  await sleep(400);
  await page.shot(shot('settings.png'));
  await page.evaluate(`document.querySelector('#settings').classList.add('hidden')`);

  // 手动输入
  await page.evaluate(`document.querySelector('#manual').classList.remove('hidden')`);
  await sleep(300);
  await page.shot(shot('manual.png'));

  // QR 解析单测
  const cases = [
    'https://h5.qiekj.com/water?NQT=20240101A',
    'qk://device?IMEI=861234567890123&cat=04',
    'https://x.cn/a?SN=SN99887766',
    'NQT88776655',
    'qeykid=ABC123'
  ];
  const parsed = await page.evaluate(`(${JSON.stringify(cases)}).map(t => [t, JSON.stringify(parseQr(t))])`);
  return { parsed };
};

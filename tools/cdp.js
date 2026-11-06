#!/usr/bin/env node
/* 极简 CDP 客户端：无需 puppeteer。
   用法：
     node cdp.js shot  <url> <out.png> [w] [h] [waitMs] [--full]
     node cdp.js eval  <url> <expr> [w] [h] [waitMs]
     node cdp.js flow  <url> <script.js> [w] [h]   // script 里可用 await page.evaluate / click 等
*/
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function httpJson(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  return res.json();
}

function launchChrome(headless = true) {
  const userDir = path.join(os.tmpdir(), 'cdp-profile-' + PORT);
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--allow-file-access-from-files',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--enable-features=NetworkService',
    'about:blank'
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu', '--hide-scrollbars');
  const p = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  return p;
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await httpJson('/json/version');
      if (v && v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch (_) { }
    await sleep(200);
  }
  throw new Error('无法连接 Chrome CDP');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 40000);
    });
  }
}

async function openPage(url, w, h) {
  const wsUrl = await connect();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 2, mobile: true,
    screenWidth: w, screenHeight: h
  });
  await S('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l'
  });
  await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const logs = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('[console] ' + (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('[error] ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
    } else if (m.method === 'Log.entryAdded') {
      logs.push('[log:' + m.params.entry.level + '] ' + m.params.entry.text);
    }
  });
  await S('Log.enable');

  await S('Page.navigate', { url });
  await new Promise(res => {
    const h = ev => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Page.loadEventFired') { ws.removeEventListener('message', h); res(); }
    };
    ws.addEventListener('message', h);
    setTimeout(res, 15000);
  });

  const page = {
    cdp, sessionId, S, logs,
    async evaluate(expr, awaitPromise = true) {
      const r = await S('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise, userGesture: true
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
      return r.result && r.result.value;
    },
    async waitFor(expr, timeout = 15000, interval = 200) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await page.evaluate(expr)) return true; } catch (_) { }
        await sleep(interval);
      }
      return false;
    },
    async click(selector) {
      const box = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      if (!box) throw new Error('找不到元素: ' + selector);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await S('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await sleep(120);
    },
    async type(selector, text) {
      await page.click(selector);
      await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value='';e.focus();})()`);
      for (const ch of String(text)) {
        await S('Input.dispatchKeyEvent', { type: 'char', text: ch });
      }
      await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    },
    async shot(outPath, fullPage = false) {
      let clip;
      if (fullPage) {
        const m = await S('Page.getLayoutMetrics');
        const ch = Math.ceil(m.cssContentSize.height);
        clip = { x: 0, y: 0, width: w, height: ch, scale: 1 };
        await S('Emulation.setDeviceMetricsOverride', {
          width: w, height: ch, deviceScaleFactor: 2, mobile: true
        });
        await sleep(200);
      }
      const r = await S('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!fullPage, ...(clip ? { clip } : {}) });
      fs.writeFileSync(outPath, Buffer.from(r.data, 'base64'));
      if (fullPage) {
        await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
      }
      return outPath;
    },
    async close() {
      try { await cdp.send('Target.closeTarget', { targetId }); } catch (_) { }
      try { ws.close(); } catch (_) { }
    }
  };
  return page;
}

async function main() {
  const [cmd, url, a3, a4, a5, a6] = process.argv.slice(2);
  const w = Number(a4 || 390);
  const h = Number(a5 || 844);
  const waitMs = Number(a6 || 1200);

  const chrome = launchChrome(true);
  let page;
  try {
    page = await openPage(url, w, h);
    await sleep(waitMs);

    if (cmd === 'shot') {
      const full = process.argv.includes('--full');
      await page.shot(a3, full);
      const dims = await page.evaluate('innerWidth+"x"+innerHeight');
      console.log('saved', a3, '| viewport', dims);
      if (page.logs.length) console.log(page.logs.join('\n'));
    } else if (cmd === 'eval') {
      const v = await page.evaluate(a3);
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      if (page.logs.length) console.log('--- logs ---\n' + page.logs.join('\n'));
    } else if (cmd === 'flow') {
      const scriptPath = path.resolve(a3);
      const fn = require(scriptPath);
      const out = await fn(page, { w, h, sleep, url });
      if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
      if (page.logs.length) console.log('--- logs ---\n' + page.logs.join('\n'));
    } else {
      console.error('unknown cmd');
    }
  } finally {
    if (page) await page.close();
    try { chrome.kill(); } catch (_) { }
    await sleep(200);
    process.exit(0);
  }
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });

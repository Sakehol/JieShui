/* 接水 PWA service worker
 *
 * 策略要点（踩过的坑）：
 * 之前对同源 GET 一律 cache-first，结果用户更新后仍然看到旧版 index.html / app.js
 * （离线优先在"界面经常改"的 App 上是灾难）。现在：
 *   - 页面与脚本（html/js/css/manifest）：**network-first**，网络拿不到才回落缓存；
 *   - 图片字体等静态资源：cache-first（够用且快）；
 *   - 接口请求（跨域 userapi）：完全不拦。
 * 另外 CACHE 版本号变了，activate 里会清掉旧缓存。
 */
const CACHE = 'qk-v19';

// 预缓存：装完就能离线打开一个可用壳
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './jsQR.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

// network-first 的资源类型
const NETWORK_FIRST = /\.(?:html|js|css|webmanifest)$|\/$/i;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .catch(() => { })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 让页面能主动要求"立刻接管"（配合前端更新提示）
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  // 接口是跨域的（userapi.qiekj.com），一律直连，绝不缓存
  if (url.origin !== location.origin) return;

  const networkFirst = NETWORK_FIRST.test(url.pathname);

  if (networkFirst) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { });
          }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => {
      if (hit) {
        // 后台静默更新，下次打开就是新的
        fetch(req)
          .then(res => { if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())); })
          .catch(() => { });
        return hit;
      }
      return fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { });
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

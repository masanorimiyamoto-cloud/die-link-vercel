/* sw.js */
// キャッシュ戦略:
//  - アプリのHTML/JS/CSS/画像 … ネットワーク優先（デプロイを即反映。オフライン時のみキャッシュ）
//  - 不変の大型資材(opencv.js / jsQR) … キャッシュ優先（毎回10MB取得を避ける）
// ※ 以前は全部キャッシュ優先で、デプロイしても古いJSが配信され続ける問題があった。
const CACHE = 'die-link-v3';
const ASSETS = [
  '/', '/index.html',
  '/scan-spec-google.html', '/scan-lookup.html', '/scan-register.html', '/find-die.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(()=>{}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k === CACHE ? null : caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 不変の大型資材か（キャッシュ優先で良いもの）
function isVendor(url) {
  return url.pathname === '/js/opencv.js' || url.hostname === 'cdn.jsdelivr.net';
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  const cacheable = req.destination === 'document' || req.destination === 'script' ||
                    req.destination === 'style' || req.destination === 'image';
  if (!cacheable && !isVendor(url)) return;

  // 大型の不変資材：キャッシュ優先（無ければ取得して保存）
  if (isVendor(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (res && (res.status === 200 || res.type === 'opaque')) cache.put(req, res.clone()).catch(()=>{});
      return res;
    })());
    return;
  }

  // アプリ資材：ネットワーク優先（最新を配信）。失敗時のみキャッシュへフォールバック。
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res && res.status === 200) cache.put(req, res.clone()).catch(()=>{});
      return res;
    } catch (err) {
      const cached = await cache.match(req, { ignoreSearch: true });
      return cached || Response.error();
    }
  })());
});

/* sw.js */
const CACHE = 'die-link-v1';
const ASSETS = [
  '/',                         // ルート
  '/index.html',
  '/scan-spec.html',
  '/scan-lookup.html',
  '/scan-register.html',
  // CDN資材も温め（opaqueでもOK）
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k===CACHE ? null : caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Cache-first, then update */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 同一オリジンHTML/JS/CSS/画像はキャッシュ優先
  if (req.method === 'GET' && (req.destination === 'document' || req.destination === 'script' ||
      req.destination === 'style' || req.destination === 'image')) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      const fetchPromise = fetch(req).then(res => {
        // 成功レスは更新
        if (res && (res.status === 200 || res.type === 'opaque')) {
          cache.put(req, res.clone()).catch(()=>{});
        }
        return res;
      }).catch(() => cached);
      return cached || fetchPromise;
    })());
  }
});

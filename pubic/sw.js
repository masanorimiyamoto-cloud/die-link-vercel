const CACHE_NAME="die-offline-v2";
const OFFLINE_URL="/offline-shell.html";

self.addEventListener("install",e=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll([OFFLINE_URL])));
  self.skipWaiting();
});
self.addEventListener("activate",e=>self.clients.claim());

self.addEventListener("fetch",e=>{
  const req=e.request;
  if (req.mode!=="navigate") return;                 // ページ遷移のみ対象
  const url=new URL(req.url);
  const hit = url.pathname.startsWith("/api/die-check");
  const bypass = url.searchParams.get("live")==="1";
  if (!hit || bypass) return;                        // live=1 は素通し

  e.respondWith((async ()=>{
    // 常にまず簡易表示を返す（オンライン・オフライン問わず）
    const cache = await caches.open(CACHE_NAME);
    const shell = await cache.match(OFFLINE_URL);
    return shell || new Response("Offline", {status:200, headers:{"Content-Type":"text/plain; charset=utf-8"}});
  })());
});

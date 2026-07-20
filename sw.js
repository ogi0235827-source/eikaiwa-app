// Service Worker — 静的アセットをキャッシュしてオフライン起動・高速化
// (Gemini APIへの通信はキャッシュ対象外)

const CACHE = 'eikaiwa-v4';
const ASSETS = [
  '.',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/gemini.js',
  'js/speech.js',
  'js/scenarios.js',
  'js/storage.js',
  'manifest.json',
  'assets/avatar.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 同一オリジンのGETのみキャッシュ運用（APIや外部リクエストは素通し）
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // stale-while-revalidate: キャッシュを即返しつつ裏で更新
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    }),
  );
});

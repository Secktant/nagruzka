// Service worker «Нагрузки». Стратегия: network-first с откатом в кэш —
// онлайн всегда свежие файлы, офлайн работает из кэша.
// Версию кэша поднимать при изменении набора файлов.
const CACHE = 'nagruzka-v4';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/engine.js',
  'js/db.js',
  'js/seed.js',
  'js/crypto.js',
  'js/sync.js',
  'js/sync-config.js',
  'js/vendor/argon2.umd.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon-180.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(u =>
        fetch(u, { cache: 'reload' }).then(r => c.put(u, r)).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // чужие запросы не трогаем (их и нет)

  // cache: 'reload' — берём из сети в обход HTTP-кэша браузера (иначе отдаёт устаревшее),
  // офлайн — откат в кэш.
  e.respondWith(
    fetch(e.request, { cache: 'reload' })
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});

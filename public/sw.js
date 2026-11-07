/* Pwointar — service worker (cache app shell, network-first API) */
const CACHE = 'pwointar-v8';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './icon.svg',
  './icon-maskable.svg',
  './manifest.webmanifest',
];

/* ============ Push ============ */
self.addEventListener('push', (e) => {
  let data = { title: '⏰ Pwointar', body: '' };
  try { data = { ...data, ...e.data.json() }; }
  catch { data.body = e.data ? e.data.text() : 'Nouvelle notification'; }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: './icon.svg',
    badge: './icon-maskable.svg',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    vibrate: [100, 50, 100],
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) {
    // API : jamais de cache (fraîcheur d'abord)
    return; // laisse passer le réseau
  }
  if (e.request.method !== 'GET') return;

  // Statique : network-first avec fallback cache (offline OK)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./')))
  );
});
// 27SQ CRM service worker: app shell cached, API always network, navigations network-first with offline fallback.
const VERSION = 'v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp/') || url.pathname.startsWith('/t/')) return; // live data only
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put('/', copy)); return r; }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok && (url.pathname.startsWith('/icons/') || url.pathname.endsWith('.webmanifest'))) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return r; })));
});

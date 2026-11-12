// Giraffe Music fuera del APK (navegador): guarda la app en el teléfono para abrir
// al instante y sin red. El audio nunca pasa por acá (rangos, y es grande).
const V = 'gm-v2';
const SHELL = ['/', '/app.css', '/app.js', '/i18n.js', '/ui.js', '/new.css', '/expressive.css', '/fonts/figtree.woff2', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V && k !== 'gm-img').map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/stream') || u.pathname.startsWith('/api/download')) return;
  // Carátulas: del caché primero (no se vuelven a bajar).
  if (u.pathname === '/api/img' || u.pathname.startsWith('/api/dl/cover')) {
    e.respondWith(caches.open('gm-img').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  // API: de la red; sin red, la última respuesta guardada.
  if (u.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) { const cl = r.clone(); caches.open(V).then((c) => c.put(e.request, cl)); }
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || Response.error())));
    return;
  }
  // La app: del caché al instante y se actualiza por detrás.
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(caches.open(V).then(async (c) => {
    const hit = await c.match(key);
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(key, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

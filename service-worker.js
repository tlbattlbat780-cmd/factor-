// FITCORE — Service Worker v2
const STATIC = 'fitcore-static-v2';
const VIDEOS = 'fitcore-videos-v2';
const API_C  = 'fitcore-api-v2';

const STATIC_FILES = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(STATIC).then(c => c.addAll(STATIC_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => ![STATIC,VIDEOS,API_C].includes(k)).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Videos — cache first
  if (url.pathname.match(/\.(mp4|gif|webm)$/) || url.pathname.includes('/videos/')) {
    e.respondWith(cacheFirst(e.request, VIDEOS)); return;
  }
  // API — network first
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(e.request, API_C)); return;
  }
  // Static — cache first
  e.respondWith(cacheFirst(e.request, STATIC));
});

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) { const c = await caches.open(cacheName); c.put(req, res.clone()); }
    return res;
  } catch { return new Response('Offline', { status: 503 }); }
}

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(5000) });
    if (res.ok) { const c = await caches.open(cacheName); c.put(req, res.clone()); }
    return res;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response(JSON.stringify({ offline:true, message:'أوفلاين' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
}

self.addEventListener('message', async e => {
  if (e.data?.type === 'CACHE_VIDEO') {
    try {
      const res = await fetch(e.data.url);
      if (res.ok) { const c = await caches.open(VIDEOS); await c.put(e.data.url, res); }
      e.source?.postMessage({ type:'VIDEO_CACHED', url:e.data.url, success:true });
    } catch { e.source?.postMessage({ type:'VIDEO_CACHED', url:e.data.url, success:false }); }
  }
});

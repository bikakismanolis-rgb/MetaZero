// Service worker: keeps the app working offline and receives files shared from other apps (Android).
const VERSION = 'katharo-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './src/clean.js',
  './src/deps.js',
  './src/exif.js',
  './src/gif.js',
  './src/iptc.js',
  './src/isobmff.js',
  './src/jpeg.js',
  './src/mp3.js',
  './src/names.js',
  './src/office.js',
  './src/pdf.js',
  './src/png.js',
  './src/util.js',
  './src/webp.js',
  './src/xmp.js',
  './vendor/pdf-lib.min.js',
  './vendor/jszip.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'katharo-shared').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  // Stale-while-revalidate: answer instantly from the cache (works offline), refresh it in the background.
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      const refresh = fetch(event.request)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => null);
      if (hit) {
        event.waitUntil(refresh);
        return hit;
      }
      return (await refresh) || new Response('Offline', { status: 503 });
    }),
  );
});

async function receiveShare(request) {
  const target = new URL('./?shared=1', self.registration.scope).href;
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => typeof f !== 'string');
    const cache = await caches.open('katharo-shared');
    for (const key of await cache.keys()) await cache.delete(key);
    let i = 0;
    for (const f of files) {
      await cache.put(
        new Request(`./shared/${Date.now()}-${i++}`),
        new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(f.name || 'file') } }),
      );
    }
  } catch (e) {
    // fall through to the app; it will simply show the picker
  }
  return Response.redirect(target, 303);
}

// Office Packages service worker — notifications + installability.
// NOTHING is cached: every request goes to the network. The fetch handler exists because
// Chrome on Android only installs a site as a real app (not a shortcut) when its worker
// handles page loads; it answers page loads from the network and shows a plain offline
// message when there is no signal. Every other request is left alone entirely.
const VERSION = 'v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k); // belt and braces: no caches, ever
  await self.clients.claim();
})()));

const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Office Packages</title><body style="font:16px system-ui;padding:24px;color:#1c2529;background:#f4f6f7">
<h2>No connection</h2><p>Office Packages needs the internet. Check your signal or Wi-Fi, then try again.</p>
<button onclick="location.reload()" style="font:inherit;padding:12px 16px;border-radius:10px;border:0;background:#53BDC0;color:#fff">Try again</button></body>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // APIs, photos, scripts: browser handles them normally
  event.respondWith(fetch(event.request).catch(() =>
    new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Office Packages', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        try { await w.navigate(url); } catch { /* some browsers refuse; focusing is enough */ }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

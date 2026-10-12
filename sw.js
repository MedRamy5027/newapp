'use strict';
self.addEventListener('install', event => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {body: event.data?.text() || 'Un nouveau downtime est actif.'}; }
  const title = payload.title || 'SMC Pulse — nouvel arrêt';
  const options = {
    body: payload.body || 'Un downtime est actif sur la ligne.',
    icon: './icons/smc-192.png',
    badge: './icons/smc-badge.png',
    tag: payload.tag || `smc-${Date.now()}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [250, 100, 250, 100, 500],
    data: {url: payload.url || './', event: payload}
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const destination = event.notification.data?.url || './';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    for (const client of windows) {
      if ('focus' in client) { await client.focus(); if ('navigate' in client) await client.navigate(destination); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(destination);
  })());
});

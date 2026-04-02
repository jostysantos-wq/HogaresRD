// ── HogaresRD Service Worker — Web Push Notifications ──────────────

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let title = 'HogaresRD';
  let options = {
    body: 'Tienes una nueva notificación',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    vibrate: [100, 50, 100],
    data: { url: '/broker.html' },
  };

  if (event.data) {
    try {
      const payload = event.data.json();
      title = payload.title || title;
      options.body = payload.body || options.body;
      options.icon = payload.icon || '/icons/icon-192.png';
      options.badge = '/icons/badge-72.png';
      options.tag = payload.type || 'general';
      options.data = { url: payload.url || '/broker.html' };
      options.vibrate = [100, 50, 100];
    } catch (e) {
      console.error('Push payload parse error:', e);
    }
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = (event.notification.data && event.notification.data.url) || '/broker.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Try to focus an existing window with the same URL
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(url);
    })
  );
});

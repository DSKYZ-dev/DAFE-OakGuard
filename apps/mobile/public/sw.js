// Self-destructing stub — DAFE Charts ships as a native app whose assets are
// local files served instantly; service-worker caching here caused poisoned
// installs to serve stale bundles forever (black screen on launch).
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.claim())
  );
});

// Deliberately NO fetch handler — every request passes through untouched.
// Essencialmente — Service Worker
// Guarda em cache o "esqueleto" da app (esta página + ícones) para que ainda
// abra mesmo sem ligação à internet. Os dados em si (consultas, agenda,
// psicólogos) são geridos à parte pela cache offline do próprio Firestore —
// isto só garante que a página em si carrega.

const CACHE_NAME = 'essencialmente-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './admin.html',
  './manifest.json',
  './logo.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {
      // Se um ficheiro individual falhar (ex: foi renomeado), não bloqueia a instalação
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first para o HTML (para apanhar atualizações quando há internet),
// com fallback para a cópia em cache quando não há ligação nenhuma.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});

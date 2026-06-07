const CACHE = 'yt-player-v3'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (e) => {
  // Hapus cache lama biar gak numpuk
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  // Audio streams — jangan di-cache, biarkan hidup
  if (url.pathname.startsWith('/api/stream/')) {
    const response = fetch(e.request)
    e.waitUntil(response.then(r => r.clone().body.getReader().closed))
    e.respondWith(response)
    return
  }

  // Navigation (HTML) — network-first, fallback ke cache
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone()
        caches.open(CACHE).then(cache => cache.put(e.request, clone))
        return res
      }).catch(() => caches.match(e.request))
    )
    return
  }

  // Static assets (JS, CSS, gambar) — cache-first
  if (e.request.method === 'GET' && !url.pathname.startsWith('/api/')) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached =>
          (cached || fetch(e.request).then(res => {
            cache.put(e.request, res.clone())
            return res
          }))
        )
      )
    )
    return
  }

  e.respondWith(fetch(e.request))
})

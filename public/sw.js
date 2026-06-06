const CACHE = 'yt-player-v2'
const AUDIO_CACHE = 'yt-audio-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim())
})

// ─── Intercept audio stream ──────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  // Audio streams — biarkan hidup selama mungkin
  if (url.pathname.startsWith('/api/stream/')) {
    const response = fetch(e.request)
    // Keep service worker alive selama stream
    e.waitUntil(
      response.then(r => {
        // Clone untuk keepalive
        const reader = r.clone().body.getReader()
        return reader.closed
      })
    )
    e.respondWith(response)
    return
  }

  // Cache static assets
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

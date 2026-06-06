const CACHE = 'yt-player-v1'

// Install — skip waiting biar langsung aktif
self.addEventListener('install', () => self.skipWaiting())

// Activate — claim client biar service worker langsung ngontrol
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim())
})

// Fetch — biarin semua request lewat, jangan cache apa-apa biar selalu fresh
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request))
})

import { useEffect, useRef, useState, useCallback } from 'react'
import { Search, Play, Pause, SkipBack, SkipForward, Volume2, Download, Music2, Repeat, Repeat1, ChevronDown, ChevronUp, Shuffle, ThumbsUp, ThumbsDown, ListMusic } from 'lucide-react'
import { cn } from '@/lib/utils'

type Track = { id: string; title: string; channel: string; thumbnail: string; duration: number }
type RepeatMode = 'none' | 'all' | 'one'

export default function App() {
  const [query, setQuery] = useState('')
  const [tracks, setTracks] = useState<Track[]>([])

  // ─── PWA Install ──────────────────────────────────────────────────
  const [installPrompt, setInstallPrompt] = useState<Event | null>(null)
  const [isIOS, setIsIOS] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)

  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e) }
    window.addEventListener('beforeinstallprompt', handler)
    window.addEventListener('appinstalled', () => setInstallPrompt(null))
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window))
    setIsStandalone(window.matchMedia('(display-mode: standalone)').matches)
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js')
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstall = async () => {
    if (installPrompt) {
      (installPrompt as any).prompt()
      const res = await (installPrompt as any).userChoice
      if (res.outcome === 'accepted') setInstallPrompt(null)
    } else if (isIOS && !isStandalone) {
      alert('📲 Tap tombol Share (📤) → "Add to Home Screen"')
    }
  }

  // ─── Player State ─────────────────────────────────────────────────
  const [queue, setQueue] = useState<Track[]>([])
  const [idx, setIdx] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(80)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [repeatMode, setRepeatMode] = useState<RepeatMode>('all')
  const [shuffle, setShuffle] = useState(false)
  const [seeking, setSeeking] = useState(false)
  const [seekTime, setSeekTime] = useState(0)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [related, setRelated] = useState<Track[]>([])
  const searchRef = useRef<HTMLDivElement>(null)

  // ─── Local history ──────────────────────────────────────────────────
  const [history, setHistory] = useState<Track[]>(() => {
    try {
      const saved = localStorage.getItem('yt-history')
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })

  const saveToHistory = useCallback((track: Track) => {
    setHistory(prev => {
      // Hapus duplikat, taruh paling depan
      const filtered = prev.filter(t => t.id !== track.id)
      const next = [track, ...filtered].slice(0, 10) // max 10 item
      try { localStorage.setItem('yt-history', JSON.stringify(next)) } catch {}
      return next
    })
  }, [])

  const audioRef = useRef<HTMLAudioElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const currentIdxRef = useRef(-1)
  const loadingRef = useRef(false)

  // ─── Play / Pause / Next / Prev ───────────────────────────────────
  const playTrack = useCallback((i: number) => {
    if (i < 0 || i >= queue.length) return
    loadingRef.current = true
    setIdx(i)
    currentIdxRef.current = i
    setPlaying(true)
    setError('')
    setShowPlayer(true) // otomatis buka player view
    const audio = audioRef.current
    if (!audio) return
    audio.src = `/api/stream/${queue[i].id}`
    audio.load()
    saveToHistory(queue[i])
    // Fetch rekomendasi (mix YouTube)
    fetch(`/api/related/${queue[i].id}`).then(r => r.ok && r.json()).then(d => {
      if (Array.isArray(d)) setRelated(d)
    }).catch(() => {})
    // Tunggu audio siap, baru play
    const onReady = () => {
      audio.removeEventListener('canplay', onReady)
      if (currentIdxRef.current === i) {
        audio.play().catch(e => {
          // Abaikan error "interrupted" — berarti lagu baru sedang dimuat
          if (e.message.includes('interrupted')) return
          setError('Gagal play: ' + e.message)
        })
      }
      loadingRef.current = false
    }
    audio.addEventListener('canplay', onReady)
    // Fallback: coba play langsung (sebagian browser langsung siap)
    setTimeout(() => {
      if (loadingRef.current && currentIdxRef.current === i) {
        audio.play().catch(() => {})
        loadingRef.current = false
      }
    }, 500)
  }, [queue])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (idx < 0) { if (queue.length) playTrack(0); return }
    if (audio.paused) {
      audio.play().catch(() => {})
      setPlaying(true)
    } else {
      audio.pause()
      setPlaying(false)
    }
  }, [idx, queue.length, playTrack])

  const nextTrack = useCallback(() => {
    if (queue.length === 0) return
    if (repeatMode === 'one') {
      playTrack(currentIdxRef.current)
      return
    }
    const next = currentIdxRef.current + 1
    if (next < queue.length) playTrack(next)
    else if (repeatMode === 'all') playTrack(0)
    else if (related.length > 0) {
      // Append rekomendasi ke queue, skip duplikat
      const fresh = related.filter(t => !queue.find(x => x.id === t.id))
      if (fresh.length > 0) {
        setQueue(prev => [...prev, ...fresh])
        setTimeout(() => playTrack(next), 50)
      } else {
        setPlaying(false); setProgress(0)
      }
    } else {
      setPlaying(false); setProgress(0)
    }
  }, [queue.length, repeatMode, playTrack, related, queue])

  const prevTrack = useCallback(() => {
    const audio = audioRef.current
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return }
    if (currentIdxRef.current > 0) playTrack(currentIdxRef.current - 1)
  }, [playTrack])

  const calcSeek = useCallback((clientX: number) => {
    const rect = progressRef.current?.getBoundingClientRect()
    if (!rect || !duration) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration
  }, [duration])

  const startSeek = useCallback((clientX: number) => {
    setSeeking(true)
    setSeekTime(calcSeek(clientX))
  }, [calcSeek])

  const onSeekMove = useCallback((clientX: number) => {
    if (!seeking) return
    setSeekTime(calcSeek(clientX))
  }, [seeking, calcSeek])

  const endSeek = useCallback((clientX: number) => {
    if (!seeking) return
    const audio = audioRef.current
    if (audio) audio.currentTime = calcSeek(clientX)
    setSeeking(false)
  }, [seeking, calcSeek])

  // Drag via Mouse
  useEffect(() => {
    if (!seeking) return
    const onMouse = (e: MouseEvent) => { e.preventDefault(); onSeekMove(e.clientX) }
    const onUp = (e: MouseEvent) => endSeek(e.clientX)
    document.addEventListener('mousemove', onMouse)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMouse); document.removeEventListener('mouseup', onUp) }
  }, [seeking, onSeekMove, endSeek])

  // Drag via Touch
  useEffect(() => {
    if (!seeking) return
    const onTouch = (e: TouchEvent) => { e.preventDefault(); onSeekMove(e.touches[0].clientX) }
    const onEnd = (e: TouchEvent) => endSeek(e.changedTouches[0].clientX)
    document.addEventListener('touchmove', onTouch, { passive: false })
    document.addEventListener('touchend', onEnd)
    return () => { document.removeEventListener('touchmove', onTouch); document.removeEventListener('touchend', onEnd) }
  }, [seeking, onSeekMove, endSeek])

  // ─── Audio Events ─────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTime = () => {
      setCurrentTime(audio.currentTime)
      setProgress(duration ? (audio.currentTime / duration) * 100 : 0)
    }
    const onMeta = () => setDuration(audio.duration)
    const onEnd = () => nextTrack()
    const onErr = () => setError('Gagal memuat audio')
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onWait = () => {}

    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnd)
    audio.addEventListener('error', onErr)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('waiting', onWait)
    audio.volume = volume / 100

    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnd)
      audio.removeEventListener('error', onErr)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('waiting', onWait)
    }
  }, [nextTrack, duration, volume]) // ← hapus 'playing' dari deps

  // ─── Media Session API (lock screen) ─────────────────────────────
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const track = queue[idx]
    if (track) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.channel,
        album: 'YT Player',
        artwork: [{ src: track.thumbnail, sizes: '320x180', type: 'image/jpeg' }],
      })
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
    }
    navigator.mediaSession.setActionHandler('play', () => togglePlay())
    navigator.mediaSession.setActionHandler('pause', () => togglePlay())
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack())
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack())
    navigator.mediaSession.setActionHandler('seekforward', () => {
      const a = audioRef.current; if (a) a.currentTime = Math.min(a.currentTime + 10, a.duration)
    })
    navigator.mediaSession.setActionHandler('seekbackward', () => {
      const a = audioRef.current; if (a) a.currentTime = Math.max(a.currentTime - 10, 0)
    })
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (d.seekTime) { const a = audioRef.current; if (a) a.currentTime = d.seekTime }
    })
  }, [idx, queue, playing, togglePlay, prevTrack, nextTrack])

  // ─── Search ───────────────────────────────────────────────────────
  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) return
    setLoading(true)
    setError('')
    setShowSuggestions(false)
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
      if (!res.ok) throw new Error(res.statusText)
      const items: Track[] = await res.json()
      setTracks(items)
      setQueue(items)
    } catch (e: any) {
      setError('Gagal mencari: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleSearch = useCallback((q: string) => {
    setQuery(q)
    doSearch(q)
  }, [doSearch])

  // Gak auto-search tiap ngetik — search cuma lewat suggestion tap / Enter

  // ─── Keyboard shortcuts ──────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Space') { e.preventDefault(); togglePlay() }
      if (e.code === 'ArrowRight') nextTrack()
      if (e.code === 'ArrowLeft') prevTrack()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [togglePlay, nextTrack, prevTrack])

  // ─── Search suggestions ──────────────────────────────────────────
  useEffect(() => {
    if (query.length < 1) { setSuggestions([]); setShowSuggestions(false); return }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`)
        if (res.ok) {
          const data: string[] = await res.json()
          setSuggestions(data.slice(0, 6))
          setShowSuggestions(data.length > 0)
        }
      } catch {}
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  // Tutup suggestions kalau klik di luar
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node))
        setShowSuggestions(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ─── Format ────────────────────────────────────────────────────
  const fmt = (s: number) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }
  const dur = (s: number) => s && !isNaN(s) ? fmt(s) : '?'

  const current = idx >= 0 ? queue[idx] : null
  const [showPlayer, setShowPlayer] = useState(false)

  return (
    <div className="min-h-screen bg-background text-foreground pb-0">

      {/* ── SEARCH VIEW ────────────────────────────────────────── */}
      {!showPlayer && (
      <div className="max-w-xl mx-auto px-4 pb-24"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1.5rem)' }}>
        <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 bg-primary rounded-xl flex items-center justify-center shadow-lg shadow-primary/30">
                <Music2 className="w-4.5 h-4.5 text-primary-foreground" />
              </div>
              <h1 className="text-lg font-bold tracking-tight">
                <span className="text-primary">YT</span> Player
              </h1>
            </div>
            {(installPrompt || (isIOS && !isStandalone)) && (
              <button onClick={handleInstall}
                className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-full border border-primary/30 text-primary bg-primary/10 hover:bg-primary/20 transition-all active:scale-95">
                <Download className="w-3 h-3" /> Install
              </button>
            )}
          </div>

          {/* Search */}
          <div className="relative mb-4" ref={searchRef}>
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none z-10" />
            <input type="search" placeholder="Cari lagu..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(query); } }}
              autoComplete="off"
              enterKeyHint="search"
              className="w-full h-12 pl-10 pr-4 rounded-xl border border-input bg-card text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring transition-all" />

            {/* Suggestions dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-xl shadow-xl z-50 overflow-hidden">
                {suggestions.map((s, i) => (
                  <button key={i} onMouseDown={e => { e.preventDefault(); handleSearch(s); }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm text-left hover:bg-accent transition-colors">
                    <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="truncate">{s}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mb-3 px-4 py-2.5 rounded-lg bg-destructive/10 text-destructive text-sm border border-destructive/20 flex items-center gap-2">
              <span>{error}</span>
              <button onClick={() => setError('')} className="ml-auto text-destructive/60 hover:text-destructive">✕</button>
            </div>
          )}

          {/* Results */}
          {loading ? (
            <div className="text-center text-muted-foreground py-16">
              <div className="inline-block w-6 h-6 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin mb-3" />
              <p className="text-sm">Mencari...</p>
            </div>
          ) : tracks.length > 0 ? (
            <div className="space-y-1">
              {tracks.map((t, i) => (
                <button key={t.id} onClick={() => { if (idx === i) togglePlay(); else playTrack(i) }}
                  className={cn(
                    "w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all min-h-[64px]",
                    idx === i
                      ? "bg-primary/10 border border-primary/30 shadow-sm"
                      : "hover:bg-accent border border-transparent"
                  )}>
                  <img src={t.thumbnail} alt="" className="w-12 h-12 rounded-lg object-cover flex-shrink-0 bg-muted shadow-sm"
                    onError={e => (e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect fill="%23e0e0e0" width="48" height="48"/></svg>')} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium leading-snug line-clamp-2">{t.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t.channel} · {dur(t.duration)}</div>
                  </div>
                  <div className={cn("w-9 h-9 min-w-[36px] rounded-full flex items-center justify-center flex-shrink-0",
                    idx === i && playing ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"
                  )}>
                    {idx === i && playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
                  </div>
                </button>
              ))}
            </div>
          ) : history.length > 0 && query.length < 2 ? (
            <div>
              <h2 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider mb-2.5 px-1">Diputar sebelumnya</h2>
              <div className="space-y-1">
                {history.map((t) => (
                  <button key={t.id} onClick={() => {
                    // Tambah ke queue & play
                    setQueue(prev => {
                      const filtered = prev.filter(x => x.id !== t.id)
                      return [t, ...filtered]
                    })
                    // play di index 0 setelah queue update
                    setTimeout(() => {
                      setIdx(0)
                      currentIdxRef.current = 0
                      setPlaying(true)
                      setShowPlayer(true)
                      const audio = audioRef.current
                      if (audio) {
                        audio.src = `/api/stream/${t.id}`
                        audio.load()
                      }
                    }, 0)
                  }}
                    className="w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all min-h-[64px] hover:bg-accent border border-transparent">
                    <img src={t.thumbnail} alt="" className="w-12 h-12 rounded-lg object-cover flex-shrink-0 bg-muted shadow-sm"
                      onError={e => (e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect fill="%23e0e0e0" width="48" height="48"/></svg>')} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium leading-snug line-clamp-2">{t.title}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{t.channel} · {dur(t.duration)}</div>
                    </div>
                    <div className="w-9 h-9 min-w-[36px] rounded-full flex items-center justify-center flex-shrink-0 bg-primary/10 text-primary">
                      <Play className="w-4 h-4 ml-0.5" />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : query.length < 2 ? (
            <div className="text-center text-muted-foreground py-16">
              <Music2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Cari lagu favorit Anda</p>
            </div>
          ) : query.length >= 2 && tracks.length === 0 && !loading ? (
            <div className="text-center text-muted-foreground py-16">
              <p className="text-lg">😕</p>
              <p className="text-sm mt-2">Tidak ditemukan</p>
            </div>
          ) : (
            <div className="text-center text-muted-foreground py-16">
              <Music2 className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Cari lagu favorit Anda</p>
            </div>
          )}
      </div>
      )}

        {/* ── PLAYER VIEW (YouTube Music style) ────────────────────── */}
        {showPlayer && current && (
          <div className="flex flex-col min-h-[calc(100vh-3rem)] bg-background text-foreground">

            {/* Top bar: back | title | menu */}
            <div className="flex items-center justify-between px-2 py-2">
              <button onClick={() => setShowPlayer(false)}
                className="flex items-center justify-center w-10 h-10 text-muted-foreground hover:text-foreground active:scale-90 transition-all rounded-full hover:bg-accent">
                <ChevronDown className="w-6 h-6" />
              </button>
              <div className="text-center flex-1 mx-2">
                <p className="text-xs font-medium truncate text-foreground">{current.title}</p>
                <p className="text-[10px] text-muted-foreground truncate">{current.channel}</p>
              </div>
              <button className="flex items-center justify-center w-10 h-10 text-muted-foreground hover:text-foreground active:scale-90 transition-all rounded-full hover:bg-accent">
                <span className="text-lg font-bold leading-none">···</span>
              </button>
            </div>

            {/* Album art */}
            <div className="flex-1 flex flex-col items-center justify-center px-6">
              <div className="w-full max-w-[360px] aspect-square rounded-lg overflow-hidden shadow-2xl mb-8">
                <img src={current.thumbnail} alt=""
                  className="w-full h-full object-cover"
                  onError={e => (e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect fill="%23e0e0e0" width="400" height="400"/><text x="200" y="220" text-anchor="middle" font-size="80" fill="%23999">🎵</text></svg>')} />
              </div>

              {/* Song info */}
              <div className="w-full text-left mb-4">
                <h2 className="text-lg font-bold leading-tight line-clamp-2 text-foreground">{current.title}</h2>
                <p className="text-sm text-muted-foreground mt-0.5">{current.channel}</p>
              </div>

              {/* Like / Dislike */}
              <div className="w-full flex items-center gap-4 mb-4">
                <button className="text-muted-foreground hover:text-foreground active:scale-90 transition-all">
                  <ThumbsUp className="w-5 h-5" />
                </button>
                <button className="text-muted-foreground/60 hover:text-muted-foreground active:scale-90 transition-all">
                  <ThumbsDown className="w-5 h-5" />
                </button>
              </div>

              {/* Progress */}
              <div className="w-full mb-2">
                <div ref={progressRef}
                  onMouseDown={e => startSeek(e.clientX)}
                  onTouchStart={e => startSeek(e.touches[0].clientX)}
                  className="w-full h-1 bg-muted-foreground/20 rounded-full cursor-pointer relative overflow-hidden group active:h-2 transition-all active:shadow-md active:shadow-primary/20">
                  <div className={`h-full bg-primary rounded-full ${!seeking ? 'transition-[width] duration-300 ease-linear' : ''}`}
                    style={{ width: `${seeking ? (seekTime / duration) * 100 : progress}%` }} />
                  <div className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-primary rounded-full shadow-md opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity"
                    style={{ left: `calc(${seeking ? (seekTime / duration) * 100 : progress}% - 8px)`, top: '50%' }} />
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground mt-1 px-0.5">
                  <span>{seeking ? fmt(seekTime) : fmt(currentTime)}</span>
                  <span>{fmt(duration)}</span>
                </div>
              </div>
            </div>

            {/* Bottom controls (thumb zone) */}
            <div className="px-6 pb-6 pt-2">
              {/* Main controls row */}
              <div className="flex items-center justify-between mb-6">
                <button onClick={() => setShuffle(s => !s)}
                  className={cn("transition-all active:scale-90 p-2",
                    shuffle ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
                  <Shuffle className="w-5 h-5" />
                </button>

                <button onClick={prevTrack}
                  className="text-muted-foreground hover:text-foreground transition-colors active:scale-90 p-2">
                  <SkipBack className="w-7 h-7" />
                </button>

                <button onClick={togglePlay}
                  className="w-14 h-14 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-xl active:scale-90 transition-all hover:bg-primary/90">
                  {playing ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
                </button>

                <button onClick={nextTrack}
                  className="text-muted-foreground hover:text-foreground transition-colors active:scale-90 p-2">
                  <SkipForward className="w-7 h-7" />
                </button>

                <button onClick={() => setRepeatMode(r => r === 'none' ? 'all' : r === 'all' ? 'one' : 'none')}
                  className={cn("transition-all active:scale-90 p-2",
                    repeatMode !== 'none' ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
                  {repeatMode === 'one' ? <Repeat1 className="w-5 h-5" /> : <Repeat className="w-5 h-5" />}
                </button>
              </div>

              {/* Extra actions row */}
              <div className="flex items-center justify-between">
                <button className="text-muted-foreground hover:text-foreground active:scale-90 transition-all p-1">
                  <ListMusic className="w-5 h-5" />
                  <span className="text-[10px] ml-1">{queue.length}</span>
                </button>

                <div className="flex items-center gap-2 text-muted-foreground">
                  <Volume2 className="w-4 h-4" />
                  <input type="range" min="0" max="100" value={volume}
                    onChange={e => { const v = +e.target.value; setVolume(v); if (audioRef.current) audioRef.current.volume = v / 100 }}
                    className="w-20 h-1 accent-primary cursor-pointer" />
                </div>
              </div>

              {/* Selanjutnya (rekomendasi) */}
              {related.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Selanjutnya</h3>
                  <div className="space-y-1 max-h-[160px] overflow-y-auto">
                    {related.slice(0, 8).map(t => (
                      <button key={t.id} onClick={() => {
                        setQueue(prev => {
                          const filtered = prev.filter(x => x.id !== t.id)
                          return [...filtered, t]
                        })
                        setTimeout(() => {
                          const idx = queue.length
                          playTrack(idx)
                        }, 50)
                      }}
                        className="w-full flex items-center gap-2.5 p-2 rounded-lg text-left hover:bg-accent transition-colors min-h-[48px]">
                        <img src={t.thumbnail} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0 bg-muted"
                          onError={e => (e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect fill="%23e0e0e0" width="36" height="36"/></svg>')} />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium leading-snug line-clamp-1">{t.title}</div>
                          <div className="text-[11px] text-muted-foreground">{t.channel}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
      </div>
      )}

      {/* ── Now Playing Bar (mini) ─── */}
      {current && !showPlayer && (
      <div onClick={() => setShowPlayer(true)}
        className="fixed bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur-xl px-4 pt-3 shadow-2xl z-50 cursor-pointer active:scale-[0.99] transition-transform"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}>

        {/* Info */}
        <div className="flex items-center gap-3 mb-2.5">
          <img src={current.thumbnail} className="w-11 h-11 rounded-lg object-cover flex-shrink-0 shadow-md" alt="" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate text-foreground/90">{current.title}</div>
            <div className="text-xs text-muted-foreground truncate">{current.channel}</div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <button onClick={e => { e.stopPropagation(); togglePlay() }}
              className="w-10 h-10 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-md active:scale-90 transition-all">
              {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
            </button>
            <ChevronUp className="w-5 h-5 text-muted-foreground" />
          </div>
        </div>

        {/* Progress */}
        <div className="w-full h-1 bg-muted-foreground/20 rounded-full overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-[width] duration-300 ease-linear"
            style={{ width: `${progress}%` }} />
        </div>
      </div>
      )}

      <audio ref={audioRef} preload="auto" playsInline />
    </div>
  )
}

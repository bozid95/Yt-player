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

  const audioRef = useRef<HTMLAudioElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
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
      playTrack(currentIdxRef.current) // repeat satu lagu
      return
    }
    const next = currentIdxRef.current + 1
    if (next < queue.length) playTrack(next)
    else if (repeatMode === 'all') playTrack(0) // ulang dari awal
    else { setPlaying(false); setProgress(0) }
  }, [queue.length, repeatMode, playTrack])

  const prevTrack = useCallback(() => {
    const audio = audioRef.current
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; return }
    if (currentIdxRef.current > 0) playTrack(currentIdxRef.current - 1)
  }, [playTrack])

  const seek = useCallback((e: React.MouseEvent) => {
    const audio = audioRef.current
    if (!audio || !duration) return
    const rect = progressRef.current?.getBoundingClientRect()
    if (!rect) return
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * duration
  }, [duration])

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

  useEffect(() => {
    clearTimeout(searchTimer.current)
    if (query.length < 2) { setTracks([]); return }
    searchTimer.current = setTimeout(() => doSearch(query), 300)
  }, [query, doSearch])

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
    <div className="min-h-screen bg-background text-foreground pb-4">
      <div className="max-w-xl mx-auto px-4 py-6">

        {/* ── SEARCH VIEW ────────────────────────────────────────── */}
        {!showPlayer && (<>
          {/* ── Header ─────────────────────────────────────────────── */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center shadow-lg shadow-primary/30">
                <Music2 className="w-5 h-5 text-primary-foreground" />
              </div>
              <h1 className="text-xl font-bold tracking-tight">
                <span className="text-primary">YT</span> Player
              </h1>
            </div>
            {(installPrompt || (isIOS && !isStandalone)) && (
              <button onClick={handleInstall}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border border-primary/30 text-primary bg-primary/10 hover:bg-primary/20 transition-all active:scale-95">
                <Download className="w-3.5 h-3.5" /> Install
              </button>
            )}
          </div>

          {/* ── Search ──────────────────────────────────────────────── */}
          <div className="relative mb-5">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input type="text" placeholder="Cari lagu..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full h-11 pl-10 pr-4 rounded-xl border border-input bg-card text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring transition-all" />
          </div>

          {/* ── Error ───────────────────────────────────────────────── */}
          {error && (
            <div className="mb-3 px-4 py-2.5 rounded-lg bg-destructive/10 text-destructive text-sm border border-destructive/20 flex items-center gap-2">
              <span>{error}</span>
              <button onClick={() => setError('')} className="ml-auto text-destructive/60 hover:text-destructive">✕</button>
            </div>
          )}

          {/* ── Results ─────────────────────────────────────────────── */}
          {loading ? (
            <div className="text-center text-muted-foreground py-16">
              <div className="inline-block w-6 h-6 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin mb-3" />
              <p className="text-sm">Mencari...</p>
            </div>
          ) : tracks.length > 0 ? (
            <div className="space-y-1.5">
              {tracks.map((t, i) => (
                <button key={t.id} onClick={() => { if (idx === i) togglePlay(); else playTrack(i) }}
                  className={cn(
                    "w-full flex items-center gap-3 p-3 rounded-xl text-left transition-all",
                    idx === i
                      ? "bg-primary/10 border border-primary/30 shadow-sm"
                      : "hover:bg-accent border border-transparent"
                  )}>
                  <img src={t.thumbnail} alt="" className="w-14 h-14 rounded-lg object-cover flex-shrink-0 bg-muted shadow-sm"
                    onError={e => (e.currentTarget.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect fill="%23333" width="56" height="56"/></svg>')} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium leading-snug line-clamp-2">{t.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{t.channel} · {dur(t.duration)}</div>
                  </div>
                  <div className={cn("w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0",
                    idx === i && playing ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"
                  )}>
                    {idx === i && playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </div>
                </button>
              ))}
            </div>
          ) : query.length >= 2 ? (
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
        </>)}

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
                <div ref={progressRef} onClick={seek}
                  className="w-full h-1 bg-muted-foreground/20 rounded-full cursor-pointer relative overflow-hidden group">
                  <div className="h-full bg-primary rounded-full transition-[width] duration-300 ease-linear"
                    style={{ width: `${progress}%` }} />
                  <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-primary rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ left: `calc(${progress}% - 6px)` }} />
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground mt-1 px-0.5">
                  <span>{fmt(currentTime)}</span>
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
            </div>
          </div>
        )}

      </div>

      {/* ── Now Playing Bar (mini) ─── */}
      {current && !showPlayer && (
        <div onClick={() => setShowPlayer(true)}
          className="fixed bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur-xl px-4 py-3 shadow-2xl z-50 cursor-pointer active:scale-[0.99] transition-transform">

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

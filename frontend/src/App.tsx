import { useEffect, useRef, useState, useCallback } from 'react'
import { Search, Play, Pause, SkipBack, SkipForward, Volume2, Download, Music2, Repeat, Repeat1 } from 'lucide-react'
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

  const audioRef = useRef<HTMLAudioElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const currentIdxRef = useRef(-1)

  // ─── Play / Pause / Next / Prev ───────────────────────────────────
  const playTrack = useCallback((i: number) => {
    if (i < 0 || i >= queue.length) return
    setIdx(i)
    currentIdxRef.current = i
    setPlaying(true)
    setError('')
    const audio = audioRef.current
    if (!audio) return
    audio.src = `/api/stream/${queue[i].id}`
    audio.load()
    audio.play().catch(e => setError('Gagal play: ' + e.message))
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
    const onCanPlay = () => { if (playing) audio.play().catch(() => {}) }

    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnd)
    audio.addEventListener('error', onErr)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('waiting', onWait)
    audio.addEventListener('canplay', onCanPlay)
    audio.volume = volume / 100

    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnd)
      audio.removeEventListener('error', onErr)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('waiting', onWait)
      audio.removeEventListener('canplay', onCanPlay)
    }
  }, [nextTrack, duration, playing, volume])

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

  return (
    <div className="min-h-screen bg-background text-foreground pb-36">
      <div className="max-w-xl mx-auto px-4 py-6">

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
      </div>

      {/* ── Now Playing Bar ───────────────────────────────────────── */}
      {current && (
        <div className="fixed bottom-0 left-0 right-0 border-t bg-card/95 backdrop-blur-xl px-4 py-3 shadow-2xl z-50">
          {/* Info */}
          <div className="flex items-center gap-3 mb-2.5">
            <img src={current.thumbnail} className="w-11 h-11 rounded-lg object-cover flex-shrink-0 shadow-md" alt="" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate">{current.title}</div>
              <div className="text-xs text-muted-foreground truncate">{current.channel}</div>
            </div>
          </div>

          {/* Progress */}
          <div className="mb-2.5">
            <div ref={progressRef} onClick={seek}
              className="w-full h-1.5 bg-muted rounded-full cursor-pointer relative overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-[width] duration-300 ease-linear"
                style={{ width: `${progress}%` }} />
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>{fmt(currentTime)}</span>
              <span>{fmt(duration)}</span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button onClick={prevTrack}
                className="text-muted-foreground hover:text-foreground transition-colors active:scale-90">
                <SkipBack className="w-5 h-5" />
              </button>

              <button onClick={togglePlay}
                className="w-12 h-12 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-lg shadow-primary/30 active:scale-90 transition-all hover:bg-primary/90">
                {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
              </button>

              <button onClick={nextTrack}
                className="text-muted-foreground hover:text-foreground transition-colors active:scale-90">
                <SkipForward className="w-5 h-5" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              {/* Repeat */}
              <button onClick={() => setRepeatMode(r => r === 'none' ? 'all' : r === 'all' ? 'one' : 'none')}
                className={cn("transition-all active:scale-90",
                  repeatMode !== 'none' ? "text-primary" : "text-muted-foreground hover:text-foreground")}
                title={repeatMode === 'one' ? 'Repeat 1' : repeatMode === 'all' ? 'Repeat all' : 'No repeat'}>
                {repeatMode === 'one' ? <Repeat1 className="w-4 h-4" /> : <Repeat className="w-4 h-4" />}
              </button>

              {/* Volume */}
              <Volume2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              <input type="range" min="0" max="100" value={volume}
                onChange={e => { const v = +e.target.value; setVolume(v); if (audioRef.current) audioRef.current.volume = v / 100 }}
                className="w-16 sm:w-20 h-1 accent-primary cursor-pointer" />
            </div>
          </div>
        </div>
      )}

      <audio ref={audioRef} preload="auto" playsInline />
    </div>
  )
}

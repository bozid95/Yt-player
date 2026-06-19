package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─── Config ────────────────────────────────────────────────────────

const (
	port       = 3000
	cookiePath = "/tmp/youtube-cookies.txt"
	cacheDir   = "/tmp/yt-cache"
	audioFmt   = "140" // M4A/AAC
	cacheTTL   = 5 * time.Minute
	metaTTL    = 10 * time.Minute
)

var ytdlpArgs = []string{
	"--cookies", cookiePath,
	"--no-warnings",
	"--js-runtimes", "deno",
	"--remote-components", "ejs:github",
}

// ─── In-memory cache ───────────────────────────────────────────────

type cacheEntry struct {
	data      interface{}
	expiresAt time.Time
}

type memCache struct {
	mu   sync.RWMutex
	data map[string]cacheEntry
}

func newCache() *memCache {
	return &memCache{data: make(map[string]cacheEntry)}
}

func (c *memCache) get(key string) interface{} {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.data[key]
	if !ok || time.Now().After(e.expiresAt) {
		return nil
	}
	return e.data
}

func (c *memCache) set(key string, val interface{}, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data[key] = cacheEntry{data: val, expiresAt: time.Now().Add(ttl)}
	if len(c.data) > 100 {
		oldestKey, oldestTime := "", time.Now()
		for k, v := range c.data {
			if v.expiresAt.Before(oldestTime) {
				oldestTime = v.expiresAt
				oldestKey = k
			}
		}
		delete(c.data, oldestKey)
	}
}

var (
	searchCache  = newCache()
	suggestCache = newCache()
	relatedCache = newCache()
	formatMeta   sync.Map // map[string]formatMetaEntry
)

type formatMetaEntry struct {
	formatID  string
	fileSize  int64
	duration  int64
	fetchedAt time.Time
}

// ─── YouTube item ──────────────────────────────────────────────────

type ytItem struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Duration  int    `json:"duration"`
	Thumbnail string `json:"thumbnail"`
	Channel   string `json:"channel"`
}

func parseYtLines(data []byte) []ytItem {
	var items []ytItem
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var raw struct {
			ID       string `json:"id"`
			Title    string `json:"title"`
			Duration int    `json:"duration"`
			Channel  string `json:"channel,omitempty"`
			Uploader string `json:"uploader,omitempty"`
		}
		if err := json.Unmarshal([]byte(line), &raw); err != nil {
			continue
		}
		ch := raw.Channel
		if ch == "" {
			ch = raw.Uploader
		}
		if ch == "" {
			ch = "Unknown"
		}
		items = append(items, ytItem{
			ID:        raw.ID,
			Title:     raw.Title,
			Duration:  raw.Duration,
			Thumbnail: "https://i.ytimg.com/vi/" + raw.ID + "/hqdefault.jpg",
			Channel:   ch,
		})
	}
	return items
}

// ─── Cookies ───────────────────────────────────────────────────────

func initCookies() {
	enc := os.Getenv("YOUTUBE_COOKIES")
	if enc == "" {
		log.Println("[WARN] YOUTUBE_COOKIES tidak diset — streaming mungkin gagal")
		return
	}
	dec, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		log.Printf("[ERR] Gagal decode YOUTUBE_COOKIES: %v", err)
		return
	}
	if err := os.WriteFile(cookiePath, dec, 0444); err != nil {
		log.Printf("[ERR] Gagal tulis cookies: %v", err)
		return
	}
	log.Println("[OK] Cookies loaded from YOUTUBE_COOKIES")
}

// ─── Handlers ──────────────────────────────────────────────────────

func handleVersion(w http.ResponseWriter, r *http.Request) {
	ver := "0"
	if b, err := os.ReadFile("/app/version.txt"); err == nil {
		ver = strings.TrimSpace(string(b))
	}
	writeJSON(w, http.StatusOK, map[string]string{"version": ver})
}

func handleSuggest(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		writeJSON(w, http.StatusOK, []string{})
		return
	}
	ck := "suggest:" + q
	if hit := suggestCache.get(ck); hit != nil {
		writeJSON(w, http.StatusOK, hit)
		return
	}
	u := "https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=" + url.QueryEscape(q)
	resp, err := http.Get(u)
	if err != nil {
		writeJSON(w, http.StatusOK, []string{})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var parsed []interface{}
	if err := json.Unmarshal(body, &parsed); err != nil || len(parsed) < 2 {
		writeJSON(w, http.StatusOK, []string{})
		return
	}
	suggestions, _ := parsed[1].([]interface{})
	suggestCache.set(ck, suggestions, 60*time.Second)
	writeJSON(w, http.StatusOK, suggestions)
}

func handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if len(q) < 2 {
		writeJSON(w, http.StatusOK, []ytItem{})
		return
	}
	ck := "search:" + strings.ToLower(q)
	if hit := searchCache.get(ck); hit != nil {
		writeJSON(w, http.StatusOK, hit)
		return
	}
	safeQ := strings.ReplaceAll(q, "'", "'\\''")
	cmd := exec.Command("yt-dlp",
		append(ytdlpArgs,
			"--flat-playlist", "--dump-json", "--no-warnings",
			"ytsearch30:"+safeQ,
		)...,
	)
	output, err := cmd.Output()
	if err != nil {
		writeJSON(w, http.StatusOK, []ytItem{})
		return
	}
	items := parseYtLines(output)
	searchCache.set(ck, items, cacheTTL)
	writeJSON(w, http.StatusOK, items)
}

func handleRelated(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/related/")
	if len(id) != 11 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid ID"})
		return
	}
	ck := "related:" + id
	if hit := relatedCache.get(ck); hit != nil {
		writeJSON(w, http.StatusOK, hit)
		return
	}
	musicURL := "https://music.youtube.com/watch?v=" + id + "&list=RDAMVM" + id
	items := fetchMix(musicURL)
	if len(items) > 1 {
		items = items[1:]
		if len(items) > 15 {
			items = items[:15]
		}
		relatedCache.set(ck, items, metaTTL)
		writeJSON(w, http.StatusOK, items)
		return
	}
	fallbackURL := "https://www.youtube.com/watch?v=" + id + "&list=RD" + id
	items = fetchMix(fallbackURL)
	if len(items) > 1 {
		items = items[1:]
		if len(items) > 15 {
			items = items[:15]
		}
		relatedCache.set(ck, items, metaTTL)
	}
	writeJSON(w, http.StatusOK, items)
}

func fetchMix(urlStr string) []ytItem {
	cmd := exec.Command("yt-dlp",
		append(ytdlpArgs,
			"--flat-playlist", "--playlist-end", "16",
			"--dump-json", "--no-warnings",
			urlStr,
		)...,
	)
	output, err := cmd.Output()
	if err != nil {
		return nil
	}
	return parseYtLines(output)
}

// ─── Streaming ─────────────────────────────────────────────────────

var (
	downloading sync.Map
	startMu     sync.Mutex
)

// downloadingTracker manages concurrent download tracking
type dlTracker struct {
	cancel chan struct{}
}

func handleStream(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/stream/")
	if len(id) != 11 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid ID"})
		return
	}

	url := "https://youtube.com/watch?v=" + id
	filePath := filepath.Join(cacheDir, id+".m4a")
	rangeHdr := r.Header.Get("Range")

	// ── FILE EXISTS & HAS CONTENT → serve from cache ──────────
	if fi, err := os.Stat(filePath); err == nil && fi.Size() > 0 {
		serveFromFile(w, r, filePath, fi.Size(), rangeHdr)
		return
	}

	// ── ALREADY DOWNLOADING → serve partial or wait ──────────
	if _, ok := downloading.Load(id); ok {
		if fi, err := os.Stat(filePath); err == nil && fi.Size() > 0 {
			serveFromFile(w, r, filePath, fi.Size(), rangeHdr)
			return
		}
		// File still 0 bytes — tell browser to retry
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// ── START NEW DOWNLOAD ────────────────────────────────────
	startMu.Lock()
	// Double-check after lock
	if _, ok := downloading.Load(id); ok {
		startMu.Unlock()
		if fi, err := os.Stat(filePath); err == nil && fi.Size() > 0 {
			serveFromFile(w, r, filePath, fi.Size(), rangeHdr)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	downloading.Store(id, &dlTracker{cancel: make(chan struct{})})
	startMu.Unlock()

	_ = os.MkdirAll(cacheDir, 0755)

	yt := exec.Command("yt-dlp",
		append(ytdlpArgs,
			"-f", audioFmt,
			"-o", "-",
			url,
		)...,
	)

	stdout, err := yt.StdoutPipe()
	if err != nil {
		downloading.Delete(id)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Stream gagal"})
		return
	}

	stderr, _ := yt.StderrPipe()
	go io.Copy(io.Discard, stderr)

	if err := yt.Start(); err != nil {
		downloading.Delete(id)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Stream gagal"})
		return
	}

	// Open file for writing
	f, err := os.Create(filePath)
	if err != nil {
		downloading.Delete(id)
		yt.Process.Kill()
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Stream gagal"})
		return
	}

	// Multi-writer: tee to file + response
	pr, pw := io.Pipe()
	multi := io.MultiWriter(f, pw)

	var headersOnce sync.Once
	done := make(chan struct{})

	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		for {
			n, err := stdout.Read(buf)
			if n > 0 {
				headersOnce.Do(func() {
					w.WriteHeader(http.StatusOK)
					w.Header().Set("Content-Type", "audio/mp4")
					w.Header().Set("Accept-Ranges", "bytes")
					w.Header().Set("Cache-Control", "public, max-age=3600")
				})
				if _, e := multi.Write(buf[:n]); e != nil {
					return
				}
			}
			if err != nil {
				if err == io.EOF {
					return
				}
				_ = err
				return
			}
		}
	}()

	// Wait for yt-dlp or client disconnect
	select {
	case <-done:
		yt.Wait()
	case <-r.Context().Done():
		time.Sleep(200 * time.Millisecond)
		yt.Process.Kill()
	}

	pw.Close()
	pr.Close()
	f.Close()
	downloading.Delete(id)

	// If we never sent headers — it failed
	var sent bool
	headersOnce.Do(func() { sent = false })
	if !sent {
		os.Remove(filePath)
	}
}

func serveFromFile(w http.ResponseWriter, r *http.Request, filePath string, fileSize int64, rangeHdr string) {
	if rangeHdr != "" {
		parts := strings.Split(strings.TrimPrefix(rangeHdr, "bytes="), "-")
		if len(parts) == 2 {
			start, err1 := strconv.ParseInt(parts[0], 10, 64)
			end, err2 := strconv.ParseInt(parts[1], 10, 64)
			if err1 != nil {
				start = 0
			}
			if err2 != nil || end <= 0 {
				end = fileSize - 1
			}
			if start >= fileSize {
				start = fileSize - 65536
				if start < 0 {
					start = 0
				}
			}
			if end >= fileSize {
				end = fileSize - 1
			}
			chunkSize := end - start + 1
			if chunkSize <= 0 {
				chunkSize = fileSize
				start = 0
				end = fileSize - 1
			}
			f, _ := os.Open(filePath)
			if f != nil {
				defer f.Close()
				f.Seek(start, 0)
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, fileSize))
				w.Header().Set("Accept-Ranges", "bytes")
				w.Header().Set("Content-Type", "audio/mp4")
				w.Header().Set("Content-Length", strconv.FormatInt(chunkSize, 10))
				w.Header().Set("Cache-Control", "public, max-age=3600")
				w.WriteHeader(http.StatusPartialContent)
				io.CopyN(w, f, chunkSize)
				return
			}
		}
	}

	// Full file serve
	f, err := os.Open(filePath)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "audio/mp4")
	w.Header().Set("Content-Length", strconv.FormatInt(fileSize, 10))
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.WriteHeader(http.StatusOK)
	io.Copy(w, f)
}

// ─── Cache cleanup ─────────────────────────────────────────────────

func cacheCleaner() {
	for {
		time.Sleep(5 * time.Minute)
		entries, _ := os.ReadDir(cacheDir)
		now := time.Now()
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			id := strings.TrimSuffix(e.Name(), ".m4a")
			if _, ok := downloading.Load(id); ok {
				continue
			}
			fi, err := e.Info()
			if err != nil {
				continue
			}
			if now.Sub(fi.ModTime()) > 10*time.Minute {
				os.Remove(filepath.Join(cacheDir, e.Name()))
			}
		}
	}
}

// ─── Helpers ───────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// ─── Main ──────────────────────────────────────────────────────────

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	initCookies()
	os.MkdirAll(cacheDir, 0755)
	go cacheCleaner()

	mux := http.NewServeMux()

	// API routes
	mux.HandleFunc("/api/version", handleVersion)
	mux.HandleFunc("/api/suggest", handleSuggest)
	mux.HandleFunc("/api/search", handleSearch)
	mux.HandleFunc("/api/related/", handleRelated)
	mux.HandleFunc("/api/stream/", handleStream)

	// Static files (frontend)
	distDir := filepath.Join(".", "frontend", "dist")
	mux.Handle("/", withCacheControl(http.FileServer(http.Dir(distDir))))

	log.Printf("[OK] YouTube Music Player running on port %d", port)
	if err := http.ListenAndServe("0.0.0.0:"+strconv.Itoa(port), mux); err != nil {
		log.Fatal(err)
	}
}

// Middleware to set Cache-Control for index.html
func withCacheControl(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		} else {
			w.Header().Set("Cache-Control", "public, max-age=3600")
			w.Header().Set("ETag", `"static"`)
		}
		h.ServeHTTP(w, r)
	})
}

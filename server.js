const express = require('express');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const app = express();
const PORT = 3000;
const COOKIE_PATH = '/tmp/youtube-cookies.txt';

// ─── In-memory cache ──────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 menit
function cached(key, ttl = CACHE_TTL) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time < ttl) return hit.data;
  return null;
}
function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
  if (cache.size > 100) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].time - b[1].time)[0];
    cache.delete(oldest[0]);
  }
}

// ─── Cookies ──────────────────────────────────────────────────────
if (process.env.YOUTUBE_COOKIES) {
  try {
    const content = Buffer.from(process.env.YOUTUBE_COOKIES, 'base64').toString('utf-8');
    fs.writeFileSync(COOKIE_PATH, content, 'utf-8');
    console.log('[OK] Cookies loaded from YOUTUBE_COOKIES env');
  } catch (e) {
    console.error('[ERR] Gagal decode YOUTUBE_COOKIES:', e.message);
  }
}

// Cek cookies di background
if (fs.existsSync(COOKIE_PATH)) {
  exec(`yt-dlp --cookies '${COOKIE_PATH}' --skip-download --print id 'https://music.youtube.com/watch?v=dQw4w9WgXcQ' 2>/dev/null`,
    (err) => { if (err) console.warn('[WARN] Cookies mungkin expired'); else console.log('[OK] YouTube cookies valid'); }
  );
} else {
  console.warn('[WARN] Tidak ada cookies — streaming mungkin gagal');
}

// ─── Static files with cache ──────────────────────────────────────
app.use(express.static(path.join(__dirname, 'frontend', 'dist'), {
  maxAge: '1h',
  etag: true,
  immutable: true,
}));

// ─── Utility: parse yt-dlp JSON lines ────────────────────────────
function parseYtLines(output) {
  return output.toString().trim().split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).map(item => ({
    id: item.id,
    title: item.title || 'Unknown',
    duration: item.duration || 0,
    thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
    channel: item.channel || item.uploader || 'Unknown',
  }));
}

// ─── Search suggestions ──────────────────────────────────────────
app.get('/api/suggest', (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 1) return res.json([]);

  const cacheKey = 'suggest:' + q;
  const hit = cached(cacheKey, 60000); // cache 1 menit
  if (hit) return res.json(hit);

  https.get(`https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`, (r) => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const suggestions = parsed[1] || [];
        setCache(cacheKey, suggestions);
        res.json(suggestions);
      } catch { res.json([]); }
    });
  }).on('error', () => res.json([]));
});

// ─── Search YouTube (cached 5 menit) ────────────────────────────
app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);

  const cacheKey = 'search:' + q.toLowerCase();
  const hit = cached(cacheKey);
  if (hit) return res.json(hit);

  try {
    const result = execSync(
      `yt-dlp --cookies '${COOKIE_PATH}' --flat-playlist --dump-json --no-warnings 'ytsearch10:${q.replace(/'/g, "'\\''")}' 2>/dev/null`,
      { timeout: 15000, maxBuffer: 512 * 1024 }
    );
    const items = parseYtLines(result);
    setCache(cacheKey, items);
    res.json(items);
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'Search gagal, coba lagi' });
  }
});

// ─── Related / Mix (cached 10 menit) ────────────────────────────
app.get('/api/related/:id', (req, res) => {
  const id = req.params.id;
  if (!id || id.length !== 11) return res.status(400).json({ error: 'Invalid ID' });

  const cacheKey = 'related:' + id;
  const hit = cached(cacheKey, 10 * 60 * 1000); // 10 menit
  if (hit) return res.json(hit);

  const tryMix = (url) => {
    try {
      const result = execSync(
        `yt-dlp --cookies '${COOKIE_PATH}' --flat-playlist --dump-json --no-warnings '${url}' 2>/dev/null`,
        { timeout: 10000, maxBuffer: 512 * 1024 }
      );
      const items = parseYtLines(result).slice(1, 16);
      setCache(cacheKey, items);
      return res.json(items);
    } catch { return null; }
  };

  // Coba YouTube Music mix dulu
  const musicUrl = `https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`;
  const result = tryMix(musicUrl);
  if (result === null) {
    // Fallback: YouTube regular mix
    const fallbackUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
    const fallback = tryMix(fallbackUrl);
    if (fallback === null) res.json([]);
  }
});

// ─── Stream audio via yt-dlp pipe ────────────────────────────────
app.get('/api/stream/:id', (req, res) => {
  const id = req.params.id;
  if (!id || id.length !== 11) return res.status(400).json({ error: 'Invalid ID' });

  const url = `https://youtube.com/watch?v=${id}`;
  let headersSent = false;

  const cleanup = () => { if (!headersSent && !res.writableEnded) { try { res.end(); } catch {} } };

  const spawnStream = (format) => {
    const yt = spawn('yt-dlp', [
      '--cookies', COOKIE_PATH,
      '--no-warnings',
      '--js-runtimes', 'deno',
      '--remote-components', 'ejs:github',
      '-f', format,
      '-o', '-',
      url,
    ]);

    yt.stdout.on('data', (chunk) => {
      if (!headersSent) {
        res.setHeader('Content-Type', format === '18/bestaudio/best' ? 'video/mp4' : 'audio/webm');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.setHeader('Accept-Ranges', 'none');
        headersSent = true;
      }
      res.write(chunk);
    });

    yt.stderr.on('data', () => {}); // silent

    yt.on('close', (code) => {
      if (!headersSent) {
        if (format === '18/bestaudio/best') {
          spawnStream('best'); // fallback
        } else {
          res.status(500).json({ error: 'Stream failed' });
        }
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    yt.on('error', () => cleanup());

    // Client disconnect
    req.on('close', () => { yt.kill(); cleanup(); });

    // Timeout 3 menit
    req.setTimeout(180000, () => { yt.kill(); cleanup(); });
  };

  spawnStream('18/bestaudio/best');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] YouTube Music Player running on port ${PORT}`);
});
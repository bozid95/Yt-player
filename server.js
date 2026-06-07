const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
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
    fs.chmodSync(COOKIE_PATH, 0o444); // read-only biar gak di-rewrite yt-dlp
    console.log('[OK] Cookies loaded from YOUTUBE_COOKIES env');
  } catch (e) {
    console.error('[ERR] Gagal decode YOUTUBE_COOKIES:', e.message);
  }
}

// Cek cookies di background (tanpa --cookies biar gak rewrite)
if (fs.existsSync(COOKIE_PATH)) {
  exec(`yt-dlp --skip-download --print id 'https://music.youtube.com/watch?v=dQw4w9WgXcQ' 2>/dev/null`,
    (err) => { if (err) console.warn('[WARN] Cookies mungkin expired'); else console.log('[OK] YouTube cookies valid'); }
  );
} else {
  console.warn('[WARN] Tidak ada cookies — streaming mungkin gagal');
}

// ─── Version endpoint (buat auto-update frontend) ──────────────
let appVersion = '0';
try {
  appVersion = fs.readFileSync('/app/version.txt', 'utf-8').trim();
} catch {}

app.get('/api/version', (req, res) => {
  res.json({ version: appVersion });
});

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

// ─── Search YouTube (cached 5 menit, async biar gak blocking) ──
app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);

  const cacheKey = 'search:' + q.toLowerCase();
  const hit = cached(cacheKey);
  if (hit) return res.json(hit);

  const child = exec(
    `yt-dlp --cookies '${COOKIE_PATH}' --flat-playlist --dump-json --no-warnings 'ytsearch10:${q.replace(/'/g, "'\\''")}' 2>/dev/null`,
    { timeout: 15000, maxBuffer: 512 * 1024 },
    (err, stdout) => {
      if (err) {
        console.error('Search error:', err.message);
        if (!res.headersSent) return res.status(500).json({ error: 'Search gagal, coba lagi' });
        return;
      }
      const items = parseYtLines(stdout);
      setCache(cacheKey, items);
      if (!res.headersSent) res.json(items);
    }
  );
  req.on('close', () => { if (child.exitCode === null) child.kill(); });
});

// ─── Related / Mix (cached 10 menit) ────────────────────────────
app.get('/api/related/:id', (req, res) => {
  const id = req.params.id;
  if (!id || id.length !== 11) return res.status(400).json({ error: 'Invalid ID' });

  const cacheKey = 'related:' + id;
  const hit = cached(cacheKey, 10 * 60 * 1000); // 10 menit
  if (hit) return res.json(hit);

  const tryMix = (url, done) => {
  const child = exec(
    `yt-dlp --cookies '${COOKIE_PATH}' --flat-playlist --playlist-end 16 --dump-json --no-warnings '${url}' 2>/dev/null`,
    { timeout: 15000, maxBuffer: 512 * 1024 },
    (err, stdout) => {
      if (err || res.headersSent) return done(null);
      const items = parseYtLines(stdout);
      if (items.length > 1) {
        setCache(cacheKey, items.slice(1, 16));
        return done(items.slice(1, 16));
      }
      done(null);
    }
  );
  req.on('close', () => { child.kill(); });
  };

  const musicUrl = `https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`;
  tryMix(musicUrl, (result) => {
  if (res.headersSent) return;
  if (result) return res.json(result);
  const fallbackUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
  tryMix(fallbackUrl, (fallback) => {
    if (!res.headersSent) res.json(fallback || []);
  });
  });
});

// ─── Stream audio via yt-dlp pipe ────────────────────────────────
app.get('/api/stream/:id', (req, res) => {
  const id = req.params.id;
  if (!id || id.length !== 11) return res.status(400).json({ error: 'Invalid ID' });

  const url = `https://youtube.com/watch?v=${id}`;

  // Pipe yt-dlp langsung — kirim header dulu biar browser mulai loading
  try {
    res.socket && res.socket.setNoDelay && res.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'audio/webm; codecs=opus',
      'Cache-Control': 'public, max-age=3600',
    });
    
    const yt = spawn('yt-dlp', [
      '--cookies', COOKIE_PATH,
      '--no-warnings',
      '--js-runtimes', 'deno',
      '--remote-components', 'ejs:github',
      '-f', 'bestaudio[acodec=opus]/bestaudio',
      '-o', '-',
      url,
    ]);

    yt.stdout.on('data', (chunk) => {
      if (!res.writableEnded) res.write(chunk);
    });

    yt.stderr.on('data', () => {});

    yt.on('close', (code) => {
      if (!res.writableEnded) res.end();
    });

    yt.on('error', () => { yt.kill(); if (!res.writableEnded) res.end(); });

    req.on('close', () => { yt.kill(); });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Stream gagal' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] YouTube Music Player running on port ${PORT}`);
});
const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;
const COOKIE_PATH = '/tmp/youtube-cookies.txt';

// ─── In-memory cache ──────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
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

// ─── Format metadata cache (buat seek / Range) ──────────────────
const formatMeta = new Map();
function getFormatMeta(id) {
  return new Promise((resolve, reject) => {
    const hit = formatMeta.get(id);
    if (hit && Date.now() - hit.time < 10 * 60 * 1000) return resolve(hit.data);

    exec(
      `yt-dlp --cookies '${COOKIE_PATH}' --no-warnings --js-runtimes deno --remote-components 'ejs:github' --print '%(format_id)s,%(filesize)s,%(duration)s' -f 'bestaudio[acodec=opus]/bestaudio' 'https://youtube.com/watch?v=${id}' 2>/dev/null`,
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) return reject(err || new Error('No format'));
        const p = stdout.trim().split(',');
        const data = { formatId: p[0], fileSize: parseInt(p[1]), duration: parseInt(p[2]) };
        formatMeta.set(id, { data, time: Date.now() });
        resolve(data);
      }
    );
  });
}

function secsToTime(sec) {
  const m = Math.floor(Math.max(0, sec) / 60);
  const s = Math.floor(Math.max(0, sec) % 60);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ─── Cookies ──────────────────────────────────────────────────────
if (process.env.YOUTUBE_COOKIES) {
  try {
    const content = Buffer.from(process.env.YOUTUBE_COOKIES, 'base64').toString('utf-8');
    fs.writeFileSync(COOKIE_PATH, content, 'utf-8');
    fs.chmodSync(COOKIE_PATH, 0o444);
    console.log('[OK] Cookies loaded from YOUTUBE_COOKIES env');
  } catch (e) {
    console.error('[ERR] Gagal decode YOUTUBE_COOKIES:', e.message);
  }
}

if (fs.existsSync(COOKIE_PATH)) {
  exec(`yt-dlp --skip-download --print id 'https://music.youtube.com/watch?v=dQw4w9WgXcQ' 2>/dev/null`,
    (err) => { if (err) console.warn('[WARN] Cookies mungkin expired'); else console.log('[OK] YouTube cookies valid'); }
  );
} else {
  console.warn('[WARN] Tidak ada cookies — streaming mungkin gagal');
}

// ─── Version endpoint ─────────────────────────────────────────────
let appVersion = '0';
try { appVersion = fs.readFileSync('/app/version.txt', 'utf-8').trim(); } catch {}
app.get('/api/version', (req, res) => { res.json({ version: appVersion }); });

// ─── Static files ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'frontend', 'dist'), {
  maxAge: '1h', etag: true, immutable: true,
}));

// ─── Parse yt-dlp JSON ────────────────────────────────────────────
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
  const hit = cached(cacheKey, 60000);
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

// ─── Search YouTube ───────────────────────────────────────────────
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

// ─── Related / Mix ────────────────────────────────────────────────
app.get('/api/related/:id', (req, res) => {
  const id = req.params.id;
  if (!id || id.length !== 11) return res.status(400).json({ error: 'Invalid ID' });
  const cacheKey = 'related:' + id;
  const hit = cached(cacheKey, 10 * 60 * 1000);
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

// ─── Stream audio ─────────────────────────────────────────────────
const YTDLP_ARGS = [
  '--cookies', COOKIE_PATH,
  '--no-warnings',
  '--js-runtimes', 'deno',
  '--remote-components', 'ejs:github',
];

app.get('/api/stream/:id', (req, res) => {
  const id = req.params.id;
  if (!id || id.length !== 11) return res.status(400).json({ error: 'Invalid ID' });
  const url = `https://youtube.com/watch?v=${id}`;
  const range = req.headers.range;

  // ── RANGE (seek) ──────────────────────────────────────────────
  if (range) {
    (async () => {
      try {
        const meta = await getFormatMeta(id);
        if (!meta.fileSize || !meta.duration) throw new Error('No metadata');
        const bytesPerSec = meta.fileSize / meta.duration;

        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : meta.fileSize - 1;
        const chunkSize = end - start + 1;

        const startTime = secsToTime(start / bytesPerSec);
        const endTime = secsToTime(end / bytesPerSec);
        const section = `*${startTime}` + (end < meta.fileSize - 1 ? `-${endTime}` : '');

        let headersSent = false;
        const yt = spawn('yt-dlp', [
          ...YTDLP_ARGS,
          '-f', meta.formatId,
          '-o', '-',
          '--download-sections', section,
          url,
        ]);

        yt.stdout.on('data', (chunk) => {
          if (!headersSent) {
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${meta.fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Type': 'audio/webm; codecs=opus',
              'Cache-Control': 'public, max-age=3600',
            });
            headersSent = true;
          }
          if (!res.writableEnded) res.write(chunk);
        });

        yt.stderr.on('data', () => {});

        yt.on('close', () => {
          if (!headersSent) { try { res.status(500).json({ error: 'Range gagal' }); } catch {} }
          else if (!res.writableEnded) res.end();
        });

        yt.on('error', () => { yt.kill(); if (!res.writableEnded) res.end(); });
        req.on('close', () => yt.kill());

      } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: 'Range error' });
      }
    })();
    return;
  }

  // ── FULL STREAM ───────────────────────────────────────────────
  try {
    res.socket && res.socket.setNoDelay && res.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'audio/webm; codecs=opus',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    });
    res.flushHeaders();

    const yt = spawn('yt-dlp', [
      ...YTDLP_ARGS,
      '-f', 'bestaudio[acodec=opus]/bestaudio',
      '-o', '-',
      url,
    ]);

    yt.stdout.on('data', (chunk) => {
      if (!res.writableEnded) res.write(chunk);
    });

    yt.stderr.on('data', () => {});

    yt.on('close', () => { if (!res.writableEnded) res.end(); });
    yt.on('error', () => { yt.kill(); if (!res.writableEnded) res.end(); });

    req.on('close', () => { yt.kill(); });

    // Pre-cache metadata buat seek berikutnya (background)
    getFormatMeta(id).catch(() => {});
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'Stream gagal' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] YouTube Music Player running on port ${PORT}`);
});

process.on('uncaughtException', (e) => console.error('Uncaught:', e.message));

const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = 3000;
const COOKIE_PATH = '/tmp/youtube-cookies.txt';

// Decode cookies dari env var (base64)
if (process.env.YOUTUBE_COOKIES) {
  try {
    const content = Buffer.from(process.env.YOUTUBE_COOKIES, 'base64').toString('utf-8');
    fs.writeFileSync(COOKIE_PATH, content, 'utf-8');
    console.log('[OK] Cookies loaded from YOUTUBE_COOKIES env');
  } catch (e) {
    console.error('[ERR] Gagal decode YOUTUBE_COOKIES:', e.message);
  }
}

app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

// Cek cookies di startup
if (fs.existsSync(COOKIE_PATH)) {
  try {
    execSync(`yt-dlp --cookies ${COOKIE_PATH} --skip-download --print id "https://music.youtube.com/watch?v=dQw4w9WgXcQ"`, { timeout: 10000 });
    console.log('[OK] YouTube cookies valid');
  } catch (e) {
    console.warn('[WARN] Cookies mungkin expired:', e.message);
  }
} else {
  console.warn('[WARN] Tidak ada cookies — streaming mungkin gagal');
}

// ─── Search suggestions ──────────────────────────────────────────
app.get('/api/suggest', (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 1) return res.json([]);
  const sanitized = encodeURIComponent(q);
  https.get(`https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${sanitized}`, (r) => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        res.json(parsed[1] || []);
      } catch { res.json([]); }
    });
  }).on('error', () => res.json([]));
});

// ─── Search YouTube ──────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);

  try {
    const sanitized = q.replace(/[^a-zA-Z0-9\s\-_]/g, '');
    const result = execSync(
      `yt-dlp --cookies ${COOKIE_PATH} --flat-playlist --dump-json --no-warnings "ytsearch10:${sanitized}" 2>/dev/null`,
      { timeout: 20000, maxBuffer: 1024 * 1024 }
    );
    const lines = result.toString().trim().split('\n').filter(Boolean);
    const items = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    res.json(items.map(item => ({
      id: item.id,
      title: item.title || 'Unknown',
      duration: item.duration || 0,
      thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      url: `https://youtube.com/watch?v=${item.id}`,
      channel: item.channel || item.uploader || 'Unknown',
    })));
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: 'Search failed: ' + e.message });
  }
});

// ─── Get video info ──────────────────────────────────────────────
app.get('/api/info/:id', (req, res) => {
  const id = req.params.id;
  if (!id || id.length !== 11) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const result = execSync(
      `yt-dlp --cookies ${COOKIE_PATH} --dump-json --no-warnings "https://youtube.com/watch?v=${id}" 2>/dev/null`,
      { timeout: 20000, maxBuffer: 1024 * 1024 }
    );
    const info = JSON.parse(result.toString());
    res.json({
      id: info.id,
      title: info.title,
      duration: info.duration,
      thumbnail: `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
      channel: info.channel || info.uploader,
      formats: (info.formats || []).filter(f => f.acodec && f.acodec !== 'none').map(f => ({
        id: f.format_id,
        ext: f.ext,
        abr: f.abr || 0,
        filesize: f.filesize || 0,
        url: f.url,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'Info fetch failed: ' + e.message });
  }
});

// ─── Related / Mix (autoplay recommendations) ────────────────────
app.get('/api/related/:id', (req, res) => {
  const id = req.params.id;
  if (!id || id.length !== 11) return res.status(400).json({ error: 'Invalid ID' });

  // Coba YouTube Music mix dulu, fallback ke YouTube regular mix
  const mixUrl = `https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`;
  try {
    const result = execSync(
      `yt-dlp --cookies ${COOKIE_PATH} --flat-playlist --dump-json --no-warnings "${mixUrl}" 2>/dev/null`,
      { timeout: 15000, maxBuffer: 1024 * 1024 }
    );
    const lines = result.toString().trim().split('\n').filter(Boolean);
    const items = lines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    // Skip the first item (it's the same video), max 15 recommendations
    const related = items.slice(1, 16).map(item => ({
      id: item.id,
      title: item.title || 'Unknown',
      duration: item.duration || 0,
      thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
      channel: item.channel || item.uploader || 'Unknown',
    }));
    res.json(related);
  } catch {
    // Fallback: coba YouTube regular mix
    try {
      const fallbackUrl = `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
      const result = execSync(
        `yt-dlp --cookies ${COOKIE_PATH} --flat-playlist --dump-json --no-warnings "${fallbackUrl}" 2>/dev/null`,
        { timeout: 15000, maxBuffer: 1024 * 1024 }
      );
      const lines = result.toString().trim().split('\n').filter(Boolean);
      const items = lines.map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      const related = items.slice(1, 16).map(item => ({
        id: item.id,
        title: item.title || 'Unknown',
        duration: item.duration || 0,
        thumbnail: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
        channel: item.channel || item.uploader || 'Unknown',
      }));
      res.json(related);
    } catch (e) {
      res.json([]); // Gak ada rekomendasi
    }
  }
});

// ─── Stream audio via yt-dlp pipe ────────────────────────────────
app.get('/api/stream/:id', (req, res) => {
  const id = req.params.id;
  if (!id || id.length !== 11) return res.status(400).json({ error: 'Invalid ID' });

  const url = `https://youtube.com/watch?v=${id}`;

  // Pipe yt-dlp output langsung ke response
  // Format: 18 (360p mp4 with AAC audio) atau fallback
  const yt = spawn('yt-dlp', [
    '--cookies', COOKIE_PATH,
    '--no-warnings',
    '--js-runtimes', 'deno',
    '--remote-components', 'ejs:github',
    '-f', '18/bestaudio/best',
    '-o', '-',
    url,
  ]);

  let headersSent = false;
  let hasData = false;

  yt.stdout.on('data', (chunk) => {
    if (!headersSent) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      headersSent = true;
      hasData = true;
    }
    res.write(chunk);
  });

  yt.stderr.on('data', (chunk) => {
    const msg = chunk.toString();
    if (msg.includes('ERROR')) {
      console.error('[yt-dlp error]', msg);
    }
  });

  yt.on('close', (code) => {
    if (!headersSent) {
      // Gagal, coba tanpa format spesifik
      const yt2 = spawn('yt-dlp', [
        '--cookies', COOKIE_PATH,
        '--no-warnings',
        '--js-runtimes', 'deno',
        '--remote-components', 'ejs:github',
        '-f', 'best',
        '-o', '-',
        url,
      ]);

      yt2.stdout.on('data', (chunk) => {
        if (!headersSent) {
          res.setHeader('Content-Type', 'audio/webm');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          headersSent = true;
          hasData = true;
        }
        res.write(chunk);
      });

      yt2.on('close', (code2) => {
        if (!headersSent) {
          res.status(500).json({ error: 'Stream failed' });
        } else {
          res.end();
        }
      });

      yt2.on('error', (e) => {
        if (!headersSent) res.status(500).json({ error: e.message });
      });

      return;
    }
    res.end();
  });

  yt.on('error', (e) => {
    if (!headersSent) res.status(500).json({ error: e.message });
  });

  // Timeout
  req.setTimeout(180000, () => {
    yt.kill();
    if (!res.headersSent) res.status(504).end();
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] YouTube Music Player running on port ${PORT}`);
});

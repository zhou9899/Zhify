// enhanced-server.js
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000; // 🚀 Use Railway PORT

// ================== BASIC SECURITY ==================
const API_KEY = process.env.API_KEY || "MASTER_KEY_123"; // use env variable
const RATE_LIMIT = 30; // requests per IP per minute
const rateMap = new Map();

// ================== HEADERS ==================
const YT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Accept: "*/*",
  Referer: "https://www.youtube.com/",
};

// ================== CACHE ==================
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000;

// ================== MIDDLEWARE ==================
app.use((req, res, next) => {
  const key = req.query.key;
  if (key !== API_KEY)
    return res.status(403).json({ error: "Invalid API key" });

  const ip = req.ip;
  const now = Date.now();

  const record = rateMap.get(ip) || [];
  const recent = record.filter((t) => now - t < 60000);

  if (recent.length >= RATE_LIMIT)
    return res.status(429).json({ error: "Rate limit exceeded" });

  recent.push(now);
  rateMap.set(ip, recent);
  next();
});

// ================== HELPERS ==================
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.time > CACHE_DURATION) {
    cache.delete(key);
    return null;
  }
  return v.data;
}

function cacheSet(key, data) {
  cache.set(key, { time: Date.now(), data });
}

// ================== SEARCH ==================
async function searchYouTube(query) {
  const cached = cacheGet(`search:${query}`);
  if (cached) return cached;

  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(
    query
  )}`;
  const res = await axios.get(url, { headers: YT_HEADERS });

  const match = res.data.match(/var ytInitialData\s*=\s*({.*?});<\/script>/s);
  if (!match) return [];

  const data = JSON.parse(match[1]);
  const results = [];

  (function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if (obj.videoRenderer) {
      const v = obj.videoRenderer;
      results.push({
        id: v.videoId,
        title: v.title?.runs?.[0]?.text,
        channel: v.ownerText?.runs?.[0]?.text,
        duration: v.lengthText?.simpleText,
        views: v.viewCountText?.simpleText,
        thumbnail: v.thumbnail?.thumbnails?.pop()?.url,
      });
    }
    Object.values(obj).forEach(walk);
  })(data);

  cacheSet(`search:${query}`, results);
  return results;
}

// ================== VIDEO INFO ==================
async function getVideoInfo(videoId) {
  const cached = cacheGet(`info:${videoId}`);
  if (cached) return cached;

  const res = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: YT_HEADERS,
  });

  const match = res.data.match(
    /var ytInitialPlayerResponse\s*=\s*({.*?});<\/script>/s
  );

  if (!match) return null;

  const data = JSON.parse(match[1]).videoDetails;
  cacheSet(`info:${videoId}`, data);
  return data;
}

// ================== ROUTES ==================
app.get("/search", async (req, res) => {
  try {
    res.json(await searchYouTube(req.query.q));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/info", async (req, res) => {
  try {
    res.json(await getVideoInfo(req.query.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ================== DOWNLOAD API ==================
app.get("/download", (req, res) => {
  const { videoId, format = "best" } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const formats = {
    mp3: "bestaudio --extract-audio --audio-format mp3",
    m4a: "bestaudio",
    "360p": "bestvideo[height<=360]+bestaudio/best",
    "720p": "bestvideo[height<=720]+bestaudio/best",
    best: "best",
  };

  const fmt = formats[format] || formats.best;
  const cmd = `yt-dlp -f "${fmt}" -g "${url}"`;

  exec(cmd, (err, stdout) => {
    if (err || !stdout)
      return res.status(500).json({ error: "yt-dlp failed" });

    res.json({
      videoId,
      format,
      downloadUrl: stdout.trim(),
      expires: "≈ 6 hours",
    });
  });
});

// ================== CACHE CONTROL ==================
app.get("/cache", (req, res) => {
  res.json({ size: cache.size, keys: [...cache.keys()] });
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`🚀 API READY → http://localhost:${PORT}`);
});

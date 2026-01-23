// enhanced-server.js - FIXED: VIDEO WITH AUDIO MERGED
const express = require("express");
const { exec } = require("child_process");
const util = require("util");

const execPromise = util.promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// ================== BASIC SECURITY ==================
const API_KEY = process.env.API_KEY || "MASTER_KEY_123";
const RATE_LIMIT = 30;
const rateMap = new Map();

// ================== CORS ==================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

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

// ================== FIXED FORMAT MAPPING ==================
const formatPresets = {
  // Audio formats
  "mp3": "bestaudio[ext=webm]/bestaudio",
  "m4a": "bestaudio[ext=m4a]/bestaudio",
  "aac": "bestaudio",
  "opus": "bestaudio[ext=webm]",
  "flac": "bestaudio",
  "wav": "bestaudio",

  // Video formats - Use combined format codes
  "144p": "bestvideo[height<=144]+bestaudio/best[height<=144]",
  "240p": "bestvideo[height<=240]+bestaudio/best[height<=240]",
  "360p": "bestvideo[height<=360]+bestaudio/best[height<=360]",
  "480p": "bestvideo[height<=480]+bestaudio/best[height<=480]",
  "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]",
  "1080p": "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
  "1440p": "bestvideo[height<=1440]+bestaudio/best[height<=1440]",
  "2160p": "bestvideo[height<=2160]+bestaudio/best[height<=2160]",

  // Special formats
  "best": "bestvideo+bestaudio/best",
  "worst": "worstvideo+worstaudio/worst",
  "mp4": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]",
  "webm": "bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]",
  "mkv": "bestvideo+bestaudio/best"
};

// ================== DOWNLOAD API - STREAMS MERGED VIDEO ==================
app.get("/download", async (req, res) => {
  const { videoId, format = "best", stream = "true" } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const fmt = formatPresets[format] || formatPresets.best;

  try {
    console.log(`Processing: ${videoId}, Format: ${format}`);
    
    // ALWAYS stream merged content (since ffmpeg is installed)
    let cmd;
    
    if (["mp3", "m4a", "aac", "flac", "wav", "opus"].includes(format)) {
      // Audio extraction with ffmpeg
      const audioFormat = format === "opus" ? "opus" : format;
      cmd = `yt-dlp -f "${fmt}" --extract-audio --audio-format ${audioFormat} -o - "${url}"`;
      
      res.setHeader('Content-Type', 
        format === 'mp3' ? 'audio/mpeg' : 
        format === 'm4a' ? 'audio/mp4' : 
        format === 'aac' ? 'audio/aac' : 
        format === 'flac' ? 'audio/flac' : 
        format === 'wav' ? 'audio/wav' : 
        'audio/ogg'
      );
      res.setHeader('Content-Disposition', `attachment; filename="youtube_${videoId}.${format}"`);
      
    } else {
      // Video with audio merge using ffmpeg
      const outputFormat = format === "webm" ? "webm" : "mp4";
      cmd = `yt-dlp -f "${fmt}" --merge-output-format ${outputFormat} -o - "${url}"`;
      
      res.setHeader('Content-Type', outputFormat === 'webm' ? 'video/webm' : 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="youtube_${videoId}.${outputFormat}"`);
    }
    
    console.log("Stream command:", cmd);
    
    // Stream the merged content directly
    const childProcess = exec(cmd);
    
    // Pipe to response
    childProcess.stdout.pipe(res);
    
    // Handle errors
    childProcess.stderr.on('data', (data) => {
      console.error('yt-dlp stderr:', data.toString());
    });
    
    childProcess.on('error', (error) => {
      console.error('Process error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Download failed", details: error.message });
      }
    });
    
    childProcess.on('close', (code) => {
      console.log(`Process exited with code ${code}`);
    });
    
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({ 
      error: "Failed to process download",
      details: error.message
    });
  }
});

// ================== GET AVAILABLE FORMATS ==================
app.get("/formats", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  try {
    const cmd = `yt-dlp -F "https://www.youtube.com/watch?v=${videoId}"`;
    const { stdout } = await execPromise(cmd);

    const lines = stdout.split('\n');
    const formats = [];

    for (const line of lines) {
      if (line.match(/^\s*\d+/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          formats.push({
            id: parts[0],
            extension: parts[1],
            resolution: parts[2],
            note: parts.slice(3).join(' ')
          });
        }
      }
    }

    res.json({
      videoId,
      availableFormats: formats,
      presets: Object.keys(formatPresets),
      note: "All downloads include merged video+audio (ffmpeg installed)"
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== HEALTH CHECK ==================
app.get("/", (req, res) => {
  res.json({
    service: "YouTube Download API",
    version: "3.0-merged",
    endpoint: "/download?videoId=ID&format=FORMAT&key=API_KEY",
    availableFormats: Object.keys(formatPresets),
    example: `https://zhify-production.up.railway.app/download?videoId=dQw4w9WgXcQ&format=720p&key=${API_KEY}`,
    note: "Downloads merged video+audio automatically (ffmpeg installed)"
  });
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`🚀 API READY → http://localhost:${PORT}`);
  console.log(`✅ ffmpeg is installed - videos include audio!`);
  console.log(`📝 Available formats: ${Object.keys(formatPresets).join(', ')}`);
});

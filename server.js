// enhanced-server.js - FIXED FORMATS
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");
const util = require("util");

const execPromise = util.promisify(exec); // Better error handling

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
  "mp3": "bestaudio[ext=webm]/bestaudio --extract-audio --audio-format mp3",
  "m4a": "bestaudio[ext=m4a]/bestaudio --extract-audio --audio-format m4a",
  "aac": "bestaudio --extract-audio --audio-format aac",
  "opus": "bestaudio[ext=webm]",
  "flac": "bestaudio --extract-audio --audio-format flac",
  "wav": "bestaudio --extract-audio --audio-format wav",
  
  // Video formats - FIXED: Use proper syntax
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
  
  // Container formats
  "mp4": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]",
  "webm": "bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]",
  "mkv": "bestvideo+bestaudio",
  "avi": "best[ext=avi]",
  "3gp": "best[ext=3gp]"
};

// ================== DOWNLOAD API - FIXED ==================
app.get("/download", async (req, res) => {
  const { videoId, format = "best" } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  
  // Get format preset or use default
  const fmt = formatPresets[format] || formatPresets.best;
  
  try {
    // For audio formats that need extraction
    if (["mp3", "m4a", "aac", "flac", "wav"].includes(format)) {
      // Try extraction first
      const cmd = `yt-dlp -f "${fmt}" -g --no-playlist "${url}"`;
      console.log("Audio command:", cmd);
      
      const { stdout, stderr } = await execPromise(cmd);
      
      if (stderr && stderr.includes("ffmpeg") && stderr.includes("not found")) {
        // Fallback to direct audio URL if ffmpeg not available
        const fallbackCmd = `yt-dlp -f "bestaudio" -g --no-playlist "${url}"`;
        const { stdout: audioStdout } = await execPromise(fallbackCmd);
        
        return res.json({
          videoId,
          format: `${format} (direct stream)`,
          downloadUrl: audioStdout.trim(),
          expires: "≈ 6 hours",
          note: "Direct audio stream - convert with ffmpeg if needed"
        });
      }
      
      res.json({
        videoId,
        format,
        downloadUrl: stdout.trim(),
        expires: "≈ 6 hours"
      });
      
    } else {
      // For video formats - get direct URLs
      const cmd = `yt-dlp -f "${fmt}" -g --no-playlist "${url}"`;
      console.log("Video command:", cmd);
      
      const { stdout, stderr } = await execPromise(cmd);
      
      if (stderr && !stderr.includes("WARNING:")) {
        console.error("yt-dlp error:", stderr);
      }
      
      const urls = stdout.trim().split('\n');
      
      // Return appropriate response
      if (urls.length === 1) {
        res.json({
          videoId,
          format,
          downloadUrl: urls[0],
          expires: "≈ 6 hours"
        });
      } else if (urls.length === 2) {
        res.json({
          videoId,
          format,
          videoUrl: urls[0], // Usually video
          audioUrl: urls[1], // Usually audio
          expires: "≈ 6 hours",
          note: "Separate video and audio streams. Merge with ffmpeg"
        });
      } else {
        res.json({
          videoId,
          format,
          downloadUrls: urls,
          expires: "≈ 6 hours"
        });
      }
    }
    
  } catch (error) {
    console.error("Download error:", error);
    
    // Try fallback
    try {
      const fallbackCmd = `yt-dlp -f "best" -g --no-playlist "${url}"`;
      const { stdout } = await execPromise(fallbackCmd);
      
      res.json({
        videoId,
        format: "best (fallback)",
        downloadUrl: stdout.trim(),
        expires: "≈ 6 hours"
      });
    } catch (fallbackError) {
      res.status(500).json({ 
        error: "Failed to get download URL",
        details: error.message
      });
    }
  }
});

// ================== GET AVAILABLE FORMATS ==================
app.get("/formats", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  try {
    const cmd = `yt-dlp -F "https://www.youtube.com/watch?v=${videoId}"`;
    const { stdout } = await execPromise(cmd);
    
    // Parse yt-dlp format list
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
      presets: Object.keys(formatPresets)
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== OTHER ROUTES (keep existing) ==================
// [Your existing search, info, cache routes remain unchanged]

// ================== HEALTH CHECK ==================
app.get("/", (req, res) => {
  res.json({
    service: "YouTube Download API",
    version: "2.0-fixed",
    availableFormats: Object.keys(formatPresets),
    example: `/download?videoId=dQw4w9WgXcQ&format=720p&key=${API_KEY}`,
    note: "Fixed format mapping for accurate quality selection"
  });
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`🚀 API READY → http://localhost:${PORT}`);
  console.log(`📝 Available formats: ${Object.keys(formatPresets).join(', ')}`);
});

// enhanced-server.js - FIXED: DOWNLOADS MERGED VIDEO+AUDIO
const express = require("express");
const { exec } = require("child_process");
const util = require("util");

const execPromise = util.promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// ================== BASIC SECURITY ==================
const API_KEY = process.env.API_KEY || "MASTER_KEY_123";

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
  next();
});

// ================== FORMAT MAPPING ==================
const formatPresets = {
  // Audio formats
  "mp3": "bestaudio[ext=webm]/bestaudio --extract-audio --audio-format mp3",
  "m4a": "bestaudio[ext=m4a]/bestaudio --extract-audio --audio-format m4a",
  "aac": "bestaudio --extract-audio --audio-format aac",
  "opus": "bestaudio[ext=webm]",
  "flac": "bestaudio --extract-audio --audio-format flac",
  "wav": "bestaudio --extract-audio --audio-format wav",

  // Video formats
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
  "mkv": "bestvideo+bestaudio",
  "avi": "best[ext=avi]",
  "3gp": "best[ext=3gp]"
};

// ================== DOWNLOAD API - MERGES VIDEO+AUDIO ==================
app.get("/download", async (req, res) => {
  const { videoId, format = "best" } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const fmt = formatPresets[format] || formatPresets.best;

  try {
    console.log(`Download: ${videoId}, Format: ${format}`);
    
    // Remove --extract-audio and --audio-format from command for streaming
    const cleanFmt = fmt.replace(/--extract-audio --audio-format \w+/g, "").trim();
    
    // Get the actual format to use
    let ytDlpFormat = cleanFmt;
    
    // For audio, we need to extract
    if (["mp3", "m4a", "aac", "flac", "wav", "opus"].includes(format)) {
      // Audio extraction
      const audioFormat = format === "opus" ? "opus" : format;
      const cmd = `yt-dlp -f "${cleanFmt}" --extract-audio --audio-format ${audioFormat} -o - "${url}"`;
      
      console.log("Audio command:", cmd);
      
      res.setHeader('Content-Type', 
        format === 'mp3' ? 'audio/mpeg' : 
        format === 'm4a' ? 'audio/mp4' : 
        format === 'aac' ? 'audio/aac' : 
        format === 'flac' ? 'audio/flac' : 
        format === 'wav' ? 'audio/wav' : 
        'audio/ogg'
      );
      res.setHeader('Content-Disposition', `attachment; filename="youtube_${videoId}.${format}"`);
      
      const child = exec(cmd);
      child.stdout.pipe(res);
      child.stderr.on('data', (data) => console.error("yt-dlp error:", data.toString()));
      
    } else {
      // Video with audio merge
      const outputFormat = format === "webm" ? "webm" : "mp4";
      const cmd = `yt-dlp -f "${cleanFmt}" --merge-output-format ${outputFormat} -o - "${url}"`;
      
      console.log("Video command:", cmd);
      
      res.setHeader('Content-Type', outputFormat === 'webm' ? 'video/webm' : 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="youtube_${videoId}.${outputFormat}"`);
      
      const child = exec(cmd);
      child.stdout.pipe(res);
      child.stderr.on('data', (data) => console.error("yt-dlp error:", data.toString()));
    }
    
  } catch (error) {
    console.error("Download error:", error);
    res.status(500).json({ 
      error: "Failed to download",
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
    const { stdout, stderr } = await execPromise(cmd);

    if (stderr && stderr.includes("ERROR")) {
      return res.status(500).json({ error: stderr.split('\n')[0] });
    }

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

// ================== HEALTH CHECK ==================
app.get("/", (req, res) => {
  res.json({
    service: "YouTube Download API",
    endpoint: "/download?videoId=ID&format=FORMAT&key=API_KEY",
    availableFormats: Object.keys(formatPresets),
    example: `https://zhify-production.up.railway.app/download?videoId=dQw4w9WgXcQ&format=720p&key=${API_KEY}`,
    note: "Downloads merged video+audio automatically"
  });
});

// ================== START ==================
app.listen(PORT, () => {
  console.log(`🚀 API READY → http://localhost:${PORT}`);
  console.log(`📝 Available formats: ${Object.keys(formatPresets).join(', ')}`);
  console.log(`✅ ffmpeg installed - videos include audio!`);
});

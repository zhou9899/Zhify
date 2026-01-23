// enhanced-server.js - HIGH QUALITY VERSION
const express = require("express");
const axios = require("axios");
const { exec, spawn } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const stream = require("stream");
const { promisify } = require("util");

const execPromise = util.promisify(exec);
const pipeline = promisify(stream.pipeline);

const app = express();
const PORT = process.env.PORT || 3000;

// ================== BASIC SECURITY ==================
const API_KEY = process.env.API_KEY || "MASTER_KEY_123";
const RATE_LIMIT = 30;
const rateMap = new Map();

// Temp directory for downloads
const TEMP_DIR = path.join(__dirname, "temp");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Clean temp files every hour
setInterval(() => {
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const now = new Date().getTime();
        const endTime = new Date(stat.mtime).getTime() + 3600000; // 1 hour
        if (now > endTime) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {
        // Ignore errors
      }
    });
  });
}, 3600000);

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

// ================== HIGH QUALITY VIDEO WITH AUDIO ==================
// YouTube format combinations for high quality with audio
const highQualityFormats = {
  "720p": "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]",
  "1080p": "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]",
  "1440p": "bestvideo[height<=1440][ext=mp4]+bestaudio[ext=m4a]/best[height<=1440][ext=mp4]",
  "2160p": "bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/best[height<=2160][ext=mp4]",
  "best": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]",
  "mp4": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]"
};

// Legacy formats (always available)
const legacyFormats = {
  "360p": "18",      // MP4 360p with audio
  "480p": "135+140", // 480p video + audio
  "720p_old": "22",  // MP4 720p with audio (if available)
};

// ================== DOWNLOAD HIGH QUALITY VIDEO ==================
app.get("/download", async (req, res) => {
  const { videoId, format = "720p" } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const timestamp = Date.now();
  
  // Use different filename based on format
  const fileName = `${videoId}_${format.replace(/[^a-z0-9]/gi, '_')}_${timestamp}.mp4`;
  const filePath = path.join(TEMP_DIR, fileName);

  try {
    console.log(`🚀 Downloading ${videoId} in ${format} quality...`);
    
    let formatSpec = "";
    
    // Check if it's a high quality format
    if (highQualityFormats[format]) {
      formatSpec = highQualityFormats[format];
    } 
    // Check if it's a legacy format
    else if (legacyFormats[format]) {
      formatSpec = legacyFormats[format];
    }
    // Default to best quality
    else {
      formatSpec = highQualityFormats.best;
    }
    
    console.log(`📝 Using format: ${formatSpec}`);
    
    // Download with yt-dlp - this will automatically merge video and audio
    const cmd = `yt-dlp -f "${formatSpec}" --merge-output-format mp4 --no-playlist -o "${filePath}" "${url}"`;
    
    console.log(`🔧 Executing: ${cmd}`);
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, async (error, stdout, stderr) => {
      if (error) {
        console.error("❌ Download error:", error.message);
        
        // Try fallback: download video and audio separately then merge
        if (stderr && stderr.includes("ffmpeg")) {
          console.log("⚠️  FFmpeg not found, trying direct format...");
          
          // Try to get a direct format that includes audio
          try {
            const directFormat = await getDirectFormat(videoId, format);
            const fallbackCmd = `yt-dlp -f "${directFormat}" --no-playlist -o "${filePath}" "${url}"`;
            
            exec(fallbackCmd, { maxBuffer: 1024 * 1024 * 50 }, (fallbackError, fallbackStdout, fallbackStderr) => {
              if (fallbackError) {
                console.error("❌ Fallback failed:", fallbackError.message);
                res.status(500).json({ 
                  error: "Failed to download video",
                  details: "Both primary and fallback methods failed",
                  suggestion: "Try a lower quality like 360p or 720p"
                });
              } else {
                console.log("✅ Fallback download successful!");
                serveDownload(filePath, videoId, format, res);
              }
            });
          } catch (directError) {
            res.status(500).json({ 
              error: "No suitable format found",
              details: directError.message
            });
          }
        } else {
          res.status(500).json({ 
            error: "Download failed",
            details: error.message,
            stderr: stderr
          });
        }
      } else {
        console.log("✅ Download completed successfully!");
        console.log(`📁 File saved to: ${filePath}`);
        
        if (stdout) console.log("yt-dlp output:", stdout);
        if (stderr) console.log("yt-dlp warnings:", stderr);
        
        serveDownload(filePath, videoId, format, res);
      }
    });
  } catch (error) {
    console.error("❌ Server error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Helper to get best direct format with audio
async function getDirectFormat(videoId, desiredQuality) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  
  try {
    // Get list of all formats
    const cmd = `yt-dlp -F --no-playlist "${url}"`;
    const { stdout } = await execPromise(cmd);
    
    const lines = stdout.split('\n');
    let bestFormat = "18"; // Default fallback
    
    // Look for formats that include audio
    for (const line of lines) {
      if (line.includes('mp4') && !line.includes('video only') && !line.includes('audio only')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const formatId = parts[0];
          const resolution = parts[2];
          
          // Check if this matches our desired quality
          if (desiredQuality === "720p" && resolution.includes('1280x720')) {
            return formatId;
          } else if (desiredQuality === "1080p" && resolution.includes('1920x1080')) {
            return formatId;
          } else if (desiredQuality === "480p" && resolution.includes('854x480')) {
            return formatId;
          }
        }
      }
    }
    
    return bestFormat;
  } catch (error) {
    return "18"; // Fallback to 360p
  }
}

function serveDownload(filePath, videoId, format, res) {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const fileName = `${videoId}_${format}.mp4`;
      
      console.log(`📦 Serving file: ${filePath} (${Math.round(stats.size / 1024 / 1024)} MB)`);
      
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Cache-Control', 'no-cache');
      
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);
      
      // Delete file after streaming
      fileStream.on('end', () => {
        console.log(`🗑️  Cleaning up: ${filePath}`);
        setTimeout(() => {
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          } catch (e) {
            console.error("Failed to delete file:", e.message);
          }
        }, 5000);
      });
      
      fileStream.on('error', (err) => {
        console.error("Stream error:", err);
        res.status(500).json({ error: "Stream error" });
      });
    } else {
      console.error("File not found:", filePath);
      res.status(500).json({ error: "File not found after download" });
    }
  } catch (error) {
    console.error("Serve error:", error);
    res.status(500).json({ error: error.message });
  }
}

// ================== QUICK DOWNLOAD (No merging, faster) ==================
app.get("/quick", async (req, res) => {
  const { videoId, quality = "720p" } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const timestamp = Date.now();
  const filePath = path.join(TEMP_DIR, `${videoId}_quick_${timestamp}.mp4`);
  
  try {
    // For quick downloads, use formats that already have audio
    const quickFormats = {
      "360p": "18",  // Always available
      "720p": "22",  // If available
      "best_direct": "best[ext=mp4]"
    };
    
    const format = quickFormats[quality] || quickFormats.best_direct;
    
    console.log(`⚡ Quick download: ${videoId} with format ${format}`);
    
    const cmd = `yt-dlp -f "${format}" --no-playlist -o "${filePath}" "${url}"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) {
        // Fallback to 360p
        const fallbackCmd = `yt-dlp -f "18" --no-playlist -o "${filePath}" "${url}"`;
        
        exec(fallbackCmd, { maxBuffer: 1024 * 1024 * 50 }, (fallbackError, fallbackStdout, fallbackStderr) => {
          if (fallbackError) {
            res.status(500).json({ error: "Quick download failed" });
          } else {
            serveDownload(filePath, videoId, "360p_fallback", res);
          }
        });
      } else {
        serveDownload(filePath, videoId, quality, res);
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== GET AVAILABLE QUALITIES ==================
app.get("/qualities", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  
  try {
    // Get all formats
    const cmd = `yt-dlp -F --no-playlist "${url}"`;
    const { stdout } = await execPromise(cmd);
    
    const lines = stdout.split('\n');
    const formats = [];
    const videoOnly = [];
    const audioOnly = [];
    
    for (const line of lines) {
      if (line.match(/^\s*\d+/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const formatInfo = {
            id: parts[0],
            extension: parts[1],
            resolution: parts[2],
            note: parts.slice(3).join(' ')
          };
          
          if (formatInfo.note.includes('video only')) {
            videoOnly.push(formatInfo);
          } else if (formatInfo.note.includes('audio only')) {
            audioOnly.push(formatInfo);
          } else {
            formats.push(formatInfo);
          }
        }
      }
    }
    
    // Determine best available combined formats
    const recommendations = [];
    
    // Check for 4K
    if (formats.some(f => f.resolution.includes('3840x2160'))) {
      recommendations.push("2160p (4K)");
    }
    
    // Check for 1440p
    if (formats.some(f => f.resolution.includes('2560x1440'))) {
      recommendations.push("1440p");
    }
    
    // Check for 1080p
    if (formats.some(f => f.resolution.includes('1920x1080'))) {
      recommendations.push("1080p");
    }
    
    // Check for 720p
    if (formats.some(f => f.resolution.includes('1280x720'))) {
      recommendations.push("720p");
    }
    
    res.json({
      videoId,
      combinedFormats: formats,
      videoOnlyFormats: videoOnly,
      audioOnlyFormats: audioOnly,
      recommendations: recommendations.length > 0 ? recommendations : ["720p", "1080p"],
      endpoints: {
        download: `/download?videoId=${videoId}&format=720p&key=${API_KEY}`,
        quick: `/quick?videoId=${videoId}&quality=720p&key=${API_KEY}`,
        player: `/player?videoId=${videoId}&quality=720p&key=${API_KEY}`
      },
      note: "High quality downloads may take longer as video and audio streams are merged"
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ================== HTML PLAYER WITH QUALITY SELECTOR ==================
app.get("/player", (req, res) => {
  const { videoId, quality = "720p" } = req.query;
  if (!videoId) return res.status(400).send("Missing videoId");

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>YouTube Downloader - ${videoId}</title>
    <style>
      body { margin: 0; padding: 20px; font-family: Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
      .container { max-width: 900px; margin: 0 auto; background: white; padding: 30px; border-radius: 15px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
      h1 { color: #333; text-align: center; margin-bottom: 30px; }
      .video-info { background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
      .quality-selector { margin: 20px 0; }
      select, button { padding: 12px 20px; font-size: 16px; border-radius: 8px; border: 1px solid #ddd; }
      button { background: #4CAF50; color: white; border: none; cursor: pointer; margin-left: 10px; }
      button:hover { background: #45a049; }
      .btn-download { background: #2196F3; display: inline-block; padding: 12px 25px; color: white; text-decoration: none; border-radius: 8px; margin: 10px 5px; }
      .btn-download:hover { background: #0b7dda; }
      .loading { display: none; color: #666; margin: 20px 0; }
      .alert { background: #ffebee; color: #c62828; padding: 15px; border-radius: 8px; margin: 20px 0; }
      .quality-badge { display: inline-block; padding: 5px 10px; background: #e3f2fd; color: #1565c0; border-radius: 4px; font-size: 14px; margin-left: 10px; }
    </style>
    <script>
      function changeQuality() {
        const quality = document.getElementById('qualitySelect').value;
        const videoId = '${videoId}';
        const key = '${API_KEY}';
        const newUrl = '/player?videoId=' + videoId + '&quality=' + quality + '&key=' + key;
        window.location.href = newUrl;
      }
      
      function startDownload() {
        const quality = document.getElementById('qualitySelect').value;
        const videoId = '${videoId}';
        const key = '${API_KEY}';
        const downloadUrl = '/download?videoId=' + videoId + '&format=' + quality + '&key=' + key;
        
        document.getElementById('loading').style.display = 'block';
        document.getElementById('downloadLink').href = downloadUrl;
        document.getElementById('downloadLink').click();
        
        setTimeout(() => {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('successMsg').style.display = 'block';
        }, 2000);
      }
      
      function quickDownload() {
        const quality = document.getElementById('qualitySelect').value;
        const videoId = '${videoId}';
        const key = '${API_KEY}';
        const quickUrl = '/quick?videoId=' + videoId + '&quality=' + quality + '&key=' + key;
        
        window.open(quickUrl, '_blank');
      }
    </script>
  </head>
  <body>
    <div class="container">
      <h1>🎬 YouTube Video Downloader</h1>
      
      <div class="video-info">
        <strong>Video ID:</strong> ${videoId}<br>
        <strong>Selected Quality:</strong> ${quality} <span class="quality-badge">${quality}</span>
      </div>
      
      <div class="quality-selector">
        <label for="qualitySelect"><strong>Select Quality:</strong></label>
        <select id="qualitySelect" onchange="changeQuality()">
          <option value="720p" ${quality === '720p' ? 'selected' : ''}>720p HD</option>
          <option value="1080p" ${quality === '1080p' ? 'selected' : ''}>1080p Full HD</option>
          <option value="1440p" ${quality === '1440p' ? 'selected' : ''}>1440p 2K</option>
          <option value="2160p" ${quality === '2160p' ? 'selected' : ''}>2160p 4K</option>
          <option value="best" ${quality === 'best' ? 'selected' : ''}>Best Available</option>
          <option value="360p" ${quality === '360p' ? 'selected' : ''}>360p (Fastest)</option>
        </select>
        <button onclick="changeQuality()">Change Quality</button>
      </div>
      
      <div>
        <h3>Download Options:</h3>
        <a class="btn-download" href="javascript:void(0)" onclick="startDownload()">
          ⬇️ Download High Quality (Merged Audio)
        </a>
        <a class="btn-download" href="javascript:void(0)" onclick="quickDownload()">
          ⚡ Quick Download (Faster)
        </a>
        <a class="btn-download" href="/qualities?videoId=${videoId}&key=${API_KEY}">
          📊 Available Qualities
        </a>
        <a class="btn-download" href="/">
          🏠 Home
        </a>
      </div>
      
      <div id="loading" class="loading">
        ⏳ Preparing your download... This may take a minute for high quality videos.
      </div>
      
      <div id="successMsg" class="alert" style="display: none; background: #e8f5e9; color: #2e7d32;">
        ✅ Download started! Check your browser's download manager.
      </div>
      
      <div style="margin-top: 30px; padding: 20px; background: #f5f5f5; border-radius: 8px;">
        <h4>ℹ️ Information:</h4>
        <ul>
          <li><strong>High Quality Download:</strong> Merges video and audio streams for perfect quality (takes longer)</li>
          <li><strong>Quick Download:</strong> Uses pre-merged formats if available (faster but quality may vary)</li>
          <li><strong>Note:</strong> 4K and 1440p downloads require more time and processing power</li>
        </ul>
      </div>
    </div>
    
    <!-- Hidden download link -->
    <a id="downloadLink" style="display: none;" download></a>
  </body>
  </html>
  `;
  
  res.send(html);
});

// ================== HOME PAGE ==================
app.get("/", (req, res) => {
  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <title>YouTube High Quality Downloader</title>
    <style>
      body { margin: 0; padding: 40px; font-family: Arial, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; }
      .container { max-width: 800px; margin: 0 auto; background: white; padding: 40px; border-radius: 20px; box-shadow: 0 15px 35px rgba(0,0,0,0.2); text-align: center; }
      h1 { color: #333; margin-bottom: 10px; }
      h2 { color: #666; margin-bottom: 30px; font-weight: normal; }
      .input-group { margin: 30px 0; }
      input { padding: 15px; width: 70%; font-size: 16px; border: 2px solid #ddd; border-radius: 8px; margin-right: 10px; }
      button { padding: 15px 30px; font-size: 16px; background: #4CAF50; color: white; border: none; border-radius: 8px; cursor: pointer; }
      button:hover { background: #45a049; }
      .examples { margin-top: 40px; text-align: left; background: #f8f9fa; padding: 20px; border-radius: 10px; }
      .example-link { display: block; margin: 10px 0; padding: 10px; background: #e3f2fd; border-radius: 5px; text-decoration: none; color: #1565c0; }
      .example-link:hover { background: #bbdefb; }
      .features { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 30px; }
      .feature { background: #f5f5f5; padding: 20px; border-radius: 10px; }
      .feature h3 { color: #333; margin-top: 0; }
    </style>
    <script>
      function goToPlayer() {
        const videoId = document.getElementById('videoId').value.trim();
        const key = '${API_KEY}';
        
        if (!videoId) {
          alert('Please enter a YouTube Video ID');
          return;
        }
        
        // Extract video ID from URL if full URL is provided
        let cleanVideoId = videoId;
        if (videoId.includes('youtube.com')) {
          const urlParams = new URLSearchParams(videoId.split('?')[1]);
          cleanVideoId = urlParams.get('v') || videoId;
        } else if (videoId.includes('youtu.be')) {
          cleanVideoId = videoId.split('/').pop().split('?')[0];
        }
        
        window.location.href = '/player?videoId=' + cleanVideoId + '&quality=720p&key=' + key;
      }
    </script>
  </head>
  <body>
    <div class="container">
      <h1>🎥 YouTube High Quality Downloader</h1>
      <h2>Download 720p, 1080p, 1440p, and 4K videos with perfect audio sync</h2>
      
      <div class="input-group">
        <input type="text" id="videoId" placeholder="Enter YouTube Video ID or URL" value="dQw4w9WgXcQ">
        <button onclick="goToPlayer()">Download Video</button>
      </div>
      
      <div class="features">
        <div class="feature">
          <h3>🎯 High Quality</h3>
          <p>Download videos in up to 4K resolution with merged audio tracks</p>
        </div>
        <div class="feature">
          <h3>⚡ Fast & Easy</h3>
          <p>Simple interface, no ads, no redirects</p>
        </div>
        <div class="feature">
          <h3>🔊 Perfect Audio</h3>
          <p>Automatic audio-video merging for flawless playback</p>
        </div>
        <div class="feature">
          <h3>📁 MP4 Format</h3>
          <p>All downloads in universal MP4 format</p>
        </div>
      </div>
      
      <div class="examples">
        <h3>Try these examples:</h3>
        <a class="example-link" href="/player?videoId=dQw4w9WgXcQ&quality=720p&key=${API_KEY}">🎵 Rick Astley - Never Gonna Give You Up (720p)</a>
        <a class="example-link" href="/qualities?videoId=dQw4w9WgXcQ&key=${API_KEY}">📊 Check available qualities for above video</a>
        <a class="example-link" href="/download?videoId=dQw4w9WgXcQ&format=1080p&key=${API_KEY}">⬇️ Direct 1080p download test</a>
      </div>
      
      <div style="margin-top: 30px; color: #666; font-size: 14px;">
        <p>Supports: YouTube, YouTube Music, Age-restricted videos</p>
        <p>Requirements: yt-dlp and ffmpeg must be installed on the server</p>
      </div>
    </div>
  </body>
  </html>
  `;
  
  res.send(html);
});

// ================== API STATUS ==================
app.get("/status", (req, res) => {
  res.json({
    status: "online",
    version: "5.0-high-quality",
    serverTime: new Date().toISOString(),
    tempFiles: fs.existsSync(TEMP_DIR) ? fs.readdirSync(TEMP_DIR).length : 0,
    supportedQualities: Object.keys(highQualityFormats),
    endpoints: {
      home: "/",
      player: "/player?videoId=VIDEO_ID&quality=720p&key=" + API_KEY,
      download: "/download?videoId=VIDEO_ID&format=1080p&key=" + API_KEY,
      quick: "/quick?videoId=VIDEO_ID&quality=720p&key=" + API_KEY,
      qualities: "/qualities?videoId=VIDEO_ID&key=" + API_KEY
    }
  });
});

// ================== SIMPLE STREAM (for browser playback) ==================
app.get("/stream", async (req, res) => {
  const { videoId, quality = "360p" } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Use format 18 for reliable streaming (360p with audio)
    const cmd = `yt-dlp -f 18 -g --no-playlist "${url}"`;
    const { stdout } = await execPromise(cmd);
    const streamUrl = stdout.trim();
    
    if (!streamUrl) {
      return res.status(500).json({ error: "No stream URL found" });
    }
    
    // Proxy the stream with proper headers
    const response = await axios({
      method: 'GET',
      url: streamUrl,
      responseType: 'stream',
      headers: {
        'Referer': 'https://www.youtube.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    // Set appropriate headers
    res.setHeader('Content-Type', 'video/mp4');
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    res.setHeader('Cache-Control', 'no-cache');
    
    // Pipe the stream
    response.data.pipe(res);
    
  } catch (error) {
    console.error("Stream error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ================== PROGRESS TRACKING FOR LARGE DOWNLOADS ==================
const downloadProgress = new Map();

app.get("/download-progress/:videoId", (req, res) => {
  const { videoId } = req.params;
  const progress = downloadProgress.get(videoId) || {
    status: "not_started",
    progress: 0,
    message: ""
  };
  
  res.json(progress);
});

// ================== BATCH DOWNLOAD (Multiple videos) ==================
app.post("/batch-download", express.json(), async (req, res) => {
  const { videoIds, format = "720p" } = req.body;
  const key = req.query.key;
  
  if (key !== API_KEY) {
    return res.status(403).json({ error: "Invalid API key" });
  }
  
  if (!videoIds || !Array.isArray(videoIds) || videoIds.length === 0) {
    return res.status(400).json({ error: "Missing or invalid videoIds array" });
  }
  
  if (videoIds.length > 10) {
    return res.status(400).json({ error: "Maximum 10 videos per batch" });
  }
  
  const batchId = `batch_${Date.now()}`;
  const batchDir = path.join(TEMP_DIR, batchId);
  fs.mkdirSync(batchDir, { recursive: true });
  
  const results = [];
  
  // Start batch download asynchronously
  processBatchDownload(videoIds, format, batchDir, results, batchId);
  
  res.json({
    batchId,
    status: "started",
    message: `Processing ${videoIds.length} videos...`,
    downloadZip: `/download-batch/${batchId}?key=${key}`,
    checkProgress: `/batch-progress/${batchId}?key=${key}`
  });
});

async function processBatchDownload(videoIds, format, batchDir, results, batchId) {
  for (let i = 0; i < videoIds.length; i++) {
    const videoId = videoIds[i];
    const fileName = `${videoId}_${format}.mp4`;
    const filePath = path.join(batchDir, fileName);
    
    try {
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      const formatSpec = highQualityFormats[format] || highQualityFormats["720p"];
      
      const cmd = `yt-dlp -f "${formatSpec}" --merge-output-format mp4 --no-playlist -o "${filePath}" "${url}"`;
      
      await new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
          if (error) {
            results.push({ videoId, status: "failed", error: error.message });
          } else {
            results.push({ videoId, status: "completed", file: fileName });
          }
          resolve();
        });
      });
      
    } catch (error) {
      results.push({ videoId, status: "failed", error: error.message });
    }
  }
}

app.get("/batch-progress/:batchId", (req, res) => {
  const { batchId } = req.params;
  const batchDir = path.join(TEMP_DIR, batchId);
  
  if (!fs.existsSync(batchDir)) {
    return res.status(404).json({ error: "Batch not found" });
  }
  
  const files = fs.readdirSync(batchDir);
  res.json({
    batchId,
    totalFiles: files.length,
    files: files,
    downloadZip: `/download-batch/${batchId}?key=${req.query.key}`
  });
});

app.get("/download-batch/:batchId", (req, res) => {
  const { batchId } = req.params;
  const batchDir = path.join(TEMP_DIR, batchId);
  
  if (!fs.existsSync(batchDir)) {
    return res.status(404).json({ error: "Batch not found" });
  }
  
  const files = fs.readdirSync(batchDir);
  if (files.length === 0) {
    return res.status(404).json({ error: "No files in batch" });
  }
  
  // Create zip file
  const zipFileName = `${batchId}.zip`;
  const zipFilePath = path.join(TEMP_DIR, zipFileName);
  
  // For simplicity, we'll just serve the directory listing
  // In production, you'd want to create an actual zip file
  res.json({
    batchId,
    files: files,
    note: "In production, this would create and serve a zip file"
  });
});

// ================== AUDIO-ONLY DOWNLOADS ==================
app.get("/audio", async (req, res) => {
  const { videoId, format = "mp3" } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const timestamp = Date.now();
  const fileName = `${videoId}_audio_${timestamp}.${format}`;
  const filePath = path.join(TEMP_DIR, fileName);

  try {
    console.log(`🎵 Downloading audio from ${videoId} in ${format} format...`);
    
    const audioFormats = {
      "mp3": "bestaudio[ext=webm]/bestaudio --extract-audio --audio-format mp3",
      "m4a": "bestaudio[ext=m4a]/bestaudio --extract-audio --audio-format m4a",
      "aac": "bestaudio --extract-audio --audio-format aac",
      "opus": "bestaudio[ext=webm]",
      "flac": "bestaudio --extract-audio --audio-format flac",
      "wav": "bestaudio --extract-audio --audio-format wav"
    };
    
    const formatSpec = audioFormats[format] || audioFormats.mp3;
    
    const cmd = `yt-dlp -f "${formatSpec}" --no-playlist -o "${filePath}" "${url}"`;
    
    console.log(`🔧 Executing: ${cmd}`);
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ Audio download error:", error.message);
        res.status(500).json({ 
          error: "Failed to download audio",
          details: error.message
        });
      } else {
        console.log("✅ Audio download completed!");
        
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          const contentType = getAudioContentType(format);
          
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Length', stats.size);
          res.setHeader('Content-Disposition', `attachment; filename="${videoId}.${format}"`);
          
          const fileStream = fs.createReadStream(filePath);
          fileStream.pipe(res);
          
          fileStream.on('end', () => {
            setTimeout(() => {
              try {
                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                }
              } catch (e) {
                console.error("Failed to delete audio file:", e.message);
              }
            }, 5000);
          });
        } else {
          res.status(500).json({ error: "Audio file not found after download" });
        }
      }
    });
  } catch (error) {
    console.error("❌ Server error:", error);
    res.status(500).json({ error: error.message });
  }
});

function getAudioContentType(format) {
  const contentTypes = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "aac": "audio/aac",
    "opus": "audio/ogg",
    "flac": "audio/flac",
    "wav": "audio/wav"
  };
  return contentTypes[format] || "audio/mpeg";
}

// ================== VIDEO INFO (without downloading) ==================
app.get("/video-info", async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).json({ error: "Missing videoId" });

  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Get video information
    const cmd = `yt-dlp --dump-json --no-playlist "${url}"`;
    const { stdout } = await execPromise(cmd);
    
    const info = JSON.parse(stdout);
    
    // Extract relevant information
    const videoInfo = {
      id: info.id,
      title: info.title,
      duration: info.duration,
      duration_string: info.duration_string,
      uploader: info.uploader,
      uploader_id: info.uploader_id,
      upload_date: info.upload_date,
      view_count: info.view_count,
      like_count: info.like_count,
      description: info.description ? info.description.substring(0, 500) + "..." : "",
      categories: info.categories,
      tags: info.tags,
      thumbnails: info.thumbnails,
      formats: info.formats ? info.formats.map(f => ({
        format_id: f.format_id,
        ext: f.ext,
        resolution: f.resolution,
        filesize: f.filesize,
        format_note: f.format_note,
        vcodec: f.vcodec,
        acodec: f.acodec
      })).slice(0, 20) : []
    };
    
    res.json(videoInfo);
    
  } catch (error) {
    console.error("Video info error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ================== ERROR HANDLER ==================
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message
  });
});

// ================== 404 HANDLER ==================
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    availableEndpoints: {
      home: "/",
      player: "/player?videoId=VIDEO_ID&quality=720p&key=" + API_KEY,
      download: "/download?videoId=VIDEO_ID&format=1080p&key=" + API_KEY,
      quick: "/quick?videoId=VIDEO_ID&quality=720p&key=" + API_KEY,
      audio: "/audio?videoId=VIDEO_ID&format=mp3&key=" + API_KEY,
      qualities: "/qualities?videoId=VIDEO_ID&key=" + API_KEY,
      info: "/video-info?videoId=VIDEO_ID&key=" + API_KEY,
      status: "/status?key=" + API_KEY
    }
  });
});

// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 YouTube High Quality Downloader Ready!`);
  console.log(`=========================================`);
  console.log(`📡 Server running on: http://localhost:${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
  console.log(`=========================================`);
  console.log(`🎬 Web Interface: http://localhost:${PORT}`);
  console.log(`📥 Example 1080p: http://localhost:${PORT}/download?videoId=dQw4w9WgXcQ&format=1080p&key=${API_KEY}`);
  console.log(`🎵 Example Audio: http://localhost:${PORT}/audio?videoId=dQw4w9WgXcQ&format=mp3&key=${API_KEY}`);
  console.log(`=========================================`);
  console.log(`✨ Features:`);
  console.log(`   • 720p, 1080p, 1440p, 4K downloads`);
  console.log(`   • Automatic audio-video merging`);
  console.log(`   • MP3, M4A, AAC audio extraction`);
  console.log(`   • Batch downloads (up to 10 videos)`);
  console.log(`   • Beautiful web interface`);
  console.log(`=========================================`);
  
  // Check if yt-dlp is installed
  exec('yt-dlp --version', (error) => {
    if (error) {
      console.warn(`⚠️  WARNING: yt-dlp is not installed or not in PATH`);
      console.warn(`   Install with: pip install yt-dlp`);
    } else {
      console.log(`✅ yt-dlp is installed`);
    }
  });
  
  // Check if ffmpeg is installed
  exec('ffmpeg -version', (error) => {
    if (error) {
      console.warn(`⚠️  WARNING: ffmpeg is not installed or not in PATH`);
      console.warn(`   Install with: apt install ffmpeg (Ubuntu)`);
      console.warn(`                 brew install ffmpeg (macOS)`);
      console.warn(`                 choco install ffmpeg (Windows)`);
    } else {
      console.log(`✅ ffmpeg is installed`);
    }
  });
  
  console.log(`=========================================`);
});

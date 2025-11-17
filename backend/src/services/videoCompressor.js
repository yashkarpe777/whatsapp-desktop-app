import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import pkg from 'whatsapp-web.js';
const { MessageMedia } = pkg;

// Try to import ffmpeg-static, but don't fail if not available
let ffmpegStatic = null;
try {
  const ffmpegModule = await import('ffmpeg-static');
  ffmpegStatic = ffmpegModule.default;
  if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
    console.log('✅ FFmpeg binary loaded from ffmpeg-static');
  }
} catch (err) {
  console.warn('⚠️ ffmpeg-static not available, will try system FFmpeg');
  // Try to use system FFmpeg if available
  try {
    ffmpeg.setFfmpegPath('ffmpeg');
  } catch (e) {
    console.warn('⚠️ System FFmpeg not found either');
  }
}

/**
 * Compress video to WhatsApp-compatible size
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path to output compressed video
 * @param {number} maxSizeMB - Maximum size in MB (default: 16)
 * @returns {Promise<string>} - Path to compressed video
 */
async function compressVideo(inputPath, outputPath, maxSizeMB = 16) {
  return new Promise((resolve, reject) => {
    const maxSizeBytes = maxSizeMB * 1024 * 1024;

    // Get video info first
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to probe video: ${err.message}`));
        return;
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (!videoStream) {
        reject(new Error('No video stream found'));
        return;
      }

      const duration = metadata.format.duration;
      const originalSize = fs.statSync(inputPath).size;
      const originalSizeMB = originalSize / 1024 / 1024;

      // Calculate target bitrate to fit within size limit (with 10% safety margin)
      const targetBitrate = Math.floor((maxSizeBytes * 8 * 0.9) / duration);
      
      // Get original video dimensions
      const width = videoStream.width || 1920;
      const height = videoStream.height || 1080;
      const originalFPS = eval(videoStream.r_frame_rate) || 30;

      // Maintain aspect ratio, but cap at 1920x1080 for quality
      let outputWidth = width;
      let outputHeight = height;
      if (width > 1920 || height > 1080) {
        const aspectRatio = width / height;
        if (aspectRatio > 1.77) { // Wider than 16:9
          outputWidth = 1920;
          outputHeight = Math.round(1920 / aspectRatio);
        } else {
          outputHeight = 1080;
          outputWidth = Math.round(1080 * aspectRatio);
        }
      }
      
      // Maintain original FPS up to 30fps for smooth playback
      const outputFPS = Math.min(originalFPS, 30);

      console.log(`📹 Compressing video (HIGH QUALITY):`);
      console.log(`   Duration: ${duration}s`);
      console.log(`   Original: ${originalSizeMB.toFixed(2)}MB (${width}x${height} @ ${originalFPS.toFixed(1)}fps)`);
      console.log(`   Target: ${maxSizeMB}MB (${outputWidth}x${outputHeight} @ ${outputFPS}fps)`);
      console.log(`   Target bitrate: ${(targetBitrate / 1000000).toFixed(2)}Mbps`);

      ffmpeg(inputPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .audioChannels(2)
        .audioFrequency(48000) // Higher quality audio
        .audioBitrate('128k') // Good audio quality
        .videoBitrate(targetBitrate)
        .size(`${outputWidth}x${outputHeight}`) // Maintain aspect ratio
        .fps(outputFPS) // Maintain smooth FPS
        .outputOptions([
          '-preset slow', // Better compression efficiency (slower but better quality)
          '-crf 23', // Lower CRF = better quality (18-28 range, 23 is good balance)
          '-profile:v high', // H.264 high profile for better quality
          '-level 4.2', // H.264 level for HD support
          '-movflags +faststart', // Enable streaming
          '-pix_fmt yuv420p' // Ensure compatibility
        ])
        .output(outputPath)
        .on('progress', (progress) => {
          console.log(`⏳ Compression progress: ${progress.percent?.toFixed(1)}%`);
        })
        .on('end', () => {
          const compressedSize = fs.statSync(outputPath).size;
          const compressedSizeMB = compressedSize / 1024 / 1024;
          const compressionRatio = ((1 - compressedSize / originalSize) * 100).toFixed(1);
          console.log(`✅ Video compressed successfully:`);
          console.log(`   Final size: ${compressedSizeMB.toFixed(2)}MB (${compressionRatio}% reduction)`);
          console.log(`   Quality: HIGH (CRF 23, ${outputWidth}x${outputHeight}, ${outputFPS}fps)`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          reject(new Error(`Video compression failed: ${err.message}`));
        })
        .run();
    });
  });
}

/**
 * Send large video with compression or alternative method
 */
async function sendLargeVideo(client, chatId, videoPath, caption, maxSizeMB = 16) {
  const stats = fs.statSync(videoPath);
  const fileSizeMB = stats.size / (1024 * 1024);

  console.log(`🎬 Processing video: ${(fileSizeMB).toFixed(2)}MB`);

  if (fileSizeMB <= maxSizeMB) {
    // Small enough, send directly
    console.log(`📤 Sending video directly (${fileSizeMB.toFixed(2)}MB <= ${maxSizeMB}MB)`);
    const media = MessageMedia.fromFilePath(videoPath);
    return await client.sendMessage(chatId, media, { caption });
  }

  // Too large, need compression
  console.log(`🗜️ Video too large (${fileSizeMB.toFixed(2)}MB > ${maxSizeMB}MB), compressing...`);

  const compressedPath = videoPath.replace(/\.[^/.]+$/, '_compressed.mp4');
  const finalPath = path.join(path.dirname(videoPath), `compressed_${Date.now()}.mp4`);

  try {
    // Compress video
    await compressVideo(videoPath, finalPath, maxSizeMB);

    // Check if compression succeeded
    const compressedStats = fs.statSync(finalPath);
    const compressedSizeMB = compressedStats.size / (1024 * 1024);

    if (compressedSizeMB <= maxSizeMB) {
      console.log(`📤 Sending compressed video (${compressedSizeMB.toFixed(2)}MB, HIGH QUALITY)...`);
      const media = MessageMedia.fromFilePath(finalPath);
      const result = await client.sendMessage(chatId, media, { caption });

      // Clean up compressed file
      try {
        fs.unlinkSync(finalPath);
        console.log(`🧹 Cleaned up temporary compressed file`);
      } catch (cleanupErr) {
        console.warn('⚠️ Failed to cleanup compressed file:', cleanupErr.message);
      }

      return result;
    } else {
      throw new Error(`Compression failed: ${compressedSizeMB.toFixed(2)}MB still > ${maxSizeMB}MB limit. Try a shorter video or lower resolution source.`);
    }

  } catch (compressError) {
    console.error(`❌ Video compression failed:`, compressError.message);

    // Fallback: Send video directly anyway (WhatsApp will handle it)
    console.log(`📤 Sending video directly despite size (compression unavailable)`);
    try {
      const media = MessageMedia.fromFilePath(videoPath);
      return await client.sendMessage(chatId, media, { caption });
    } catch (sendError) {
      // If direct send also fails, send text message with caption
      console.error(`❌ Direct video send also failed:`, sendError.message);
      const fileName = path.basename(videoPath);
      const message = `📹 Video "${fileName}" (${fileSizeMB.toFixed(2)}MB) could not be sent.\n\n${caption || ''}`;
      return await client.sendMessage(chatId, message);
    }
  }
}

export {
  compressVideo,
  sendLargeVideo
};

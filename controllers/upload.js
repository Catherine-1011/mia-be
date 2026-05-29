const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream/promises');
const os = require('os');
const { uploadToCloudinary } = require('../config/cloudinary');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// Basic memory-based rate limit: 10 uploads per IP per minute
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 10;
const ipBuckets = new Map();

const getClientIp = (request) => {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return request.ip || request.socket?.remoteAddress || 'unknown';
};

const checkRateLimit = (ip) => {
  const now = Date.now();
  const existing = ipBuckets.get(ip) || [];
  const validTimestamps = existing.filter(ts => now - ts < WINDOW_MS);
  
  if (validTimestamps.length >= MAX_REQUESTS) {
    return false;
  }
  
  validTimestamps.push(now);
  ipBuckets.set(ip, validTimestamps);
  return true;
};

exports.uploadImage = async (request, reply) => {
  try {
    const ip = getClientIp(request);
    if (!checkRateLimit(ip)) {
      return reply.status(429).send({ message: 'Upload failed: Too many requests. Please try again later.' });
    }

    // fastify-multipart provides request.parts()
    const parts = request.parts();
    let uploadedFile = null;

    for await (const part of parts) {
      if (part.file && part.fieldname === 'file') {
        if (!ALLOWED_MIME_TYPES.includes(part.mimetype)) {
          throw new Error('Only JPEG, PNG, and WEBP images are allowed');
        }

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(part.filename);
        const filename = `upload-${uniqueSuffix}${ext}`;
        const filepath = path.join(os.tmpdir(), filename);

        // Limit the size handled by busboy/multipart internally by throwing later if it exceeds, 
        // fastify-multipart might also enforce limits if configured, but we check size after writing or during
        
        let size = 0;
        part.file.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_FILE_SIZE) {
            part.file.destroy(new Error('File exceeds 5MB limit'));
          }
        });

        const tempWriteStream = fs.createWriteStream(filepath);
        try {
          await pipeline(part.file, tempWriteStream);
        } catch (err) {
          if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
          }
          throw err;
        }

        uploadedFile = { path: filepath };
        break; // Only need the single file
      }
    }

    if (!uploadedFile) {
      return reply.status(400).send({ message: 'Upload failed: No file provided under fieldname "file"' });
    }

    // Upload to Cloudinary
    let cloudResult;
    try {
      cloudResult = await uploadToCloudinary(uploadedFile.path, 'refund-evidence');
    } catch (err) {
      throw new Error('Failed to upload image to storage');
    } finally {
      // Clean up temporary file
      if (fs.existsSync(uploadedFile.path)) {
        fs.unlinkSync(uploadedFile.path);
      }
    }

    return reply.status(200).send({ url: cloudResult.url });

  } catch (error) {
    return reply.status(400).send({ message: `Upload failed: ${error.message}` });
  }
};
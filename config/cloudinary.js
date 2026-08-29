const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const s3 = new S3Client({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  region: process.env.DO_SPACES_REGION || 'syd1',
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET
  },
  forcePathStyle: false
});

const BUCKET = process.env.DO_SPACES_BUCKET;
const CDN_ENDPOINT = process.env.DO_SPACES_CDN_ENDPOINT || process.env.DO_SPACES_ENDPOINT;

// Upload file to DigitalOcean Spaces
const uploadToCloudinary = async (filePath, folder = 'sellers', contentType) => {
  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath);
  const uniqueName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
  const key = `alpa/${folder}/${uniqueName}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fileBuffer,
    ACL: 'public-read',
    ContentType: contentType || _mimeFromExt(ext)
  });

  try {
    await s3.send(command);
    const url = `${CDN_ENDPOINT}/${key}`;
    return {
      url,
      publicId: key
    };
  } catch (error) {
    console.error('Spaces upload error:', error);
    throw error;
  }
};

// Delete file from DigitalOcean Spaces
const deleteFromCloudinary = async (publicId) => {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: publicId }));
  } catch (error) {
    console.error('Spaces delete error:', error);
  }
};

function _mimeFromExt(ext) {
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo'
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

module.exports = {
  s3,
  uploadToCloudinary,
  deleteFromCloudinary
};

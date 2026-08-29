const crypto = require('crypto');
const path = require('path');

const RASTER_TYPES = Object.freeze({
  jpeg: Object.freeze({ extension: '.jpg', mime: 'image/jpeg' }),
  png: Object.freeze({ extension: '.png', mime: 'image/png' }),
  webp: Object.freeze({ extension: '.webp', mime: 'image/webp' })
});

function createContainedUploadPath(directory, prefix = 'upload', extension = '') {
  const root = path.resolve(directory);
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '') || 'upload';
  const safeExtension = /^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : '';
  const filepath = path.resolve(root, `${safePrefix}-${crypto.randomUUID()}${safeExtension}`);
  const relative = path.relative(root, filepath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Generated upload path escaped the temporary directory');
  }

  return filepath;
}

function detectRasterImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  if (isValidJpegStructure(buffer)) {
    return RASTER_TYPES.jpeg;
  }

  if (isValidPngStructure(buffer)) {
    return RASTER_TYPES.png;
  }

  if (isValidWebpStructure(buffer)) {
    return RASTER_TYPES.webp;
  }

  return null;
}

function isValidJpegStructure(buffer) {
  if (buffer.length < 16 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;

  while (offset < buffer.length) {
    if (buffer[offset++] !== 0xff) return false;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) return false;
    const marker = buffer[offset++];
    if (marker === 0xd9) return sawFrame && sawScan && offset === buffer.length;
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > buffer.length) return false;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return false;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      sawFrame = true;
    }
    offset += segmentLength;
    if (marker === 0xda) {
      sawScan = true;
      while (offset < buffer.length - 1) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const next = buffer[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
    }
  }
  return false;
}

function isValidPngStructure(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature)) return false;
  let offset = 8;
  let chunks = 0;
  let sawIdat = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) return false;
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (chunks === 0 && (type !== 'IHDR' || length !== 13)) return false;
    if (type === 'IDAT') sawIdat = true;
    if (type === 'IEND') return length === 0 && sawIdat && end === buffer.length;
    offset = end;
    chunks++;
  }
  return false;
}

function isValidWebpStructure(buffer) {
  if (
    buffer.length < 20 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== buffer.length
  ) return false;
  let offset = 12;
  let sawImageChunk = false;
  while (offset + 8 <= buffer.length) {
    const type = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32LE(offset + 4);
    const paddedLength = length + (length % 2);
    offset += 8;
    if (offset + paddedLength > buffer.length) return false;
    if (['VP8 ', 'VP8L', 'VP8X'].includes(type) && length > 0) sawImageChunk = true;
    offset += paddedLength;
  }
  return sawImageChunk && offset === buffer.length;
}

function sanitizeOriginalFilename(filename) {
  return path.basename(String(filename || '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 255);
}

function extensionForMime(mime) {
  return ({
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/x-msvideo': '.avi'
  })[String(mime || '').toLowerCase()] || '';
}

module.exports = {
  createContainedUploadPath,
  detectRasterImageType,
  extensionForMime,
  sanitizeOriginalFilename
};

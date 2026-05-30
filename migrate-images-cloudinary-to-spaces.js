/**
 * Transfer ALL images from Cloudinary → DigitalOcean Spaces
 *
 * - Uses Cloudinary Admin API to list every asset (paginated)
 * - Downloads each file directly from its Cloudinary URL
 * - Uploads to DO Spaces preserving the folder path
 * - Saves url-mapping.json  (oldCloudinaryUrl → newSpacesUrl)
 *   which the DB migration script will use later
 *
 * Run:
 *   node migrate-images-cloudinary-to-spaces.js            (live)
 *   node migrate-images-cloudinary-to-spaces.js --dry-run  (preview only)
 *
 * Progress is saved to migration-progress.json so the script is
 * safe to re-run — already-migrated assets are skipped.
 */

require('dotenv').config();

const cloudinary = require('cloudinary').v2;
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const DRY_RUN       = process.argv.includes('--dry-run');
const MAPPING_FILE  = path.join(__dirname, 'url-mapping.json');
const PROGRESS_FILE = path.join(__dirname, 'migration-progress.json');
const CONCURRENCY   = 5; // parallel uploads

// ─── Cloudinary ───────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ─── DigitalOcean Spaces ─────────────────────────────────────────────────────
const s3 = new S3Client({
  endpoint:    process.env.DO_SPACES_ENDPOINT,
  region:      process.env.DO_SPACES_REGION || 'syd1',
  credentials: {
    accessKeyId:     process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET
  },
  forcePathStyle: false
});

const BUCKET       = process.env.DO_SPACES_BUCKET;
const CDN_ENDPOINT = (process.env.DO_SPACES_CDN_ENDPOINT || process.env.DO_SPACES_ENDPOINT).replace(/\/$/, '');

// ─── Helpers ──────────────────────────────────────────────────────────────────
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function mimeFromFormat(format) {
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png',  webp: 'image/webp',
    gif: 'image/gif',  svg: 'image/svg+xml',
    pdf: 'application/pdf', mp4: 'video/mp4',
    mov: 'video/quicktime'
  };
  return map[(format || '').toLowerCase()] || 'application/octet-stream';
}

// ─── List ALL Cloudinary resources (paginated) ────────────────────────────────
async function listAllCloudinaryResources() {
  const resources = [];
  let nextCursor = null;

  log('Fetching asset list from Cloudinary...');
  do {
    const opts = { max_results: 500, resource_type: 'image' };
    if (nextCursor) opts.next_cursor = nextCursor;

    const result = await cloudinary.api.resources(opts);
    resources.push(...result.resources);
    nextCursor = result.next_cursor || null;
    log(`  fetched ${resources.length} assets so far...`);

    if (nextCursor) await sleep(300); // be polite to the API
  } while (nextCursor);

  // Also fetch videos/raw if any exist
  for (const type of ['video', 'raw']) {
    try {
      let cursor = null;
      do {
        const opts = { max_results: 500, resource_type: type };
        if (cursor) opts.next_cursor = cursor;
        const result = await cloudinary.api.resources(opts);
        resources.push(...result.resources);
        cursor = result.next_cursor || null;
        if (cursor) await sleep(300);
      } while (cursor);
    } catch (_) { /* resource type might not exist */ }
  }

  log(`Total Cloudinary assets found: ${resources.length}`);
  return resources;
}

// ─── Upload one resource to Spaces ───────────────────────────────────────────
async function uploadToSpaces(buffer, spacesKey, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         spacesKey,
    Body:        buffer,
    ACL:         'public-read',
    ContentType: contentType
  }));
  return `${CDN_ENDPOINT}/${spacesKey}`;
}

// ─── Migrate one asset ────────────────────────────────────────────────────────
async function migrateAsset(resource, progress) {
  const oldUrl = resource.secure_url;

  if (progress[oldUrl]) {
    return { skipped: true, oldUrl, newUrl: progress[oldUrl] };
  }

  // Build Spaces key: keep Cloudinary's public_id path + extension
  const format     = resource.format || 'jpg';
  const spacesKey  = `alpa/${resource.public_id}.${format}`;
  const contentType = mimeFromFormat(format);

  if (DRY_RUN) {
    const newUrl = `${CDN_ENDPOINT}/${spacesKey}`;
    return { dry: true, oldUrl, newUrl };
  }

  const buffer = await downloadBuffer(oldUrl);
  const newUrl = await uploadToSpaces(buffer, spacesKey, contentType);
  return { oldUrl, newUrl };
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────
async function runPool(tasks, concurrency) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        results[idx] = { error: err.message, index: idx };
      }
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`Starting Cloudinary → Spaces image transfer${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log(`Bucket: ${BUCKET}  CDN: ${CDN_ENDPOINT}`);

  // Load existing progress & mapping
  const progress = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    : {};
  const mapping = fs.existsSync(MAPPING_FILE)
    ? JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'))
    : {};

  const resources = await listAllCloudinaryResources();
  if (resources.length === 0) {
    log('No assets found in Cloudinary. Done.');
    return;
  }

  let done = 0, skipped = 0, failed = 0;

  const tasks = resources.map(resource => async () => {
    const result = await migrateAsset(resource, progress);

    if (result.error) {
      log(`  ✗ FAILED  ${resource.secure_url}\n    ${result.error}`);
      failed++;
      return;
    }

    if (result.skipped) {
      skipped++;
      return;
    }

    mapping[result.oldUrl] = result.newUrl;
    if (!DRY_RUN) {
      progress[result.oldUrl] = result.newUrl;
      // Persist progress after each successful upload
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      fs.writeFileSync(MAPPING_FILE,  JSON.stringify(mapping, null, 2));
    }

    done++;
    log(`  ✓ (${done + skipped}/${resources.length}) ${result.oldUrl.slice(0, 55)}...`);
  });

  await runPool(tasks, CONCURRENCY);

  // Final save
  if (!DRY_RUN) {
    fs.writeFileSync(MAPPING_FILE,  JSON.stringify(mapping, null, 2));
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  }

  log('\n─────────────────────────────────────────────────────');
  log(`Total   : ${resources.length}`);
  log(`Uploaded: ${done}`);
  log(`Skipped : ${skipped}  (already done)`);
  log(`Failed  : ${failed}`);
  if (!DRY_RUN) {
    log(`\nMapping saved → url-mapping.json  (${Object.keys(mapping).length} entries)`);
    log('Use this file when running the DB migration later.');
  }
  if (DRY_RUN) log('(dry run — nothing was uploaded)');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

/**
 * Migration: Cloudinary → DigitalOcean Spaces
 *
 * What it does:
 *  1. Scans every DB column that can hold a Cloudinary URL
 *  2. Downloads each image from Cloudinary
 *  3. Uploads it to DigitalOcean Spaces under the same folder structure
 *  4. Updates the DB row with the new CDN URL
 *
 * Run: node migrate-cloudinary-to-spaces.js
 * Supports --dry-run flag to preview without making changes.
 */

require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const https = require('https');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const DRY_RUN = process.argv.includes('--dry-run');

const prisma = new PrismaClient();

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
const CDN_ENDPOINT = (process.env.DO_SPACES_CDN_ENDPOINT || process.env.DO_SPACES_ENDPOINT).replace(/\/$/, '');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isCloudinaryUrl = (url) =>
  typeof url === 'string' && url.includes('res.cloudinary.com');

const mimeFromUrl = (url) => {
  const ext = path.extname(url.split('?')[0]).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf'
  };
  return map[ext] || 'image/jpeg';
};

const extFromUrl = (url) => {
  const raw = path.extname(url.split('?')[0]);
  return raw || '.jpg';
};

/** Download a URL into a Buffer */
const downloadBuffer = (url) =>
  new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });

/** Upload buffer to Spaces and return the new CDN URL */
const uploadToSpaces = async (buffer, folder, ext, contentType) => {
  const key = `alpa/${folder}/${crypto.randomBytes(16).toString('hex')}${ext}`;
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ACL: 'public-read',
    ContentType: contentType
  });
  await s3.send(cmd);
  return `${CDN_ENDPOINT}/${key}`;
};

/** Migrate a single URL: download → upload → return new URL */
const migrateUrl = async (oldUrl, folder) => {
  if (!isCloudinaryUrl(oldUrl)) return null; // already migrated or not cloudinary
  const ext = extFromUrl(oldUrl);
  const mime = mimeFromUrl(oldUrl);
  const buffer = await downloadBuffer(oldUrl);
  const newUrl = await uploadToSpaces(buffer, folder, ext, mime);
  return newUrl;
};

// ─── Migration tasks ──────────────────────────────────────────────────────────

let total = 0;
let migrated = 0;
let errors = 0;

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

/** Migrate a single-string field on a model */
async function migrateField({ model, idField, id, field, value, folder, updateFn }) {
  total++;
  if (!isCloudinaryUrl(value)) return;

  log(`  → ${model}[${id}].${field}: ${value.slice(0, 60)}...`);

  if (DRY_RUN) {
    migrated++;
    return;
  }

  try {
    const newUrl = await migrateUrl(value, folder);
    await updateFn(id, newUrl);
    migrated++;
    log(`    ✓ ${newUrl.slice(0, 60)}...`);
  } catch (err) {
    errors++;
    log(`    ✗ ERROR: ${err.message}`);
  }
}

// ─── Per-model migrations ─────────────────────────────────────────────────────

async function migrateUsers() {
  log('\n[Users] scanning profileImage...');
  const users = await prisma.user.findMany({
    where: { profileImage: { contains: 'cloudinary' } },
    select: { id: true, profileImage: true }
  });
  log(`  found ${users.length} rows`);
  for (const u of users) {
    await migrateField({
      model: 'User', idField: 'id', id: u.id,
      field: 'profileImage', value: u.profileImage, folder: 'profile',
      updateFn: (id, url) => prisma.user.update({ where: { id }, data: { profileImage: url } })
    });
  }
}

async function migrateSellerProfiles() {
  log('\n[SellerProfile] scanning storeBanner, storeLogo...');
  const sellers = await prisma.sellerProfile.findMany({
    where: {
      OR: [
        { storeBanner: { contains: 'cloudinary' } },
        { storeLogo: { contains: 'cloudinary' } }
      ]
    },
    select: { id: true, storeBanner: true, storeLogo: true }
  });
  log(`  found ${sellers.length} rows`);
  for (const s of sellers) {
    if (isCloudinaryUrl(s.storeBanner)) {
      await migrateField({
        model: 'SellerProfile', idField: 'id', id: s.id,
        field: 'storeBanner', value: s.storeBanner, folder: 'store-banners',
        updateFn: (id, url) => prisma.sellerProfile.update({ where: { id }, data: { storeBanner: url } })
      });
    }
    if (isCloudinaryUrl(s.storeLogo)) {
      await migrateField({
        model: 'SellerProfile', idField: 'id', id: s.id,
        field: 'storeLogo', value: s.storeLogo, folder: 'store-logos',
        updateFn: (id, url) => prisma.sellerProfile.update({ where: { id }, data: { storeLogo: url } })
      });
    }
  }
}

async function migrateProducts() {
  log('\n[Product] scanning images[], featuredImage...');
  const products = await prisma.product.findMany({
    select: { id: true, images: true, featuredImage: true }
  });

  for (const p of products) {
    // featuredImage
    if (isCloudinaryUrl(p.featuredImage)) {
      await migrateField({
        model: 'Product', idField: 'id', id: p.id,
        field: 'featuredImage', value: p.featuredImage, folder: 'products',
        updateFn: (id, url) => prisma.product.update({ where: { id }, data: { featuredImage: url } })
      });
    }

    // images array
    const cloudinaryImages = p.images.filter(isCloudinaryUrl);
    if (cloudinaryImages.length === 0) continue;

    log(`  → Product[${p.id}].images has ${cloudinaryImages.length} cloudinary URLs`);
    if (DRY_RUN) { total += cloudinaryImages.length; migrated += cloudinaryImages.length; continue; }

    const newImages = [...p.images];
    for (let i = 0; i < newImages.length; i++) {
      if (!isCloudinaryUrl(newImages[i])) continue;
      total++;
      try {
        newImages[i] = await migrateUrl(newImages[i], 'products');
        migrated++;
      } catch (err) {
        errors++;
        log(`    ✗ ERROR on image[${i}]: ${err.message}`);
      }
    }
    await prisma.product.update({ where: { id: p.id }, data: { images: newImages } });
  }
}

async function migrateProductVariants() {
  log('\n[ProductVariant] scanning images[]...');
  const variants = await prisma.productVariant.findMany({
    select: { id: true, images: true }
  });

  for (const v of variants) {
    const cloudinaryImages = v.images.filter(isCloudinaryUrl);
    if (cloudinaryImages.length === 0) continue;

    log(`  → ProductVariant[${v.id}].images has ${cloudinaryImages.length} cloudinary URLs`);
    if (DRY_RUN) { total += cloudinaryImages.length; migrated += cloudinaryImages.length; continue; }

    const newImages = [...v.images];
    for (let i = 0; i < newImages.length; i++) {
      if (!isCloudinaryUrl(newImages[i])) continue;
      total++;
      try {
        newImages[i] = await migrateUrl(newImages[i], 'products');
        migrated++;
      } catch (err) {
        errors++;
        log(`    ✗ ERROR on variant image[${i}]: ${err.message}`);
      }
    }
    await prisma.productVariant.update({ where: { id: v.id }, data: { images: newImages } });
  }
}

async function migrateBlogs() {
  log('\n[Blog] scanning coverImage...');
  const blogs = await prisma.blog.findMany({
    where: { coverImage: { contains: 'cloudinary' } },
    select: { id: true, coverImage: true }
  });
  log(`  found ${blogs.length} rows`);
  for (const b of blogs) {
    await migrateField({
      model: 'Blog', idField: 'id', id: b.id,
      field: 'coverImage', value: b.coverImage, folder: 'blogs',
      updateFn: (id, url) => prisma.blog.update({ where: { id }, data: { coverImage: url } })
    });
  }
}

async function migrateSponsoredSections() {
  log('\n[SponsoredSection] scanning mediaUrl...');
  const items = await prisma.sponsoredSection.findMany({
    where: { mediaUrl: { contains: 'cloudinary' } },
    select: { id: true, mediaUrl: true }
  });
  log(`  found ${items.length} rows`);
  for (const item of items) {
    await migrateField({
      model: 'SponsoredSection', idField: 'id', id: item.id,
      field: 'mediaUrl', value: item.mediaUrl, folder: 'sponsored',
      updateFn: (id, url) => prisma.sponsoredSection.update({ where: { id }, data: { mediaUrl: url } })
    });
  }
}

async function migrateNewsletterCampaigns() {
  log('\n[NewsletterCampaign] scanning bannerImage...');
  const campaigns = await prisma.newsletterCampaign.findMany({
    where: { bannerImage: { contains: 'cloudinary' } },
    select: { id: true, bannerImage: true }
  });
  log(`  found ${campaigns.length} rows`);
  for (const c of campaigns) {
    await migrateField({
      model: 'NewsletterCampaign', idField: 'id', id: c.id,
      field: 'bannerImage', value: c.bannerImage, folder: 'newsletter-campaigns',
      updateFn: (id, url) => prisma.newsletterCampaign.update({ where: { id }, data: { bannerImage: url } })
    });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting Cloudinary → DigitalOcean Spaces migration${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log(`Target bucket: ${BUCKET} | CDN: ${CDN_ENDPOINT}`);

  await migrateUsers();
  await migrateSellerProfiles();
  await migrateProducts();
  await migrateProductVariants();
  await migrateBlogs();
  await migrateSponsoredSections();
  await migrateNewsletterCampaigns();

  log('\n─────────────────────────────────────────');
  log(`Done. Total URLs scanned: ${total}`);
  log(`  Migrated : ${migrated}`);
  log(`  Errors   : ${errors}`);
  if (DRY_RUN) log('(dry run — no changes were written)');
}

main()
  .catch((err) => { console.error('Fatal:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());

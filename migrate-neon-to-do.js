/**
 * Data migration: Neon (old) → DigitalOcean (new)
 *
 * Reads every table from Neon and inserts into DO.
 * Tables are migrated in dependency order (parents before children).
 *
 * Run: node migrate-neon-to-do.js
 * Supports --dry-run to count rows without copying.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const DRY_RUN = process.argv.includes('--dry-run');

// Old DB (Neon)
const SOURCE_URL = 'postgresql://neondb_owner:npg_H7aFsbBKYX0g@ep-young-thunder-a7w1if39-pooler.ap-southeast-2.aws.neon.tech/neondb?sslmode=require';

// New DB (DigitalOcean) - from .env DATABASE_URL
const TARGET_URL = process.env.DATABASE_URL;

const source = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } });
const target = new PrismaClient({ datasources: { db: { url: TARGET_URL } } });

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// Tables in dependency order (no FK violations)
const TABLES = [
  'users',
  'user_addresses',
  'user_sessions',
  'seller_profiles',
  'pending_registrations',
  'attributes',
  'attribute_values',
  'shipping_methods',
  'gst_settings',
  'products',
  'product_variants',
  'variant_attribute_values',
  'carts',
  'cart_items',
  'orders',
  'sub_orders',
  'order_items',
  'order_notifications',
  'ratings',
  'coupons',
  'seller_coupons',
  'payout_requests',
  'commissions',
  'commission_earned',
  'notifications',
  'support_tickets',
  'category_requests',
  'bank_change_requests',
  'audit_logs',
  'login_verifications',
  'sso_tickets',
  'site_feedback',
  'blogs',
  'sponsored_sections',
  'wishlists',
  'NewsletterCampaign',
  'ContactMessage',
];

const BATCH = 500;

async function migrateTable(tableName) {
  const rows = await source.$queryRawUnsafe(`SELECT * FROM "${tableName}"`);
  log(`  ${tableName}: ${rows.length} rows`);

  if (rows.length === 0 || DRY_RUN) return rows.length;

  // Insert in batches
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    // Build bulk insert using raw SQL
    await target.$transaction(
      batch.map(row => {
        const cols = Object.keys(row).map(c => `"${c}"`).join(', ');
        const vals = Object.values(row);
        const placeholders = vals.map((_, idx) => `$${idx + 1}`).join(', ');
        return target.$queryRawUnsafe(
          `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          ...vals
        );
      })
    );
  }

  return rows.length;
}

async function main() {
  log(`Neon → DigitalOcean data migration${DRY_RUN ? ' (DRY RUN)' : ''}`);
  log(`Source: Neon`);
  log(`Target: ${TARGET_URL.match(/@([^/]+)/)?.[1]}`);

  let totalRows = 0;
  let failed = [];

  for (const table of TABLES) {
    try {
      const count = await migrateTable(table);
      totalRows += count;
    } catch (err) {
      log(`  ✗ FAILED ${table}: ${err.message}`);
      failed.push(table);
    }
  }

  log('\n─────────────────────────────────────────');
  log(`Total rows copied: ${totalRows}`);
  if (failed.length) log(`Failed tables: ${failed.join(', ')}`);
  else log('All tables migrated successfully.');
  if (DRY_RUN) log('(dry run — no data was written)');
}

main()
  .catch(err => { console.error('Fatal:', err); process.exit(1); })
  .finally(async () => { await source.$disconnect(); await target.$disconnect(); });

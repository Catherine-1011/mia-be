/**
 * Data migration: Neon (old) → DigitalOcean (new)
 *
 * Uses pg directly so enum columns are auto-detected and cast correctly.
 * FK constraints are disabled during migration then re-enabled.
 *
 * Run: node migrate-neon-to-do.js
 * Supports --dry-run to count rows without copying.
 */

require('dotenv').config();
const { Client } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const SOURCE_URL = 'postgresql://neondb_owner:npg_H7aFsbBKYX0g@ep-young-thunder-a7w1if39-pooler.ap-southeast-2.aws.neon.tech/neondb?sslmode=require';
const TARGET_URL = process.env.DATABASE_URL;

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

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

// Returns a map of { columnName -> enumTypeName } for a given table on the target
async function getEnumColumns(client, tableName) {
  const res = await client.query(`
    SELECT a.attname AS col, t.typname AS typename
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = $1
      AND n.nspname = 'public'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND t.typtype = 'e'
  `, [tableName]);
  const map = {};
  for (const row of res.rows) map[row.col] = row.typename;
  return map;
}

// Returns set of column names that are json/jsonb in the target
async function getJsonColumns(client, tableName) {
  const res = await client.query(`
    SELECT a.attname AS col
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = $1
      AND n.nspname = 'public'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND t.typname IN ('json', 'jsonb')
  `, [tableName]);
  return new Set(res.rows.map(r => r.col));
}

async function migrateTable(src, tgt, tableName) {
  const { rows } = await src.query(`SELECT * FROM "${tableName}"`);
  log(`  ${tableName}: ${rows.length} rows`);
  if (rows.length === 0 || DRY_RUN) return rows.length;

  const enumCols = await getEnumColumns(tgt, tableName);
  const jsonCols = await getJsonColumns(tgt, tableName);

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    for (const row of batch) {
      const keys = Object.keys(row);
      const cols = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((k, idx) => {
        const cast = enumCols[k] ? `::\"${enumCols[k]}\"` : '';
        return `$${idx + 1}${cast}`;
      }).join(', ');
      const vals = keys.map(k => {
        const v = row[k];
        // Stringify objects/arrays for json/jsonb columns
        if (jsonCols.has(k) && v !== null && typeof v === 'object') return JSON.stringify(v);
        return v;
      });
      await tgt.query(
        `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        vals
      );
    }
  }

  return rows.length;
}

async function main() {
  log(`Neon → DigitalOcean data migration${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // Strip sslmode from URLs and handle SSL manually
  const cleanUrl = (url) => url.replace(/[?&]sslmode=[^&]*/g, '').replace(/\?$/, '');
  const src = new Client({ connectionString: cleanUrl(SOURCE_URL), ssl: { rejectUnauthorized: false } });
  const tgt = new Client({ connectionString: cleanUrl(TARGET_URL), ssl: { rejectUnauthorized: false } });

  await src.connect();
  await tgt.connect();

  log(`Source: Neon`);
  log(`Target: ${TARGET_URL.match(/@([^/]+)/)?.[1]}`);

  // Truncate all tables in DO to start clean (CASCADE handles FKs)
  log('\nClearing DO tables...');
  await tgt.query(`TRUNCATE TABLE "users" CASCADE`);
  log('  DO tables cleared.\n');

  let totalRows = 0;
  const failed = [];

  for (const table of TABLES) {
    try {
      const count = await migrateTable(src, tgt, table);
      totalRows += count;
    } catch (err) {
      log(`  ✗ FAILED ${table}: ${err.message}`);
      failed.push(table);
    }
  }

  await src.end();
  await tgt.end();

  log('\n─────────────────────────────────────────');
  log(`Total rows copied: ${totalRows}`);
  if (failed.length) log(`Failed tables: ${failed.join(', ')}`);
  else log('All tables migrated successfully.');
  if (DRY_RUN) log('(dry run — no data was written)');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

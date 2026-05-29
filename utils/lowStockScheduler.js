const cron = require('node-cron');
const prisma = require('../config/prisma');
const { notifySellerLowStock } = require('../controllers/notification');
const { sendSellerLowStockEmail } = require('./emailService');

const LOW_STOCK_THRESHOLD = 2;

/**
 * Scans all active products and auto-deactivates any with stock <= LOW_STOCK_THRESHOLD.
 * Sends an in-app notification and email to the seller for each product deactivated.
 */
const runLowStockScan = async () => {
  try {
    // Only scan SIMPLE products — VARIABLE products track stock at the variant level.
    // Their product.stock is 0/NULL by default and must NOT trigger deactivation.
    const products = await prisma.$queryRaw`
      SELECT p.id, p.title, p.stock, p.type, p."sellerId",
             u.email AS "sellerEmail", u.name AS "sellerName"
      FROM "products" p
      JOIN "users" u ON u.id = p."sellerId"
      WHERE p."isActive" = true
        AND p.type = 'SIMPLE'
        AND p.stock <= ${LOW_STOCK_THRESHOLD}
    `;

    if (products.length === 0) {
      console.log('✅ [Low Stock Scheduler] No low-stock active products found.');
      return;
    }

    console.log(`⚠️  [Low Stock Scheduler] Found ${products.length} low-stock product(s) — deactivating...`);

    for (const product of products) {
      await prisma.$executeRaw`
        UPDATE "products"
        SET "isActive" = false, status = 'INACTIVE'
        WHERE id = ${product.id}
      `;

      notifySellerLowStock(
        product.sellerId,
        product.id,
        product.title,
        Number(product.stock)
      ).catch(err => console.error('[Low Stock Scheduler] Notification error:', err.message));

      if (product.sellerEmail) {
        sendSellerLowStockEmail(
          product.sellerEmail,
          product.sellerName || 'Seller',
          product.title,
          Number(product.stock),
          product.id
        ).then(result => {
          if (!result.success) console.warn(`⚠️  [Low Stock Scheduler] Email not sent to ${product.sellerEmail}: ${result.error}`);
          else console.log(`✅ [Low Stock Scheduler] Email sent to ${product.sellerEmail} for "${product.title}"`);
        }).catch(err => console.error('[Low Stock Scheduler] Email error:', err.message));
      } else {
        console.warn(`⚠️  [Low Stock Scheduler] No email for seller ${product.sellerId} — email skipped`);
      }

      console.log(`   ↳ Deactivated "${product.title}" (stock: ${product.stock})`);
    }

    console.log(`✅ [Low Stock Scheduler] Done — ${products.length} product(s) deactivated.`);
  } catch (error) {
    console.error('❌ [Low Stock Scheduler] Scan error:', error.message);
  }
};

/**
 * Initialise the low-stock cron job.
 * Runs every 30 minutes by default.
 */
const initializeLowStockScheduler = () => {
  console.log('🔔 Initializing low-stock auto-deactivation scheduler (every 30 min)...');

  // Run immediately on startup to catch existing low-stock products
  runLowStockScan();

  // Then run every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('⏰ [Low Stock Scheduler] Running scheduled scan...');
    await runLowStockScan();
  });

  console.log('✅ Low-stock scheduler initialized.');
};

module.exports = { initializeLowStockScheduler, runLowStockScan };

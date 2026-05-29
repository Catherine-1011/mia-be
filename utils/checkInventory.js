/**
 * checkInventory.js
 * -----------------
 * Checks a product's stock level in the database (Prisma) and:
 *  - Marks the product as inactive when stock hits 0
 *  - Broadcasts a real-time stock:update event via Socket.io
 *  - Logs low-stock warnings for seller awareness
 */

const prisma = require('../config/prisma');
const { broadcastStockUpdate } = require('./stockSocket');

// Units remaining at or below this number trigger a low-stock warning
const LOW_STOCK_THRESHOLD = 5;

/**
 * @param {string} productId
 * @returns {Promise<{ type: 'outOfStock' | 'lowStock' | 'ok' }>}
 */
exports.checkInventory = async (productId) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, title: true, stock: true, isActive: true }
    });

    if (!product) return { type: 'ok' };

    const { stock, isActive } = product;

    // OUT OF STOCK — deactivate product and broadcast
    if (stock <= 0) {
      if (isActive) {
        await prisma.$executeRaw`UPDATE "products" SET "isActive" = false WHERE id = ${productId}`;
        console.log(`⚠️  Product auto-deactivated (out of stock): ${product.title}`);
      }
      broadcastStockUpdate(productId, 0, false);
      return { type: 'outOfStock' };
    }

    // LOW STOCK — warn but keep active, still broadcast updated count
    if (stock <= LOW_STOCK_THRESHOLD) {
      console.log(`🟡 Low stock alert: "${product.title}" — ${stock} remaining`);
      broadcastStockUpdate(productId, stock, isActive ?? true);
      return { type: 'lowStock' };
    }

    // NORMAL — broadcast so any open product/cart page stays in sync
    broadcastStockUpdate(productId, stock, isActive ?? true);
    return { type: 'ok' };
  } catch (err) {
    console.error('checkInventory error:', err.message);
    return { type: 'ok' }; // fail-safe: never block the order flow
  }
};


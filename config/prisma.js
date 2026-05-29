const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' 
    ? ['query', 'error', 'warn'] 
    : ['error'],
  // Set transaction timeout to 30 seconds to prevent timeout issues
  transactionOptions: {
    timeout: 20000, // 20 seconds to avoid NeonDB serverless timeouts
    maxWait: 3000,  // 3 seconds max wait to acquire connection
    isolationLevel: 'ReadCommitted'
  }
});

// ── NeonDB cold-start retry middleware ───────────────────────────────────────
// NeonDB serverless branches sleep after inactivity. The first query after
// sleep hits a P1001 "Can't reach database server" error while the branch wakes.
// This middleware transparently retries up to 5 times with exponential backoff
// so callers never see the cold-start error.
prisma.$use(async (params, next) => {
  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 500; // 500ms, 1s, 2s, 4s, 8s
  let attempt = 0;

  while (true) {
    try {
      return await next(params);
    } catch (err) {
      const isColdStart = err?.code === 'P1001' || err?.message?.includes("Can't reach database server");
      attempt++;
      if (isColdStart && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`⏳ NeonDB cold-start — retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Real-time stock broadcast middleware ─────────────────────────────────────
// Intercepts EVERY product.update / product.updateMany that touches `stock`,
// regardless of which controller triggered it (orders, cancellations, seller
// bulk-update, admin edits, etc.).
// Fires AFTER the DB write so the broadcast always carries the committed value.
prisma.$use(async (params, next) => {
  const result = await next(params);

  try {
    if (params.model === 'Product' && params.action === 'update') {
      const dataArg = params.args?.data;
      // Only broadcast when the update actually touches the stock field
      const stockTouched =
        dataArg !== undefined &&
        ('stock' in dataArg ||
          (typeof dataArg.stock === 'object' && dataArg.stock !== null));

      if (stockTouched && result) {
        // result is the full updated product record (all default scalar fields)
        const { broadcastStockUpdate } = require('../utils/stockSocket');
        const productId = result.id || params.args?.where?.id;
        const newStock  = result.stock  ?? 0;
        // isActive may be undefined if SELECT didn't include it — default to true unless stock is 0
        const isActive  = result.isActive !== undefined ? result.isActive : newStock > 0;
        if (productId) {
          broadcastStockUpdate(productId, newStock, isActive);
        }
      }
    }
  } catch (broadcastErr) {
    // Never let a broadcast failure crash a DB operation
    console.error('[prisma middleware] stock broadcast error:', broadcastErr.message);
  }

  return result;
});
// ─────────────────────────────────────────────────────────────────────────────

// Test connection
prisma.$connect()
  .then(() => console.log('✅ PostgreSQL connected via Prisma'))
  .catch((err) => console.error('❌ Prisma connection error:', err));

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = prisma;

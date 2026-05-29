/**
 * stockSocket.js
 * ──────────────
 * Singleton that holds the Socket.io server instance and exposes helpers
 * for broadcasting real-time stock updates to connected frontend clients.
 *
 * Room convention:
 *   product:<productId>  →  all clients watching a specific product
 *
 * Events emitted by SERVER → CLIENT:
 *   stock:update  { productId, stock, isAvailable, timestamp }
 *
 * Events listened by SERVER ← CLIENT:
 *   watch:product   (productId: string)
 *   unwatch:product (productId: string)
 *   watch:cart      (productIds: string[])
 */

let _io = null;

/**
 * Initialise the Socket.io server.
 * Call this once after Socket.io is created in server.js.
 * @param {import('socket.io').Server} io
 */
function initStockSocket(io) {
  _io = io;

  io.on('connection', (socket) => {
    console.log(`🟢 [Stock socket] connected: ${socket.id}`);

    // ── Client wants real-time updates for a single product ──
    socket.on('watch:product', (productId) => {
      if (typeof productId === 'string' && productId.trim()) {
        socket.join(`product:${productId}`);
      }
    });

    // ── Client no longer viewing a product ──
    socket.on('unwatch:product', (productId) => {
      if (typeof productId === 'string' && productId.trim()) {
        socket.leave(`product:${productId}`);
      }
    });

    // ── Client opens cart — watch ALL products in cart at once ──
    socket.on('watch:cart', (productIds) => {
      if (Array.isArray(productIds)) {
        productIds.forEach((id) => {
          if (typeof id === 'string' && id.trim()) {
            socket.join(`product:${id}`);
          }
        });
      }
    });

    socket.on('disconnect', () => {
      console.log(`🔴 [Stock socket] disconnected: ${socket.id}`);
    });
  });
}

/**
 * Broadcast a stock change to all clients watching a product room.
 * Safe to call even if Socket.io is not initialised (logs warning, no crash).
 *
 * @param {string}  productId
 * @param {number}  newStock    - updated stock count after deduction
 * @param {boolean} isActive    - whether the product is still active in the DB
 */
function broadcastStockUpdate(productId, newStock, isActive = true) {
  if (!_io) {
    console.warn('[Stock socket] broadcastStockUpdate called before init — skipping');
    return;
  }

  _io.to(`product:${productId}`).emit('stock:update', {
    productId,
    stock: newStock,
    isAvailable: isActive && newStock > 0,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Returns the raw Socket.io server instance (use sparingly).
 * @returns {import('socket.io').Server|null}
 */
function getIO() {
  return _io;
}

module.exports = { initStockSocket, broadcastStockUpdate, getIO };

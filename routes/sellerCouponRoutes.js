'use strict';

const { authenticateSellerOrAdmin } = require('../middlewares/authMiddleware');
const couponController = require('../controllers/coupon');

async function sellerCouponRoutes(fastify, options) {
  // ── Public ────────────────────────────────────────────────────────────────
  // GET  /api/seller-coupons/active          — browse active coupons (optional ?sellerId=)
  fastify.get('/active', couponController.getActiveSellerCoupons);

  // POST /api/seller-coupons/apply           — calculate discount on cart items (no auth needed)
  fastify.post('/apply', couponController.applySellerCoupon);

  // ── Seller & Admin protected ──────────────────────────────────────────────
  // POST   /api/seller-coupons               — create a seller coupon
  //        Seller: creates for own store
  //        Admin:  must provide sellerId in body to create on behalf of a seller
  fastify.post('/', { preHandler: authenticateSellerOrAdmin }, couponController.createSellerCoupon);

  // GET    /api/seller-coupons               — list coupons
  //        Seller: their own | Admin: all (optional ?sellerId= & ?recycleBin=true)
  fastify.get('/', { preHandler: authenticateSellerOrAdmin }, couponController.getSellerCoupons);

  // GET    /api/seller-coupons/:id           — get single coupon
  fastify.get('/:id', { preHandler: authenticateSellerOrAdmin }, couponController.getSellerCouponById);

  // PUT    /api/seller-coupons/:id           — update coupon
  fastify.put('/:id', { preHandler: authenticateSellerOrAdmin }, couponController.updateSellerCoupon);

  // DELETE /api/seller-coupons/:id           — soft delete (move to recycle bin)
  fastify.delete('/:id', { preHandler: authenticateSellerOrAdmin }, couponController.softDeleteSellerCoupon);

  // PATCH  /api/seller-coupons/:id/restore   — restore from recycle bin
  fastify.patch('/:id/restore', { preHandler: authenticateSellerOrAdmin }, couponController.restoreSellerCoupon);

  // DELETE /api/seller-coupons/:id/permanent — hard delete (must be in recycle bin first)
  fastify.delete('/:id/permanent', { preHandler: authenticateSellerOrAdmin }, couponController.hardDeleteSellerCoupon);
}

module.exports = sellerCouponRoutes;

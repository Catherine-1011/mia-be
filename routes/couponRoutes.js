const adminController = require('../controllers/admin');

async function couponRoutes(fastify, options) {
  // Public route for customers to validate coupons
  fastify.post('/validate', adminController.validateCoupon);
}

module.exports = couponRoutes;
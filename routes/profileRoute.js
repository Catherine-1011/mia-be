const profileController = require('../controllers/profile');
const authMiddleware = require('../middlewares/auth');
const { authenticateSeller } = require('../middlewares/authMiddleware');

async function profileRoutes(fastify, options) {
  // Get user profile for authenticated user
  fastify.get('/profile', { preHandler: authMiddleware }, profileController.getProfile);

  // Update user profile for authenticated user
  fastify.put('/profile', { preHandler: authMiddleware }, profileController.updateProfile);

  // Change password for authenticated user
  fastify.put('/change-password', { preHandler: authMiddleware }, profileController.changePassword);

  // ==================== SELLER PROFILE ====================

  // Get full seller profile (seller token required)
  fastify.get('/seller-profile', { preHandler: authenticateSeller }, profileController.getSellerProfile);

  // Edit seller profile (seller token required)
  // Supports both JSON and multipart/form-data (for storeLogo / storeBanner file upload)
  fastify.put('/seller-profile', { preHandler: authenticateSeller }, profileController.updateSellerProfile);
}

module.exports = profileRoutes;

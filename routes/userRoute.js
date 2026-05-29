// ...existing code...
const userController = require('../controllers/user');
const authMiddleware = require('../middlewares/auth');

async function userRoutes(fastify, options) {
	// Get all users (admin only)
	fastify.get('/all', { preHandler: authMiddleware }, userController.getAllUsers);

	// Get profile for any user (no auth)
	fastify.get('/profile', userController.getProfile);

	// ==================== ADDRESS ROUTES (Auth Required) ====================

	// Get all saved addresses
	fastify.get('/addresses', { preHandler: authMiddleware }, userController.getAddresses);

	// Save a new address
	fastify.post('/addresses', { preHandler: authMiddleware }, userController.saveAddress);

	// Delete an address
	fastify.delete('/addresses/:id', { preHandler: authMiddleware }, userController.deleteAddress);

	// Set an address as default
	fastify.patch('/addresses/:id/default', { preHandler: authMiddleware }, userController.setDefaultAddress);
}

module.exports = userRoutes;


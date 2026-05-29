const {
  getSellerNotifications,
  updateOrderStatus,
  acknowledgeNotification,
  getSLADashboard
} = require('../controllers/orderNotification');
const authMiddleware = require('../middlewares/auth');
const checkRole = require('../middlewares/checkRole');

async function orderNotificationRoutes(fastify, options) {
  // Test endpoint to check if the route is working
  fastify.get('/test', async (request, reply) => {
    return reply.status(200).send({
      success: true,
      message: 'Order notification routes are working',
      timestamp: new Date().toISOString()
    });
  });

  // Routes for seller notifications
  fastify.get('/notifications', {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, getSellerNotifications);

  fastify.get('/sla-dashboard', {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, getSLADashboard);

  fastify.patch('/notifications/:notificationId/acknowledge', {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, acknowledgeNotification);

  fastify.patch('/orders/:orderId/status', {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, updateOrderStatus);
}

module.exports = orderNotificationRoutes;
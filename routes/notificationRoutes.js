const notificationController = require("../controllers/notification");
const { authenticateUser } = require("../middlewares/authMiddleware");

async function notificationRoutes(fastify, options) {
  
  // Get user notifications
  fastify.get("/", { preHandler: authenticateUser }, notificationController.getNotifications);
  
  // Mark specific notification as read
  fastify.put("/read/:notificationId", { preHandler: authenticateUser }, notificationController.markAsRead);
  
  // Mark all notifications as read
  fastify.put("/read-all", { preHandler: authenticateUser }, notificationController.markAllAsRead);
  
  // Delete notification
  fastify.delete("/:notificationId", { preHandler: authenticateUser }, notificationController.deleteNotification);
}

module.exports = notificationRoutes;
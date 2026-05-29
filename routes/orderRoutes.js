const orderController = require("../controllers/orders");
const { authenticateUser } = require("../middlewares/authMiddleware");
const checkRole = require("../middlewares/checkRole");
const guestRefundRateLimit = require("../middlewares/guestRefundRateLimit");

async function orderRoutes(fastify, options) {
  // ---------------- USER ORDER ROUTES ----------------

  // Place a new order
  fastify.post("/create", { preHandler: authenticateUser }, orderController.createOrder);

  // Get logged-in user's orders
  fastify.get("/my-orders", { preHandler: authenticateUser }, orderController.getMyOrders);

  // Cancel order
  fastify.put("/cancel/:id", { preHandler: authenticateUser }, orderController.cancelOrder);

  // Request refund / partial refund (customer)
  fastify.post("/refund-request/:id", { preHandler: authenticateUser }, orderController.requestRefund);

  // Track all refund / partial refund requests for logged-in customer
  fastify.get("/refund-requests", { preHandler: authenticateUser }, orderController.getMyRefundRequests);

  // Track single refund request by request ID
  fastify.get("/refund-requests/:requestId", { preHandler: authenticateUser }, orderController.getRefundRequestById);

  // Reorder - Add all items from previous order to cart
  fastify.post("/reorder/:id", { preHandler: authenticateUser }, orderController.reorder);

  // Download invoice PDF — requires auth (used by frontend in many places)
  fastify.get("/invoice/:orderId", { preHandler: [authenticateUser, checkRole(['CUSTOMER', 'USER', 'SELLER', 'ADMIN'])] }, orderController.downloadInvoice);

  // Download sub-order invoice PDF — seller-specific, only that seller's items
  // :subOrderId = subDisplayId without # prefix, e.g. "A4X9KR-A"
  fastify.get("/invoice/sub/:subOrderId", { preHandler: [authenticateUser, checkRole(['CUSTOMER', 'USER', 'SELLER', 'ADMIN'])] }, orderController.downloadSubOrderInvoice);

  // Download invoice PDF — public endpoint for email "Download Invoice" button
  // Registered as a separate path so it never conflicts with the auth route above
  fastify.get("/invoice/public/:orderId", orderController.downloadPublicInvoice);

  // ----------- GUEST CHECKOUT ROUTES (No authentication) -----------
  // Note: Guest checkout is Stripe-only. There is no COD option.

  // Track guest order by Order ID and Email (no authentication required)
  fastify.get("/guest/track", orderController.trackGuestOrder);

  // Download guest invoice PDF (no authentication required)
  fastify.get("/guest/invoice", orderController.downloadGuestInvoice);

  // Public endpoint finding delivered items eligible for refund (works for both guests and registered users)
  fastify.post("/guest/track-for-refund", { preHandler: guestRefundRateLimit }, orderController.findOrderForRefund);

  // Guest refund request create (no authentication; verified by orderId + customerEmail)
  fastify.post("/guest/refund-request", { preHandler: guestRefundRateLimit }, orderController.requestGuestRefund);

  // Guest refund request list tracking (no authentication; verified by orderId + customerEmail)
  fastify.get("/guest/refund-requests", { preHandler: guestRefundRateLimit }, orderController.getGuestRefundRequests);

  // Guest single refund request tracking (no authentication; verified by orderId + customerEmail)
  fastify.get("/guest/refund-requests/:requestId", { preHandler: guestRefundRateLimit }, orderController.getGuestRefundRequestById);
}

module.exports = orderRoutes;


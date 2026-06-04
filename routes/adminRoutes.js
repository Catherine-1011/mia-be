const { isAdmin, authenticateUser } = require("../middlewares/authMiddleware");
const authMiddleware = require("../middlewares/auth");
const checkRole = require("../middlewares/checkRole");
const adminController = require("../controllers/admin");
const couponController = require("../controllers/coupon");
const productController = require("../controllers/product");
const feedbackController = require("../controllers/feedback");
const commissionController = require("../controllers/commission");
const sellerOrderController = require("../controllers/sellerOrders");

async function adminRoutes(fastify, options) {
  // Apply admin middleware to all routes
  const adminAuth = isAdmin;

  // ---------------- REFUND MANAGEMENT ----------------
  fastify.get("/refund-requests", { preHandler: adminAuth }, adminController.getAllRefundRequests);
  // PUT /admin/refund-requests/:id/status — body: { status: 'APPROVED'|'REJECTED'|'COMPLETED', message?: string }
  fastify.put("/refund-requests/:id/status", { preHandler: adminAuth }, adminController.updateRefundRequestStatus);

  // ---------------- USER MANAGEMENT ----------------
  fastify.get("/users", { preHandler: adminAuth }, adminController.getAllUsers);
  
  // ── User Recycle Bin Management ──
  fastify.delete("/users/:userId", { preHandler: adminAuth }, adminController.softDeleteUser);
  fastify.get("/users/recycle-bin", { preHandler: adminAuth }, adminController.getUserRecycleBin);
  fastify.post("/users/:userId/restore", { preHandler: adminAuth }, adminController.restoreUser);
  
  // Auto-cleanup for users in recycle bin (manual trigger for admins)
  fastify.post("/users/cleanup-expired", { preHandler: adminAuth }, adminController.cleanupExpiredUsers);

  // One-time backfill: anonymize stale PII in site_feedback & contact_messages for already-deleted users
  fastify.post("/users/backfill-pii-anonymization", { preHandler: adminAuth }, adminController.backfillPiiAnonymization);

  // ---------------- SELLER MANAGEMENT ----------------

  // Get all sellers (with optional status filter)
  fastify.get("/sellers", { preHandler: adminAuth }, adminController.getAllSellers);

  // Get pending sellers for review
  fastify.get("/sellers/pending", { preHandler: adminAuth }, adminController.getPendingSellers);

  // Get seller details by ID
  fastify.get("/sellers/:id", { preHandler: adminAuth }, adminController.getSellerDetails);

  // Get seller's products
  fastify.get("/sellers/:sellerId/products", { preHandler: adminAuth }, adminController.getProductsBySeller);

  // Get all orders (admin only) - simple list
  fastify.get("/orders", { preHandler: adminAuth }, adminController.getAllOrders);

  // Get all orders with full customer + seller details (admin only)
  // Supports: ?page ?limit ?status ?paymentStatus ?search ?from ?to ?orderType=MULTI_SELLER|DIRECT|LEGACY
  fastify.get("/orders/detailed", { preHandler: adminAuth }, adminController.getAllOrdersDetailed);

  // Get all orders by seller ID (admin only)
  fastify.get("/orders/by-seller/:sellerId", { preHandler: adminAuth }, adminController.getOrdersBySellerId);

  // Seller approval actions
  fastify.post("/sellers/approve/:id", { preHandler: adminAuth }, adminController.approveSeller);
  fastify.post("/sellers/reject/:id", { preHandler: adminAuth }, adminController.rejectSeller);
  fastify.put("/sellers/suspend/:sellerId", { preHandler: adminAuth }, adminController.suspendSeller);

  // Update seller notes
  fastify.put("/sellers/notes/:id", { preHandler: adminAuth }, adminController.updateSellerNotes);

  // Update seller profile fields (abn, businessName, etc.)
  fastify.put("/sellers/:sellerId/profile", { preHandler: adminAuth }, adminController.updateSellerProfile);

  // Activate seller (Go Live - SOW Requirement)
  fastify.post("/sellers/activate/:id", { preHandler: adminAuth }, adminController.activateSeller);

  // Sync seller Stripe KYC status → auto-approves platform status if charges_enabled
  fastify.post("/sellers/stripe-sync/:id", { preHandler: adminAuth }, adminController.syncSellerStripeStatus);

  // Bulk sync ALL sellers' Stripe status in one call
  fastify.post("/sellers/stripe-sync-all", { preHandler: adminAuth }, adminController.bulkSyncSellerStripeStatus);

  // Retry pending Stripe transfers for a seller (for orders where transfer was skipped)
  fastify.post("/sellers/retry-transfers/:id", { preHandler: adminAuth }, adminController.retrySellerTransfers);

  // ---------------- CATEGORY MANAGEMENT ----------------
  // Get all categories with product counts (Admin & Seller)
  fastify.get("/categories", { 
    preHandler: [authMiddleware, checkRole(['ADMIN', 'SELLER'])]
  }, adminController.getAllCategories);

  // ---------------- PRODUCT APPROVAL MANAGEMENT ----------------
  // Get ALL products with status filter: ?status=pending|approved|rejected|inactive|all
  // Optional filters: &sellerId=xxx  &page=1 &limit=20
  fastify.get("/products", { preHandler: adminAuth }, adminController.getAllAdminProducts);

  // Get all pending products for approval
  fastify.get("/products/pending", { preHandler: adminAuth }, adminController.getPendingProducts);
  
  // Approve a product
  fastify.post("/products/approve/:productId", { preHandler: adminAuth }, adminController.approveProduct);
  
  // Reject a product (supports both DELETE and POST for body parsing reliability)
  fastify.post("/products/reject/:productId", { preHandler: adminAuth }, adminController.rejectProduct);
  fastify.delete("/products/reject/:productId", { preHandler: adminAuth }, adminController.rejectProduct);
  
  // Bulk approve products
  fastify.post("/products/approve-bulk", { preHandler: adminAuth }, adminController.bulkApproveProducts);

  // Activate / Deactivate a product
  fastify.put("/products/activate/:productId", { preHandler: adminAuth }, adminController.activateProduct);
  fastify.put("/products/deactivate/:productId", { preHandler: adminAuth }, adminController.deactivateProduct);

  // ── Recycle Bin (admin) ────────────────────────────────────────────────────
  // DELETE /admin/products/:productId               — soft delete (move to Recycle Bin)
  fastify.delete("/products/:productId", { preHandler: adminAuth }, productController.deleteProduct);
  // GET  /admin/products/recycle-bin?sellerId=xxx   — all deleted products
  fastify.get("/products/recycle-bin", { preHandler: adminAuth }, adminController.getAdminRecycleBin);
  // POST /admin/products/:productId/restore         — restore to INACTIVE
  fastify.post("/products/:productId/restore", { preHandler: adminAuth }, productController.restoreProduct);
  // DELETE /admin/products/:productId/permanent     — hard delete from recycle bin
  fastify.delete("/products/:productId/permanent", { preHandler: adminAuth }, adminController.permanentlyDeleteProduct);

  // Scan & deactivate all low-stock active products and notify sellers
  fastify.post("/products/scan-low-stock", { preHandler: adminAuth }, adminController.scanLowStockProducts);

  // Backfill order notifications for all existing orders that have no notification record
  fastify.post("/orders/backfill-notifications", { preHandler: adminAuth }, adminController.backfillOrderNotifications);

  // Update order / sub-order status (admin can update any order)
  fastify.put("/orders/update-status/:orderId", { preHandler: [authenticateUser, checkRole(['ADMIN', 'SUPER_ADMIN'])] }, sellerOrderController.updateOrderStatus);

  // Update tracking info for order / sub-order (admin)
  fastify.put("/orders/tracking/:orderId", { preHandler: [authenticateUser, checkRole(['ADMIN', 'SUPER_ADMIN'])] }, sellerOrderController.updateTrackingInfo);

  // ---------------- COUPON MANAGEMENT ----------------
  // Public: active coupons visible to all users (no auth required)
  fastify.get("/coupons/active", adminController.getActiveCoupons);

  // Admin only: full coupon list + management
  fastify.get("/coupons",                                    adminController.getAllCoupons);
  fastify.post("/coupons",            { preHandler: adminAuth }, adminController.createCoupon);
  fastify.put("/coupons/:id",         { preHandler: adminAuth }, adminController.updateCoupon);

  // Recycle bin: soft-delete, restore, hard-delete
  fastify.delete("/coupons/:id",           { preHandler: adminAuth }, adminController.softDeleteCoupon);
  fastify.patch("/coupons/:id/restore",    { preHandler: adminAuth }, adminController.restoreCoupon);
  fastify.delete("/coupons/:id/permanent", { preHandler: adminAuth }, adminController.hardDeleteCoupon);
  // ---------------- SALES ANALYTICS & EXPORT ----------------
  
  fastify.get("/sales/analytics", { preHandler: adminAuth }, adminController.getSalesAnalytics);
  fastify.get("/sales/export", { preHandler: adminAuth }, adminController.exportSalesCSV);
  fastify.get("/sales/gst-report", { preHandler: adminAuth }, adminController.getGstReport);

  // ---------------- REVENUE & ORDERS CHART ----------------
  // GET /admin/analytics/revenue-chart?period=7D|30D|1Y
  fastify.get("/analytics/revenue-chart", { preHandler: adminAuth }, adminController.getRevenueOrdersChart);

  // ---------------- COMMISSION MANAGEMENT ----------------
  fastify.get("/commissions",                         { preHandler: adminAuth }, commissionController.getAllCommissions);
  fastify.get("/commissions/:id",                     { preHandler: adminAuth }, commissionController.getCommissionById);
  fastify.post("/commissions",                        { preHandler: adminAuth }, commissionController.createCommission);
  fastify.put("/commissions/:id",                     { preHandler: adminAuth }, commissionController.updateCommission);
  fastify.put("/commissions/:id/set-default",         { preHandler: adminAuth }, commissionController.setDefaultCommission);
  fastify.delete("/commissions/:id",                  { preHandler: adminAuth }, commissionController.deleteCommission);
  // Assign a specific commission to a specific seller
  fastify.put("/sellers/:sellerId/commission",        { preHandler: adminAuth }, commissionController.assignCommissionToSeller);

  // Commission Earned (recorded per order)
  fastify.get("/commissions/earned",                          { preHandler: adminAuth }, commissionController.getAllCommissionEarned);
  fastify.get("/commissions/earned/summary",                  { preHandler: adminAuth }, commissionController.getCommissionEarnedSummary);
  fastify.get("/commissions/earned/order/:orderId",           { preHandler: adminAuth }, commissionController.getCommissionEarnedByOrder);
  fastify.put("/commissions/earned/:id/status",               { preHandler: adminAuth }, commissionController.updateCommissionEarnedStatus);

  // Payout Requests (Admin)
  fastify.get("/commissions/payout-requests",                 { preHandler: adminAuth }, commissionController.getAllPayoutRequests);
  fastify.put("/commissions/payout-requests/:id/status",      { preHandler: adminAuth }, commissionController.updatePayoutRequestStatus);
  
  // Debug endpoint for troubleshooting commission/payout issues
  fastify.get("/commissions/debug/balance/:sellerId",         { preHandler: adminAuth }, commissionController.debugSellerBalance);

  // ---------------- SITE FEEDBACK ----------------
  fastify.get("/feedback", { preHandler: adminAuth }, feedbackController.getAllFeedback);
  fastify.delete("/feedback/:id", { preHandler: adminAuth }, feedbackController.deleteFeedback);

  // ---------------- BANK CHANGE REQUESTS ----------------
  fastify.get("/bank-change-requests", { preHandler: adminAuth }, adminController.getBankChangeRequests);
  fastify.get("/bank-change-requests/:id", { preHandler: adminAuth }, adminController.getBankChangeRequest);
  fastify.post("/bank-change-requests/:id/approve", { preHandler: adminAuth }, adminController.approveBankChangeRequest);
  fastify.post("/bank-change-requests/:id/reject", { preHandler: adminAuth }, adminController.rejectBankChangeRequest);

  // ---------------- AUDIT LOGS (immutable, read-only) ----------------
  // GET /admin/audit-logs?entityType=PRODUCT&action=PRODUCT_APPROVED&from=2026-01-01&page=1&limit=50
  fastify.get("/audit-logs", { preHandler: adminAuth }, adminController.getAuditLogs);
  // GET /admin/audit-logs/products/:productId  — full history for one product
  // Accessible by ADMIN (any product) or SELLER (own products only)
  fastify.get("/audit-logs/products/:productId", { preHandler: authenticateUser }, adminController.getProductAuditHistory);

  // ---------------- SPONSORED SECTIONS MANAGEMENT ----------------
  fastify.post("/sponsored-sections", { preHandler: adminAuth }, adminController.createSponsoredSection);
  fastify.get("/sponsored-sections", { preHandler: adminAuth }, adminController.getAllSponsoredSections);
  fastify.put("/sponsored-sections/:id", { preHandler: adminAuth }, adminController.updateSponsoredSection);
  fastify.delete("/sponsored-sections/:id", { preHandler: adminAuth }, adminController.deleteSponsoredSection);

  // ---------------- SELLER COUPON MANAGEMENT ----------------
  // GET /api/admin/seller-coupons — all seller coupons grouped by seller
  // Query: sellerId, isActive, couponType, recycleBin, search, page, limit
  fastify.get("/seller-coupons", { preHandler: adminAuth }, couponController.adminGetSellerCouponsBySeller);

  // ---------------- SITE SETTINGS ----------------
  // GET /api/admin/settings — get all site settings
  fastify.get("/settings", { preHandler: adminAuth }, adminController.getSiteSettings);
  // PUT /api/admin/settings/international-shipping — enable or disable international shipping
  fastify.put("/settings/international-shipping", { preHandler: adminAuth }, adminController.toggleInternationalShipping);
} 

module.exports = adminRoutes;



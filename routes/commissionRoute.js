const { authenticateUser } = require("../middlewares/authMiddleware");
const checkRole = require("../middlewares/checkRole");
const commissionController = require("../controllers/commission");

async function commissionRoutes(fastify, options) {
  // GET /api/commissions/earned/my
  // Seller views their own commission earned records (with optional filters)
  fastify.get(
    "/earned/my",
    { preHandler: [authenticateUser, checkRole(["SELLER"])] },
    commissionController.getMyCommissionEarned
  );

  // ── Payout Requests (Seller) ──────────────────────────────────────────────
  // GET  /api/commissions/payout/redeemable  — redeemable balance summary
  fastify.get(
    "/payout/redeemable",
    { preHandler: [authenticateUser, checkRole(["SELLER"])] },
    commissionController.getRedeemableSummary
  );

  // POST /api/commissions/payout/request  — submit a payout request
  fastify.post(
    "/payout/request",
    { preHandler: [authenticateUser, checkRole(["SELLER"])] },
    commissionController.requestPayout
  );

  // GET  /api/commissions/payout/requests  — seller's own payout request history
  fastify.get(
    "/payout/requests",
    { preHandler: [authenticateUser, checkRole(["SELLER"])] },
    commissionController.getMyPayoutRequests
  );
}

module.exports = commissionRoutes;

const { authenticateUser } = require("../middlewares/authMiddleware");
const { submitFeedback } = require("../controllers/feedback");

async function feedbackRoutes(fastify, options) {
  // POST /api/feedback — submit website feedback (public, but enriched if logged in)
  // No auth required — guests can submit too
  fastify.post("/", { 
    config: { allowUnauthorized: true },
    preHandler: async (request) => {
      // Try to extract user from token if present, but don't fail if missing
      try {
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
          await authenticateUser(request, {
            status: () => ({ send: () => {} })
          });
        }
      } catch (_) {
        // Guest — no token, that's fine
      }
    }
  }, submitFeedback);
}

module.exports = feedbackRoutes;

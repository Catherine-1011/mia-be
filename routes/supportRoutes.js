const supportController = require("../controllers/support");
const { authenticateUser } = require("../middlewares/authMiddleware");

async function supportRoutes(fastify, options) {
  // ---------------- SUPPORT ROUTES ----------------

  // Submit contact form (Public - no auth required)
  fastify.post("/contact", supportController.submitContactForm);

  // Get return policy (Public - no auth required)
  fastify.get("/return-policy", supportController.getReturnPolicy);

  // Get my support tickets (Authenticated users only)
  fastify.get("/my-tickets", { preHandler: authenticateUser }, supportController.getMyTickets);
}

module.exports = supportRoutes;



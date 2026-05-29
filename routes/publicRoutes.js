const publicController = require("../controllers/public");

async function publicRoutes(fastify, options) {
  // Public sponsored sections (only active ones visible)
  fastify.get("/sponsored-sections", publicController.getActiveSponsoredSections);
}

module.exports = publicRoutes;
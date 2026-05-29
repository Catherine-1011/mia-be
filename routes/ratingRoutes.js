const { authenticateUser } = require("../middlewares/authMiddleware");
const ratingController = require("../controllers/rating");

async function ratingRoutes(fastify, options) {
  // Rate a product (requires purchase)
  fastify.post("/products/:productId/rate", 
    { preHandler: [authenticateUser] }, 
    ratingController.rateProduct
  );

  // Update a rating
  fastify.put("/ratings/:ratingId", 
    { preHandler: [authenticateUser] }, 
    ratingController.updateRating
  );

  // Delete a rating
  fastify.delete("/ratings/:ratingId", 
    { preHandler: [authenticateUser] }, 
    ratingController.deleteRating
  );

  // Get all ratings for a product (public)
  fastify.get("/products/:productId/ratings", 
    ratingController.getProductRatings
  );

  // Get buyer's rating for a specific product
  fastify.get("/products/:productId/my-rating", 
    { preHandler: [authenticateUser] }, 
    ratingController.getBuyerRating
  );

  // Get buyer's rating history
  fastify.get("/my-ratings", 
    { preHandler: [authenticateUser] }, 
    ratingController.getBuyerRatings
  );
}

module.exports = ratingRoutes;
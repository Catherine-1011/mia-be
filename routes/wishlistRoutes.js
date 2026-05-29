const wishlistController = require("../controllers/wishlist");
const { authenticateUser } = require("../middlewares/authMiddleware");

async function wishlistRoutes(fastify, options) {
  // Get user's wishlist
  fastify.get("/", { preHandler: authenticateUser }, wishlistController.getWishlist);

  // Add product to wishlist
  fastify.post("/:productId", { preHandler: authenticateUser }, wishlistController.addToWishlist);

  // Remove product from wishlist
  fastify.delete("/:productId", { preHandler: authenticateUser }, wishlistController.removeFromWishlist);

  // Remove wishlist item by ID
  fastify.delete("/item/:itemId", { preHandler: authenticateUser }, wishlistController.removeWishlistItemById);

  // Toggle product in wishlist (add/remove)
  fastify.put("/toggle/:productId", { preHandler: authenticateUser }, wishlistController.toggleWishlist);

  // Check if product is in wishlist
  fastify.get("/check/:productId", { preHandler: authenticateUser }, wishlistController.isInWishlist);

  // Clear entire wishlist
  fastify.delete("/", { preHandler: authenticateUser }, wishlistController.clearWishlist);

  // Move wishlist item to cart
  fastify.post("/move-to-cart/:productId", { preHandler: authenticateUser }, wishlistController.moveToCart);

  // Move wishlist item to cart by item ID
  fastify.post("/move-to-cart/item/:itemId", { preHandler: authenticateUser }, wishlistController.moveToCartById);

  // Clean up invalid wishlist items (VARIABLE products without variants)
  fastify.post("/cleanup", { preHandler: authenticateUser }, wishlistController.cleanupInvalidWishlistItems);
}
// fix
module.exports = wishlistRoutes;

const { authenticateUser } = require("../middlewares/authMiddleware");
const { addToCart, getMyCart, updateCartQuantity, removeFromCart, calculateGuestCart, getCheckoutOptions, syncCart } = require("../controllers/cart");

async function cartRoutes(fastify, options) {
  // ADD TO CART
  fastify.post("/add", { preHandler: authenticateUser }, addToCart);
  fastify.get("/view", { preHandler: authenticateUser }, addToCart);
  fastify.get("/my-cart", { preHandler: authenticateUser }, getMyCart);
  fastify.delete("/remove/:productId", { preHandler: authenticateUser }, removeFromCart);
  fastify.put("/update", { preHandler: authenticateUser }, updateCartQuantity);
  
  // SYNC GUEST CART ON LOGIN
  fastify.post("/sync", { preHandler: authenticateUser }, syncCart);

  // GUEST CART CALCULATION (No authentication required)
  fastify.post("/calculate-guest", calculateGuestCart);
  
  // PUBLIC CHECKOUT OPTIONS (No authentication required)
  fastify.get("/checkout-options", getCheckoutOptions);
}

module.exports = cartRoutes;



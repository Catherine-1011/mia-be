const { authenticateSeller, authenticateUser } = require("../middlewares/authMiddleware");
const { handleProductImagesUpload } = require("../middlewares/upload");
const checkRole = require("../middlewares/checkRole");
const {
  addProduct,
  getMyProducts,
  getAllProducts,
  getProductById,
  getProductVariants,
  updateVariant,
  bulkSaveVariants,
  toggleVariantStatus,
  deleteProduct,
  updateProduct,
  getProductStock,
  getBulkStock,
  getRecycleBin,
  restoreProduct,
  deactivateMyProduct,
  submitProductForReview
} = require("../controllers/product");

async function productRoutes(fastify, options) {
  // ADD PRODUCT (Seller only - must be approved, with image upload)
  fastify.post("/add", { preHandler: [authenticateSeller, handleProductImagesUpload] }, addProduct);

  // GET ALL PRODUCTS (Public) — also aliased at root for ?sellerId= support
  fastify.get("/", getAllProducts);
  fastify.get("/all", getAllProducts);

  // BULK STOCK CHECK (Public) — must be registered before /:id to avoid route conflict
  fastify.post("/bulk-stock", getBulkStock);

  // GET MY PRODUCTS (Seller only)
  fastify.get("/my-products", { preHandler: authenticateSeller }, getMyProducts);

  // GET PRODUCT STOCK BY ID (Public — lightweight real-time polling endpoint)
  fastify.get("/:id/stock", getProductStock);

  // GET PRODUCT BY ID (Public)
  fastify.get("/:id", getProductById);

  // GET PRODUCT VARIANTS (Public - for VARIABLE products)
  fastify.get("/:id/variants", getProductVariants);

  // BULK SAVE VARIANTS (Seller or Admin — replaces full variant set, handles attributes)
  fastify.put("/:productId/variants/bulk", { preHandler: [authenticateUser, checkRole(['SELLER', 'ADMIN'])] }, bulkSaveVariants);

  // UPDATE VARIANT (Seller or Admin — also auto-reactivates product if stock is restored)
  fastify.put("/:productId/variants/:variantId", { preHandler: [authenticateUser, checkRole(['SELLER', 'ADMIN'])] }, updateVariant);

  // TOGGLE VARIANT STATUS (Seller or Admin — flip isActive without touching price/stock)
  fastify.patch("/:productId/variants/:variantId/toggle-status", { preHandler: [authenticateUser, checkRole(['SELLER', 'ADMIN'])] }, toggleVariantStatus);

  // ── Seller: Self-Deactivate & Submit for Review ────────────────────────────
  // PUT  /products/:id/deactivate    — seller deactivates their ACTIVE product with a reason
  fastify.put("/:id/deactivate", { preHandler: authenticateSeller }, deactivateMyProduct);

  // POST /products/:id/submit-review — seller submits INACTIVE/REJECTED product for admin review
  //   Body: { reviewNote?: string }  (optional note to admin)
  fastify.post("/:id/submit-review", { preHandler: authenticateSeller }, submitProductForReview);

  // UPDATE PRODUCT (Seller and Admin - own products or admin access, with image upload)
  fastify.put("/:id", { preHandler: [authenticateUser, checkRole(['SELLER', 'ADMIN']), handleProductImagesUpload] }, updateProduct);

  // DELETE PRODUCT (Seller and Admin - soft delete — moves to Recycle Bin)
  fastify.delete("/:id", { preHandler: [authenticateUser, checkRole(['SELLER', 'ADMIN'])] }, deleteProduct);

  // ── Recycle Bin ────────────────────────────────────────────────────────────
  // GET  /products/recycle-bin       — seller views their own deleted products
  fastify.get("/recycle-bin", { preHandler: authenticateSeller }, getRecycleBin);

  // POST /products/:id/restore       — seller or admin restores a deleted product
  fastify.post("/:id/restore", { preHandler: [authenticateUser, checkRole(['SELLER', 'ADMIN'])] }, restoreProduct);
}

module.exports = productRoutes;



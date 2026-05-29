const categoryController = require("../controllers/categories");
const { authenticateSeller } = require("../middlewares/authMiddleware");
const authMiddleware = require("../middlewares/auth");
const checkRole = require("../middlewares/checkRole");

async function categoryRoutes(fastify, options) {

  // ── Read ─────────────────────────────────────────────────────────────────

  // GET all active categories (approved + not soft-deleted)
  fastify.get("/", {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, categoryController.getAllCategories);

  // GET soft-deleted categories (recycle bin) — Admin only
  fastify.get("/deleted", {
    preHandler: [authMiddleware, checkRole('ADMIN')]
  }, categoryController.getSoftDeletedCategories);

  // GET detail for a single category — Admin (any category incl. soft-deleted); Seller (own or approved)
  fastify.get("/:id", {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, categoryController.getCategoryDetail);

  // GET all category audit logs — Admin only
  // Query params: ?page=1&limit=50&action=CATEGORY_APPROVED
  fastify.get("/logs", {
    preHandler: [authMiddleware, checkRole('ADMIN')]
  }, categoryController.getAllCategoryLogs);

  // GET audit logs for a specific category — Admin (any); Seller (own categories only)
  fastify.get("/:id/logs", {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, categoryController.getCategoryLogs);

  // ── Create / Request ──────────────────────────────────────────────────────

  // REQUEST a new category — Sellers and Admin
  fastify.post("/request", {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, categoryController.requestCategory);

  // CREATE categories directly as APPROVED — Admin only (bulk)
  fastify.post("/create-direct", {
    preHandler: [authMiddleware, checkRole('ADMIN')]
  }, categoryController.createCategoryDirect);

  // ── Approval workflow ─────────────────────────────────────────────────────

  // APPROVE a pending category request — Admin only
  fastify.post("/approve/:id", {
    preHandler: [authMiddleware, checkRole('ADMIN')]
  }, categoryController.approveCategory);

  // REJECT a pending category request — Admin only
  fastify.post("/reject/:id", {
    preHandler: [authMiddleware, checkRole('ADMIN')]
  }, categoryController.rejectCategory);

  // ── Edit / Resubmit ───────────────────────────────────────────────────────

  // EDIT an approved category — Admin only
  fastify.put("/:id", {
    preHandler: [authMiddleware, checkRole('ADMIN')]
  }, categoryController.editCategory);

  // RESUBMIT a rejected category after editing — Seller (own) or Admin
  fastify.post("/resubmit/:id", {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, categoryController.resubmitCategory);

  // ── Soft delete / Restore / Hard delete ───────────────────────────────────

  // SOFT DELETE a category (move to recycle bin) — Admin or Seller (own categories only)
  fastify.delete("/:id", {
    preHandler: [authMiddleware, checkRole(['SELLER', 'ADMIN'])]
  }, categoryController.softDeleteCategory);

  // RESTORE a soft-deleted category — Admin only
  fastify.post("/restore/:id", {
    preHandler: [authMiddleware, checkRole('ADMIN')]
  }, categoryController.restoreCategory);

  // HARD DELETE a category permanently — Admin only
  fastify.delete("/hard-delete/:id", {
    preHandler: [authMiddleware, checkRole('ADMIN')]
  }, categoryController.hardDeleteCategory);
}

module.exports = categoryRoutes;

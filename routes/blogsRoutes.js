const { isAdmin } = require("../middlewares/authMiddleware");
const { handleBlogImageUpload } = require("../middlewares/upload");
const blogsController = require("../controllers/blogs");

async function blogsRoutes(fastify, options) {
  // ─────────────────────────────────────────────
  // PUBLIC routes
  // ─────────────────────────────────────────────

  // GET /api/blogs — all published & active blogs (paginated)
  fastify.get("/", blogsController.getAllBlogs);

  // GET /api/blogs/:id — single blog by ID or slug (published & active only)
  fastify.get("/:id", blogsController.getBlogById);

  // ─────────────────────────────────────────────
  // ADMIN routes
  // ─────────────────────────────────────────────

  // GET /api/blogs/admin/all — all blogs regardless of status/active (admin)
  fastify.get("/admin/all", { preHandler: isAdmin }, blogsController.adminGetAllBlogs);

  // GET /api/blogs/admin/:id — get single blog by ID or slug (admin, any status)
  fastify.get("/admin/:id", { preHandler: isAdmin }, blogsController.adminGetBlogById);

  // POST /api/blogs — create a new blog (admin) — supports form-data (file) or JSON (URL)
  fastify.post("/", { preHandler: [isAdmin, handleBlogImageUpload] }, blogsController.createBlog);

  // PUT /api/blogs/:id — edit blog details (admin) — supports form-data (file) or JSON (URL)
  fastify.put("/:id", { preHandler: [isAdmin, handleBlogImageUpload] }, blogsController.updateBlog);

  // DELETE /api/blogs/:id — delete a blog (admin)
  fastify.delete("/:id", { preHandler: isAdmin }, blogsController.deleteBlog);

  // PATCH /api/blogs/:id/toggle-publish — toggle published / draft (admin)
  fastify.patch("/:id/toggle-publish", { preHandler: isAdmin }, blogsController.togglePublish);
}

module.exports = blogsRoutes;

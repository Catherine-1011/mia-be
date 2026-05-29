const uploadController = require("../controllers/upload");

async function uploadRoutes(fastify, options) {
  // Image upload endpoint (e.g. for refund evidence)
  fastify.post(
    "/image",
    uploadController.uploadImage
  );
}

module.exports = uploadRoutes;
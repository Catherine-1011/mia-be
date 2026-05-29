const attributeController = require('../controllers/attribute');
const authMiddleware = require('../middlewares/auth');
const checkRole = require('../middlewares/checkRole');

async function attributeRoutes(fastify, options) {
  // Public routes - for sellers to see available attributes
  fastify.get('/attributes', attributeController.getAllAttributes);
  fastify.get('/attributes/:attributeId/values', attributeController.getAttributeValues);

  // Admin-only routes - for managing attributes
  fastify.register(async function (fastify) {
    fastify.addHook('preHandler', authMiddleware);
    fastify.addHook('preHandler', checkRole(['ADMIN', 'SUPER_ADMIN']));

    fastify.post('/attributes', attributeController.createAttribute);
    fastify.put('/attributes/:id', attributeController.updateAttribute);
    fastify.post('/attributes/:attributeId/values', attributeController.addAttributeValue);
    fastify.delete('/attributes/:id', attributeController.deleteAttribute);
  });
}

module.exports = attributeRoutes;
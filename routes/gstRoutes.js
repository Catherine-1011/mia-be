const { 
  createGST,
  getActiveGST,
  getDefaultGST,
  getAllGST,
  getGSTById,
  updateGST,
  deleteGST,
  toggleGSTStatus,
  setDefaultGST
} = require('../controllers/gst');
const { isAdmin } = require('../middlewares/authMiddleware');

async function gstRoutes(fastify, options) {
  /**
   * PUBLIC ROUTES - For customers/sellers to view GST settings
   */
  // GET /api/gst/active - Get all active GST settings
  fastify.get('/active', getActiveGST);

  // GET /api/gst/default - Get default GST setting
  fastify.get('/default', getDefaultGST);

  /**
   * ADMIN ONLY ROUTES - For managing GST settings
   */
  // POST /api/gst - Create new GST setting
  fastify.post('/', { preHandler: isAdmin }, createGST);

  // GET /api/gst - Get all GST settings (including inactive)
  fastify.get('/', { preHandler: isAdmin }, getAllGST);

  // GET /api/gst/:id - Get single GST setting by ID
  fastify.get('/:id', { preHandler: isAdmin }, getGSTById);

  // PUT /api/gst/:id - Update GST setting
  fastify.put('/:id', { preHandler: isAdmin }, updateGST);

  // DELETE /api/gst/:id - Delete GST setting
  fastify.delete('/:id', { preHandler: isAdmin }, deleteGST);

  // PATCH /api/gst/:id/toggle - Toggle GST active status
  fastify.patch('/:id/toggle', { preHandler: isAdmin }, toggleGSTStatus);

  // PATCH /api/gst/:id/set-default - Set GST as default
  fastify.patch('/:id/set-default', { preHandler: isAdmin }, setDefaultGST);
}

module.exports = gstRoutes;

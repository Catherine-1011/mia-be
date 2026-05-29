const contactController = require('../controllers/contact');
const { isAdmin } = require('../middlewares/authMiddleware');

async function contactRoutes(fastify, options) {
  // Public route: Everyone can submit the contact form
  fastify.post('/contact', contactController.submitContactForm);

  // Protected route: Only Admin/Super Admin can view contact form submissions
  fastify.get('/contact', { preHandler: isAdmin }, contactController.getContactSubmissions);
  fastify.patch('/contact/:id/status', { preHandler: isAdmin }, contactController.updateContactStatus);
  fastify.delete('/contact/:id', { preHandler: isAdmin }, contactController.deleteContactMessage);
}

module.exports = contactRoutes;
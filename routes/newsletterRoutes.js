const newsletterController = require('../controllers/newsletter');
const newsletterCampaignController = require('../controllers/newsletterCampaign');
const { isAdmin } = require('../middlewares/authMiddleware');

async function newsletterRoutes(fastify) {
  // Public route: user submits email for newsletter updates
  fastify.post('/newsletter', newsletterController.submitNewsletterEmail);
  fastify.post('/newsletter/unsubscribe', newsletterController.unsubscribeNewsletterEmail);

  // Protected route: admin views newsletter email submissions
  fastify.get('/newsletter', { preHandler: isAdmin }, newsletterController.getNewsletterEmails);
  fastify.get('/newsletter/export', { preHandler: isAdmin }, newsletterController.exportNewsletterEmailsCsv);

  // Campaign routes (admin only)
  fastify.post('/newsletter/campaigns', { preHandler: isAdmin }, newsletterCampaignController.createCampaign);
  fastify.get('/newsletter/campaigns', { preHandler: isAdmin }, newsletterCampaignController.getCampaigns);
  fastify.get('/newsletter/campaigns/:id', { preHandler: isAdmin }, newsletterCampaignController.getCampaign);
  fastify.put('/newsletter/campaigns/:id', { preHandler: isAdmin }, newsletterCampaignController.updateCampaign);
  fastify.delete('/newsletter/campaigns/:id', { preHandler: isAdmin }, newsletterCampaignController.deleteCampaign);
  fastify.post('/newsletter/campaigns/:id/send', { preHandler: isAdmin }, newsletterCampaignController.sendCampaign);
}

module.exports = newsletterRoutes;

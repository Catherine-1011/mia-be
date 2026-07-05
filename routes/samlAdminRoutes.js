'use strict';

const { isAdmin } = require('../middlewares/authMiddleware');
const checkRole = require('../middlewares/checkRole');
const samlAdminController = require('../controllers/samlAdmin');

async function samlAdminRoutes(fastify) {
  const superAdminOnly = [isAdmin, checkRole('SUPER_ADMIN')];

  fastify.get('/saml-users', { preHandler: superAdminOnly }, samlAdminController.getAllSamlUsers);
  fastify.post('/saml-users', { preHandler: superAdminOnly }, samlAdminController.createSamlUser);
  fastify.get('/saml-users/pending', { preHandler: superAdminOnly }, samlAdminController.getPendingSamlUsers);
  fastify.put('/saml-users/:userId/approve', { preHandler: superAdminOnly }, samlAdminController.approveSamlUser);
  fastify.put('/saml-users/:userId/reject', { preHandler: superAdminOnly }, samlAdminController.rejectSamlUser);
  fastify.put('/saml-users/:userId/block', { preHandler: superAdminOnly }, samlAdminController.blockSamlUser);
  fastify.put('/saml-users/:userId/unblock', { preHandler: superAdminOnly }, samlAdminController.unblockSamlUser);
  fastify.put('/saml-users/:userId/role', { preHandler: superAdminOnly }, samlAdminController.changeSamlUserRole);
  fastify.put('/saml-users/:userId/archive', { preHandler: superAdminOnly }, samlAdminController.archiveSamlUser);
  fastify.put('/saml-users/:userId/unarchive', { preHandler: superAdminOnly }, samlAdminController.unarchiveSamlUser);
}

module.exports = samlAdminRoutes;

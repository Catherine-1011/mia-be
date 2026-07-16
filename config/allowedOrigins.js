'use strict';

/**
 * Approved browser origins shared by:
 *  - @fastify/cors (server.js)
 *  - Logout CSRF / Origin validation (controllers/auth.js)
 *
 * Add new frontend origins here — only here.
 */
const ALLOWED_ORIGINS = [
                                          // Website (customer/seller facing)
                                         // Dashboard (seller/admin portal)
  'http://localhost:3000',               // Local dev — website
  'http://localhost:3001',               // Local dev — dashboard
  'http://localhost:3002',
  'https://usa.authpoint.watchguard.com',
  'https://madeinarnhemland.com.au',
  'https://dashboard.madeinarnhemland.com.au',
  'https://www.madeinarnhemland.com.au',
];

module.exports = { ALLOWED_ORIGINS };

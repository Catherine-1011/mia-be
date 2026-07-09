const prisma = require("../config/prisma");

const SAML_PASSWORD = 'SAML_MANAGED_ACCOUNT_NO_PASSWORD';

async function samlAdminAllowed(request) {
  const userId = request.user?.userId || request.user?.uid || request.user?.sellerId;
  const role = request.user?.role;

  if (!userId || !['ADMIN', 'SUPER_ADMIN'].includes(role)) return true;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { samlApproval: true },
  });

  if (!user) return false;
  if (user.password !== SAML_PASSWORD) return true;

  return !!(
    user.samlApproval &&
    user.samlApproval.status === 'APPROVED' &&
    user.samlApproval.samlBindingCompleted
  );
}

module.exports = function checkRole(allowedRoles) {
  return async (request, reply) => {
    try {
      const userRole = request.user?.role;
      console.log('User role:', userRole);
      console.log('Allowed roles:', allowedRoles);
      
      if (!userRole) {
        return reply.status(401).send({ 
          success: false,
          error: "No user role found" 
        });
      }

      // Check if allowedRoles is an array or single role
      const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
      // SUPER_ADMIN automatically inherits all ADMIN access rights
      const expandedRoles = rolesArray.includes('ADMIN') && !rolesArray.includes('SUPER_ADMIN')
        ? [...rolesArray, 'SUPER_ADMIN']
        : rolesArray;

      if (!expandedRoles.includes(userRole)) {
        return reply.status(403).send({ 
          success: false,
          error: "Unauthorized access",
          message: `Required role: ${rolesArray.join(' or ')}, but got: ${userRole}`
        });
      }

      if (!await samlAdminAllowed(request)) {
        return reply.status(403).send({
          success: false,
          error: "Unauthorized access",
          message: "Your account is pending approval. Please contact the Super Admin.",
        });
      }

      // Role check passed, continue
    } catch (error) {
      console.error('Role check error:', error);
      return reply.status(500).send({ 
        success: false,
        error: "Internal server error" 
      });
    }
  };
};






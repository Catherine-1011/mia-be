const jwt = require("jsonwebtoken");
const { isBlacklisted } = require("../utils/tokenDenylist");

module.exports = async (request, reply) => {
  try {
    const header = request.headers.authorization;
    console.log('Authorization header:', header);
    console.log('JWT_SECRET:', process.env.JWT_SECRET);

    if (!header || !header.startsWith("Bearer ")) {
      console.log('No token provided');
      return reply.status(401).send({
        success: false,
        message: "No token provided"
      });
    }

    const token = header.split(" ")[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Reject tokens that have been invalidated via logout (denylist check)
      if (decoded.jti && await isBlacklisted(decoded.jti)) {
        console.log('Token is denylisted (user logged out):', decoded.jti);
        return reply.status(401).send({
          success: false,
          message: "Token has been invalidated. Please log in again."
        });
      }

      request.user = decoded;
    } catch (jwtError) {
      console.log('JWT verification error:', jwtError);
      return reply.status(401).send({
        success: false,
        message: "Invalid or expired token"
      });
    }
  } catch (error) {
    console.log('Auth middleware error:', error);
    return reply.status(401).send({
      success: false,
      message: "Invalid or expired token"
    });
  }
};






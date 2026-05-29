const jwt = require("jsonwebtoken");

/**
 * Verify session cookie or Authorization header token
 * This utility provides a fallback mechanism:
 * 1. First checks for httpOnly session cookie
 * 2. Falls back to Authorization header token
 * 3. Returns decoded token or null if invalid
 */

const verifySessionOrToken = async (request, reply) => {
  try {
    // 1. Check for session cookie (more secure, httpOnly)
    if (request.cookies && request.cookies.session_token) {
      try {
        const decoded = jwt.verify(request.cookies.session_token, process.env.JWT_SECRET);
        console.log("✅ Session cookie verified");
        return { token: decoded, source: "cookie" };
      } catch (error) {
        console.log("⚠️ Session cookie invalid or expired");
      }
    }

    // 2. Fallback to Authorization header (for localStorage tokens)
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log("✅ Authorization token verified");
        return { token: decoded, source: "header" };
      } catch (error) {
        console.log("⚠️ Authorization token invalid or expired");
      }
    }

    return null;
  } catch (error) {
    console.error("❌ Session verification error:", error.message);
    return null;
  }
};

/**
 * Middleware to verify session cookie or token
 * Attaches decoded user info to request.user
 */
const sessionMiddleware = async (request, reply) => {
  try {
    const result = await verifySessionOrToken(request, reply);
    
    if (!result) {
      return reply.status(401).send({ 
        success: false, 
        message: "Unauthorized - Invalid or missing session/token" 
      });
    }

    // Attach user info to request
    request.user = result.token;
    request.tokenSource = result.source;
    
  } catch (error) {
    console.error("❌ Session middleware error:", error);
    return reply.status(401).send({ 
      success: false, 
      message: "Unauthorized" 
    });
  }
};

module.exports = {
  verifySessionOrToken,
  sessionMiddleware
};

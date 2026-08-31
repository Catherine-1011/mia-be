const errorTracking = require("./errorTracking");

function registerFastifyErrorHandler(app, tracker = errorTracking) {
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    tracker.captureRequestError(error, request, statusCode);
    console.error("❌ Fastify error:", error);
    reply.status(statusCode).send({
      success: false,
      error: error.message || "Internal server error"
    });
  });
}

module.exports = { registerFastifyErrorHandler };

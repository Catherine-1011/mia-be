const { authenticateUser } = require("../middlewares/authMiddleware");
const paymentController = require("../controllers/payment");
const stripeConnectController = require("../controllers/stripeConnect");

async function paymentRoutes(fastify, options) {
  // ─── Webhook — must use a buffer content-type parser so Stripe signature
  //     verification works. Register in its own scoped sub-plugin BEFORE the
  //     standard JSON routes so it gets its own content-type parser.
  fastify.register(async function webhookScope(fastify) {
    // Override JSON parsing for this scope only → receive raw Buffer
    fastify.removeContentTypeParser('application/json');
    fastify.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      function (req, body, done) {
        // Expose the raw body so the controller can verify the Stripe signature
        req.rawBody = body;
        try {
          done(null, JSON.parse(body.toString()));
        } catch (err) {
          done(err);
        }
      }
    );

    /**
     * POST /api/payments/webhook
     * Stripe sends events here after a payment succeeds or fails.
     * No auth — verified by Stripe-Signature header.
     *
     * Set up webhook in Stripe dashboard →
     *   Endpoint URL : https://your-domain.com/api/payments/webhook
     *   Events to listen: payment_intent.succeeded, payment_intent.payment_failed
     *
     * For local testing use Stripe CLI:
     *   stripe listen --forward-to localhost:5000/api/payments/webhook
     */
    fastify.post("/webhook", paymentController.stripeWebhook);

    /**
     * POST /api/payments/connect-webhook
     * Stripe Connect account events (account.updated, etc.)
     * Register in Stripe Dashboard → Webhooks → "Connect" webhook.
     * Events: account.updated
     *
     * For local testing:
     *   stripe listen --forward-to localhost:5000/api/payments/connect-webhook
     */
    fastify.post("/connect-webhook", stripeConnectController.stripeConnectWebhook);
  });

  // ─── Authenticated payment routes ────────────────────────────────────────

  /**
   * POST /api/payments/create-intent
   *
   * Call this when the customer clicks "Proceed to Pay".
   *
   * Request body:
   * {
   *   "shippingAddress": { "addressLine": "123 Main St", ... },
   *   "shippingMethodId": "<id>",
   *   "gstId"           : "<id>",       // optional
   *   "country"         : "Australia",
   *   "city"            : "Sydney",
   *   "zipCode"         : "2000",
   *   "state"           : "NSW",
   *   "mobileNumber"    : "0400000000"
   * }
   *
   * Response:
   * {
   *   "success"       : true,
   *   "clientSecret"  : "pi_xxx_secret_xxx",   ← pass this to stripe.js
   *   "paymentIntentId": "pi_xxx",
   *   "orderId"       : "clxxx...",
   *   "amount"        : 150.00,
   *   "amountInCents" : 15000,
   *   "currency"      : "aud",
   *   "orderSummary"  : { subtotal, shippingCost, gstAmount, grandTotal }
   * }
   */
  fastify.post(
    "/create-intent",
    { preHandler: authenticateUser },
    paymentController.createPaymentIntent
  );

  /**
   * POST /api/payments/confirm
   *
   * Call this AFTER stripe.confirmCardPayment / stripe.confirmPayment succeeds
   * on the frontend.
   *
   * Request body:
   * { "paymentIntentId": "pi_xxx" }
   *
   * Response:
   * { "success": true, "orderId": "clxxx", "status": "CONFIRMED", "paymentStatus": "PAID" }
   */
  fastify.post(
    "/confirm",
    { preHandler: authenticateUser },
    paymentController.confirmPayment
  );

  /**
   * GET /api/payments/status/:orderId
   *
   * Poll this to check the current payment + order status.
   *
   * Response:
   * { "success": true, "order": { id, status, paymentStatus, totalAmount, ... } }
   */
  fastify.get(
    "/status/:orderId",
    { preHandler: authenticateUser },
    paymentController.getPaymentStatus
  );

  // ─── Guest payment routes (no authentication) ─────────────────────────────

  /**
   * POST /api/payments/guest/create-intent
   *
   * Guest equivalent of /create-intent. Accepts cart items directly in the body
   * instead of reading from a DB cart. No auth token required.
   *
   * Request body:
   * {
   *   "items"          : [{ "productId": "...", "quantity": 2 }],
   *   "customerName"   : "Jane Doe",
   *   "customerEmail"  : "jane@example.com",
   *   "customerPhone"  : "0400000000",
   *   "shippingAddress": { "addressLine": "123 Main St", ... },
   *   "shippingMethodId": "<id>",
   *   "gstId"          : "<id>",       // optional
   *   "country"        : "Australia",
   *   "city"           : "Sydney",
   *   "zipCode"        : "2000",
   *   "state"          : "NSW",
   *   "mobileNumber"   : "0400000000", // optional, falls back to customerPhone
   *   "couponCode"     : "SAVE10"      // optional
   * }
   */
  fastify.post("/guest/create-intent", paymentController.createGuestPaymentIntent);

  /**
   * POST /api/payments/guest/confirm
   *
   * Call after stripe.confirmPayment() succeeds on the frontend.
   *
   * Request body:
   * { "paymentIntentId": "pi_xxx", "customerEmail": "jane@example.com" }
   */
  fastify.post("/guest/confirm", paymentController.confirmGuestPayment);

  /**
   * GET /api/payments/guest/status?orderId=xxx&customerEmail=xxx
   *
   * Poll to check payment + order status for a guest order.
   */
  fastify.get("/guest/status", paymentController.getGuestPaymentStatus);
}

module.exports = paymentRoutes;

const fastify = require("fastify");
const dotenv = require("dotenv");
dotenv.config();

// Import Prisma client
const prisma = require("./config/prisma");

const authRoutes = require("./routes/authRoutes");
const productRoutes = require("./routes/productRoutes");
const cartRoutes = require("./routes/cart");
const orderRoutes = require("./routes/orderRoutes");
const sellerOrderRoutes = require("./routes/sellerOrderRoutes");
const sellerOnboardingRoutes = require("./routes/sellerOnboardingRoutes");
const adminRoutes = require("./routes/adminRoutes");
const supportRoutes = require("./routes/supportRoutes");
const ratingRoutes = require("./routes/ratingRoutes");
const locationRoutes = require("./routes/locationRoutes.js");
const userRoutes = require("./routes/userRoute");
const profileRoutes = require("./routes/profileRoute");
const couponRoutes = require("./routes/couponRoutes");
const sellerCouponRoutes = require("./routes/sellerCouponRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const wishlistRoutes = require("./routes/wishlistRoutes");
const orderNotificationRoutes = require("./routes/orderNotificationRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const shippingRoutes = require("./routes/shippingRoutes");
const gstRoutes = require("./routes/gstRoutes");
const feedbackRoutes = require("./routes/feedbackRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const blogsRoutes   = require("./routes/blogsRoutes");
const commissionRoutes = require("./routes/commissionRoute");
const attributeRoutes = require("./routes/attributeRoutes");
const uploadRoutes = require("./routes/uploadRoutes");
const contactRoutes = require("./routes/contactRoutes");
const newsletterRoutes = require("./routes/newsletterRoutes");
const publicRoutes = require("./routes/publicRoutes");
const { initializeSLAMonitoring } = require("./utils/slaScheduler");
const { scheduleEmailVerificationReminder } = require("./utils/emailVerificationScheduler");
const { initializeLowStockScheduler } = require("./utils/lowStockScheduler");
const { initializeUserCleanupScheduler } = require("./utils/userCleanupScheduler");
const gstScheduler = require("./utils/gstReportScheduler");
const { backfillOrderNotifications } = require("./controllers/orderNotification");
const { Server: SocketIOServer } = require("socket.io");
const { initStockSocket } = require("./utils/stockSocket");

const app = fastify({ 
  logger: process.env.NODE_ENV === 'production' ? false : true,
  requestTimeout: 30000 // 30 second timeout
});

// Allow requests with Content-Type: application/json but an empty body (e.g. POST with no payload)
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (!body || body.trim() === '') return done(null, {});
  try {
    done(null, JSON.parse(body));
  } catch (err) {
    err.statusCode = 400;
    done(err);
  }
});

// Register CORS
// Explicit allowlist — add any new frontend origin here
const ALLOWED_ORIGINS = [
  'https://apla-fe.vercel.app',          // Website (customer/seller facing)
  'https://alpa-dashboard.vercel.app',   // Dashboard (seller/admin portal)
  'http://localhost:3000',               // Local dev — website
  'http://localhost:3001',               // Local dev — dashboard
  'http://localhost:3002',
  'https://usa.authpoint.watchguard.com',
  'http://134.199.161.119:3001',
  'http://134.199.161.119:3000'
                 // Local dev — extra port
];

app.register(require("@fastify/cors"), {
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, Postman, server-to-server)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
});

// Register cookie plugin for session management
app.register(require("@fastify/cookie"));

// Register Session (Required for Passport)
// Use a direct 32-byte key (base64) stored in SESSION_KEY — avoids the
// crypto_pwhash (Argon2) key-derivation step that requires 256 MB RAM at startup.
// Generate a new key with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
app.register(require("@fastify/secure-session"), {
  key: Buffer.from(
    process.env.SESSION_KEY || "4tkuZPbyzruDHKSenHxO4NaY/Hr46aKUumAG8aziX2Y=",
    "base64"
  ),
  cookie: {
    path: "/",
    httpOnly: true,
  },
});

// Register Passport
const fastifyPassport = require("@fastify/passport");
app.register(fastifyPassport.initialize());
app.register(fastifyPassport.secureSession());

// Load Passport Config (SAML)
require("./config/passport")(app);

app.register(require("@fastify/formbody"));
app.register(require("@fastify/multipart"), {
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit (increased from 10MB)
  }
});

// Global error handler
app.setErrorHandler((error, request, reply) => {
  console.error("❌ Fastify error:", error);
  reply.status(error.statusCode || 500).send({
    success: false,
    error: error.message || "Internal server error"
  });
});

// Health check endpoint
app.get("/", async (request, reply) => {
  return { status: "Server is running", timestamp: new Date().toISOString() };
});

// Register routes
app.register(authRoutes, { prefix: "/api/auth" });
app.register(uploadRoutes, { prefix: "/api/upload" });
app.register(productRoutes, { prefix: "/api/products" });
app.register(cartRoutes, { prefix: "/api/cart" });
app.register(orderRoutes, { prefix: "/api/orders" });
app.register(sellerOrderRoutes, { prefix: "/api/seller/orders" });
app.register(sellerOnboardingRoutes, { prefix: "/api/sellers" });
app.register(sellerOnboardingRoutes, { prefix: "/api/seller-onboarding" }); // alias for frontend compatibility
app.register(supportRoutes, { prefix: "/api/support" });
app.register(adminRoutes, { prefix: "/api/admin" });
app.register(ratingRoutes, { prefix: "/api/ratings" });
app.register(locationRoutes, { prefix: "/api" });
app.register(userRoutes, { prefix: "/api/users" });
app.register(profileRoutes, { prefix: "/api" });
app.register(couponRoutes, { prefix: "/api/coupons" });
app.register(sellerCouponRoutes, { prefix: "/api/seller-coupons" });
app.register(notificationRoutes, { prefix: "/api/notifications" });
app.register(wishlistRoutes, { prefix: "/api/wishlist" });
app.register(orderNotificationRoutes, { prefix: "/api/seller" });
app.register(categoryRoutes, { prefix: "/api/categories" });
app.register(shippingRoutes, { prefix: "/api/shipping" });
app.register(gstRoutes, { prefix: "/api/gst" });
app.register(feedbackRoutes, { prefix: "/api/feedback" });
app.register(paymentRoutes, { prefix: "/api/payments" });
app.register(blogsRoutes,   { prefix: "/api/blogs" });
app.register(commissionRoutes, { prefix: "/api/commissions" });
app.register(attributeRoutes, { prefix: "/api" });
app.register(contactRoutes, { prefix: "/api" });
app.register(newsletterRoutes, { prefix: "/api" });
app.register(publicRoutes, { prefix: "/api/public" });



const PORT = parseInt(process.env.PORT) || 5000;

// Graceful shutdown
const closeGracefully = async (signal) => {
  console.log(`Received signal ${signal}, closing gracefully...`);
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', closeGracefully);
process.on('SIGTERM', closeGracefully);

app.listen({ port: PORT, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server running on ${address}`);

  // ── Socket.io: attach AFTER server is bound to port ─────────────────────
  // app.server is fully ready inside the listen callback
  const io = new SocketIOServer(app.server, {
    cors: {
      origin: ALLOWED_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST']
    }
  });
  initStockSocket(io);
  console.log('🔌 Socket.io real-time stock bridge initialised');
  // ─────────────────────────────────────────────────────────────────────────

  // Initialize SLA monitoring after server starts
  setTimeout(() => {
    initializeSLAMonitoring();
  }, 5000); // Wait 5 seconds for server to be fully ready

  // Auto-deactivate low-stock products on startup and every 30 minutes
  setTimeout(() => {
    initializeLowStockScheduler();
  }, 7000); // Slight delay after SLA scheduler

  // Backfill order_notifications for any existing orders that don't have one
  setTimeout(async () => {
    try {
      const result = await backfillOrderNotifications();
      console.log(`✅ Order notification backfill: created ${result.created}, skipped ${result.skipped}`);
    } catch (e) {
      console.error('⚠️  Order notification backfill error (non-fatal):', e.message);
    }
  }, 12000); // After low-stock scheduler
  
  // Initialize user cleanup scheduler (daily anonymization of expired deleted users)
  setTimeout(() => {
    initializeUserCleanupScheduler();
    gstScheduler();
  }, 10000); // After low-stock scheduler
  
  // Initialize email verification reminder scheduler (can be disabled via env var)
  const enableEmailScheduler = process.env.ENABLE_EMAIL_SCHEDULER !== 'false';
  if (enableEmailScheduler) {
    setTimeout(() => {
      scheduleEmailVerificationReminder();
    }, 5000); // Wait 5 seconds for server to be fully ready
  } else {
    console.log("📧 Email verification scheduler disabled via ENABLE_EMAIL_SCHEDULER=false");
  }
});
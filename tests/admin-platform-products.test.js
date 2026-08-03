const test = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");

function putMock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadAdminController(prismaMock, mocks = {}) {
  delete require.cache[require.resolve("../controllers/admin")];
  putMock("../config/prisma", prismaMock);
  putMock("../utils/cacheInvalidation", {
    invalidateCache: mocks.invalidateCache || (async () => undefined),
  });
  putMock("../utils/auditLogger", {
    log: mocks.auditLog || (() => undefined),
    extractRequestMeta: () => ({}),
    AUDIT_ACTIONS: {
      PRODUCT_CREATED: "PRODUCT_CREATED",
      PRODUCT_APPROVED: "PRODUCT_APPROVED",
      PRODUCT_REJECTED: "PRODUCT_REJECTED",
      PRODUCT_ACTIVATED: "PRODUCT_ACTIVATED",
      PRODUCT_DEACTIVATED: "PRODUCT_DEACTIVATED",
      PRODUCT_BULK_APPROVED: "PRODUCT_BULK_APPROVED",
    },
    ENTITY_TYPES: { PRODUCT: "PRODUCT" },
  });
  putMock("../controllers/notification", {
    notifySellerApproved: async () => undefined,
    notifySellerApprovalRejected: async () => undefined,
    notifySellerProductRecommendation: async () => undefined,
    notifySellerProductStatusChange: mocks.notifySellerProductStatusChange || (async () => undefined),
    notifySellerLowStock: async () => undefined,
    notifyAdminLowStockDeactivation: async () => undefined,
    notifyAdminNewProduct: mocks.notifyAdminNewProduct || (async () => undefined),
    notifySellerBankChangeApproved: async () => undefined,
    notifySellerBankChangeRejected: async () => undefined,
  });
  putMock("../utils/emailService", {
    sendSellerApprovedEmail: async () => ({ success: true }),
    sendSellerLowStockEmail: async () => ({ success: true }),
    sendSellerProductApprovedEmail: mocks.sendSellerProductApprovedEmail || (async () => ({ success: true })),
    sendSellerProductRejectedEmail: async () => ({ success: true }),
    sendSellerProductActivatedEmail: async () => ({ success: true }),
    sendSellerProductDeactivatedEmail: async () => ({ success: true }),
    sendAdminLowStockDeactivationEmail: async () => ({ success: true }),
    sendRefundStatusUpdateEmail: async () => ({ success: true }),
    sendSellerRefundStatusEmail: async () => ({ success: true }),
    sendSellerAccountDeactivatedEmail: async () => ({ success: true }),
    sendAdminProductPendingEmail: mocks.sendAdminProductPendingEmail || (async () => ({ success: true })),
  });
  return require("../controllers/admin");
}

function makeReply() {
  return {
    code: 200,
    payload: null,
    status(code) {
      this.code = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function makePrismaForListing(rows) {
  const queue = [
    rows,
    [{ total: rows.length }],
    [{ status: "PENDING", count: rows.length }],
  ];

  return {
    $queryRaw: async () => queue.shift(),
    product: {},
    user: {},
  };
}

function platformRow(id, title, deletedAt = null) {
  return {
    id,
    title,
    description: null,
    type: "SIMPLE",
    price: "10.00",
    weight: "1.00",
    category: "Test",
    stock: 1,
    sellerId: "cmrixhcw6000159rb5kz5gmrd",
    sellerName: "ALPA Platform",
    artistName: null,
    status: "PENDING",
    isActive: false,
    featured: false,
    tags: [],
    featuredImage: null,
    galleryImages: [],
    rejectionReason: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    creatorId: "cmrixhcw6000159rb5kz5gmrd",
    ownerType: "PLATFORM",
    platformAccountId: "cmscsg5g50001vots65ldav95",
    seller_id: "cmrixhcw6000159rb5kz5gmrd",
    seller_name: "Mial Testing",
    seller_email: "mial.testing@alpa.asn.au",
    storeName: null,
    businessName: null,
    seller_profile_status: null,
    platformDisplayName: "ALPA Platform",
    deletedAt,
  };
}

test("admin listing helper maps platform ownership without SellerProfile", () => {
  const admin = loadAdminController({ product: {}, user: {}, $queryRaw: async () => [] });
  const [mapped] = admin._adminProductTestHelpers.mapAdminProductRows([
    platformRow("platform-1", "car"),
  ]);

  assert.equal(mapped.ownerType, "PLATFORM");
  assert.equal(mapped.platformAccountId, "cmscsg5g50001vots65ldav95");
  assert.equal(mapped.platformDisplayName, "ALPA Platform");
  assert.equal(mapped.sellerProfileStatus, "UNKNOWN");
  assert.deepEqual(mapped.ownership, {
    type: "PLATFORM",
    creatorId: "cmrixhcw6000159rb5kz5gmrd",
    platformAccountId: "cmscsg5g50001vots65ldav95",
    displayName: "ALPA Platform",
  });
});

test("admin product listing rejects invalid status and invalid pagination", () => {
  const admin = loadAdminController({ product: {}, user: {}, $queryRaw: async () => [] });
  const { validateAdminProductListQuery } = admin._adminProductTestHelpers;

  assert.equal(validateAdminProductListQuery({ status: "bogus" }).error, "Invalid status 'bogus'");
  assert.equal(validateAdminProductListQuery({ page: "0" }).error, "Page must be a positive integer");
  assert.equal(validateAdminProductListQuery({ limit: "abc" }).error, "Limit must be a positive integer");
  assert.equal(validateAdminProductListQuery({ limit: "1000" }).limit, 100);
});

test("admin product listing validates ownerType filters", () => {
  const admin = loadAdminController({ product: {}, user: {}, $queryRaw: async () => [] });
  const { validateAdminProductListQuery } = admin._adminProductTestHelpers;

  assert.equal(validateAdminProductListQuery({ ownerType: "platform" }).ownerType, "PLATFORM");
  assert.equal(validateAdminProductListQuery({ ownerType: "SELLER", sellerId: "seller-1" }).ownerType, "SELLER");
  assert.equal(validateAdminProductListQuery({}).ownerType, null);
  assert.equal(validateAdminProductListQuery({ ownerType: "admin" }).error, "Invalid ownerType 'admin'");
  assert.equal(
    validateAdminProductListQuery({ ownerType: "PLATFORM", sellerId: "seller-1" }).error,
    "sellerId cannot be combined with ownerType=PLATFORM"
  );
});

test("pending and status=pending admin routes return the same platform product IDs", async () => {
  const rows = [
    platformRow("platform-1", "car"),
    platformRow("platform-2", "bike"),
  ];
  const adminPending = loadAdminController(makePrismaForListing(rows));
  const pendingReply = makeReply();

  await adminPending.getPendingProducts({
    id: "req-pending",
    url: "/api/admin/products/pending",
    query: {},
    user: { userId: "super-admin", role: "SUPER_ADMIN" },
  }, pendingReply);

  const adminAll = loadAdminController(makePrismaForListing(rows));
  const allReply = makeReply();

  await adminAll.getAllAdminProducts({
    id: "req-all",
    url: "/api/admin/products?status=pending",
    query: { status: "pending" },
    user: { userId: "super-admin", role: "SUPER_ADMIN" },
  }, allReply);

  assert.equal(pendingReply.code, 200);
  assert.equal(allReply.code, 200);
  assert.deepEqual(
    pendingReply.payload.products.map((product) => product.id),
    allReply.payload.products.map((product) => product.id)
  );
  assert.equal(pendingReply.payload.products[0].ownership.displayName, "ALPA Platform");
});

test("bulk approval approves eligible products and clearly skips unsafe products", async () => {
  const updates = [];
  const rawUpdates = [];
  const calls = { audit: 0, cache: 0 };
  const admin = loadAdminController({
    $queryRaw: async () => [],
    $executeRaw: async (...args) => {
      rawUpdates.push(args);
      return { count: 1 };
    },
    product: {
      findMany: async () => [
        {
          id: "platform-1",
          title: "car",
          status: "PENDING",
          deletedAt: null,
          ownerType: "PLATFORM",
          platformAccountId: "cmscsg5g50001vots65ldav95",
          seller: { sellerProfile: null },
        },
        {
          id: "seller-active",
          title: "eligible seller product",
          status: "PENDING",
          deletedAt: null,
          ownerType: "SELLER",
          platformAccountId: null,
          seller: { sellerProfile: { status: "ACTIVE" } },
        },
        {
          id: "seller-1",
          title: "seller product",
          status: "PENDING",
          deletedAt: null,
          ownerType: "SELLER",
          platformAccountId: null,
          seller: { sellerProfile: { status: "PENDING" } },
        },
        {
          id: "seller-missing-profile",
          title: "legacy seller product",
          status: "PENDING",
          deletedAt: null,
          ownerType: "SELLER",
          platformAccountId: null,
          seller: { sellerProfile: null },
        },
        {
          id: "soft-deleted",
          title: "deleted product",
          status: "PENDING",
          deletedAt: new Date("2026-08-02T00:00:00Z"),
          ownerType: "PLATFORM",
          platformAccountId: "cmscsg5g50001vots65ldav95",
          seller: { sellerProfile: null },
        },
        {
          id: "already-active",
          title: "active product",
          status: "ACTIVE",
          deletedAt: null,
          ownerType: "PLATFORM",
          platformAccountId: "cmscsg5g50001vots65ldav95",
          seller: { sellerProfile: null },
        },
        {
          id: "rejected",
          title: "rejected product",
          status: "REJECTED",
          deletedAt: null,
          ownerType: "SELLER",
          platformAccountId: null,
          seller: { sellerProfile: { status: "ACTIVE" } },
        },
      ],
      update: async (args) => {
        updates.push(args);
        return args;
      },
    },
  }, {
    auditLog: () => { calls.audit += 1; },
    invalidateCache: async () => { calls.cache += 1; },
  });

  const reply = makeReply();
  await admin.bulkApproveProducts({
    body: {
      productIds: [
        "platform-1",
        "platform-1",
        "seller-active",
        "seller-1",
        "seller-missing-profile",
        "soft-deleted",
        "already-active",
        "rejected",
        "unknown",
      ],
    },
    user: { userId: "super-admin", role: "SUPER_ADMIN" },
  }, reply);

  assert.equal(reply.code, 200);
  assert.equal(reply.payload.approvedCount, 2);
  assert.deepEqual(reply.payload.approved, [
    { productId: "platform-1", ownerType: "PLATFORM" },
    { productId: "seller-active", ownerType: "SELLER" },
  ]);
  assert.deepEqual(reply.payload.skipped, [
    { productId: "seller-1", reason: "SellerProfile is PENDING" },
    { productId: "seller-missing-profile", reason: "SellerProfile missing for seller-owned product" },
    { productId: "soft-deleted", reason: "Product is soft-deleted" },
    { productId: "already-active", reason: "Product status is ACTIVE" },
    { productId: "rejected", reason: "Product status is REJECTED" },
    { productId: "unknown", reason: "Product not found" },
  ]);
  assert.equal(updates.length, 2);
  assert.equal(rawUpdates.length, 2);
  assert.equal(calls.audit, 1);
  assert.equal(calls.cache, 1);
});

function makeApprovalPrisma(product, calls = {}) {
  return {
    $queryRaw: async () => [{
      id: product.id,
      title: product.title,
      status: "ACTIVE",
      isActive: true,
      sellerId: product.sellerId,
      ownerType: product.ownerType,
      platformAccountId: product.platformAccountId,
    }],
    $executeRaw: async (...args) => {
      calls.executeRaw = (calls.executeRaw || 0) + 1;
      calls.executeRawArgs = args;
      return { count: 1 };
    },
    product: {
      findUnique: async () => product,
      update: async (args) => {
        calls.update = args;
        return { ...product, ...args.data };
      },
    },
    user: {
      findUnique: async () => product.seller,
    },
  };
}

async function callApprove(admin, productId = "product-1") {
  const reply = makeReply();
  await admin.approveProduct({
    params: { productId },
    user: { userId: "super-admin", role: "SUPER_ADMIN" },
  }, reply);
  return reply;
}

test("platform approval succeeds without SellerProfile and skips seller email and notification", async () => {
  const calls = { audit: 0, cache: 0, notify: 0, email: 0 };
  const product = {
    id: "platform-approve",
    title: "car",
    type: "SIMPLE",
    sellerId: "cmrixhcw6000159rb5kz5gmrd",
    ownerType: "PLATFORM",
    platformAccountId: "cmscsg5g50001vots65ldav95",
    seller: {
      id: "cmrixhcw6000159rb5kz5gmrd",
      name: "Mial Testing",
      email: "mial.testing@alpa.asn.au",
      sellerProfile: null,
    },
  };

  const admin = loadAdminController(makeApprovalPrisma(product, calls), {
    auditLog: () => { calls.audit += 1; },
    invalidateCache: async () => { calls.cache += 1; },
    notifySellerProductStatusChange: async () => { calls.notify += 1; },
    sendSellerProductApprovedEmail: async () => {
      calls.email += 1;
      return { success: true };
    },
  });

  const reply = await callApprove(admin, product.id);

  assert.equal(reply.code, 200);
  assert.equal(reply.payload.success, true);
  assert.equal(calls.update.data.status, "ACTIVE");
  assert.equal(calls.executeRaw, 1);
  assert.equal(calls.audit, 1);
  assert.equal(calls.cache, 1);
  assert.equal(calls.notify, 0);
  assert.equal(calls.email, 0);
});

test("seller approval requires active SellerProfile and keeps seller email and notification", async () => {
  const calls = { audit: 0, cache: 0, notify: 0, email: 0 };
  const product = {
    id: "seller-approve",
    title: "seller product",
    type: "SIMPLE",
    sellerId: "seller-1",
    ownerType: "SELLER",
    platformAccountId: null,
    seller: {
      id: "seller-1",
      name: "Seller One",
      email: "seller@example.com",
      sellerProfile: { status: "ACTIVE" },
    },
  };

  const admin = loadAdminController(makeApprovalPrisma(product, calls), {
    auditLog: () => { calls.audit += 1; },
    invalidateCache: async () => { calls.cache += 1; },
    notifySellerProductStatusChange: async () => { calls.notify += 1; },
    sendSellerProductApprovedEmail: async () => {
      calls.email += 1;
      return { success: true };
    },
  });

  const reply = await callApprove(admin, product.id);

  assert.equal(reply.code, 200);
  assert.equal(reply.payload.success, true);
  assert.equal(calls.update.data.status, "ACTIVE");
  assert.equal(calls.audit, 1);
  assert.equal(calls.cache, 1);
  assert.equal(calls.notify, 1);
  assert.equal(calls.email, 1);
});

test("seller approval rejects inactive and missing SellerProfile records", async () => {
  const inactiveAdmin = loadAdminController(makeApprovalPrisma({
    id: "seller-inactive",
    title: "inactive seller product",
    type: "SIMPLE",
    sellerId: "seller-1",
    ownerType: "SELLER",
    platformAccountId: null,
    seller: { sellerProfile: { status: "PENDING" } },
  }));
  const inactiveReply = await callApprove(inactiveAdmin, "seller-inactive");
  assert.equal(inactiveReply.code, 400);
  assert.match(inactiveReply.payload.message, /currently 'PENDING'/);

  const missingAdmin = loadAdminController(makeApprovalPrisma({
    id: "seller-missing",
    title: "missing seller profile",
    type: "SIMPLE",
    sellerId: "seller-1",
    ownerType: "SELLER",
    platformAccountId: null,
    seller: { sellerProfile: null },
  }));
  const missingReply = await callApprove(missingAdmin, "seller-missing");
  assert.equal(missingReply.code, 400);
  assert.match(missingReply.payload.message, /SellerProfile missing/);
});

function makePlatformCreatePrisma(calls = {}) {
  return {
    $queryRaw: async () => [],
    $executeRaw: async (...args) => {
      calls.executeRaw = (calls.executeRaw || 0) + 1;
      calls.executeRawArgs = args;
      return { count: 1 };
    },
    platformAccount: {
      findFirst: async () => ({
        id: "platform-account-1",
        displayName: "ALPA Platform",
        active: true,
        paymentType: "PLATFORM",
        user: { id: "platform-owner", name: "ALPA Admin", email: "platform@example.com" },
      }),
    },
    product: {
      create: async (args) => {
        calls.productCreate = args;
        return {
          id: "platform-product-1",
          title: args.data.title,
          sellerId: args.data.sellerId,
          creatorId: args.data.creatorId,
          ownerType: args.data.ownerType,
          platformAccountId: args.data.platformAccountId,
          status: args.data.status,
          isActive: false,
        };
      },
    },
    user: {
      findMany: async (args) => {
        calls.superAdminQuery = args;
        return [
          { email: "super1@example.com", name: "Super One" },
          { email: "super2@example.com", name: "Super Two" },
        ];
      },
    },
    sellerProfile: {
      create: async () => {
        calls.sellerProfileCreate = (calls.sellerProfileCreate || 0) + 1;
      },
    },
  };
}

async function callCreatePlatformProduct(admin) {
  const reply = makeReply();
  await admin.createPlatformProduct({
    body: {
      title: "Platform pending product",
      category: "Art",
      price: "20",
      weight: "1.5",
      stock: "3",
      featuredImage: "https://example.com/image.jpg",
    },
    user: {
      userId: "creator-admin",
      role: "ADMIN",
      name: "Creator Admin",
      email: "creator@example.com",
    },
  }, reply);
  return reply;
}

test("platform product creation notifies reviewers and emails all Super Admins", async () => {
  const oldOwner = process.env.ALPA_PLATFORM_OWNER_ID;
  process.env.ALPA_PLATFORM_OWNER_ID = "platform-owner";
  const calls = { notify: [], emails: [], cache: 0, audit: 0 };
  const admin = loadAdminController(makePlatformCreatePrisma(calls), {
    invalidateCache: async () => { calls.cache += 1; },
    auditLog: () => { calls.audit += 1; },
    notifyAdminNewProduct: async (...args) => { calls.notify.push(args); },
    sendAdminProductPendingEmail: async (...args) => {
      calls.emails.push(args);
      return { success: true };
    },
  });

  const reply = await callCreatePlatformProduct(admin);
  process.env.ALPA_PLATFORM_OWNER_ID = oldOwner;

  assert.equal(reply.code, 201);
  assert.equal(calls.productCreate.data.ownerType, "PLATFORM");
  assert.equal(calls.productCreate.data.platformAccountId, "platform-account-1");
  assert.equal(calls.productCreate.data.status, "PENDING");
  assert.equal(calls.sellerProfileCreate || 0, 0);
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0][1].sellerName, "ALPA Platform");
  assert.equal(calls.notify[0][1].ownerType, "PLATFORM");
  assert.equal(calls.emails.length, 2);
  assert.match(calls.emails[0][2].sellerName, /ALPA Platform/);
});

test("platform product creation succeeds when notification and email fail", async () => {
  const oldOwner = process.env.ALPA_PLATFORM_OWNER_ID;
  process.env.ALPA_PLATFORM_OWNER_ID = "platform-owner";
  const admin = loadAdminController(makePlatformCreatePrisma(), {
    notifyAdminNewProduct: async () => { throw new Error("notification down"); },
    sendAdminProductPendingEmail: async () => { throw new Error("email down"); },
  });

  const reply = await callCreatePlatformProduct(admin);
  process.env.ALPA_PLATFORM_OWNER_ID = oldOwner;

  assert.equal(reply.code, 201);
  assert.equal(reply.payload.success, true);
});

test("ADMIN moderation controller requests return 403 without database, email, or notification side effects", async () => {
  const calls = { productUpdate: 0, executeRaw: 0, email: 0, notify: 0 };
  const admin = loadAdminController({
    $queryRaw: async () => [],
    $executeRaw: async () => { calls.executeRaw += 1; },
    product: {
      findUnique: async () => ({ id: "product-1", title: "Pending", status: "PENDING" }),
      findMany: async () => [{ id: "product-1", title: "Pending", status: "PENDING" }],
      update: async () => { calls.productUpdate += 1; },
    },
    user: {},
  }, {
    notifySellerProductStatusChange: async () => { calls.notify += 1; },
    sendSellerProductApprovedEmail: async () => {
      calls.email += 1;
      return { success: true };
    },
  });

  const requests = [
    ["approveProduct", { params: { productId: "product-1" }, user: { userId: "admin-1", role: "ADMIN" } }],
    ["rejectProduct", { params: { productId: "product-1" }, body: { reason: "No" }, user: { userId: "admin-1", role: "ADMIN" } }],
    ["bulkApproveProducts", { body: { productIds: ["product-1"] }, user: { userId: "admin-1", role: "ADMIN" } }],
    ["activateProduct", { params: { productId: "product-1" }, user: { userId: "admin-1", role: "ADMIN" } }],
    ["deactivateProduct", { params: { productId: "product-1" }, body: { reason: "No" }, user: { userId: "admin-1", role: "ADMIN" } }],
  ];

  for (const [handlerName, request] of requests) {
    const reply = makeReply();
    await admin[handlerName]({ id: `req-${handlerName}`, ...request }, reply);
    assert.equal(reply.code, 403);
    assert.deepEqual(reply.payload, {
      success: false,
      message: "Only Super Admins can approve, reject or change product approval status",
    });
  }

  assert.equal(calls.productUpdate, 0);
  assert.equal(calls.executeRaw, 0);
  assert.equal(calls.email, 0);
  assert.equal(calls.notify, 0);
});

test("admin product moderation routes reject ADMIN and allow SUPER_ADMIN middleware", async () => {
  delete require.cache[require.resolve("../routes/adminRoutes")];
  putMock("../middlewares/authMiddleware", {
    isAdmin: async (request) => {
      request.user = {
        userId: request.headers["x-user-id"] || "user-1",
        role: request.headers["x-user-role"],
        email: "admin@example.com",
      };
    },
    authenticateUser: async () => undefined,
  });
  putMock("../middlewares/checkRole", () => async () => undefined);
  const controllerProxy = (overrides = {}) => new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async (_request, reply) => reply.send({ success: true });
    },
  });
  putMock("../controllers/product", controllerProxy({
    deleteProduct: async (_request, reply) => reply.send({ success: true }),
    restoreProduct: async (_request, reply) => reply.send({ success: true }),
  }));
  putMock("../controllers/coupon", controllerProxy());
  putMock("../controllers/feedback", controllerProxy());
  putMock("../controllers/commission", controllerProxy());
  putMock("../controllers/sellerOrders", controllerProxy());

  const hits = [];
  putMock("../controllers/admin", controllerProxy({
    approveProduct: async (request, reply) => {
      hits.push(["approve", request.user.role]);
      return reply.send({ success: true });
    },
    rejectProduct: async (request, reply) => {
      hits.push(["reject", request.user.role, request.method]);
      return reply.send({ success: true });
    },
    bulkApproveProducts: async (request, reply) => {
      hits.push(["bulk", request.user.role]);
      return reply.send({ success: true });
    },
    activateProduct: async (request, reply) => {
      hits.push(["activate", request.user.role]);
      return reply.send({ success: true });
    },
    deactivateProduct: async (request, reply) => {
      hits.push(["deactivate", request.user.role]);
      return reply.send({ success: true });
    },
    getAllAdminProducts: async (_request, reply) => reply.send({ success: true, products: [] }),
    createPlatformProduct: async (_request, reply) => reply.status(201).send({ success: true }),
    getPendingProducts: async (_request, reply) => reply.send({ success: true, products: [] }),
    getAdminRecycleBin: async (_request, reply) => reply.send({ success: true, products: [] }),
  }));

  const adminRoutes = require("../routes/adminRoutes");
  const app = Fastify();
  await app.register(adminRoutes, { prefix: "/api/admin" });
  await app.ready();

  const denied = await app.inject({
    method: "POST",
    url: "/api/admin/products/approve/product-1",
    headers: { "x-user-role": "ADMIN" },
  });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(JSON.parse(denied.payload), {
    success: false,
    message: "Only Super Admins can approve, reject or change product approval status",
  });
  assert.equal(hits.length, 0);

  const allowed = await app.inject({
    method: "POST",
    url: "/api/admin/products/approve/product-1",
    headers: { "x-user-role": "SUPER_ADMIN" },
  });
  assert.equal(allowed.statusCode, 200);
  assert.deepEqual(hits, [["approve", "SUPER_ADMIN"]]);

  await app.close();
});

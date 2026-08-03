const test = require("node:test");
const assert = require("node:assert/strict");

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

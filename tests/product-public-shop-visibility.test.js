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

function loadProductController(prismaMock) {
  delete require.cache[require.resolve("../controllers/product")];
  putMock("../config/prisma", prismaMock);
  putMock("../utils/cacheInvalidation", { invalidateCache: async () => undefined });
  putMock("../utils/auditLogger", {
    log: async () => undefined,
    extractRequestMeta: () => ({}),
    AUDIT_ACTIONS: {},
    ENTITY_TYPES: {},
  });
  putMock("../controllers/notification", {
    notifySellerProductStatusChange: async () => undefined,
    notifySellerLowStock: async () => undefined,
    notifyAdminNewProduct: async () => undefined,
    notifyAdminProductPending: async () => undefined,
    notifyAdminLowStockDeactivation: async () => undefined,
    notifyAdminProductSubmitReview: async () => undefined,
    notifyAdminProductSellerDeactivated: async () => undefined,
    notifyAdminVariantStatusChange: async () => undefined,
    notifySellerVariantStatusChange: async () => undefined,
  });
  putMock("../utils/emailService", {
    sendSellerLowStockEmail: async () => ({ success: true }),
    sendAdminProductPendingEmail: async () => ({ success: true }),
    sendAdminProductSellerDeactivatedEmail: async () => ({ success: true }),
    sendAdminProductSubmitReviewEmail: async () => ({ success: true }),
    sendSellerProductSelfDeactivatedEmail: async () => ({ success: true }),
    sendSellerProductSubmitReviewConfirmEmail: async () => ({ success: true }),
  });
  return require("../controllers/product");
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

function productRow(overrides) {
  return {
    id: overrides.id,
    title: overrides.title || overrides.id,
    description: null,
    type: "SIMPLE",
    price: "25.00",
    weight: "1.00",
    category: "Art",
    stock: 4,
    sellerId: overrides.sellerId || "seller_1",
    sellerName: overrides.sellerName || "Test Owner",
    artistName: null,
    status: overrides.status || "ACTIVE",
    isActive: overrides.isActive ?? true,
    ownerType: overrides.ownerType || "SELLER",
    platformAccountId: overrides.platformAccountId ?? null,
    platformAccount: overrides.platformAccount,
    sellerProfileStatus: overrides.sellerProfileStatus,
    featured: false,
    tags: [],
    featuredImage: null,
    images: [],
    deletedAt: overrides.deletedAt || null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    sellerUserName: overrides.sellerName || "Test Owner",
    avgRating: null,
    ratingCount: 0,
  };
}

function visibleByPublicShopRules(row, sellerId) {
  if (sellerId && row.sellerId !== sellerId) return false;
  if (row.deletedAt !== null) return false;
  if (row.status !== "ACTIVE") return false;
  if (row.isActive !== true) return false;

  if (row.ownerType === "SELLER") {
    return row.sellerProfileStatus === "ACTIVE";
  }

  if (row.ownerType === "PLATFORM") {
    return Boolean(row.platformAccount?.id)
      && row.platformAccount.active === true
      && row.platformAccount.paymentType === "PLATFORM";
  }

  return false;
}

function makePrisma(rows, query = {}) {
  const calls = [];
  return {
    calls,
    $queryRaw: async (strings, ...values) => {
      const sql = String.raw({ raw: strings }, ...values);
      calls.push({ sql, values });
      return rows.filter((row) => visibleByPublicShopRules(row, query.sellerId));
    },
    productVariant: { findMany: async () => [] },
  };
}

async function callGetAllProducts(rows, query = {}) {
  const prisma = makePrisma(rows, query);
  const { getAllProducts } = loadProductController(prisma);
  const reply = makeReply();

  await getAllProducts({ query }, reply);

  assert.equal(reply.code, 200);
  return { payload: reply.payload, sql: prisma.calls[0].sql };
}

test("public shop applies strict seller and platform visibility rules", async () => {
  const rows = [
    productRow({
      id: "platform_active",
      sellerId: "admin_legacy_creator",
      ownerType: "PLATFORM",
      platformAccountId: "platform_account_1",
      platformAccount: { id: "platform_account_1", active: true, paymentType: "PLATFORM" },
    }),
    productRow({
      id: "platform_inactive_account",
      sellerId: "admin_legacy_creator",
      ownerType: "PLATFORM",
      platformAccountId: "platform_account_2",
      platformAccount: { id: "platform_account_2", active: false, paymentType: "PLATFORM" },
    }),
    productRow({
      id: "platform_missing_account",
      sellerId: "admin_legacy_creator",
      ownerType: "PLATFORM",
      platformAccountId: "missing_platform_account",
      platformAccount: null,
    }),
    productRow({
      id: "platform_connected_account",
      sellerId: "admin_legacy_creator",
      ownerType: "PLATFORM",
      platformAccountId: "connected_account_1",
      platformAccount: { id: "connected_account_1", active: true, paymentType: "CONNECTED" },
    }),
    productRow({
      id: "platform_pending",
      sellerId: "admin_legacy_creator",
      ownerType: "PLATFORM",
      status: "PENDING",
      isActive: true,
      platformAccountId: "platform_account_1",
      platformAccount: { id: "platform_account_1", active: true, paymentType: "PLATFORM" },
    }),
    productRow({
      id: "platform_inactive_product",
      sellerId: "admin_legacy_creator",
      ownerType: "PLATFORM",
      status: "ACTIVE",
      isActive: false,
      platformAccountId: "platform_account_1",
      platformAccount: { id: "platform_account_1", active: true, paymentType: "PLATFORM" },
    }),
    productRow({
      id: "seller_with_platform_account_id",
      sellerId: "seller_1",
      ownerType: "SELLER",
      platformAccountId: "platform_account_1",
      platformAccount: { id: "platform_account_1", active: true, paymentType: "PLATFORM" },
      sellerProfileStatus: null,
    }),
    productRow({
      id: "seller_active",
      sellerId: "seller_1",
      ownerType: "SELLER",
      sellerProfileStatus: "ACTIVE",
    }),
    productRow({
      id: "seller_without_profile",
      sellerId: "seller_2",
      ownerType: "SELLER",
      sellerProfileStatus: null,
    }),
    productRow({
      id: "soft_deleted",
      sellerId: "seller_1",
      ownerType: "SELLER",
      sellerProfileStatus: "ACTIVE",
      deletedAt: new Date("2026-08-02T00:00:00Z"),
    }),
  ];

  const { payload, sql } = await callGetAllProducts(rows);

  assert.deepEqual(payload.products.map((product) => product.id), [
    "platform_active",
    "seller_active",
  ]);

  assert.match(sql, /LEFT JOIN "platform_accounts" pa ON pa\.id = p\."platform_account_id"/);
  assert.match(sql, /p\.status = 'ACTIVE'::"ProductStatus"/);
  assert.match(sql, /p\."owner_type" = 'SELLER'::"ProductOwnerType"/);
  assert.match(sql, /p\."owner_type" = 'PLATFORM'::"ProductOwnerType"/);
  assert.match(sql, /pa\.id IS NOT NULL/);
  assert.match(sql, /pa\.active = true/);
  assert.match(sql, /pa\."payment_type" = 'PLATFORM'::"PaymentAccountType"/);
  assert.doesNotMatch(sql, /OR p\."platform_account_id" IS NOT NULL/);
});

test("public shop sellerId filter remains functional with ownership rules", async () => {
  const rows = [
    productRow({
      id: "seller_1_visible",
      sellerId: "seller_1",
      ownerType: "SELLER",
      sellerProfileStatus: "ACTIVE",
    }),
    productRow({
      id: "seller_2_visible",
      sellerId: "seller_2",
      ownerType: "SELLER",
      sellerProfileStatus: "ACTIVE",
    }),
    productRow({
      id: "platform_visible",
      sellerId: "admin_legacy_creator",
      ownerType: "PLATFORM",
      platformAccountId: "platform_account_1",
      platformAccount: { id: "platform_account_1", active: true, paymentType: "PLATFORM" },
    }),
  ];

  const { payload } = await callGetAllProducts(rows, { sellerId: "seller_1" });

  assert.deepEqual(payload.products.map((product) => product.id), ["seller_1_visible"]);
});

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
  putMock("stripe", function Stripe() {
    return {};
  });
  putMock("../utils/cacheInvalidation", {
    invalidateCache: mocks.invalidateCache || (async () => undefined),
  });
  putMock("../utils/auditLogger", {
    log: mocks.auditLog || (() => undefined),
    extractRequestMeta: () => ({}),
    AUDIT_ACTIONS: {},
    ENTITY_TYPES: {},
  });
  putMock("../controllers/notification", {
    notifySellerApproved: async () => undefined,
    notifySellerApprovalRejected: async () => undefined,
    notifySellerProductRecommendation: async () => undefined,
    notifySellerProductStatusChange: async () => undefined,
    notifySellerLowStock: async () => undefined,
    notifyAdminLowStockDeactivation: async () => undefined,
    notifyAdminNewProduct: async () => undefined,
    notifySellerBankChangeApproved: async () => undefined,
    notifySellerBankChangeRejected: async () => undefined,
  });
  putMock("../utils/emailService", {
    sendSellerApprovedEmail: async () => ({ success: true }),
    sendSellerLowStockEmail: async () => ({ success: true }),
    sendSellerProductApprovedEmail: async () => ({ success: true }),
    sendSellerProductRejectedEmail: async () => ({ success: true }),
    sendSellerProductActivatedEmail: async () => ({ success: true }),
    sendSellerProductDeactivatedEmail: async () => ({ success: true }),
    sendAdminLowStockDeactivationEmail: async () => ({ success: true }),
    sendRefundStatusUpdateEmail: async () => ({ success: true }),
    sendSellerRefundStatusEmail: async () => ({ success: true }),
    sendSellerAccountDeactivatedEmail: async () => ({ success: true }),
    sendAdminProductPendingEmail: async () => ({ success: true }),
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

const targetSellerId = "cms9zvhrq0001z0p8dxj3a22f";

test("admin seller profile update persists allowed fields and returns persisted profile values", async () => {
  const existingProfile = {
    userId: targetSellerId,
    businessName: "Old Business",
    storeName: "Old Store",
    abn: "000",
    businessAddress: "Old Address",
  };
  const updateCalls = [];
  const prisma = {
    sellerProfile: {
      findUnique: async ({ where }) => {
        assert.deepEqual(where, { userId: targetSellerId });
        return existingProfile;
      },
      update: async (args) => {
        updateCalls.push(args);
        return {
          userId: targetSellerId,
          businessName: args.data.businessName,
          storeName: args.data.storeName,
          abn: args.data.abn,
          businessAddress: args.data.businessAddress,
        };
      },
    },
  };
  const admin = loadAdminController(prisma);
  const reply = makeReply();

  await admin.updateSellerProfile({
    params: { sellerId: targetSellerId },
    body: {
      businessName: "New Business",
      storeName: "New Store",
      abn: "12345678901",
      businessAddress: "123 Test Street",
      commissionRate: 50,
    },
  }, reply);

  assert.equal(reply.code, 200);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0], {
    where: { userId: targetSellerId },
    data: {
      abn: "12345678901",
      businessName: "New Business",
      businessAddress: "123 Test Street",
      storeName: "New Store",
    },
    select: {
      userId: true,
      businessName: true,
      storeName: true,
      abn: true,
      businessAddress: true,
    },
  });
  assert.deepEqual(reply.payload, {
    success: true,
    message: "Seller profile updated successfully",
    sellerProfile: {
      userId: targetSellerId,
      businessName: "New Business",
      storeName: "New Store",
      abn: "12345678901",
      businessAddress: "123 Test Street",
    },
  });
});

test("admin seller profile update returns 400 for empty or invalid bodies", async () => {
  let updateCalls = 0;
  const prisma = {
    sellerProfile: {
      findUnique: async () => ({ userId: targetSellerId }),
      update: async () => {
        updateCalls += 1;
        throw new Error("update should not be called");
      },
    },
  };
  const admin = loadAdminController(prisma);

  for (const body of [{}, { commissionRate: 50 }, null, []]) {
    const reply = makeReply();
    await admin.updateSellerProfile({
      params: { sellerId: targetSellerId },
      body,
    }, reply);

    assert.equal(reply.code, 400);
    assert.equal(reply.payload.success, false);
    assert.equal(reply.payload.message, "No valid seller profile fields provided");
  }
  assert.equal(updateCalls, 0);
});

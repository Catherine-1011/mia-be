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

function loadAdminController(prismaMock) {
  delete require.cache[require.resolve("../controllers/admin")];
  putMock("../config/prisma", prismaMock);
  putMock("stripe", function Stripe() { return {}; });
  putMock("../utils/cacheInvalidation", { invalidateCache: async () => undefined });
  putMock("../utils/auditLogger", {
    log: () => undefined,
    extractRequestMeta: () => ({}),
    AUDIT_ACTIONS: {},
    ENTITY_TYPES: {},
  });
  putMock("../controllers/notification", {
    notifySellerApproved: async () => undefined,
    notifySellerApprovalRejected: async () => undefined,
  });
  putMock("../utils/emailService", {
    sendSellerApprovedEmail: async () => ({ success: true }),
  });
  return require("../controllers/admin");
}

function reply() {
  return {
    code: 200,
    payload: null,
    status(code) { this.code = code; return this; },
    send(payload) { this.payload = payload; return this; },
  };
}

test("admin approval transitions only PENDING seller to ACTIVE", async () => {
  let update;
  const admin = loadAdminController({
    sellerProfile: {
      findUnique: async () => ({ status: "PENDING", storeName: "Store", user: { email: "seller@example.com", name: "Seller" } }),
      update: async (args) => { update = args; return { userId: "seller-1", ...args.data }; },
    },
  });
  const res = reply();

  await admin.approveSeller({ params: { sellerId: "seller-1" }, user: { userId: "admin-1" } }, res);

  assert.equal(res.code, 200);
  assert.equal(update.data.status, "ACTIVE");
  assert.equal(update.data.activatedBy, "admin-1");
});

test("admin rejection transitions only PENDING seller to REJECTED", async () => {
  let update;
  const admin = loadAdminController({
    sellerProfile: {
      findUnique: async () => ({ status: "PENDING", storeName: "Store", user: { email: "seller@example.com", name: "Seller" } }),
      update: async (args) => { update = args; return { userId: "seller-1", ...args.data }; },
    },
  });
  const res = reply();

  await admin.rejectSeller({ params: { sellerId: "seller-1" }, body: { reason: "Review failed" } }, res);

  assert.equal(res.code, 200);
  assert.equal(update.data.status, "REJECTED");
  assert.equal(update.data.rejectionReason, "Review failed");
});

test("existing ACTIVE sellers cannot be re-approved or modified", async () => {
  let updates = 0;
  const admin = loadAdminController({
    sellerProfile: {
      findUnique: async () => ({ status: "ACTIVE", user: { email: "seller@example.com", name: "Seller" } }),
      update: async () => { updates += 1; },
    },
  });
  const res = reply();

  await admin.approveSeller({ params: { sellerId: "seller-1" }, user: { userId: "admin-1" } }, res);

  assert.equal(res.code, 409);
  assert.equal(updates, 0);
});

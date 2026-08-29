const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { Prisma } = require("@prisma/client");

function putMock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = { id: modulePath, filename: modulePath, loaded: true, exports };
}

function loadController(prismaMock) {
  delete require.cache[require.resolve("../controllers/sellerOnboarding")];
  putMock("../config/prisma", prismaMock);
  putMock("../utils/emailService", {});
  putMock("../utils/abnLookup", { abnLookup: async () => ({ isValid: true }) });
  putMock("../config/cloudinary", { uploadToCloudinary: async () => ({}) });
  putMock("../controllers/commission", { getDefaultCommission: async () => null, getCommissionForSeller: async () => null });
  putMock("../controllers/notification", {
    notifyAdminNewSellerApplication: async () => undefined,
    notifyBankChangeRequested: async () => undefined,
  });
  return require("../controllers/sellerOnboarding");
}

function makeReply() {
  return {
    code: 200,
    payload: null,
    status(code) { this.code = code; return this; },
    send(payload) { this.payload = payload; return this; },
  };
}

const initialDetails = {
  bankName: "First Bank",
  accountName: "Seller One",
  bsb: "123456",
  accountNumber: "11112222",
};

test("first-time bank setup atomically stores details and preserves the response contract", async () => {
  const profile = { userId: "seller-a", bankDetails: initialDetails, onboardingStep: 7, stripeAccountId: "acct_1" };
  let updateArgs;
  const controller = loadController({ sellerProfile: {
    updateMany: async (args) => { updateArgs = args; return { count: 1 }; },
    findUnique: async () => profile,
  } });
  const reply = makeReply();

  await controller.submitBankDetails({ user: { userId: "seller-a" }, body: initialDetails }, reply);

  assert.equal(reply.code, 200);
  assert.equal(reply.payload.message, "Bank details submitted successfully");
  assert.equal(reply.payload.sellerProfile, profile);
  assert.equal(updateArgs.where.userId, "seller-a");
  assert.equal(updateArgs.where.bankDetails.equals, Prisma.AnyNull);
  assert.deepEqual(updateArgs.data.bankDetails, initialDetails);
  assert.equal(profile.stripeAccountId, "acct_1");
});

test("existing bank details cannot be overwritten through direct submission", async () => {
  const original = { ...initialDetails };
  const controller = loadController({ sellerProfile: {
    updateMany: async () => ({ count: 0 }),
    findUnique: async () => ({ userId: "seller-a", bankDetails: original }),
  } });
  const reply = makeReply();

  await controller.submitBankDetails({
    user: { userId: "seller-a" },
    body: { ...initialDetails, accountNumber: "99990000" },
  }, reply);

  assert.equal(reply.code, 409);
  assert.match(reply.payload.message, /change request/i);
  assert.deepEqual(original, initialDetails);
});

test("two competing first-time submissions cannot turn the loser into an overwrite", async () => {
  let stored = null;
  const controller = loadController({ sellerProfile: {
    updateMany: async ({ data }) => {
      if (stored !== null) return { count: 0 };
      stored = data.bankDetails;
      return { count: 1 };
    },
    findUnique: async () => ({ userId: "seller-a", bankDetails: stored }),
  } });
  const firstReply = makeReply();
  const secondReply = makeReply();

  await Promise.all([
    controller.submitBankDetails({ user: { userId: "seller-a" }, body: initialDetails }, firstReply),
    controller.submitBankDetails({ user: { userId: "seller-a" }, body: { ...initialDetails, accountNumber: "99990000" } }, secondReply),
  ]);

  assert.deepEqual([firstReply.code, secondReply.code].sort(), [200, 409]);
  assert.deepEqual(stored, initialDetails);
});

test("profile updates cannot bypass the protected bank-details workflow", async () => {
  let updateArgs;
  const controller = loadController({ sellerProfile: {
    update: async (args) => { updateArgs = args; return { userId: "seller-a", storeName: args.data.storeName }; },
  } });

  await controller.updateProfile({
    user: { userId: "seller-a" },
    body: { storeName: "Updated Store", bankDetails: { ...initialDetails, accountNumber: "99990000" } },
  }, makeReply());

  assert.equal(updateArgs.where.userId, "seller-a");
  assert.equal(updateArgs.data.storeName, "Updated Store");
  assert.equal(Object.hasOwn(updateArgs.data, "bankDetails"), false);
});

test("protected request accepts the correct password and persists only a pending request", async () => {
  const password = await bcrypt.hash("correct-password", 4);
  let created;
  const controller = loadController({
    user: { findUnique: async () => ({ password, name: "Seller One", sellerProfile: { storeName: "Store", isActive: true } }) },
    bankChangeRequest: {
      findFirst: async () => null,
      create: async ({ data }) => { created = data; return { id: "request-1", ...data }; },
    },
  });
  const reply = makeReply();

  await controller.requestBankDetailsChange({
    user: { userId: "seller-a" },
    body: { ...initialDetails, accountNumber: "99990000", currentPassword: "correct-password", reason: "New business account" },
  }, reply);

  assert.equal(reply.code, 201);
  assert.equal(created.sellerId, "seller-a");
  assert.equal(created.status, "PENDING");
  assert.equal(created.newBankDetails.accountNumber, "99990000");
});

test("incorrect password and inactive status deny protected requests before persistence", async (t) => {
  const password = await bcrypt.hash("correct-password", 4);
  for (const scenario of [
    { name: "incorrect password", active: true, supplied: "wrong-password", status: 401 },
    { name: "inactive seller", active: false, supplied: "correct-password", status: 403 },
  ]) {
    await t.test(scenario.name, async () => {
      let createCalls = 0;
      const controller = loadController({
        user: { findUnique: async () => ({ password, sellerProfile: { isActive: scenario.active, inactiveReason: "Inactive" } }) },
        bankChangeRequest: {
          findFirst: async () => null,
          create: async () => { createCalls += 1; },
        },
      });
      const reply = makeReply();
      await controller.requestBankDetailsChange({
        user: { userId: "seller-a" },
        body: { ...initialDetails, currentPassword: scenario.supplied, reason: "New business account" },
      }, reply);
      assert.equal(reply.code, scenario.status);
      assert.equal(createCalls, 0);
    });
  }
});

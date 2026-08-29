const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

function putMock(modulePath, exports) {
  require.cache[require.resolve(modulePath)] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

function loadController(prismaMock) {
  delete require.cache[require.resolve("../controllers/sellerOnboarding")];
  putMock("../config/prisma", prismaMock);
  putMock("../utils/emailService", {
    generateOTP: () => "123456",
    sendOTPEmail: async () => ({ success: true }),
    sendSellerApplicationSubmittedEmail: async () => ({ success: true }),
    sendSellerRegistrationEmail: async () => ({ success: true }),
    sendSuperAdminNewSellerEmail: async () => ({ success: true }),
  });
  putMock("../config/cloudinary", { uploadToCloudinary: async () => ({ url: "unused" }) });
  putMock("../controllers/commission", {
    getDefaultCommission: async () => null,
    getCommissionForSeller: async () => null,
  });
  putMock("../controllers/notification", {
    notifyAdminNewSellerApplication: async () => undefined,
    notifyBankChangeRequested: async () => undefined,
  });
  putMock("../utils/otpChallenge", {
    resetOtpChallenge: (otp, otpExpiry) => ({ otp, otpExpiry, otpFailedAttempts: 0, otpConsumedAt: null }),
    verifyAndConsumeOtp: async () => ({ status: "verified" }),
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

async function* onboardingParts(password) {
  const fields = {
    email: "NewSeller@example.com",
    phone: "0400000000",
    contactPerson: "New Seller",
    password,
    businessName: "New Business",
    businessAddress: "1 Test Street",
    businessType: "Artist",
    storeName: "New Store",
    storeDescription: "Store description",
  };
  for (const [fieldname, value] of Object.entries(fields)) {
    yield { type: "field", fieldname, value };
  }
}

test("submit onboarding persists only a bcrypt hash and does not return it", async () => {
  const plaintext = "pending-secret";
  let upsertArgs;
  const controller = loadController({
    user: { findUnique: async () => null },
    pendingRegistration: {
      findUnique: async () => null,
      upsert: async (args) => { upsertArgs = args; return { id: "pending-1" }; },
    },
  });
  const res = makeReply();

  await controller.submitSellerOnboarding({ parts: () => onboardingParts(plaintext) }, res);

  const stored = upsertArgs.create.formData.password;
  assert.notEqual(stored, plaintext);
  assert.equal(await bcrypt.compare(plaintext, stored), true);
  assert.equal(JSON.stringify(res.payload).includes(plaintext), false);
  assert.equal(JSON.stringify(res.payload).includes(stored), false);
});

for (const scenario of [
  { name: "new hashed pending record", pendingPassword: async (plain) => bcrypt.hash(plain, 4) },
  { name: "legacy plaintext pending record", pendingPassword: async (plain) => plain },
]) {
  test(`OTP completion supports ${scenario.name} without double hashing`, async () => {
    const plaintext = "completion-secret";
    const storedPendingPassword = await scenario.pendingPassword(plaintext);
    let createdUser;
    let createdProfile;
    const pending = {
      id: "pending-1",
      email: "seller@example.com",
      otpExpiry: new Date(Date.now() + 60_000),
      formData: { password: storedPendingPassword, contactPerson: "Seller", phone: "0400000000" },
    };
    const controller = loadController({
      pendingRegistration: { findUnique: async () => pending },
      user: { findMany: async () => [] },
      $transaction: async (fn) => fn({
        user: {
          create: async ({ data }) => {
            createdUser = { id: "seller-1", ...data };
            return createdUser;
          },
        },
        sellerProfile: {
          create: async ({ data }) => {
            createdProfile = { id: "profile-1", ...data };
            return createdProfile;
          },
        },
        pendingRegistration: { delete: async () => undefined },
      }),
    });
    const res = makeReply();

    await controller.verifyAndSubmit({ body: { email: pending.email, otp: "123456" } }, res);

    assert.equal(res.code, 200);
    assert.equal(await bcrypt.compare(plaintext, createdUser.password), true);
    if (scenario.name.startsWith("new")) assert.equal(createdUser.password, storedPendingPassword);
    assert.equal(createdProfile.status, "PENDING");
    assert.equal(JSON.stringify(res.payload).includes(createdUser.password), false);
    assert.equal(JSON.stringify(res.payload).includes(plaintext), false);
  });
}

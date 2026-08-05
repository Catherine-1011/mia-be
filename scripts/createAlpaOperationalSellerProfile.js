require("dotenv").config();

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const CONFIRM_CREATE = process.env.CONFIRM_CREATE_ALPA_OPERATIONAL_PROFILE === "true";
const platformAccountId = process.env.ALPA_PLATFORM_ACCOUNT_ID?.trim();

function assertCreatedProfile({ platformAccount, sellerProfile }) {
  if (sellerProfile.userId !== platformAccount.userId) {
    throw new Error("Created SellerProfile.userId does not match PlatformAccount.userId");
  }
  if (sellerProfile.paymentAccountType !== "PLATFORM") {
    throw new Error("Created SellerProfile.paymentAccountType is not PLATFORM");
  }
  if (sellerProfile.stripeAccountId !== null) {
    throw new Error("Created SellerProfile.stripeAccountId must be null");
  }
  if (sellerProfile.stripeOnboardingComplete !== false) {
    throw new Error("Created SellerProfile.stripeOnboardingComplete must be false");
  }
  if (sellerProfile.stripeChargesEnabled !== false) {
    throw new Error("Created SellerProfile.stripeChargesEnabled must be false");
  }
  if (sellerProfile.stripePayoutsEnabled !== false) {
    throw new Error("Created SellerProfile.stripePayoutsEnabled must be false");
  }
}

async function main() {
  if (!platformAccountId) {
    throw new Error("ALPA_PLATFORM_ACCOUNT_ID is required");
  }

  await prisma.$transaction(async (tx) => {
    const platformAccount = await tx.platformAccount.findUnique({
      where: { id: platformAccountId },
      include: { user: true },
    });

    if (!platformAccount) {
      throw new Error(`PlatformAccount not found: ${platformAccountId}`);
    }
    if (!platformAccount.active) {
      throw new Error(`PlatformAccount is inactive: ${platformAccountId}`);
    }
    if (platformAccount.paymentType !== "PLATFORM") {
      throw new Error(`PlatformAccount.paymentType must be PLATFORM, found: ${platformAccount.paymentType}`);
    }
    if (!platformAccount.user) {
      throw new Error(`PlatformAccount.user is missing for userId: ${platformAccount.userId}`);
    }

    const existing = await tx.sellerProfile.findUnique({
      where: { userId: platformAccount.userId },
    });

    if (existing) {
      throw new Error(`SellerProfile already exists for PlatformAccount.userId: ${platformAccount.userId}`);
    }

    if (!CONFIRM_CREATE) {
      console.log("Dry run only. No SellerProfile was created.");
      console.log({
        platformAccountId: platformAccount.id,
        platformAccountUserId: platformAccount.userId,
        userEmail: platformAccount.user.email,
        userRole: platformAccount.user.role,
        wouldCreate: {
          userId: platformAccount.userId,
          status: "PENDING",
          isActive: false,
          paymentAccountType: "PLATFORM",
          stripeAccountId: null,
          stripeOnboardingComplete: false,
          stripeChargesEnabled: false,
          stripePayoutsEnabled: false,
          stripeAbnProvided: false,
          stripeBankConnected: false,
        },
      });
      return;
    }

    const created = await tx.sellerProfile.create({
      data: {
        userId: platformAccount.userId,
        status: "PENDING",
        isActive: false,
        paymentAccountType: "PLATFORM",
        stripeAccountId: null,
        stripeOnboardingComplete: false,
        stripeChargesEnabled: false,
        stripePayoutsEnabled: false,
        stripeAbnProvided: false,
        stripeBankConnected: false,
      },
    });

    const sellerProfile = await tx.sellerProfile.findUnique({
      where: { userId: platformAccount.userId },
    });

    if (!sellerProfile || sellerProfile.id !== created.id) {
      throw new Error("Created SellerProfile could not be read back for validation");
    }

    assertCreatedProfile({ platformAccount, sellerProfile });

    console.log("Created and validated ALPA operational SellerProfile.");
    console.log({
      platformAccountId: platformAccount.id,
      sellerProfileId: sellerProfile.id,
      userId: sellerProfile.userId,
      paymentAccountType: sellerProfile.paymentAccountType,
      stripeAccountId: sellerProfile.stripeAccountId,
    });
  });
}

main()
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

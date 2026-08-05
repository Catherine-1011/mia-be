require("dotenv").config();

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const platformAccountId = process.env.ALPA_PLATFORM_ACCOUNT_ID?.trim();

async function main() {
  if (!platformAccountId) {
    throw new Error("ALPA_PLATFORM_ACCOUNT_ID is required");
  }

  await prisma.$transaction(async (tx) => {
    const platformAccount = await tx.platformAccount.findUnique({
      where: { id: platformAccountId },
      select: { id: true, userId: true },
    });

    if (!platformAccount) {
      throw new Error(`PlatformAccount not found: ${platformAccountId}`);
    }

    const existing = await tx.sellerProfile.findUnique({
      where: { userId: platformAccount.userId },
      select: { id: true, userId: true, paymentAccountType: true, stripeAccountId: true },
    });

    if (existing) {
      console.log(
        `SellerProfile already exists for PlatformAccount "${platformAccount.id}" user "${existing.userId}" (${existing.id}). No changes made.`
      );
      return;
    }

    const created = await tx.sellerProfile.create({
      data: {
        userId: platformAccount.userId,
        paymentAccountType: "PLATFORM",
        stripeAccountId: null,
      },
    });

    console.log(
      `Created ALPA operational SellerProfile "${created.id}" for PlatformAccount "${platformAccount.id}" user "${created.userId}".`
    );
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

require("dotenv").config();

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const cuid = require("cuid");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const PLATFORM_EMAIL = "alpa.platform.internal@alpa.asn.au";
const PLATFORM_NAME = "ALPA Platform Internal";

const shouldCreate = process.argv.includes("--create");

const isValidPlatformOwner = (user) => (
  user &&
  user.role === "SELLER" &&
  user.sellerProfile &&
  user.sellerProfile.status === "ACTIVE" &&
  user.sellerProfile.isActive === true &&
  user.sellerProfile.paymentAccountType === "PLATFORM" &&
  user.sellerProfile.stripeAccountId === null
);

const printOwner = (user, source) => {
  console.log(`\n${source}`);
  console.log(`User ID: ${user.id}`);
  console.log(`Email: ${user.email}`);
  console.log(`Name: ${user.name}`);
  console.log(`Role: ${user.role}`);
  console.log(`SellerProfile ID: ${user.sellerProfile.id}`);
  console.log(`SellerProfile status: ${user.sellerProfile.status}`);
  console.log(`SellerProfile isActive: ${user.sellerProfile.isActive}`);
  console.log(`Payment account type: ${user.sellerProfile.paymentAccountType}`);
  console.log(`Stripe account ID: ${user.sellerProfile.stripeAccountId || "null"}`);
  console.log(`\nSet backend environment variable:\nALPA_PLATFORM_OWNER_ID=${user.id}\n`);
};

const mapOwnerRow = (row) => row && ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  sellerProfile: {
    id: row.sellerProfileId,
    status: row.sellerProfileStatus,
    isActive: row.sellerProfileIsActive,
    paymentAccountType: row.paymentAccountType,
    stripeAccountId: row.stripeAccountId,
  },
});

async function findValidPlatformOwner() {
  const rows = await prisma.$queryRaw`
    SELECT
      u.id,
      u.email,
      u.name,
      u.role::text AS role,
      sp.id AS "sellerProfileId",
      sp.status::text AS "sellerProfileStatus",
      sp."isActive" AS "sellerProfileIsActive",
      sp.payment_account_type::text AS "paymentAccountType",
      sp.stripe_account_id AS "stripeAccountId"
    FROM users u
    JOIN seller_profiles sp ON sp."userId" = u.id
    WHERE u.role::text = 'SELLER'
      AND sp.status::text = 'ACTIVE'
      AND sp."isActive" = true
      AND sp.payment_account_type::text = 'PLATFORM'
      AND sp.stripe_account_id IS NULL
    ORDER BY u."createdAt" ASC
    LIMIT 1
  `;

  return mapOwnerRow(rows[0]);
}

async function provisionReservedPlatformOwner() {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { email: PLATFORM_EMAIL },
      include: { sellerProfile: true },
    });

    if (existing && existing.role !== "SELLER") {
      throw new Error(
        `Reserved platform email already exists as role ${existing.role}. Resolve manually before provisioning.`
      );
    }

    if (existing?.sellerProfile?.stripeAccountId) {
      throw new Error(
        `Reserved platform seller has stripeAccountId=${existing.sellerProfile.stripeAccountId}. ` +
        "Platform owner must not be a Stripe Connect seller."
      );
    }

    const internalPassword = crypto.randomBytes(48).toString("base64url");
    const passwordHash = await bcrypt.hash(internalPassword, 12);

    const user = existing || await tx.user.create({
      data: {
        name: PLATFORM_NAME,
        email: PLATFORM_EMAIL,
        password: passwordHash,
        role: "SELLER",
        isVerified: true,
        emailVerified: true,
      },
    });

    if (existing?.sellerProfile) {
      await tx.$executeRaw`
        UPDATE seller_profiles
        SET status = 'ACTIVE'::"SellerStatus",
            "isActive" = true,
            payment_account_type = 'PLATFORM'::"PaymentAccountType",
            stripe_account_id = NULL,
            stripe_onboarding_complete = false,
            stripe_charges_enabled = false,
            stripe_payouts_enabled = false,
            "businessName" = COALESCE("businessName", ${PLATFORM_NAME}),
            "storeName" = COALESCE("storeName", 'ALPA Platform'),
            "updatedAt" = NOW()
        WHERE "userId" = ${user.id}
      `;
    } else {
      await tx.$executeRaw`
        INSERT INTO seller_profiles (
          id,
          "userId",
          "businessName",
          "storeName",
          status,
          "isActive",
          payment_account_type,
          stripe_account_id,
          stripe_onboarding_complete,
          stripe_charges_enabled,
          stripe_payouts_enabled,
          "minimumProductsUploaded",
          "productCount",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          ${cuid()},
          ${user.id},
          ${PLATFORM_NAME},
          'ALPA Platform',
          'ACTIVE'::"SellerStatus",
          true,
          'PLATFORM'::"PaymentAccountType",
          NULL,
          false,
          false,
          false,
          false,
          0,
          NOW(),
          NOW()
        )
      `;
    }

    const rows = await tx.$queryRaw`
      SELECT
        u.id,
        u.email,
        u.name,
        u.role::text AS role,
        sp.id AS "sellerProfileId",
        sp.status::text AS "sellerProfileStatus",
        sp."isActive" AS "sellerProfileIsActive",
        sp.payment_account_type::text AS "paymentAccountType",
        sp.stripe_account_id AS "stripeAccountId"
      FROM users u
      JOIN seller_profiles sp ON sp."userId" = u.id
      WHERE u.id = ${user.id}
      LIMIT 1
    `;

    return mapOwnerRow(rows[0]);
  });
}

async function main() {
  const validOwner = await findValidPlatformOwner();
  if (validOwner) {
    printOwner(validOwner, "Existing valid ALPA platform owner found. No database changes needed.");
    return;
  }

  console.log("\nNo valid ALPA platform owner found.");
  console.log("Required shape: User.role=SELLER, SellerProfile.status=ACTIVE, isActive=true, paymentAccountType=PLATFORM, stripeAccountId=null.");

  if (!shouldCreate) {
    console.log("\nAudit-only mode. Re-run with --create to provision the internal platform owner.");
    process.exitCode = 2;
    return;
  }

  const owner = await provisionReservedPlatformOwner();
  printOwner(owner, "Provisioned ALPA platform owner.");
}

main()
  .catch((error) => {
    console.error("\nFailed to provision ALPA platform owner:");
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

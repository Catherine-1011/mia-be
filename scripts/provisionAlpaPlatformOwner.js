require("dotenv").config();

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const DEFAULT_DISPLAY_NAME = "ALPA Platform";
const shouldCreate = process.argv.includes("--create");

function printAccount(account, source) {
  console.log(`\n${source}`);
  console.log(`PlatformAccount ID: ${account.id}`);
  console.log(`Display name: ${account.displayName}`);
  console.log(`Active: ${account.active}`);
  console.log(`Payment type: ${account.paymentType}`);
  console.log(`User ID: ${account.user.id}`);
  console.log(`Email: ${account.user.email}`);
  console.log(`Name: ${account.user.name}`);
  console.log(`Role: ${account.user.role}`);
  console.log(`\nSet backend environment variable:\nALPA_PLATFORM_OWNER_ID=${account.user.id}\n`);
}

async function findActivePlatformAccount() {
  return prisma.platformAccount.findFirst({
    where: { active: true, paymentType: "PLATFORM" },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });
}

async function provisionConfiguredPlatformAccount() {
  const userId = process.env.ALPA_PLATFORM_OWNER_ID?.trim();
  if (!userId) {
    throw new Error("ALPA_PLATFORM_OWNER_ID must point to an existing ADMIN, SUPER_ADMIN, or reserved platform user.");
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error(`Configured ALPA_PLATFORM_OWNER_ID was not found: ${userId}`);
  }
  if (user.role === "SELLER") {
    throw new Error("ALPA_PLATFORM_OWNER_ID must not be a SELLER user. Use an ADMIN or SUPER_ADMIN platform identity.");
  }

  return prisma.platformAccount.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      displayName: DEFAULT_DISPLAY_NAME,
      active: true,
      paymentType: "PLATFORM",
    },
    update: {
      active: true,
      paymentType: "PLATFORM",
      displayName: DEFAULT_DISPLAY_NAME,
    },
    include: { user: true },
  });
}

async function main() {
  const existing = await findActivePlatformAccount();
  if (existing) {
    printAccount(existing, "Existing active ALPA platform account found. No database changes needed.");
    return;
  }

  console.log("\nNo active ALPA platform account found.");
  console.log("Required shape: PlatformAccount.active=true, paymentType=PLATFORM, userId=<existing platform/admin user>.");

  if (!shouldCreate) {
    console.log("\nAudit-only mode. Re-run with --create after setting ALPA_PLATFORM_OWNER_ID to provision the platform account.");
    process.exitCode = 2;
    return;
  }

  const account = await provisionConfiguredPlatformAccount();
  printAccount(account, "Provisioned ALPA platform account.");
}

main()
  .catch((error) => {
    console.error("\nFailed to provision ALPA platform account:");
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

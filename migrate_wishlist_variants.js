const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function addWishlistVariantSupport() {
  try {
    console.log('🚀 Starting wishlist variant migration...');

    // Step 1: Check if variantId column already exists
    console.log('Step 1: Checking if variantId column exists...');
    const variantIdExists = await prisma.$queryRaw`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'wishlists' AND column_name = 'variantId'
    `;

    if (variantIdExists.length === 0) {
      console.log('Adding variantId column...');
      await prisma.$executeRaw`ALTER TABLE "wishlists" ADD COLUMN "variantId" TEXT`;
      console.log('✅ variantId column added');
    } else {
      console.log('✅ variantId column already exists');
    }

    // Step 2: Add foreign key constraint
    console.log('Step 2: Adding foreign key constraint...');
    try {
      await prisma.$executeRaw`
        ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_variantId_fkey" 
        FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE
      `;
      console.log('✅ Foreign key constraint added');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ Foreign key constraint already exists');
      } else {
        console.log(`⚠️  Warning: Could not add foreign key constraint: ${error.message}`);
      }
    }

    // Step 3: Update unique constraint
    console.log('Step 3: Updating unique constraint...');
    
    // Check if old constraint exists
    const oldConstraintExists = await prisma.$queryRaw`
      SELECT constraint_name FROM information_schema.table_constraints 
      WHERE table_name = 'wishlists' 
      AND constraint_name = 'wishlists_userId_productId_key'
    `;

    if (oldConstraintExists.length > 0) {
      console.log('Dropping old unique constraint...');
      await prisma.$executeRaw`ALTER TABLE "wishlists" DROP CONSTRAINT "wishlists_userId_productId_key"`;
      console.log('✅ Old unique constraint dropped');
    }

    // Check if new constraint exists
    const newConstraintExists = await prisma.$queryRaw`
      SELECT constraint_name FROM information_schema.table_constraints 
      WHERE table_name = 'wishlists' 
      AND constraint_name = 'wishlists_userId_productId_variantId_key'
    `;

    if (newConstraintExists.length === 0) {
      console.log('Adding new unique constraint...');
      await prisma.$executeRaw`
        ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_userId_productId_variantId_key" 
        UNIQUE ("userId", "productId", "variantId")
      `;
      console.log('✅ New unique constraint added');
    } else {
      console.log('✅ New unique constraint already exists');
    }

    // Step 4: Add index for variantId
    console.log('Step 4: Adding variantId index...');
    try {
      await prisma.$executeRaw`CREATE INDEX "wishlists_variantId_idx" ON "wishlists"("variantId")`;
      console.log('✅ variantId index added');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ variantId index already exists');
      } else {
        console.log(`⚠️  Warning: Could not add index: ${error.message}`);
      }
    }

    console.log('🎉 Wishlist variant migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run migration if called directly
if (require.main === module) {
  addWishlistVariantSupport()
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { addWishlistVariantSupport };
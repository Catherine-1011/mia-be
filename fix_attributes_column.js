const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixAttributesColumn() {
  console.log('🔧 Fixing product_variants table - removing old attributes column...');
  
  try {
    // Check if attributes column exists
    const columns = await prisma.$queryRaw`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'product_variants' AND column_name = 'attributes'
    `;
    
    if (columns.length > 0) {
      console.log('📋 Old attributes column found, dropping it...');
      
      // Drop the old attributes column
      await prisma.$executeRaw`
        ALTER TABLE product_variants DROP COLUMN attributes;
      `;
      
      console.log('✅ Old attributes column dropped successfully');
    } else {
      console.log('ℹ️  No old attributes column found');
    }
    
    // Check the new structure
    const finalColumns = await prisma.$queryRaw`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = 'product_variants'
      ORDER BY ordinal_position
    `;
    
    console.log('\n📊 Final product_variants table structure:');
    finalColumns.forEach(col => {
      console.log(`- ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
    });
    
    // Test creating a variant to make sure it works
    console.log('\n🧪 Testing variant creation...');
    
    // First check if we have any example products to test with
    const exampleProduct = await prisma.product.findFirst();
    if (!exampleProduct) {
      console.log('⚠️  No products found to test with');
      return;
    }
    
    // Try to create a test variant (we'll delete it right after)
    const testVariant = await prisma.productVariant.create({
      data: {
        productId: exampleProduct.id,
        price: 99.99,
        stock: 1,
        sku: `TEST-${Date.now()}`,
        isActive: true,
        images: []
      }
    });
    
    console.log('✅ Test variant created successfully:', testVariant.id);
    
    // Clean up test variant
    await prisma.productVariant.delete({
      where: { id: testVariant.id }
    });
    
    console.log('✅ Test variant cleaned up');
    console.log('🎉 Product variant system is now working correctly!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

fixAttributesColumn();
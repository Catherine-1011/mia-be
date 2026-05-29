const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkExistingData() {
  try {
    // Check existing product_variants structure and data
    const variants = await prisma.$queryRaw`SELECT * FROM product_variants LIMIT 5`;
    console.log('Existing variants:', JSON.stringify(variants, null, 2));
    
    // Check column structure
    const columns = await prisma.$queryRaw`
      SELECT column_name, data_type, is_nullable, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'product_variants'
      ORDER BY ordinal_position
    `;
    console.log('\nColumn structure:');
    columns.forEach(col => {
      console.log(`- ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
    });
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkExistingData();